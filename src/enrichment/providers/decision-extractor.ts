import type {
  Entity,
  EntityType,
  EnrichmentContext,
  EnrichmentProvider,
  EnrichmentResult,
  LLMProvider,
} from "../types.js";
import type { EntityDraft, SynapseDraft } from "../types.js";

// ── Signal Patterns ──────────────────────────────────────────────────────────

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
  /\[ \]/,
  /will (do|handle|take care of|follow up)/i,
  /assigned to\s+\S+/i,
  /by (monday|tuesday|wednesday|thursday|friday|eow|eod|end of (week|day|month))/i,
  /due (date|by)\s*:/i,
  /\bdeadline\b/i,
  /@\w+\s+(please|can you|could you|will you)/i,
  /\bneeds to\b/i,
  /\bshould (be done|complete|finish)/i,
];

// ── Types ────────────────────────────────────────────────────────────────────

interface ExtractedDecision {
  summary: string;
  context: string;
  alternatives: string[];
  confidence: "explicit" | "implicit";
}

interface ExtractedAction {
  description: string;
  owner: string | null;
  deadline: string | null;
  status: "open" | "in-progress" | "done";
}

interface ExtractionOutput {
  decisions: ExtractedDecision[];
  actions: ExtractedAction[];
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
          status: {
            type: "string",
            enum: ["open", "in-progress", "done"],
          },
        },
        required: ["description", "owner", "deadline", "status"],
      },
    },
  },
  required: ["decisions", "actions"],
};

const EXTRACTION_PROMPT = `Extract all decisions and action items from the following content.

For decisions, identify:
- The decision itself (summary)
- Context/reasoning behind it
- Any alternatives that were considered
- Whether it was explicit ("we decided") or implicit (implied agreement)

For action items, identify:
- What needs to be done (description)
- Who is responsible (owner, often @mentioned)
- Any deadline mentioned
- Current status (open, in-progress, or done)

Content:
{content}`;

// ── Provider ─────────────────────────────────────────────────────────────────

export class DecisionExtractorProvider implements EnrichmentProvider {
  readonly id = "decision-extractor";
  readonly name = "Decision & Action Item Extractor";
  readonly applicableTo: EntityType[] = [
    "conversation",
    "message",
    "document",
    "meeting",
  ];
  readonly priority = 50;

  shouldEnrich(entity: Entity): boolean {
    if (entity.attributes?._decisionsExtracted) return false;
    if (entity.content.length < 50) return false;
    return (
      this.hasDecisionSignals(entity.content) ||
      this.hasActionSignals(entity.content)
    );
  }

  async enrich(
    entity: Entity,
    ctx: EnrichmentContext,
  ): Promise<EnrichmentResult> {
    let decisions: ExtractedDecision[];
    let actions: ExtractedAction[];
    let extractionMethod: "llm" | "rule-based" = "rule-based";

    if (ctx.llm) {
      try {
        const result = await this.extractWithLLM(entity, ctx.llm);
        decisions = result.decisions;
        actions = result.actions;
        extractionMethod = "llm";
      } catch (err) {
        console.warn(
          `[decision-extractor] LLM extraction failed for ${entity.id}, falling back to rules:`,
          err,
        );
        ({ decisions, actions } = this.extractWithRules(entity.content));
      }
    } else {
      ({ decisions, actions } = this.extractWithRules(entity.content));
    }

    if (decisions.length === 0 && actions.length === 0) {
      return { attributes: { _decisionsExtracted: true } };
    }

    const derivedEntities: EntityDraft[] = [
      ...decisions.map((d, i) =>
        this.makeDecisionDraft(entity, d, i, extractionMethod),
      ),
      ...actions.map((a, i) =>
        this.makeActionDraft(entity, a, i, extractionMethod),
      ),
    ];

    const synapses: SynapseDraft[] = derivedEntities.map((e) => ({
      targetId: e.source.externalId!,
      axon: "derived",
      weight: 1.0,
    }));

    // Attempt owner resolution for action items
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      if (action.owner) {
        const ownerHandle = action.owner.replace(/^@/, "");
        const personEntity = ctx.findRelated(ownerHandle, {
          entityType: "person",
          limit: 1,
        })[0];
        if (personEntity) {
          const taskExternalId = `ce:action:${entity.id}:${i}`;
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
    return DECISION_SIGNALS.some((p) => p.test(content));
  }

  private hasActionSignals(content: string): boolean {
    return ACTION_SIGNALS.some((p) => p.test(content));
  }

  private async extractWithLLM(
    entity: Entity,
    llm: LLMProvider,
  ): Promise<ExtractionOutput> {
    const content = entity.content.slice(0, 8000);
    const prompt = EXTRACTION_PROMPT.replace("{content}", content);
    return llm.extract<ExtractionOutput>(prompt, EXTRACTION_SCHEMA);
  }

  // Exported for testing
  extractWithRules(content: string): {
    decisions: ExtractedDecision[];
    actions: ExtractedAction[];
  } {
    const lines = content.split("\n");
    const decisions: ExtractedDecision[] = [];
    const actions: ExtractedAction[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (DECISION_SIGNALS.some((p) => p.test(trimmed))) {
        decisions.push({
          summary: trimmed.slice(0, 200),
          context: "",
          alternatives: [],
          confidence: "implicit",
        });
      }

      if (ACTION_SIGNALS.some((p) => p.test(trimmed))) {
        const ownerMatch = trimmed.match(/@(\w+)/);
        actions.push({
          description: trimmed.slice(0, 200),
          owner: ownerMatch ? `@${ownerMatch[1]}` : null,
          deadline: null,
          status: "open",
        });
      }
    }

    return { decisions, actions };
  }

  private makeDecisionDraft(
    source: Entity,
    decision: ExtractedDecision,
    index: number,
    method: "llm" | "rule-based",
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
      tags: ["decision", "extracted", source.entityType],
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
      domain: source.domain ?? "code",
      confidence: "inferred",
    };
  }

  private makeActionDraft(
    source: Entity,
    action: ExtractedAction,
    index: number,
    method: "llm" | "rule-based",
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
      tags: ["action-item", "extracted", source.entityType],
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
      domain: source.domain ?? "code",
      confidence: "inferred",
    };
  }
}
