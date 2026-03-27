# Plan: enrichment-framework

**Date:** 2026-03-25
**Scope:** 15 new files, 4 modified files
**Estimated complexity:** MEDIUM-HIGH
**Design doc:** `openspec/changes/enrichment-framework/design.md`

---

## Context

The enrichment framework processes stored entities with rule-based classification and optional LLM-backed extraction. It adds metadata (domain, tags, keywords) and infers synapse relationships between entities. The design is fully specified in the openspec doc with code examples for every component.

---

## GAP Analysis: Missing HiveDatabase Methods

The design doc's `EnrichmentEngine.applyResult()` and `enrichBatch()` call several methods that **do not exist** on `HiveDatabase`:

| Method Called in Design | Exists? | Notes |
|---|---|---|
| `db.getEntity(id)` | YES | Returns `Entity \| null` |
| `db.searchEntities(query, opts)` | YES | Signature: `(query: string, options: SearchEntitiesOptions)` |
| `db.listEntities(opts)` | PARTIAL | Exists but missing `unenrichedOnly`, `hasKeywords`, array `entityType` filters |
| `db.updateEntityAttributes(id, attrs)` | **NO** | Need: merge attrs into existing JSON, update `updated_at` |
| `db.addEntityTags(id, tags)` | **NO** | Need: append unique tags to existing JSON array |
| `db.addEntityKeywords(id, keywords)` | **NO** | Need: append unique keywords to existing JSON array |
| `db.upsertSynapse({sourceId, targetId, axon, weight})` | **NO** | Existing `insertSynapse()` requires full `SynapseRecord` with id/timestamps. Need a convenience wrapper. |
| `db.upsertEntity(draft)` | **NO** | Need: create entity from `EntityDraft` shape (auto-generate id, timestamps) |

---

## Design Concerns & Simplifications

1. **`listEntities` filter extensions** -- Adding `unenrichedOnly` and `hasKeywords` and array-typed `entityType` to `ListEntitiesOptions` is the cleanest path. `unenrichedOnly` checks `JSON_EXTRACT(attributes, '$._enrichedAt') IS NULL`. `hasKeywords` checks `keywords != '[]'`. Array `entityType` uses `IN (...)`.

2. **`upsertSynapse` convenience** -- Rather than changing `insertSynapse`, add a new `upsertSynapse(opts)` method that generates UUID + timestamps and delegates to `insertSynapse`.

3. **LLMEnrichProvider.shouldEnrich** -- Design doc shows `shouldEnrich` checking `ctx.llm`, but the interface signature is `shouldEnrich(entity)` with no `ctx` parameter. The engine already gates on `applicableTo`, so `shouldEnrich` should just check `entity.content.length >= 100`. The LLM existence check happens at registration time (`enrichMode === "llm" && llm`).

4. **TopicStitcher is NOT an EnrichmentProvider** -- It has a different interface (`stitchBatch`) and runs separately. This is correct per design.

5. **`searchEntities` adapter** -- `EnrichmentContext.findRelated` wraps `db.searchEntities()`. The current signature is `(query, options)` where `entityType` is a string. The design's `findRelated` passes `entityType` as a single value -- this matches. No change needed.

---

## Task Flow (5 Phases)

### Phase 1: Database Layer Extensions
**Files:** `src/db/database.ts`
**Why first:** Every downstream component depends on these methods.

**TODOs:**
1. Add `updateEntityAttributes(id: string, attributes: Record<string, unknown>): void`
   - Read existing entity, merge attributes via `{ ...existing.attributes, ...attributes }`, call `updateEntity`
   - AC: Method exists, merges (not replaces) attributes, updates `updated_at`

2. Add `addEntityTags(id: string, tags: string[]): void`
   - Read existing entity, dedupe-merge tags, call `updateEntity`
   - AC: Appends new tags without duplicating existing ones

3. Add `addEntityKeywords(id: string, keywords: string[]): void`
   - Same pattern as tags
   - AC: Appends new keywords without duplicating existing ones

4. Add `upsertSynapse(opts: { sourceId: string; targetId: string; axon: string; weight: number; metadata?: Record<string, string> }): void`
   - Generate UUID + timestamps, delegate to `insertSynapse` (which already has ON CONFLICT upsert)
   - AC: Creates synapse with auto-generated id/timestamps; upserts on conflict

5. Add `upsertEntity(draft: { entityType: string; title?: string; content: string; tags: string[]; attributes: Record<string, unknown>; source: { system: string; externalId: string; connector: string }; domain: string; confidence: string }): string`
   - Generate UUID, set timestamps, build full `Entity`, call `insertEntity`, return id
   - AC: Creates entity from draft shape, returns generated id

6. Extend `ListEntitiesOptions` to support `unenrichedOnly?: boolean`, `hasKeywords?: boolean`, `entityType` as `string | string[]`
   - In `listEntities()`: add WHERE conditions for JSON_EXTRACT check and keywords check; handle array entityType with IN clause
   - AC: `listEntities({ unenrichedOnly: true })` returns only entities without `_enrichedAt` attribute; `hasKeywords: true` filters to entities with non-empty keywords array

### Phase 2: Core Enrichment Types + Engine + ClassifyProvider
**Files:** `src/enrichment/types.ts`, `src/enrichment/engine.ts`, `src/enrichment/providers/classify.ts`

**TODOs:**
1. Create `src/enrichment/types.ts` -- pure type definitions per design doc
   - AC: All interfaces exported, no runtime code, compiles clean

2. Create `src/enrichment/engine.ts` -- `EnrichmentEngine` class per design doc
   - `register()`, `enrichEntity()`, `enrichBatch()`, `applyResult()`
   - AC: Providers run in priority order; errors in one provider don't crash batch; stamps `_enrichedAt`/`_enrichedBy`

3. Create `src/enrichment/providers/classify.ts` -- `ClassifyProvider` per design doc
   - Pattern arrays for code/meeting/decision/time-sensitive detection
   - AC: No I/O; correctly tags content matching patterns; `shouldEnrich` returns false for content < 20 chars

### Phase 3: LLM Abstraction + LLMEnrichProvider
**Files:** `src/enrichment/llm/index.ts`, `src/enrichment/llm/openai.ts`, `src/enrichment/llm/anthropic.ts`, `src/enrichment/llm/ollama.ts`, `src/enrichment/providers/llm-enrich.ts`

**TODOs:**
1. Create LLM provider implementations (OpenAI, Anthropic, Ollama) -- all use native `fetch`, no new dependencies
   - Shared `extract<T>()` logic: append JSON schema instruction, parse JSON from response
   - Custom `LLMError` class with status code
   - AC: Each provider calls correct API endpoint with correct headers; extract() parses JSON from markdown code blocks

2. Create `src/enrichment/llm/index.ts` -- `createLLMProvider()` factory
   - Reads `CORTEX_ENRICHMENT`, `CORTEX_LLM_PROVIDER`, `CORTEX_LLM_MODEL`, `CORTEX_LLM_API_KEY`, `CORTEX_LLM_BASE_URL`
   - AC: Returns `undefined` when enrichment mode is not "llm"; throws on unknown provider

3. Create `src/enrichment/providers/llm-enrich.ts` -- `LLMEnrichProvider`
   - Calls `ctx.llm.extract()` for summary + domain classification
   - 429 retry with max 3 attempts, 2s backoff
   - AC: Sets `attributes.summary` (max 100 chars), `attributes._llmModel`; handles failures gracefully

### Phase 4: Topic Stitching + Integration (Store, Tools, CLI)
**Files:** `src/enrichment/providers/topic-stitch.ts`, `src/store.ts`, `src/tools/context-tools.ts`, `src/tools/index.ts`, `src/cli.ts`

**TODOs:**
1. Create `src/enrichment/providers/topic-stitch.ts` -- `TopicStitcher`
   - Jaccard similarity on top-5 keywords, optional LLM confirmation
   - AC: Links entities with Jaccard >= threshold; creates synapses with `axon: "related"`

2. Integrate `EnrichmentEngine` into `src/store.ts`
   - Initialize engine in constructor, register providers based on `CORTEX_ENRICHMENT` env var
   - Add `enrichEntity(id)` and `enrichBatch(opts)` public methods
   - AC: `store.enrichEntity()` and `store.enrichBatch()` delegate to engine; engine initialized after db

3. Create `src/tools/context-tools.ts` -- `context_enrich` MCP tool
   - Register in `src/tools/index.ts`
   - AC: Tool handles both `scope: "entity"` and `scope: "batch"`; returns JSON result

4. Add `enrich` subcommand to `src/cli.ts`
   - Flags: `--since`, `--type`, `--limit`
   - AC: Calls `store.enrichBatch()` and prints result summary

### Phase 5: Tests + Evaluation Harness
**Files:** `tests/enrichment.test.ts`, `src/enrichment/eval/eval-dataset.json`, `src/enrichment/eval/eval.ts`

**TODOs:**
1. Create `tests/enrichment.test.ts`
   - Engine tests: priority ordering, `_enrichedAt` stamping, error handling, batch correctness
   - ClassifyProvider tests: high-signal, code domain, decision tag, time-sensitive, meeting domain, min-length gate
   - LLM provider test (mocked fetch): summary extraction, correct API call
   - AC: All tests pass; covers engine + classify + mocked LLM

2. Create eval dataset (`src/enrichment/eval/eval-dataset.json`) -- 50+ labeled samples
   - AC: Mix of code (10), Slack (10), meeting (10), decision (10), neutral (10+)

3. Create eval harness (`src/enrichment/eval/eval.ts`)
   - Computes tag precision, recall, domain accuracy
   - Exits with code 1 if precision < 0.80
   - Add `"eval:enrichment"` script to `package.json`
   - AC: Runs standalone, prints results table, gate on precision

---

## Guardrails

### Must Have
- Zero new npm dependencies (LLM providers use native `fetch`)
- `CORTEX_ENRICHMENT=off` (default) means no enrichment runs at all
- `CORTEX_ENRICHMENT=rule` means only ClassifyProvider
- `CORTEX_ENRICHMENT=llm` means ClassifyProvider + LLMEnrichProvider
- All existing tests continue to pass
- Enrichment is opt-in, never triggered automatically on insert

### Must NOT Have
- No MCP-over-MCP -- enrichment accesses HiveDatabase directly
- No automatic enrichment on entity insert (only explicit calls via tool/CLI/API)
- No new external service dependencies
- No changes to existing entity schema (attributes JSON is the extension point)

---

## Success Criteria
1. `npm run build` succeeds with no type errors
2. `npm test` passes (all existing + new enrichment tests)
3. `CORTEX_ENRICHMENT=rule hive-memory enrich --limit 10` runs classify on up to 10 entities
4. `context_enrich` MCP tool works for both single entity and batch
5. `npm run eval:enrichment` passes with precision >= 0.80
6. No new npm dependencies added
