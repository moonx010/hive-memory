# Tasks: decision-action-extraction

**Phase:** B (starts after enrichment-framework is complete)
**Estimated effort:** 1 week
**Dependencies:** `enrichment-framework` (EnrichmentProvider interface, EnrichmentEngine)

## Implementation Tasks

- [ ] **TASK-DAE-01**: Create `src/enrichment/providers/decision-extractor.ts` skeleton
  - Define `DecisionExtractorProvider` class implementing `EnrichmentProvider` from `../types.js`
  - Set `id = "decision-extractor"`, `priority = 50`, `applicableTo = ["conversation", "message", "document", "meeting"]`
  - Stub `shouldEnrich()` and `enrich()` with `throw new Error("not implemented")`
  - Export the class

- [ ] **TASK-DAE-02**: Implement signal pattern arrays
  - Define `DECISION_SIGNALS: RegExp[]` — at least 13 patterns as specified in design
  - Define `ACTION_SIGNALS: RegExp[]` — at least 11 patterns as specified in design
  - Export both arrays (needed by evaluation harness)
  - Add comment explaining the provenance (expanded from `src/connectors/slack.ts` patterns)

- [ ] **TASK-DAE-03**: Implement `shouldEnrich()` method
  - Check `entity.attributes?._decisionsExtracted === true` → return `false`
  - Check `entity.content.length < 50` → return `false`
  - Check `DECISION_SIGNALS.some(p => p.test(entity.content)) || ACTION_SIGNALS.some(p => p.test(entity.content))`
  - Add test: entity with `_decisionsExtracted: true` → `shouldEnrich` returns `false`
  - Add test: entity with short content → `shouldEnrich` returns `false`
  - Add test: entity with "We decided to use PostgreSQL" → `shouldEnrich` returns `true`

- [ ] **TASK-DAE-04**: Implement LLM extraction path
  - Define `ExtractionOutput` interface with `decisions[]` and `actions[]`
  - Define `EXTRACTION_SCHEMA` (JSON schema for `extract<T>()`)
  - Write `EXTRACTION_PROMPT_TEMPLATE` string constant
  - Implement `extractWithLLM(entity, llm)`: truncate content to 8000 chars, call `llm.extract<ExtractionOutput>(prompt, schema)`
  - Wrap in try/catch — on parse failure, log warning and return `{ decisions: [], actions: [] }`
  - Add test: mock `ctx.llm.extract` to return canned response → assert decision entity is in result

- [ ] **TASK-DAE-05**: Implement rule-based fallback extraction
  - Implement `extractWithRules(content)` returning `{ decisions, actions }`
  - Split content into lines, test each line against signal arrays
  - For decision lines: create `ExtractedDecision` with `summary = line.slice(0,200)`, `confidence: "implicit"`, empty `alternatives`
  - For action lines: extract `@handle` via regex for `owner`, no deadline parsing (null)
  - Add test: content "decided to use Redis" → 1 decision extracted
  - Add test: content "Action: @bob will deploy by Friday" → 1 action with `owner: "@bob"`

- [ ] **TASK-DAE-06**: Implement `makeDecisionDraft()` helper
  - Build `EntityDraft` with `entityType: "decision"`, formatted `content`, correct `source.externalId = "ce:decision:{entity.id}:{index}"`
  - Set `tags = ["decision", "extracted", source.entityType]`
  - Set `attributes = { extractedFrom, decisionConfidence, alternatives, _extractedBy, _extractionMethod }`
  - Add test: assert `externalId` format is correct for index 0 and 1

- [ ] **TASK-DAE-07**: Implement `makeActionDraft()` helper
  - Build `EntityDraft` with `entityType: "task"`, formatted `content`, correct `source.externalId = "ce:action:{entity.id}:{index}"`
  - Set `tags = ["action-item", "extracted", source.entityType]`
  - Set `attributes = { extractedFrom, owner, deadline, actionStatus, _extractedBy, _extractionMethod }`
  - Add test: assert `actionStatus` is `"open"` by default

- [ ] **TASK-DAE-08**: Implement `enrich()` orchestration method
  - Dispatch to LLM or rule-based based on `ctx.llm` availability
  - Build `derivedEntities[]` array from decision and action drafts
  - Build `synapses[]` array: source `--derived-->` each derived entity (use `externalId` as temporary target ref)
  - Attempt owner resolution: call `ctx.findRelated(ownerHandle, { entityType: "person", limit: 1 })`, add `authored` synapse if found
  - Return `{ attributes: { _decisionsExtracted: true }, derivedEntities, synapses }`
  - Add test: entity with decision AND action signal → both derived entities in result, plus correct synapses

- [ ] **TASK-DAE-09**: Register `DecisionExtractorProvider` in `src/store.ts`
  - Add `import { DecisionExtractorProvider } from "./enrichment/providers/decision-extractor.js"`
  - In enrichment engine initialization block: `if (enrichMode !== "off") { this._enrichmentEngine.register(new DecisionExtractorProvider()); }`
  - Place registration BEFORE `ClassifyProvider` registration (priority 50 < 100, but registration order shouldn't matter — engine sorts by priority)

- [ ] **TASK-DAE-10**: Create evaluation dataset `src/enrichment/eval/decision-eval-dataset.json`
  - Create 20+ samples covering: explicit decisions (5), implicit decisions (5), action items (5), mixed decision+action (3), no-signal content (2+)
  - Each sample: `{ id, entityContent, entityType, attributes, expectedSignalsFound, expectedDecisions, expectedActions, notes }`
  - Include edge cases: checkbox `[ ]`, `@mention will ...`, `by EOD`, `consensus:`

- [ ] **TASK-DAE-11**: Implement evaluation harness `src/enrichment/eval/decision-eval.ts`
  - Load `decision-eval-dataset.json`
  - For each sample: create mock entity, run `shouldEnrich()` + `extractWithRules()` (rule-based only, no LLM needed)
  - Compute:
    - **Signal precision**: samples where `shouldEnrich` was true AND expected signals = true / total `shouldEnrich=true`
    - **Decision recall**: sum of `min(extracted, expected) / expected` across signal-positive samples
    - **Action recall**: same for actions
  - Print table, exit 1 if precision < 0.75
  - Add to `package.json` scripts: `"eval:decisions": "npx tsx src/enrichment/eval/decision-eval.ts"`

- [ ] **TASK-DAE-12**: End-to-end integration test
  - Create a test entity in the SQLite database with decision/action content
  - Call `store.enrichEntity(entityId)` in a test
  - Assert derived `decision` and `task` entities are created in DB (query by `source_connector = "decision-extractor"`)
  - Assert `derived` synapses exist between source entity and derived entities
  - Assert re-running enrichment is a no-op (entity count doesn't increase)
