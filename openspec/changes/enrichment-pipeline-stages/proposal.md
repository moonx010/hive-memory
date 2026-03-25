# Change: enrichment-pipeline-stages

**Layer:** 2 (Context Engine)
**One-liner:** Split the monolithic `enrichEntity()` call into atomic, resumable pipeline stages (classify, extract, stitch, resolve) with per-stage status tracking and selective re-runs.
**Estimated effort:** 4 days
**Dependencies:** enrichment-framework (existing engine), content-hash-dedup (_enrichedContentHash for dirty detection)
**Priority:** P2

## Design Review

### PM Perspective

**User problem:** The current `enrichEntity()` runs all registered providers sequentially in a single call. If the LLM provider fails mid-batch (rate limit, timeout), there's no way to resume from the failed stage — the entire entity must be re-enriched. For a batch of 500 entities where the LLM provider fails at entity #200, the first 199 entities' classify results are fine but their LLM enrichments are lost. Users must re-run the entire batch.

Additionally, users cannot selectively run specific stages. A user who only wants to re-classify entities (cheap, no LLM) currently must run the full pipeline including expensive LLM calls.

**Success metrics:**
- Failed enrichment can resume from the last successful stage (not from scratch)
- Users can run `context_enrich --stage classify` to run only classification
- Per-stage status visible via `memory_inspect`: shows which stages have completed

**Priority justification:** This is the reliability upgrade for the enrichment pipeline. Without stages, enrichment is all-or-nothing. The Airflow task atomization pattern is proven — every workflow engine uses this for exactly this reason.

### Tech Lead Perspective

**Implementation approach:**
1. Define `EnrichmentStage` type: `"classify" | "extract" | "stitch" | "resolve"`
2. Map existing providers to stages: `ClassifyProvider → classify`, `LLMEnrichProvider → extract`, `TopicStitcher → stitch`, `EntityResolver → resolve`
3. Track per-entity stage completion in attributes: `_stages: { classify: "2026-03-25T...", extract: "2026-03-25T..." }`
4. Add `stage?: EnrichmentStage` filter to `enrichEntity()` and `enrichBatch()` to run only specific stages
5. Add `resume: true` option to skip already-completed stages for an entity

**File changes:**
- `src/enrichment/types.ts` — Add `EnrichmentStage` type, `StageStatus` interface, extend `BatchFilter` with `stage?`
- `src/enrichment/engine.ts` — Refactor `enrichEntity()` to stage-aware execution with resume support
- `src/enrichment/providers/*.ts` — Add `stage` field to each provider
- `src/tools/context-tools.ts` — Add `--stage` parameter to `context_enrich`
- `src/tools/browse-tools.ts` — Show stage status in `memory_inspect`

**Risk assessment:** MEDIUM. This refactors the core enrichment loop. However, it's backward-compatible: without `stage` or `resume` parameters, behavior is identical to current implementation. Each provider already has `priority` ordering which maps naturally to stages.

### Architect Perspective

**System design impact:** This introduces a pipeline-stage abstraction on top of the existing provider system. It does NOT replace providers — it groups them into stages with checkpointing.

**Stage → Provider mapping:**
```
Stage "classify"  → ClassifyProvider (priority 100)
Stage "extract"   → LLMEnrichProvider (priority 200), DecisionExtractorProvider (priority 150)
Stage "stitch"    → TopicStitcher (priority 300)
Stage "resolve"   → EntityResolver (priority 400)
```

**Per-entity stage tracking (in attributes JSON):**
```json
{
  "_stages": {
    "classify": { "completedAt": "2026-03-25T10:00:00Z", "provider": "classify" },
    "extract": { "completedAt": "2026-03-25T10:00:01Z", "provider": "llm-enrich" },
    "stitch": null,
    "resolve": null
  },
  "_enrichedAt": "2026-03-25T10:00:01Z",
  "_enrichedContentHash": "abc123..."
}
```

**Integration points:**
- `EnrichmentProvider.stage` — new required field mapping provider to a stage
- `EnrichmentEngine.enrichEntity(id, { stage?, resume? })` — stage-filtered, resumable execution
- `context_enrich` tool — accepts `stage` parameter
- `enrichBatch()` — accepts `stage` parameter for stage-specific batch runs

### Devil's Advocate

**What could go wrong?**
- Stage ordering assumptions: If a provider in "extract" stage depends on results from "classify" stage (e.g., uses domain classification to select extraction prompt), running "extract" without "classify" could produce wrong results. Mitigation: when running a specific stage, warn if prerequisite stages haven't completed.
- Attribute bloat: `_stages` adds ~200 bytes per entity per pipeline run. For 10k entities, that's 2MB — negligible for SQLite.

**Over-engineering concerns:**
- Is this premature optimization? Current enrichBatch processes entities sequentially and failures just increment the error counter. The entity is simply not enriched and can be retried. Counter: Yes, retry works for single failures. But systematic failures (LLM API down for 10 minutes) lose all classify work done before the LLM stage.
- Could we just catch LLM errors and continue? We already do (line 67-72 in engine.ts). But the entity is then stamped as `_enrichedAt` even though only classify ran. The next `unenrichedOnly: true` batch skips it. Counter: That's exactly the bug stages fix.

**Alternative simpler approaches:**
- Don't track stages per-entity. Instead, run separate batches per stage: `enrichBatch({ stage: "classify" })` followed by `enrichBatch({ stage: "extract" })`. Each batch only runs providers in that stage. This is simpler and achieves selective re-runs without per-entity stage tracking. ACCEPTED as scope reduction — we can add per-entity tracking later.
- Add a `_lastClassifiedAt` / `_lastExtractedAt` attribute per stage instead of a structured `_stages` object. Simpler but less extensible. ACCEPTABLE.

### Consensus Decision

**Go** — with scope adjustment.

**Scope adjustments:**
- Use simple per-stage timestamp attributes (`_classifiedAt`, `_extractedAt`, `_stitchedAt`, `_resolvedAt`) instead of a nested `_stages` object. Simpler to query and filter.
- Add `stage` parameter to `enrichBatch()` and `context_enrich` — stage-filtered batch runs.
- Skip per-entity resume for now (P3). The stage-filtered batch approach covers the main use case.
- Stage dependency validation: warn in logs but don't block execution.

**Implementation order:** Third P2 feature. Can be implemented in parallel with sync-metadata-columns.

## Acceptance Criteria

1. Each `EnrichmentProvider` has a `stage: EnrichmentStage` field.
2. `enrichBatch({ stage: "classify" })` runs only providers in the "classify" stage.
3. After classify-only batch, entities have `_classifiedAt` attribute but NOT `_extractedAt`.
4. `enrichBatch({ stage: "extract" })` runs LLM providers only; skips classify.
5. `context_enrich` MCP tool accepts optional `stage` parameter.
6. `memory_inspect` shows which enrichment stages have completed for an entity.
7. Running `enrichBatch()` without `stage` parameter runs all stages (backward compatible).

## Impact

- **Modified:** `src/enrichment/types.ts` — add `EnrichmentStage`, extend `BatchFilter` (~10 lines)
- **Modified:** `src/enrichment/engine.ts` — stage filtering in `enrichEntity()` and `enrichBatch()` (~25 lines)
- **Modified:** `src/enrichment/providers/classify.ts` — add `stage: "classify"` field (~1 line)
- **Modified:** `src/enrichment/providers/llm-enrich.ts` — add `stage: "extract"` field (~1 line)
- **Modified:** `src/enrichment/providers/decision-extractor.ts` — add `stage: "extract"` field (~1 line)
- **Modified:** `src/enrichment/providers/topic-stitch.ts` — add `stage: "stitch"` field (~1 line)
- **Modified:** `src/enrichment/entity-resolver.ts` — add `stage: "resolve"` field (~1 line)
- **Modified:** `src/tools/context-tools.ts` — add `stage` parameter (~5 lines)
- **Modified:** `src/tools/browse-tools.ts` — show stage status in inspect (~10 lines)
