# Requirements: decision-action-extraction

## Functional Requirements

### REQ-DAE-01: EnrichmentProvider Implementation

- MUST implement `EnrichmentProvider` interface from `src/enrichment/types.ts`.
- MUST set `id = "decision-extractor"`, `priority = 50` (runs before `classify` at 100 and `llm-enrich` at 200).
- MUST set `applicableTo = ["conversation", "message", "document", "meeting"]`.
- `shouldEnrich(entity)` MUST return `false` when:
  - `entity.attributes._decisionsExtracted === true`
  - `entity.content.length < 50`
  - Neither `hasDecisionSignals(entity)` nor `hasActionSignals(entity)` returns true.
- `shouldEnrich(entity)` MUST return `true` when content matches at least one decision or action signal pattern.

### REQ-DAE-02: Rule-Based Signal Detection

- MUST define `DECISION_SIGNALS` as an array of at least 10 regex patterns, including:
  - `/we('re| are) going (with|to)/i`
  - `/decided (to|on|that)/i`
  - `/decision\s*:/i`
  - `/approved/i`
  - `/agreed (to|on|that)/i`
  - `/consensus\s*:/i`
- MUST define `ACTION_SIGNALS` as an array of at least 8 regex patterns, including:
  - `/action item\s*:/i`
  - `/\[ \]/` (unchecked checkbox)
  - `/assigned to/i`
  - `/by (monday|tuesday|wednesday|thursday|friday|eow|eod)/i`
  - `/deadline/i`
- Signal detection MUST be case-insensitive.
- Signal detection MUST NOT make any I/O calls.

### REQ-DAE-03: LLM Extraction

- MUST call `ctx.llm.extract<ExtractionOutput>()` when `ctx.llm` is defined AND rule signals fire.
- Prompt template MUST request both `decisions[]` and `actions[]` in a single LLM call.
- Each extracted decision MUST have: `summary: string`, `context: string`, `alternatives: string[]`, `confidence: "explicit" | "implicit"`.
- Each extracted action MUST have: `description: string`, `owner: string | null`, `deadline: string | null`, `status: "open" | "in-progress" | "done"`.
- MUST gracefully handle LLM response parse failure: log warning, fall back to rule-based extraction.
- MUST set `attributes._extractionMethod: "llm"` on extracted entities when LLM was used.

### REQ-DAE-04: Rule-Based Fallback (No LLM)

- MUST run when `ctx.llm` is undefined.
- MUST extract lines matching `DECISION_SIGNALS` as decision entities with simple content.
- MUST extract lines matching `ACTION_SIGNALS` as task entities with simple content.
- MUST set `attributes._extractionMethod: "rule-based"` on extracted entities.
- Rule-based extracted entities MUST have `confidence: "inferred"` (lower than LLM-extracted).

### REQ-DAE-05: Decision Entity Creation

- MUST create `EntityDraft` with `entityType: "decision"` for each extracted decision.
- MUST set `title = decision.summary`.
- MUST set `content = "Decision: {summary}\n\nContext: {context}\n\nAlternatives considered: {alternatives.join(', ')}"`.
- MUST set `domain` from source entity's domain.
- MUST set `tags = ["decision", "extracted", sourceEntityType]`.
- MUST set `attributes = { extractedFrom, decisionConfidence, alternatives, _extractedBy: "decision-extractor", _extractionMethod }`.
- MUST set `source.externalId = "ce:decision:{sourceEntity.id}:{index}"` (index = 0-based position in extracted array).
- MUST set `source.system = "context-engine"`.
- MUST set `confidence = "inferred"`.

### REQ-DAE-06: Task Entity Creation

- MUST create `EntityDraft` with `entityType: "task"` for each extracted action item.
- MUST set `title = action.description`.
- MUST set `content = "Action: {description}\nOwner: {owner ?? 'unassigned'}\nDeadline: {deadline ?? 'none'}\nStatus: {status}"`.
- MUST set `domain` from source entity's domain.
- MUST set `tags = ["action-item", "extracted", sourceEntityType]`.
- MUST set `attributes = { extractedFrom, owner, deadline, actionStatus, _extractedBy: "decision-extractor", _extractionMethod }`.
- MUST set `source.externalId = "ce:action:{sourceEntity.id}:{index}"`.
- MUST set `confidence = "inferred"`.

### REQ-DAE-07: Synapse Creation

- MUST include in `EnrichmentResult.synapses`:
  - Source entity `--derived-->` each extracted decision entity.
  - Source entity `--derived-->` each extracted task entity.
- MUST attempt owner resolution: call `ctx.db.getEntityByExternalId("gcal:person:{owner}")` or search by name. If found, add synapse: person `--authored-->` task.
- MUST NOT fail if owner resolution finds no match — owner field remains as string attribute.
- MUST set `weight = 1.0` for `derived` synapses.

### REQ-DAE-08: Idempotency

- MUST stamp `attributes._decisionsExtracted = true` on the source entity after successful extraction.
- `shouldEnrich()` MUST check for this flag and return `false` to prevent re-extraction.
- Re-running `enrichBatch` on an already-processed entity MUST be a no-op for this provider.
- Entity deduplication is handled by `EnrichmentEngine` via `source.externalId` upsert in `db.upsertEntity()`.

### REQ-DAE-09: Evaluation

- MUST include `src/enrichment/eval/decision-eval-dataset.json` with 20+ labeled samples.
- Each sample MUST have: `entityContent`, `entityType`, `expectedDecisions: number`, `expectedActions: number`, `expectedSignalsFound: boolean`.
- MUST add eval script entry to `package.json`: `"eval:decisions": "npx tsx src/enrichment/eval/decision-eval.ts"`.
- Rule-based eval MUST achieve precision >= 0.75 (true signals identified / signals flagged) on the dataset.

## Non-Functional Requirements

- MUST NOT add new npm dependencies.
- MUST follow patterns from `src/enrichment/providers/classify.ts` (established in enrichment-framework).
- Rule-based `shouldEnrich()` MUST complete in < 1ms per entity (regex tests only).
- LLM extraction MUST complete in < 30 seconds per entity (single LLM call with max 1000 tokens).
- MUST be testable without LLM credentials (all LLM paths guarded by provider availability).
- MUST handle entities with content up to 100,000 characters (truncate to 8,000 tokens before LLM call).
