# Design: decision-action-extraction

## Overview

A single new file `src/enrichment/providers/decision-extractor.ts` implements `EnrichmentProvider`. It has three layers:

1. **Signal detection** — synchronous regex scan, < 1ms per entity.
2. **LLM extraction** — single `ctx.llm.extract()` call with structured JSON schema.
3. **Rule-based fallback** — extracts matching lines into simpler entities when LLM is unavailable.

## File Layout

```
src/enrichment/providers/
  classify.ts           ← already exists (enrichment-framework)
  llm-enrich.ts         ← already exists (enrichment-framework)
  decision-extractor.ts ← new file (this change)
  topic-stitch.ts       ← already exists (enrichment-framework)

src/enrichment/eval/
  decision-eval-dataset.json  ← new file (this change)
  decision-eval.ts            ← new file (this change)

src/store.ts                  ← modified (register provider)
```

## Signal Pattern Definitions

```typescript
export const DECISION_SIGNALS: RegExp[] = [
  /we('re| are) going (with|to)/i,
  /decided (to|on|that)/i,
  /decision\s*:/i,
  /let'?s go with/i,
  /\bapproved\b/i,
  /final(ized|ly|ize)\b/i,
  /agreed (to|on|that)/i,
  /conclusion\s*:/i,
  /resolved\s*:/i,
  /verdict\s*:/i,
  /consensus\s*:/i,
  /going forward/i,
  /our (approach|plan|strategy) (will|is)/i,
];

export const ACTION_SIGNALS: RegExp[] = [
  /action item\s*:/i,
  /\btodo\s*:/i,
  /\[ \]/,                                           // unchecked markdown checkbox
  /will (do|handle|take care of|follow up)/i,
  /assigned to\s+\S+/i,
  /by (monday|tuesday|wednesday|thursday|friday|eow|eod|end of (week|day|month))/i,
  /due (date|by)\s*:/i,
  /\bdeadline\b/i,
  /@\w+\s+(please|can you|could you|will you)/i,
  /\bneeds to\b/i,
  /\bshould (be done|complete|finish)/i,
];
```

## DecisionExtractorProvider Class

```typescript
export class DecisionExtractorProvider implements EnrichmentProvider {
  readonly id = "decision-extractor";
  readonly name = "Decision & Action Item Extractor";
  readonly applicableTo: EntityType[] = ["conversation", "message", "document", "meeting"];
  readonly priority = 50;

  shouldEnrich(entity: Entity): boolean {
    if (entity.attributes?._decisionsExtracted) return false;
    if (entity.content.length < 50) return false;
    return this.hasDecisionSignals(entity.content) || this.hasActionSignals(entity.content);
  }

  async enrich(entity: Entity, ctx: EnrichmentContext): Promise<EnrichmentResult> {
    let decisions: ExtractedDecision[] = [];
    let actions: ExtractedAction[] = [];
    let extractionMethod: "llm" | "rule-based" = "rule-based";

    if (ctx.llm) {
      try {
        const result = await this.extractWithLLM(entity, ctx.llm);
        decisions = result.decisions;
        actions = result.actions;
        extractionMethod = "llm";
      } catch (err) {
        console.warn(`[decision-extractor] LLM extraction failed for ${entity.id}, falling back to rules:`, err);
        ({ decisions, actions } = this.extractWithRules(entity.content));
      }
    } else {
      ({ decisions, actions } = this.extractWithRules(entity.content));
    }

    const derivedEntities: EntityDraft[] = [
      ...decisions.map((d, i) => this.makeDecisionDraft(entity, d, i, extractionMethod)),
      ...actions.map((a, i) => this.makeActionDraft(entity, a, i, extractionMethod)),
    ];

    const synapses: SynapseDraft[] = derivedEntities.map(e => ({
      targetId: e.source.externalId,  // resolved to real ID by engine after upsert
      axon: "derived",
      weight: 1.0,
    }));

    // Attempt owner resolution for action items
    for (const action of actions) {
      if (action.owner) {
        const ownerHandle = action.owner.replace(/^@/, "");
        const personEntity = ctx.findRelated(ownerHandle, { entityType: "person", limit: 1 })[0];
        if (personEntity) {
          const taskExternalId = `ce:action:${entity.id}:${actions.indexOf(action)}`;
          synapses.push({
            targetId: taskExternalId,
            axon: "authored",
            weight: 1.0,
            metadata: { ownerEntityId: personEntity.id },
          });
        }
      }
    }

    return {
      attributes: { _decisionsExtracted: true },
      derivedEntities,
      synapses,
    };
  }

  private hasDecisionSignals(content: string): boolean {
    return DECISION_SIGNALS.some(p => p.test(content));
  }

  private hasActionSignals(content: string): boolean {
    return ACTION_SIGNALS.some(p => p.test(content));
  }
}
```

## LLM Extraction

```typescript
interface ExtractionOutput {
  decisions: {
    summary: string;
    context: string;
    alternatives: string[];
    confidence: "explicit" | "implicit";
  }[];
  actions: {
    description: string;
    owner: string | null;
    deadline: string | null;
    status: "open" | "in-progress" | "done";
  }[];
}

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          summary: { type: "string" },
          context: { type: "string" },
          alternatives: { type: "array", items: { type: "string" } },
          confidence: { type: "string", enum: ["explicit", "implicit"] },
        },
        required: ["summary", "context", "alternatives", "confidence"],
      },
    },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          owner: { type: ["string", "null"] },
          deadline: { type: ["string", "null"] },
          status: { type: "string", enum: ["open", "in-progress", "done"] },
        },
        required: ["description", "owner", "deadline", "status"],
      },
    },
  },
  required: ["decisions", "actions"],
};

private async extractWithLLM(entity: Entity, llm: LLMProvider): Promise<ExtractionOutput> {
  // Truncate to ~8000 chars to stay within token limits
  const content = entity.content.slice(0, 8000);
  const prompt = EXTRACTION_PROMPT_TEMPLATE.replace("{content}", content);
  return llm.extract<ExtractionOutput>(prompt, EXTRACTION_SCHEMA);
}
```

## Rule-Based Fallback

```typescript
private extractWithRules(content: string): { decisions: ExtractedDecision[]; actions: ExtractedAction[] } {
  const lines = content.split("\n");
  const decisions: ExtractedDecision[] = [];
  const actions: ExtractedAction[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (DECISION_SIGNALS.some(p => p.test(trimmed))) {
      decisions.push({
        summary: trimmed.slice(0, 200),
        context: "",
        alternatives: [],
        confidence: "implicit",
      });
    }

    if (ACTION_SIGNALS.some(p => p.test(trimmed))) {
      // Simple owner extraction: look for @handle pattern
      const ownerMatch = trimmed.match(/@(\w+)/);
      // Simple deadline extraction: look for "by {day}" pattern
      const deadlineMatch = trimmed.match(/by (monday|tuesday|wednesday|thursday|friday|eow|eod)/i);
      actions.push({
        description: trimmed.slice(0, 200),
        owner: ownerMatch ? `@${ownerMatch[1]}` : null,
        deadline: deadlineMatch ? null : null,  // no date parsing in rule mode
        status: "open",
      });
    }
  }

  return { decisions, actions };
}
```

## Derived Entity Builders

```typescript
private makeDecisionDraft(
  source: Entity,
  decision: ExtractedDecision,
  index: number,
  method: "llm" | "rule-based"
): EntityDraft {
  return {
    entityType: "decision",
    title: decision.summary,
    content: [
      `Decision: ${decision.summary}`,
      decision.context ? `\nContext: ${decision.context}` : "",
      decision.alternatives.length
        ? `\nAlternatives considered: ${decision.alternatives.join(", ")}`
        : "",
    ].join(""),
    tags: ["decision", "extracted", source.entityType as string],
    attributes: {
      extractedFrom: source.id,
      decisionConfidence: decision.confidence,
      alternatives: decision.alternatives,
      _extractedBy: "decision-extractor",
      _extractionMethod: method,
    },
    source: {
      system: "context-engine",
      externalId: `ce:decision:${source.id}:${index}`,
      connector: "decision-extractor",
    },
    domain: source.domain ?? "unknown",
    confidence: "inferred",
  };
}

private makeActionDraft(
  source: Entity,
  action: ExtractedAction,
  index: number,
  method: "llm" | "rule-based"
): EntityDraft {
  return {
    entityType: "task",
    title: action.description,
    content: [
      `Action: ${action.description}`,
      `\nOwner: ${action.owner ?? "unassigned"}`,
      `\nDeadline: ${action.deadline ?? "none"}`,
      `\nStatus: ${action.status}`,
    ].join(""),
    tags: ["action-item", "extracted", source.entityType as string],
    attributes: {
      extractedFrom: source.id,
      owner: action.owner,
      deadline: action.deadline,
      actionStatus: action.status,
      _extractedBy: "decision-extractor",
      _extractionMethod: method,
    },
    source: {
      system: "context-engine",
      externalId: `ce:action:${source.id}:${index}`,
      connector: "decision-extractor",
    },
    domain: source.domain ?? "unknown",
    confidence: "inferred",
  };
}
```

## Registration in store.ts

```typescript
// After ClassifyProvider and LLMEnrichProvider registrations:
import { DecisionExtractorProvider } from "./enrichment/providers/decision-extractor.js";

const enrichMode = process.env.CORTEX_ENRICHMENT ?? "rule";
if (enrichMode !== "off") {
  this._enrichmentEngine.register(new DecisionExtractorProvider());
}
```

## Evaluation Dataset Format

`src/enrichment/eval/decision-eval-dataset.json`:
```json
[
  {
    "id": "dae-001",
    "entityContent": "We decided to use PostgreSQL instead of MongoDB for the user service because of better transaction support.",
    "entityType": "message",
    "attributes": {},
    "expectedSignalsFound": true,
    "expectedDecisions": 1,
    "expectedActions": 0,
    "notes": "Clear decision with explicit signal 'decided to use'"
  },
  {
    "id": "dae-002",
    "entityContent": "Action: @alice will set up the CI pipeline by Friday. @bob please review the PR.",
    "entityType": "message",
    "attributes": {},
    "expectedSignalsFound": true,
    "expectedDecisions": 0,
    "expectedActions": 2,
    "notes": "Two action items with owners"
  }
]
```
