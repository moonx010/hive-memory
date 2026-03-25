# Tasks: enrichment-pipeline-stages

**Estimated effort:** 4 days
**Dependencies:** enrichment-framework, content-hash-dedup

## Day 1: Types + Provider Annotations

- [ ] **TASK-STAGE-01**: Define EnrichmentStage type and constants
  - Add `EnrichmentStage = "classify" | "extract" | "stitch" | "resolve"` to `src/enrichment/types.ts`
  - Add `STAGE_ORDER` array defining execution order
  - Add `STAGE_TIMESTAMP_KEYS` mapping stage → attribute key
  - Add `stage: EnrichmentStage` to `EnrichmentProvider` interface
  - Add `stage?: EnrichmentStage` to `BatchFilter` interface

- [ ] **TASK-STAGE-02**: Annotate existing providers with stage field
  - `ClassifyProvider`: add `readonly stage = "classify"`
  - `DecisionExtractorProvider`: add `readonly stage = "extract"`
  - `LLMEnrichProvider`: add `readonly stage = "extract"`
  - `TopicStitchProvider`: add `readonly stage = "stitch"` (adapt from standalone to provider if needed)
  - `EntityResolver`: add `readonly stage = "resolve"` (adapt to provider interface if needed)

## Day 2: Engine Refactor

- [ ] **TASK-STAGE-03**: Add stage filtering to enrichEntity()
  - Accept optional `stage?: EnrichmentStage` parameter
  - Skip providers whose `stage` doesn't match requested stage
  - Stamp per-stage completion timestamp (e.g., `_classifiedAt`, `_extractedAt`)
  - When no stage specified, run all providers (backward compatible)
  - Add `getProviderStage(providerId)` private helper

- [ ] **TASK-STAGE-04**: Add stage filtering to enrichBatch()
  - Pass `filter.stage` through to `enrichEntity()` calls
  - When `stage` is specified, don't require `unenrichedOnly` (allow re-running specific stage)
  - Log stage name in batch progress messages

## Day 3: Tool + UI Integration

- [ ] **TASK-STAGE-05**: Add stage parameter to context_enrich tool
  - Add `stage: z.enum(["classify", "extract", "stitch", "resolve"]).optional()` to tool schema
  - Pass `stage` to `enrichEntity()` and `enrichBatch()`
  - Include stage in response JSON

- [ ] **TASK-STAGE-06**: Show enrichment stage status in memory_inspect
  - In `src/tools/browse-tools.ts`, add "Enrichment Status" section
  - Display table with stage name and completion timestamp for each stage
  - Show "Pending" for stages that haven't completed
  - Show enrichedBy provider list

- [ ] **TASK-STAGE-07**: Add --stage flag to CLI enrich command
  - In `src/cli.ts`, add `--stage classify|extract|stitch|resolve` option
  - Pass through to `enrichBatch({ stage })`
  - Show stage in output message: `"Enriched {n} entities (stage: classify)"`

## Day 4: Tests

- [ ] **TASK-STAGE-08**: Unit tests for stage filtering
  - Test: `enrichEntity(id, { stage: "classify" })` only runs ClassifyProvider
  - Test: `enrichEntity(id, { stage: "extract" })` only runs LLMEnrich + DecisionExtractor
  - Test: `enrichEntity(id)` (no stage) runs all providers
  - Test: `_classifiedAt` is set after classify stage runs
  - Test: `_extractedAt` is set after extract stage runs

- [ ] **TASK-STAGE-09**: Integration tests for stage-based batch
  - Test: `enrichBatch({ stage: "classify" })` processes entities through classify only
  - Test: entities have `_classifiedAt` but not `_extractedAt` after classify-only batch
  - Test: subsequent `enrichBatch({ stage: "extract" })` runs extract on same entities
  - Test: backward compatibility — `enrichBatch({})` runs all stages
  - Test: `enrichBatch({ stage: "classify", unenrichedOnly: false })` re-classifies all entities
