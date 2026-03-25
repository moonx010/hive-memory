# Requirements: enrichment-framework

## Functional Requirements

### REQ-ENR-01: EnrichmentProvider Interface

- MUST define `EnrichmentProvider` interface in `src/enrichment/types.ts` with:
  - `id: string` — unique provider identifier
  - `name: string` — human-readable name
  - `applicableTo: EntityType[]` — which entity types this provider handles
  - `priority: number` — execution order (lower runs first)
  - `shouldEnrich(entity: Entity): boolean` — fast pre-check (no I/O)
  - `enrich(entity: Entity, ctx: EnrichmentContext): Promise<EnrichmentResult>` — main logic
- MUST define `EnrichmentContext` with:
  - `db: HiveDatabase` — direct in-process database reference (NOT MCP-over-MCP)
  - `findRelated(query, opts?)` — convenience wrapper over FTS5 search
  - `llm?: LLMProvider` — optional, only present when LLM is configured
- MUST define `EnrichmentResult` as a partial update object: `attributes`, `tags`, `keywords`, `synapses`, `aliases`, `derivedEntities` (all optional).
- MUST define `LLMProvider` interface with `complete()` and `extract<T>()` methods.

### REQ-ENR-02: EnrichmentEngine Orchestrator

- MUST register multiple `EnrichmentProvider` instances and sort them by `priority` at registration time.
- MUST implement `enrichEntity(entityId: string)`:
  - Load entity from `HiveDatabase` by ID.
  - Run `shouldEnrich()` for each provider; skip if false.
  - Call `enrich()` in priority order; merge results into entity attributes.
  - Persist merged attributes, new tags, new keywords to database.
  - Persist derived entities via `db.upsertEntity()`.
  - Persist synapses via `db.upsertSynapse()`.
  - Stamp `attributes._enrichedAt = ISO8601` and `attributes._enrichedBy: string[]` (list of provider IDs that ran).
- MUST implement `enrichBatch(filter: BatchFilter)`:
  - `filter.entityType?: EntityType[]` — only process these types
  - `filter.since?: string` — only entities `updated_at > since`
  - `filter.unenrichedOnly?: boolean` — skip entities where `attributes._enrichedAt` exists
  - `filter.limit?: number` — max entities to process (default: 100)
  - Return `{ processed: number; enriched: number; errors: number; batchId: string }`.
- MUST stamp `attributes._batchId` on each enriched entity for rollback identification.
- MUST be idempotent: running `enrichBatch` twice with the same `batchId` does not double-enrich.

### REQ-ENR-03: RuleBasedEnricher (ClassifyProvider)

- MUST implement `EnrichmentProvider` with `id = "classify"`, `priority = 100`.
- MUST apply `applicableTo` = all entity types (wildcard).
- MUST detect domain from content using patterns:
  - Content matches code patterns (`function`, `class`, `import`, `const`, ` = >`): set `domain: "code"`.
  - Content matches meeting patterns (`attendees`, `agenda`, `minutes`, `standup`): set `domain: "meetings"`.
  - Content matches decision patterns (`decided`, `approved`, `resolved`): add tag `"decision"`.
- MUST add `"high-signal"` tag when:
  - `attributes.reactions >= 5` (Slack reaction count), OR
  - `attributes.replyCount >= 10`, OR
  - `attributes.commentCount >= 10` (GitHub).
- MUST add `"time-sensitive"` tag when content matches: `deadline`, `due by`, `due date`, `by EOD`, `by Friday`, `by (Monday|Tuesday|Wednesday|Thursday|Friday)`.
- MUST NOT make any I/O calls (no `fetch`, no DB reads beyond what is passed in `entity`).
- MUST NOT make LLM calls.
- MUST set `attributes._enrichedAt` and append `"classify"` to `attributes._enrichedBy`.

### REQ-ENR-04: LLMEnricher (LLMEnrichProvider)

- MUST implement `EnrichmentProvider` with `id = "llm-enrich"`, `priority = 200`.
- MUST be a no-op (`shouldEnrich()` returns `false`) when `ctx.llm` is undefined.
- MUST extract a one-line summary via LLM prompt → `attributes.summary` (max 100 chars).
- MUST classify `domain` when `attributes.domain` is `"unknown"` or missing.
- MUST NOT run on entities with `content.length < 100` (too short for meaningful summarization).
- MUST set `attributes._llmModel` to the model name used for extraction.
- MUST handle LLM rate limit (429) by waiting and retrying up to 3 times before marking entity with `attributes._llmError`.

### REQ-ENR-05: LLM Provider Abstraction

- MUST implement `LLMProvider` interface for three backends:
  - **OpenAI**: POST to `https://api.openai.com/v1/chat/completions` with `gpt-4o-mini` default.
  - **Anthropic**: POST to `https://api.anthropic.com/v1/messages` with `claude-haiku-4-5` default.
  - **Ollama**: POST to `{CORTEX_LLM_BASE_URL}/api/chat` (default: `http://localhost:11434`).
- MUST use Node.js built-in `fetch` only — NO SDK dependencies.
- MUST implement `extract<T>(prompt, schema)` as a JSON-mode completion: append schema to prompt and parse response.
- Factory function `createLLMProvider()` in `src/enrichment/llm/index.ts`:
  - Reads `CORTEX_LLM_PROVIDER`, `CORTEX_LLM_MODEL`, `CORTEX_LLM_API_KEY`, `CORTEX_LLM_BASE_URL`.
  - Returns `undefined` when `CORTEX_ENRICHMENT=rule` or `CORTEX_ENRICHMENT=off`.

### REQ-ENR-06: Batch Processing Pipeline

- MUST support `CORTEX_ENRICHMENT=off` — engine is initialized but no providers are registered; all `enrichBatch` calls return `{ processed: 0, enriched: 0, errors: 0 }`.
- MUST support `CORTEX_ENRICHMENT=rule` — only `ClassifyProvider` is registered (default).
- MUST support `CORTEX_ENRICHMENT=llm` — both `ClassifyProvider` and `LLMEnrichProvider` are registered.
- MUST process entities in batches of 50 to avoid holding large result sets in memory.
- MUST log progress: `"[enrichment] processed {n}/{total} entities"` every 50 entities.

### REQ-ENR-07: Topic Stitching Batch Job

- MUST implement `TopicStitchProvider` in `src/enrichment/providers/topic-stitch.ts`.
- MUST run as a standalone batch job (NOT as a per-entity enrichment provider).
- MUST use FTS5 keyword overlap as pre-filter:
  - Extract top-5 keywords from each entity's `keywords` array.
  - Compute Jaccard similarity between keyword sets.
  - Only consider pairs with Jaccard >= 0.4.
- MUST create `"related"` synapses between qualifying entity pairs with `weight = jaccard_score`.
- MUST be disabled by default (`CORTEX_TOPIC_STITCH=off`).
- MUST be idempotent: existing `"related"` synapses are not duplicated.
- LLM similarity scoring is OPTIONAL (runs when `CORTEX_LLM_PROVIDER` is set and Jaccard is 0.4–0.7).

### REQ-ENR-08: Evaluation Dataset

- MUST include `src/enrichment/eval/eval-dataset.json` with 50+ labeled samples.
- Each sample MUST have: `{ entityId: string, entityContent: string, entityType: string, expected: EnrichmentResult }`.
- MUST implement eval harness `src/enrichment/eval/eval.ts`:
  - Run `ClassifyProvider` on each sample.
  - Compute precision/recall for tags and domain classification.
  - Print summary table to stdout.
- Baseline precision MUST be >= 0.80 on the 50-sample dataset before merge.

### REQ-ENR-09: Enrichment Batch ID and Rollback

- MUST stamp `attributes._batchId` on each entity enriched in a batch run.
- MUST expose `enrichBatch()` return value including `batchId`.
- MUST provide a mechanism to identify all entities enriched in a given batch (query by `attributes._batchId`).
- Rollback of enriched fields is NOT automatically implemented in v1 — `_batchId` enables manual identification for rollback.

### REQ-ENR-10: MCP Tool — `context_enrich`

- MUST register `context_enrich` tool in `src/tools/context-tools.ts`.
- MUST accept parameters: `scope` (`"entity"` | `"batch"`), `entityId?`, `entityType?`, `since?`, `limit?`.
- MUST return: `{ processed, enriched, errors, batchId, sample: Entity[] }` where `sample` is the first 5 enriched entities.
- MUST be registered in `src/tools/index.ts`.

## Non-Functional Requirements

- MUST NOT add npm dependencies (all HTTP via built-in `fetch`).
- MUST follow TypeScript patterns established in `src/connectors/types.ts` and `src/db/database.ts`.
- MUST complete rule-based `enrichBatch` of 1,000 entities in under 10 seconds.
- MUST complete LLM `enrichBatch` of 100 entities in under 5 minutes (sequential, one LLM call per entity).
- MUST be testable without LLM credentials (all LLM-dependent paths guarded by provider availability).
