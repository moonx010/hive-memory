# Design: enrichment-framework

## Directory Layout

```
src/enrichment/
  types.ts                      ← interfaces: EnrichmentProvider, EnrichmentContext, LLMProvider, etc.
  engine.ts                     ← EnrichmentEngine class
  providers/
    classify.ts                 ← ClassifyProvider (rule-based, no LLM)
    llm-enrich.ts               ← LLMEnrichProvider (summarize, domain classify)
    topic-stitch.ts             ← TopicStitchProvider (batch job, separate trigger)
  llm/
    index.ts                    ← createLLMProvider() factory
    openai.ts                   ← OpenAI LLMProvider implementation
    anthropic.ts                ← Anthropic LLMProvider implementation
    ollama.ts                   ← Ollama LLMProvider implementation
  eval/
    eval-dataset.json           ← 50+ labeled samples
    eval.ts                     ← evaluation harness

src/tools/
  context-tools.ts              ← context_enrich MCP tool (new file)
  index.ts                      ← register context-tools (modified)

src/store.ts                    ← EnrichmentEngine init + enrichEntity/enrichBatch methods (modified)
src/cli.ts                      ← `enrich` subcommand (modified)
```

## Core Interfaces (`src/enrichment/types.ts`)

```typescript
import type { HiveDatabase } from "../db/database.js";

export type EntityType =
  | "memory" | "reference" | "decision" | "person" | "document"
  | "conversation" | "message" | "meeting" | "task" | "event" | "snippet";

export interface SynapseDraft {
  targetId: string;
  axon: string;           // e.g. "related", "derived", "attended", "causal"
  weight: number;
  metadata?: Record<string, string>;
}

export interface AliasDraft {
  canonicalId: string;
  aliasType: string;      // e.g. "slack-handle", "github-username"
  aliasValue: string;
  confidence: "confirmed" | "inferred";
}

export interface EntityDraft {
  entityType: EntityType;
  title?: string;
  content: string;
  tags: string[];
  attributes: Record<string, unknown>;
  source: { system: string; externalId: string; connector: string };
  domain: string;
  confidence: "confirmed" | "inferred";
}

export interface EnrichmentResult {
  attributes?: Record<string, unknown>;
  tags?: string[];
  keywords?: string[];
  synapses?: SynapseDraft[];
  aliases?: AliasDraft[];
  derivedEntities?: EntityDraft[];
}

export interface EnrichmentContext {
  /** Direct in-process HiveDatabase reference. NOT MCP-over-MCP. */
  db: HiveDatabase;
  /**
   * Convenience FTS5 search over entities.
   * Wraps db.searchEntities() with sensible defaults.
   */
  findRelated(query: string, opts?: { entityType?: EntityType; limit?: number }): Entity[];
  /** Only defined when CORTEX_LLM_PROVIDER is set and CORTEX_ENRICHMENT=llm */
  llm?: LLMProvider;
}

export interface LLMProvider {
  readonly model: string;
  /** Text completion — returns raw string */
  complete(prompt: string, opts?: { maxTokens?: number; temperature?: number }): Promise<string>;
  /** Structured extraction — appends JSON schema to prompt, parses response */
  extract<T>(prompt: string, schema: Record<string, unknown>): Promise<T>;
}

export interface EnrichmentProvider {
  readonly id: string;
  readonly name: string;
  readonly applicableTo: EntityType[];
  /** Lower number runs first. ClassifyProvider=100, LLMEnrichProvider=200, TopicStitch=300 */
  readonly priority: number;
  shouldEnrich(entity: Entity): boolean;
  enrich(entity: Entity, ctx: EnrichmentContext): Promise<EnrichmentResult>;
}

export interface BatchFilter {
  entityType?: EntityType[];
  since?: string;             // ISO8601
  unenrichedOnly?: boolean;
  limit?: number;
}

export interface BatchResult {
  processed: number;
  enriched: number;
  errors: number;
  batchId: string;
}
```

## EnrichmentEngine (`src/enrichment/engine.ts`)

```typescript
import { randomUUID } from "node:crypto";
import type { HiveDatabase } from "../db/database.js";
import type {
  BatchFilter, BatchResult, EnrichmentContext,
  EnrichmentProvider, EnrichmentResult, LLMProvider
} from "./types.js";

export class EnrichmentEngine {
  private providers: EnrichmentProvider[] = [];

  constructor(
    private db: HiveDatabase,
    private llm?: LLMProvider
  ) {}

  register(provider: EnrichmentProvider): void {
    this.providers.push(provider);
    this.providers.sort((a, b) => a.priority - b.priority);
  }

  async enrichEntity(entityId: string): Promise<EnrichmentResult[]> {
    const entity = this.db.getEntity(entityId);
    if (!entity) throw new Error(`Entity not found: ${entityId}`);

    const ctx: EnrichmentContext = {
      db: this.db,
      findRelated: (query, opts) =>
        this.db.searchEntities({ query, entityType: opts?.entityType, limit: opts?.limit ?? 10 }),
      llm: this.llm,
    };

    const results: EnrichmentResult[] = [];
    const enrichedBy: string[] = [];

    for (const provider of this.providers) {
      if (!provider.applicableTo.includes(entity.entityType as EntityType) &&
          !provider.applicableTo.includes("*" as EntityType)) continue;
      if (!provider.shouldEnrich(entity)) continue;

      try {
        const result = await provider.enrich(entity, ctx);
        await this.applyResult(entity, result);
        results.push(result);
        enrichedBy.push(provider.id);
      } catch (err) {
        console.error(`[enrichment] provider ${provider.id} failed on ${entityId}:`, err);
      }
    }

    if (enrichedBy.length > 0) {
      this.db.updateEntityAttributes(entityId, {
        _enrichedAt: new Date().toISOString(),
        _enrichedBy: enrichedBy,
      });
    }

    return results;
  }

  async enrichBatch(filter: BatchFilter = {}): Promise<BatchResult> {
    const batchId = randomUUID();
    const limit = filter.limit ?? 100;
    // Query entities matching filter using db.listEntities() or db.searchEntities()
    const entities = this.db.listEntities({
      entityType: filter.entityType,
      since: filter.since,
      unenrichedOnly: filter.unenrichedOnly,
      limit,
    });

    let processed = 0, enriched = 0, errors = 0;

    for (const entity of entities) {
      processed++;
      try {
        const results = await this.enrichEntity(entity.id);
        if (results.length > 0) {
          this.db.updateEntityAttributes(entity.id, { _batchId: batchId });
          enriched++;
        }
      } catch {
        errors++;
      }
      if (processed % 50 === 0) {
        console.error(`[enrichment] processed ${processed}/${entities.length} entities`);
      }
    }

    return { processed, enriched, errors, batchId };
  }

  private async applyResult(entity: Entity, result: EnrichmentResult): Promise<void> {
    if (result.attributes) {
      this.db.updateEntityAttributes(entity.id, result.attributes);
    }
    if (result.tags?.length) {
      this.db.addEntityTags(entity.id, result.tags);
    }
    if (result.keywords?.length) {
      this.db.addEntityKeywords(entity.id, result.keywords);
    }
    for (const syn of result.synapses ?? []) {
      this.db.upsertSynapse({ sourceId: entity.id, ...syn });
    }
    for (const draft of result.derivedEntities ?? []) {
      this.db.upsertEntity(draft);
    }
  }
}
```

## ClassifyProvider (`src/enrichment/providers/classify.ts`)

```typescript
const CODE_PATTERNS = [
  /\bfunction\b/, /\bclass\b/, /\bimport\b/, /\bconst\s+\w+\s*=/, /=>/,
  /\binterface\b/, /\btype\b.*=/, /\bexport\b/,
];

const MEETING_PATTERNS = [
  /\battendee(s)?\b/i, /\bagenda\b/i, /\bminutes\b/i,
  /\bstandup\b/i, /\bsync\b/i, /\baction items\b/i,
];

const DECISION_PATTERNS = [
  /\bdecided\b/i, /\bapproved\b/i, /\bresolved\b/i, /\bagreed\b/i,
];

const TIME_SENSITIVE_PATTERNS = [
  /\bdeadline\b/i, /\bdue by\b/i, /\bdue date\b/i,
  /\bby eod\b/i, /\bby eow\b/i,
  /\bby (monday|tuesday|wednesday|thursday|friday)\b/i,
];

export class ClassifyProvider implements EnrichmentProvider {
  readonly id = "classify";
  readonly name = "Rule-Based Classifier";
  readonly applicableTo: EntityType[] = [
    "memory", "message", "conversation", "document", "meeting", "decision", "task",
  ];
  readonly priority = 100;

  shouldEnrich(entity: Entity): boolean {
    return entity.content.length >= 20;
  }

  async enrich(entity: Entity, _ctx: EnrichmentContext): Promise<EnrichmentResult> {
    const content = entity.content;
    const tags: string[] = [];
    const attributes: Record<string, unknown> = {};

    // Domain detection
    if (CODE_PATTERNS.some(p => p.test(content))) {
      attributes.domain = "code";
    } else if (MEETING_PATTERNS.some(p => p.test(content))) {
      attributes.domain = "meetings";
    }

    // Signal strength
    const reactions = Number(entity.attributes?.reactions ?? 0);
    const replies = Number(entity.attributes?.replyCount ?? entity.attributes?.commentCount ?? 0);
    if (reactions >= 5 || replies >= 10) tags.push("high-signal");

    // Time sensitivity
    if (TIME_SENSITIVE_PATTERNS.some(p => p.test(content))) tags.push("time-sensitive");

    // Decision marker
    if (DECISION_PATTERNS.some(p => p.test(content))) tags.push("decision");

    return { attributes, tags };
  }
}
```

## LLM Provider Abstraction (`src/enrichment/llm/`)

### Unified Interface

All three providers implement the same `LLMProvider` interface. The `extract<T>` method wraps `complete()` with a JSON instruction appended to the prompt:

```typescript
async extract<T>(prompt: string, schema: Record<string, unknown>): Promise<T> {
  const fullPrompt = `${prompt}\n\nRespond ONLY with valid JSON matching this schema:\n${JSON.stringify(schema, null, 2)}`;
  const text = await this.complete(fullPrompt, { maxTokens: 1000, temperature: 0 });
  // Extract JSON from text (handle markdown code blocks)
  const jsonMatch = text.match(/```json\n?([\s\S]*?)\n?```/) ?? text.match(/(\{[\s\S]*\})/);
  return JSON.parse(jsonMatch?.[1] ?? text) as T;
}
```

### OpenAI (`src/enrichment/llm/openai.ts`)

```typescript
export class OpenAIProvider implements LLMProvider {
  readonly model: string;
  constructor(private apiKey: string, model = "gpt-4o-mini") {
    this.model = model;
  }

  async complete(prompt: string, opts?: { maxTokens?: number; temperature?: number }): Promise<string> {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: opts?.maxTokens ?? 500,
        temperature: opts?.temperature ?? 0.3,
      }),
    });
    if (!res.ok) throw new LLMError(res.status, await res.text());
    const data = await res.json() as OpenAIChatResponse;
    return data.choices[0].message.content ?? "";
  }
}
```

### Factory (`src/enrichment/llm/index.ts`)

```typescript
export function createLLMProvider(): LLMProvider | undefined {
  const enrichMode = process.env.CORTEX_ENRICHMENT ?? "rule";
  if (enrichMode !== "llm") return undefined;

  const provider = process.env.CORTEX_LLM_PROVIDER ?? "openai";
  const model = process.env.CORTEX_LLM_MODEL;
  const apiKey = process.env.CORTEX_LLM_API_KEY ?? "";
  const baseUrl = process.env.CORTEX_LLM_BASE_URL;

  switch (provider) {
    case "openai":    return new OpenAIProvider(apiKey, model ?? "gpt-4o-mini");
    case "anthropic": return new AnthropicProvider(apiKey, model ?? "claude-haiku-4-5");
    case "ollama":    return new OllamaProvider(baseUrl ?? "http://localhost:11434", model ?? "llama3");
    default: throw new Error(`Unknown LLM provider: ${provider}`);
  }
}
```

## Topic Stitching Design (`src/enrichment/providers/topic-stitch.ts`)

Topic stitching is a **batch job** distinct from per-entity enrichment. It runs via a separate CLI command or MCP tool call, not as part of `enrichBatch`.

```typescript
export class TopicStitcher {
  constructor(private db: HiveDatabase, private llm?: LLMProvider) {}

  async stitchBatch(opts: { limit?: number; minJaccard?: number } = {}): Promise<StitchResult> {
    const minJaccard = opts.minJaccard ?? 0.4;

    // Step 1: Load all entities with at least 3 keywords
    const candidates = this.db.listEntities({ hasKeywords: true, limit: opts.limit ?? 500 });

    // Step 2: Pre-filter via keyword Jaccard
    const pairs: [Entity, Entity, number][] = [];
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const jaccard = computeJaccard(candidates[i].keywords, candidates[j].keywords);
        if (jaccard >= minJaccard) pairs.push([candidates[i], candidates[j], jaccard]);
      }
    }

    // Step 3: Optional LLM confirmation for borderline pairs (0.4 <= jaccard < 0.7)
    let linked = 0;
    for (const [a, b, score] of pairs) {
      let finalScore = score;
      if (this.llm && score < 0.7) {
        finalScore = await this.confirmWithLLM(a, b);
        if (finalScore < 0.5) continue;
      }
      this.db.upsertSynapse({ sourceId: a.id, targetId: b.id, axon: "related", weight: finalScore });
      linked++;
    }

    return { candidates: candidates.length, pairs: pairs.length, linked };
  }

  private computeJaccard(a: string[], b: string[]): number {
    const setA = new Set(a.slice(0, 5));
    const setB = new Set(b.slice(0, 5));
    const intersection = [...setA].filter(k => setB.has(k)).length;
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : intersection / union;
  }
}
```

## CortexStore Integration

```typescript
// In src/store.ts constructor:
import { EnrichmentEngine } from "./enrichment/engine.js";
import { ClassifyProvider } from "./enrichment/providers/classify.js";
import { LLMEnrichProvider } from "./enrichment/providers/llm-enrich.js";
import { createLLMProvider } from "./enrichment/llm/index.js";

const llm = createLLMProvider();
this._enrichmentEngine = new EnrichmentEngine(this.db, llm);

const enrichMode = process.env.CORTEX_ENRICHMENT ?? "rule";
if (enrichMode !== "off") {
  this._enrichmentEngine.register(new ClassifyProvider());
}
if (enrichMode === "llm" && llm) {
  this._enrichmentEngine.register(new LLMEnrichProvider(llm));
}

// New public methods:
async enrichEntity(entityId: string): Promise<EnrichmentResult[]> {
  return this._enrichmentEngine.enrichEntity(entityId);
}

async enrichBatch(opts: BatchFilter = {}): Promise<BatchResult> {
  return this._enrichmentEngine.enrichBatch(opts);
}
```

## MCP Tool (`src/tools/context-tools.ts`)

```typescript
export function registerContextTools(server: McpServer, store: CortexStore): void {
  server.tool(
    "context_enrich",
    "Enrich entities with extracted metadata, classifications, and inferred relationships",
    {
      scope: z.enum(["entity", "batch"]),
      entityId: z.string().optional(),
      entityType: z.array(z.string()).optional(),
      since: z.string().optional(),
      limit: z.number().int().positive().max(500).optional(),
    },
    async ({ scope, entityId, entityType, since, limit }) => {
      if (scope === "entity") {
        if (!entityId) throw new Error("entityId required for scope=entity");
        const results = await store.enrichEntity(entityId);
        return { content: [{ type: "text", text: JSON.stringify({ enriched: results.length }) }] };
      }

      const result = await store.enrichBatch({
        entityType: entityType as EntityType[],
        since,
        limit,
        unenrichedOnly: true,
      });

      const sample = store.db.listEntities({ limit: 5, since: new Date(Date.now() - 60000).toISOString() });
      return { content: [{ type: "text", text: JSON.stringify({ ...result, sample }) }] };
    }
  );
}
```

## Evaluation Harness Design

`src/enrichment/eval/eval.ts` loads `eval-dataset.json`, runs `ClassifyProvider` on each sample, and computes:

- **Tag precision** = correct tags predicted / total tags predicted
- **Tag recall** = correct tags predicted / total expected tags
- **Domain accuracy** = % samples where domain prediction matches expected

Expected output format:
```
ClassifyProvider Evaluation (50 samples)
─────────────────────────────────────────
Tag Precision:  0.88
Tag Recall:     0.72
Domain Accuracy: 0.84
─────────────────────────────────────────
PASS (precision >= 0.80)
```
