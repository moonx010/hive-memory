# Change: decision-action-extraction

**Layer:** 2 (Context Engine)
**One-liner:** EnrichmentProvider that extracts decisions and action items from conversations, meetings, and documents, creating structured `decision` and `task` entities with owners and deadlines.
**Estimated effort:** 1 week
**Dependencies:** `enrichment-framework` (implements the `EnrichmentProvider` interface)

## Why

Decisions are made in Slack threads, PR reviews, and meeting notes — then forgotten. Action items are assigned in conversations but never tracked. Today, the Slack connector uses simple regex patterns (`/decided\s*:/i`) to flag decisions, catching maybe 10% of actual decisions.

This provider uses a two-stage approach: fast rule-based pre-filtering followed by LLM extraction for high-signal content. The result is a structured decision/action graph that Meeting Agent and search can leverage.

## What Changes

### In Scope

1. **New file: `src/enrichment/providers/decision-extractor.ts`** — implements `EnrichmentProvider`.

2. **Rule-based signal detection** — fast pre-filter, no LLM:

   Decision signals (expanded from current Slack connector patterns):
   ```typescript
   const DECISION_SIGNALS = [
     /we('re| are) going (with|to)/i,
     /decided (to|on|that)/i,
     /decision\s*:/i,
     /let'?s go with/i,
     /approved/i,
     /final(ized|ly|ize)/i,
     /agreed (to|on|that)/i,
     /conclusion\s*:/i,
     /resolved\s*:/i,
     /verdict\s*:/i,
     /consensus\s*:/i,
   ];
   ```

   Action signals:
   ```typescript
   const ACTION_SIGNALS = [
     /action item\s*:/i,
     /todo\s*:/i,
     /\[ \]/,
     /will (do|handle|take care of|follow up)/i,
     /assigned to/i,
     /by (monday|tuesday|wednesday|thursday|friday|eow|eod)/i,
     /due (date|by)/i,
     /deadline/i,
     /@\w+\s+(please|can you|could you|will you)/i,
   ];
   ```

3. **LLM extraction** (when `ctx.llm` is available AND rule signals fire):

   Prompt template:
   ```
   Extract decisions and action items from the following content.

   For each DECISION, provide:
   - summary: one-line description of what was decided
   - context: why this decision was made (1-2 sentences)
   - alternatives: what was considered but rejected (if mentioned)
   - confidence: "explicit" (clearly stated) or "implicit" (inferred)

   For each ACTION ITEM, provide:
   - description: what needs to be done
   - owner: who is responsible (name/handle, or "unassigned")
   - deadline: ISO date string or null
   - status: "open" | "in-progress" | "done"

   Content:
   ---
   {entity.content}
   ---

   Respond in JSON: { "decisions": [...], "actions": [...] }
   ```

4. **Derived entity creation** — for each extracted decision/action, creates child entities and synapses.

5. **Rule-only fallback** — when no LLM is configured, extracts lines matching patterns into simpler entities with `attributes._extractionMethod: "rule-based"`.

6. **Registration** — registered in `CortexStore` initialization alongside `ClassifyProvider`.

7. **Evaluation against golden test set** — 20+ labeled samples in `src/enrichment/eval/decision-eval-dataset.json`.

### Out of Scope

- Real-time extraction (webhook-triggered) — only runs via `enrichBatch`.
- Action item status tracking / updates — extracted status is point-in-time snapshot.
- Notion/GitHub-specific decision formats — GitHub connector already handles ADRs separately.
- Custom extraction prompt configuration via env vars.

## Devil's Advocate Review

**Risk: LLM extraction produces false positives for implicit decisions.**
Mitigation: Rule-based pre-filter is the gating mechanism — LLM only runs when explicit signals are present. LLM output includes `confidence: "explicit" | "implicit"`, allowing downstream consumers to filter.

**Risk: Derived entities pollute the graph with low-quality extractions.**
Mitigation: All extracted entities use `source.system: "context-engine"` with unique `externalId: "ce:decision:{entityId}:{index}"`. Re-running enrichment on an entity with `_decisionsExtracted: true` is a no-op — no proliferation on re-runs.

**Risk: Owner resolution (`@alice` → person entity) fails when no person entity exists.**
Mitigation: Owner field is stored as raw string. Person resolution attempt is a best-effort lookup by `source_external_id` containing the handle. Failure creates task with `owner: "@alice"` string — still useful even without graph link.

**Risk: Depends on enrichment-framework being complete.**
Mitigation: This change is in Phase B (starts after Phase A). The `EnrichmentProvider` interface and `EnrichmentEngine` are the only hard dependencies — no dependency on LLM provider internals.

## Acceptance Criteria

1. Given a Slack conversation entity containing "We decided to use PostgreSQL instead of MongoDB for the user service", the provider extracts a `decision` entity and creates a `derived` synapse from the conversation to the decision.
2. Given a meeting entity containing "Action: @alice will set up the CI pipeline by Friday", the provider extracts a `task` entity with `owner: "alice"` and `deadline` set to the upcoming Friday.
3. When `CORTEX_ENRICHMENT=rule` (no LLM), the rule-based fallback extracts decisions matching regex patterns with `attributes._extractionMethod: "rule-based"`.
4. Re-running enrichment on an already-processed entity (`attributes._decisionsExtracted = true`) is a no-op.
5. `memory_recall` with query `"decisions about database"` returns context-engine-extracted decisions.
6. Eval harness on 20+ golden samples achieves precision >= 0.75.

## Impact

- **New file:** `src/enrichment/providers/decision-extractor.ts` (~300 lines)
- **New file:** `src/enrichment/eval/decision-eval-dataset.json` (20+ samples)
- **Modified:** `src/store.ts` — register `DecisionExtractorProvider` in enrichment engine (~5 lines)
- **No schema changes** — uses existing entity types and synapse table
- **No new dependencies**
- **No new MCP tools** — uses existing `context_enrich` from enrichment-framework
