# Tasks: enrichment-framework

**Phase:** A (parallel with calendar-connector)
**Estimated effort:** 2 weeks
**Dependencies:** None

## Week 1: Core Interfaces + Engine + Rule-Based Provider + Eval

- [x] **TASK-ENR-01**: Create `src/enrichment/types.ts`
  - Define `EnrichmentProvider`, `EnrichmentContext`, `EnrichmentResult`, `LLMProvider` interfaces
  - Define `SynapseDraft`, `AliasDraft`, `EntityDraft`, `BatchFilter`, `BatchResult` types
  - Export all types; import `HiveDatabase` from `../db/database.js` for `EnrichmentContext.db`
  - No runtime logic — pure type definitions only

- [x] **TASK-ENR-02**: Implement `EnrichmentEngine` in `src/enrichment/engine.ts`
  - Constructor: `(db: HiveDatabase, llm?: LLMProvider)`
  - `register(provider)`: push to sorted array (sort by `priority` ascending after each insert)
  - `enrichEntity(entityId)`: load entity → run providers in order → apply results → stamp `_enrichedAt` + `_enrichedBy`
  - `applyResult(entity, result)` private helper: call `db.updateEntityAttributes`, `db.addEntityTags`, `db.upsertSynapse`, `db.upsertEntity` as needed
  - `enrichBatch(filter)`: generate `batchId` via `randomUUID()`, query entities via `db.listEntities(filter)`, call `enrichEntity` for each, stamp `_batchId`, log every 50
  - Return `BatchResult` from `enrichBatch`

- [x] **TASK-ENR-03**: Add tests for `EnrichmentEngine`
  - Test: provider runs in priority order (lower priority number first)
  - Test: `enrichEntity` stamps `_enrichedAt` on entity attributes
  - Test: `enrichBatch` with `unenrichedOnly: true` skips entities that already have `_enrichedAt`
  - Test: provider throwing does not crash batch — increments `errors` count
  - Test: `enrichBatch` returns correct `{ processed, enriched, errors, batchId }`

- [x] **TASK-ENR-04**: Implement `ClassifyProvider` in `src/enrichment/providers/classify.ts`
  - Define `CODE_PATTERNS`, `MEETING_PATTERNS`, `DECISION_PATTERNS`, `TIME_SENSITIVE_PATTERNS` arrays
  - `shouldEnrich(entity)`: return `entity.content.length >= 20`
  - `enrich(entity, _ctx)`: test content against patterns; build `attributes` (domain) and `tags` (high-signal, time-sensitive, decision)
  - Signal strength: read `entity.attributes.reactions`, `entity.attributes.replyCount`, `entity.attributes.commentCount`
  - Zero I/O in this provider — no db calls, no fetch

- [x] **TASK-ENR-05**: Add tests for `ClassifyProvider`
  - Test: Slack message with 15 replies → tag `"high-signal"`
  - Test: PR content with `function`, `class` keywords → `domain: "code"`
  - Test: content with `"decided to use PostgreSQL"` → tag `"decision"`
  - Test: content with `"due by Friday"` → tag `"time-sensitive"`
  - Test: content with meeting patterns → `domain: "meetings"`
  - Test: content with fewer than 20 chars → `shouldEnrich` returns `false`

- [x] **TASK-ENR-06**: Create evaluation dataset `src/enrichment/eval/eval-dataset.json`
  - Create 50+ sample objects with fields: `entityContent`, `entityType`, `expectedTags`, `expectedDomain`
  - Mix of: code snippets (10), Slack messages with signals (10), meeting notes (10), decisions (10), neutral content (10+)
  - Label each sample with expected `ClassifyProvider` output
  - Format:
    ```json
    [
      {
        "id": "sample-001",
        "entityContent": "We decided to use PostgreSQL...",
        "entityType": "message",
        "attributes": { "replyCount": 12 },
        "expectedTags": ["decision", "high-signal"],
        "expectedDomain": null
      }
    ]
    ```

- [x] **TASK-ENR-07**: Implement evaluation harness `src/enrichment/eval/eval.ts`
  - Load `eval-dataset.json`
  - For each sample, construct a mock `Entity` and run `ClassifyProvider.enrich()`
  - Compute tag precision, tag recall, domain accuracy
  - Print results table to stdout
  - Exit with code 1 if tag precision < 0.80
  - Add to `package.json` scripts: `"eval:enrichment": "npx tsx src/enrichment/eval/eval.ts"`

## Week 2: LLM Providers + Topic Stitch + Integration

- [x] **TASK-ENR-08**: Implement `LLMEnrichProvider` in `src/enrichment/providers/llm-enrich.ts`
  - `shouldEnrich(entity)`: return `false` if `ctx.llm` is undefined OR `entity.content.length < 100`
  - `enrich(entity, ctx)`: call `ctx.llm.extract()` with summary extraction prompt and schema `{ summary: string, domain: string | null }`
  - Write `attributes.summary` (max 100 chars) and optionally update domain
  - Write `attributes._llmModel` from `ctx.llm.model`
  - Handle 429 with retry (max 3 attempts, 2s backoff) — write `attributes._llmError` on final failure

- [x] **TASK-ENR-09**: Implement `OpenAIProvider` in `src/enrichment/llm/openai.ts`
  - Constructor: `(apiKey: string, model = "gpt-4o-mini")`
  - `complete(prompt, opts)`: POST to `https://api.openai.com/v1/chat/completions` using `fetch`
  - Request body: `{ model, messages: [{ role: "user", content: prompt }], max_tokens, temperature }`
  - Parse `choices[0].message.content` from response
  - Throw `LLMError` (custom error class with `status` field) on non-200 responses
  - `extract<T>(prompt, schema)`: append JSON schema instruction, call `complete()`, parse JSON from response

- [x] **TASK-ENR-10**: Implement `AnthropicProvider` in `src/enrichment/llm/anthropic.ts`
  - Constructor: `(apiKey: string, model = "claude-haiku-4-5")`
  - `complete(prompt, opts)`: POST to `https://api.anthropic.com/v1/messages` using `fetch`
  - Headers: `x-api-key: {apiKey}`, `anthropic-version: 2023-06-01`, `content-type: application/json`
  - Request body: `{ model, max_tokens, messages: [{ role: "user", content: prompt }] }`
  - Parse `content[0].text` from response
  - Handle rate limits (429) with retry

- [x] **TASK-ENR-11**: Implement `OllamaProvider` in `src/enrichment/llm/ollama.ts`
  - Constructor: `(baseUrl = "http://localhost:11434", model = "llama3")`
  - `complete(prompt, opts)`: POST to `{baseUrl}/api/chat` using `fetch`
  - Request body: `{ model, messages: [{ role: "user", content: prompt }], stream: false }`
  - Parse `message.content` from response

- [x] **TASK-ENR-12**: Implement `createLLMProvider()` factory in `src/enrichment/llm/index.ts`
  - Read env vars: `CORTEX_ENRICHMENT`, `CORTEX_LLM_PROVIDER`, `CORTEX_LLM_MODEL`, `CORTEX_LLM_API_KEY`, `CORTEX_LLM_BASE_URL`
  - Return `undefined` if `CORTEX_ENRICHMENT !== "llm"`
  - Dispatch to appropriate provider class based on `CORTEX_LLM_PROVIDER`
  - Throw clear error for unknown provider values

- [x] **TASK-ENR-13**: Implement `TopicStitcher` in `src/enrichment/providers/topic-stitch.ts`
  - `stitchBatch(opts)`: load candidate entities, compute pairwise Jaccard on top-5 keywords
  - Filter pairs with Jaccard >= `minJaccard` (default 0.4)
  - Optional LLM confirmation for pairs 0.4–0.7 (when `this.llm` is defined)
  - Call `db.upsertSynapse` for qualifying pairs with `axon: "related"`
  - Return `StitchResult: { candidates, pairs, linked }`
  - Guard with `CORTEX_TOPIC_STITCH=on` env var check

- [x] **TASK-ENR-14**: Integrate `EnrichmentEngine` into `src/store.ts`
  - Import `EnrichmentEngine`, `ClassifyProvider`, `LLMEnrichProvider`, `createLLMProvider`
  - In `CortexStore` constructor: initialize engine, register providers based on `CORTEX_ENRICHMENT` env var
  - Add `enrichEntity(id)` and `enrichBatch(opts)` public methods that delegate to engine
  - Ensure engine is initialized AFTER `this.db` is ready

- [x] **TASK-ENR-15**: Create `src/tools/context-tools.ts`
  - Implement `registerContextTools(server, store)` function
  - Register `context_enrich` tool with Zod schema validation
  - Handle both `scope: "entity"` and `scope: "batch"` paths
  - Return `{ processed, enriched, errors, batchId, sample }` JSON response

- [x] **TASK-ENR-16**: Register context tools in `src/tools/index.ts`
  - Import `registerContextTools` from `./context-tools.js`
  - Call `registerContextTools(server, store)` in tool registration function

- [x] **TASK-ENR-17**: Add `enrich` subcommand to `src/cli.ts`
  - Parse flags: `--since DATE`, `--type TYPE`, `--limit N`, `--batch-id ID`
  - Call `store.enrichBatch({ since, entityType, limit })`
  - Print result: `"Enriched {enriched}/{processed} entities (batchId: {batchId})"`
  - Add to help text

- [x] **TASK-ENR-18**: Add integration test for LLM provider (mocked)
  - Mock `fetch` globally in test to return a canned OpenAI response
  - Run `LLMEnrichProvider` on a sample entity
  - Assert `attributes.summary` is set and under 100 chars
  - Assert `fetch` was called with correct endpoint and headers
