# Change: enrichment-framework

**Layer:** 2 (Context Engine)
**One-liner:** EnrichmentProvider plugin interface with rule-based and LLM-backed implementations that enrich raw entities with extracted metadata, classifications, and inferred relationships.
**Estimated effort:** 2 weeks
**Dependencies:** None (uses HiveDatabase directly, in-process)

## Why

Raw connector data is noisy and unstructured. A Slack thread might contain a critical architecture decision buried in casual conversation. A PR description might reference a meeting outcome without an explicit link. The Context Engine's job is to transform raw entities into richly-connected, classified knowledge.

The Enrichment Framework is the foundation of Layer 2 — every other Context Engine feature (decision extraction, topic stitching) is implemented as an `EnrichmentProvider`. Without it, there is no extension point for intelligence.

## What Changes

### In Scope

1. **New directory: `src/enrichment/`** — Layer 2 root (not `src/context-engine/` — simpler path, no namespace collision).

2. **New file: `src/enrichment/types.ts`** — Core interfaces:

   ```typescript
   interface EnrichmentResult {
     attributes?: Record<string, unknown>;
     tags?: string[];
     keywords?: string[];
     synapses?: SynapseDraft[];
     aliases?: AliasDraft[];
     derivedEntities?: EntityDraft[];
   }

   interface EnrichmentProvider {
     readonly id: string;
     readonly name: string;
     readonly applicableTo: EntityType[];
     readonly priority: number;          // lower = runs first
     shouldEnrich(entity: Entity): boolean;
     enrich(entity: Entity, ctx: EnrichmentContext): Promise<EnrichmentResult>;
   }

   interface EnrichmentContext {
     db: HiveDatabase;                   // direct in-process access, NOT MCP-over-MCP
     findRelated(query: string, opts?: { entityType?: EntityType; limit?: number }): Entity[];
     llm?: LLMProvider;
   }

   interface LLMProvider {
     complete(prompt: string, opts?: { maxTokens?: number; temperature?: number }): Promise<string>;
     extract<T>(prompt: string, schema: Record<string, unknown>): Promise<T>;
   }
   ```

   **Design decision:** `EnrichmentContext.db` is a direct `HiveDatabase` reference (in-process, synchronous SQLite via `better-sqlite3`). This avoids the MCP-over-MCP anti-pattern where an MCP server would call itself via the MCP protocol. No network hop, no serialization overhead.

3. **New file: `src/enrichment/engine.ts`** — `EnrichmentEngine` orchestrator:

   ```typescript
   class EnrichmentEngine {
     constructor(private db: HiveDatabase, private llm?: LLMProvider) {}
     register(provider: EnrichmentProvider): void;
     async enrichEntity(entityId: string): Promise<EnrichmentResult[]>;
     async enrichBatch(filter: BatchFilter): Promise<BatchResult>;
   }
   ```

4. **New file: `src/enrichment/providers/classify.ts`** — Rule-based classifier (no LLM):
   - Detects domain from content patterns (code, meetings, decisions).
   - Adds `"high-signal"` tag when reactions >= 5 or reply count >= 10.
   - Adds `"time-sensitive"` tag when content matches deadline patterns.
   - Sets `attributes._enrichedAt` and `attributes._enrichedBy`.

5. **New file: `src/enrichment/providers/llm-enrich.ts`** — LLM-backed enrichment:
   - Extracts one-line summary → `attributes.summary`.
   - Classifies topic/domain when rule-based is uncertain.
   - Infers person name aliases (e.g., `@moon` → `Moon Seokhoon`).
   - No-op when LLM provider is not configured.

6. **New file: `src/enrichment/providers/topic-stitch.ts`** — Topic stitching batch job:
   - Finds semantically related entities via FTS5 keyword overlap (pre-filter).
   - Optional LLM similarity scoring for borderline pairs (>0.4 keyword overlap but <0.7).
   - Creates `"related"` synapses between topically linked entities.
   - Runs as a separate batch step, not per-entity enrichment.
   - Configurable: `CORTEX_TOPIC_STITCH=on|off` (default: `off`).

7. **LLM provider abstraction** — `src/enrichment/llm/`:
   - `src/enrichment/llm/openai.ts` — OpenAI provider (raw `fetch`, no SDK).
   - `src/enrichment/llm/anthropic.ts` — Anthropic provider (raw `fetch`, no SDK).
   - `src/enrichment/llm/ollama.ts` — Ollama provider (local, raw `fetch`).
   - `src/enrichment/llm/index.ts` — factory function `createLLMProvider()` from env vars.

8. **Evaluation dataset** — `src/enrichment/eval/`:
   - `eval-dataset.json` — 50+ labeled entity samples with expected enrichment output.
   - `eval.ts` — harness: run enrichment on dataset, compute precision/recall on tags, domain, summary quality.
   - `eval-report.md` — baseline results (filled in during implementation).

9. **Config environment variables:**
   - `CORTEX_ENRICHMENT` — `"rule"` | `"llm"` | `"off"` (default: `"rule"`)
   - `CORTEX_LLM_PROVIDER` — `"openai"` | `"anthropic"` | `"ollama"` (default: `"openai"`)
   - `CORTEX_LLM_MODEL` — model name (default: `"gpt-4o-mini"`)
   - `CORTEX_LLM_API_KEY` — API key for OpenAI or Anthropic
   - `CORTEX_LLM_BASE_URL` — base URL override (for Ollama: `"http://localhost:11434"`)
   - `CORTEX_LLM_MAX_TOKENS` — max tokens per LLM call (default: `500`)
   - `CORTEX_ENRICHMENT_BATCH_ID` — opaque string stamped on enriched entities for rollback

10. **Integration into CortexStore:**
    ```typescript
    // In store.ts
    this.enrichmentEngine = new EnrichmentEngine(this.db, createLLMProvider());
    this.enrichmentEngine.register(new ClassifyProvider());
    if (CORTEX_ENRICHMENT === "llm") {
      this.enrichmentEngine.register(new LLMEnrichProvider(this.enrichmentEngine.llm!));
    }
    async enrichEntity(id: string): Promise<void>;
    async enrichBatch(opts: BatchFilter): Promise<BatchResult>;
    ```

11. **New MCP tool: `context_enrich`** — registered in `src/tools/context-tools.ts`:
    ```
    context_enrich(scope, entityId?, entityType?, since?, limit?)
    → { processed, enriched, errors, batchId, sample: Entity[] }
    ```

12. **CLI command:** `hive-memory enrich [--since DATE] [--type TYPE] [--limit N] [--batch-id ID]`

### Out of Scope

- Specific extraction providers (decision extraction, action items) — those are `decision-action-extraction` change.
- Embedding/vector generation — staying with FTS5 + keyword search.
- Streaming LLM responses.
- Cost tracking / token budget management.
- MCP-over-MCP patterns — all enrichment accesses HiveDatabase directly.

## Devil's Advocate Review

**Risk: Direct HiveDatabase access couples enrichment to SQLite schema.**
Mitigation: EnrichmentContext exposes `db: HiveDatabase` which already has a stable API. Schema changes go through `schema.ts` version bump — enrichment is already coupled to entity types. This is acceptable coupling at Layer 2.

**Risk: Enrichment batch job rewrites attributes, losing original connector data.**
Mitigation: Enrichment only *merges* into `attributes` — it never replaces the whole object. `_enrichedAt`, `_enrichedBy`, `_batchId` keys are namespaced with `_` prefix. Rollback uses `_batchId` to identify and revert enriched fields.

**Risk: Topic stitching creates too many low-quality `related` synapses.**
Mitigation: Topic stitching is `off` by default. Keyword overlap pre-filter is aggressive (>0.4 Jaccard on top-5 keywords). LLM confirmation gate further reduces false positives. Users opt-in explicitly.

**Risk: 2-week budget is tight for all LLM providers + eval dataset.**
Mitigation: Week 1 delivers rule-based only (ClassifyProvider + engine). Week 2 delivers LLM providers + topic stitching + eval. LLM provider abstraction is 3 thin files (~50 lines each). Eval dataset creation is structured work, not research.

## Acceptance Criteria

1. `EnrichmentEngine.enrichBatch({ unenrichedOnly: true })` processes all un-enriched entities through registered providers in priority order; each processed entity has `attributes._enrichedAt` set.
2. `ClassifyProvider` correctly tags a Slack conversation with 10+ replies as `"high-signal"` and a GitHub PR with code content as `domain: "code"`, without LLM calls.
3. When `CORTEX_LLM_PROVIDER=anthropic`, `LLMEnrichProvider` calls Anthropic API via `fetch` and writes `attributes.summary`.
4. When `CORTEX_ENRICHMENT=rule` (default), engine runs only rule-based providers with no LLM calls.
5. `context_enrich` MCP tool returns correct counts and a sample of enriched entities.
6. Eval harness runs against 50+ labeled samples and reports precision/recall baseline.
7. Re-enriching an entity with the same `_batchId` is a no-op (idempotent).

## Impact

- **New directory:** `src/enrichment/` (~9 files, ~750 lines total)
- **New file:** `src/tools/context-tools.ts` (~70 lines)
- **Modified:** `src/store.ts` — add enrichment engine init + methods (~35 lines)
- **Modified:** `src/tools/index.ts` — register context tools
- **Modified:** `src/cli.ts` — add `enrich` subcommand
- **No new npm dependencies** (uses raw `fetch` for LLM API calls)
- **No schema changes** (enrichment writes to existing `attributes` JSON column + `synapses` table)
