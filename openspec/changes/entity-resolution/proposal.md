# Change: entity-resolution

**Layer:** 1 (dedup) + 2 (fuzzy matching)
**One-liner:** Two-layer identity resolution — mechanical dedup by source_external_id (Layer 1) and cross-source person matching with optional LLM fuzzy matching (Layer 2) — plus an `entity_resolve` MCP tool for human-in-the-loop merges.
**Estimated effort:** 2 weeks
**Dependencies:** `enrichment-framework` (uses `EnrichmentContext.db`, shares alias storage patterns)

## Why

The same person exists in multiple sources: `gcal:person:alice@company.com`, `github:user:alice-dev`, `slack:user:U012AB3CD`. Today these are three separate unlinked entities. Queries like "what has Alice been working on?" return results from only one source.

Entity resolution is the mechanism that unifies cross-source identities into a single canonical entity, enabling true cross-source queries.

## What Changes

### In Scope

#### Layer 1: Source-Level Dedup (Mechanical, Always-On)

The `source_external_id` column in the `entities` table already provides dedup within a single source system. This is already implemented in `HiveDatabase.upsertEntity()`. Layer 1 work is documentation + hardening:

- MUST document `source_external_id` contract in `src/db/database.ts` comments.
- MUST add `UNIQUE` constraint verification test on `source_external_id` within the same `source_system`.
- MUST add regression test: re-syncing a connector does not create duplicate entities.

#### Layer 2: Cross-Source Person Matching

New matching pipeline for `person` entities across source systems:

**Strategy hierarchy** (applied in order, stops at first match):
1. **Exact email match** — `gcal:person:alice@co.com` ↔ entity with `attributes.email = "alice@co.com"` in GitHub/Slack.
2. **Exact name match** — `displayName` normalization (lowercase, trim) comparison.
3. **LLM fuzzy match** — prompt LLM with two person entity descriptions; ask if they are the same person. Used when Levenshtein distance on names is < 3 but not exact.
4. **Manual confirmation** — present candidates to user via `entity_resolve` MCP tool.

#### Schema Addition: `entity_aliases` Table

New table to store identity mappings without destroying source entities:
```sql
CREATE TABLE IF NOT EXISTS entity_aliases (
  id              TEXT PRIMARY KEY,
  canonical_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias_system    TEXT NOT NULL,   -- e.g. "google-calendar", "github", "slack"
  alias_value     TEXT NOT NULL,   -- external ID or email
  alias_type      TEXT NOT NULL,   -- "external_id" | "email" | "name" | "handle"
  confidence      TEXT NOT NULL DEFAULT 'inferred',  -- "confirmed" | "inferred"
  created_at      TEXT NOT NULL,
  UNIQUE(alias_system, alias_value)
);
```

#### Merge Operation

When two entities are confirmed as the same person:
1. Designate one as **primary** (prefer the entity with more synapses, or the oldest).
2. Set `superseded_by = primary.id` on the non-primary entity.
3. Copy all synapses from superseded entity to primary (remap `source_id` or `target_id`).
4. Insert aliases for the superseded entity into `entity_aliases`.
5. Set `status = "archived"` on superseded entity.

This is **non-destructive**: superseded entities remain in the database, marked as archived with `superseded_by` set.

#### EntityResolver Class

New file `src/enrichment/entity-resolver.ts`:
```typescript
class EntityResolver {
  findCandidates(entity: Entity): ResolutionCandidate[];
  async resolveWithLLM(a: Entity, b: Entity, llm: LLMProvider): Promise<boolean>;
  merge(primaryId: string, supersededId: string): MergeResult;
  getAliases(entityId: string): EntityAlias[];
}
```

#### MCP Tool: `entity_resolve`

New tool in `src/tools/context-tools.ts`:
```
entity_resolve
  - action: "list_candidates" | "merge" | "list_aliases"
  - entityId: string (required)
  - mergeIntoId?: string (required when action="merge")
  - confirmed?: boolean (required when action="merge", safety gate)

Returns (list_candidates): { candidates: [{ entity, matchType, confidence }] }
Returns (merge): { merged: true, primaryId, supersededId, synapsesMoved }
Returns (list_aliases): { aliases: EntityAlias[] }
```

### Out of Scope

- Automated bulk merge without human confirmation (all merges require `confirmed: true` in API).
- Non-person entity resolution (document dedup, topic dedup) — future work.
- Rollback of completed merges (superseded entities remain, manual recovery only).
- Real-time resolution triggers (resolution runs on-demand, not on entity insert).

## Devil's Advocate Review

**Risk: Merging wrong entities is destructive and hard to undo.**
Mitigation: Merge is non-destructive — `superseded_by` is set but original entity rows remain. Synapses are copied (not moved). Archived entities can be un-archived by clearing `superseded_by` and `status` manually. The `entity_resolve` tool requires `confirmed: true` as an explicit human acknowledgment.

**Risk: LLM fuzzy matching produces false positive merges for common names (e.g., "John Lee").**
Mitigation: LLM is only triggered when Levenshtein distance < 3 (near-identical names). Even then, LLM match produces a `"inferred"` confidence candidate — human must confirm via `entity_resolve` tool. Automated merges only happen for `confidence: "confirmed"` matches (exact email match).

**Risk: Schema change (entity_aliases table) requires migration.**
Mitigation: Schema version bump from `SCHEMA_VERSION=1` to `SCHEMA_VERSION=2` in `src/db/schema.ts`. `createSchema()` is idempotent (`CREATE TABLE IF NOT EXISTS`). No data migration needed — new table starts empty.

**Risk: Synapse remapping on merge is expensive for entities with hundreds of synapses.**
Mitigation: Merge is an on-demand operation, not a hot path. SQLite UPDATE with WHERE clause is fast even at thousands of rows. Batch the synapse copy in a transaction.

## Acceptance Criteria

1. `entity_aliases` table is created on database initialization (schema version 2).
2. After syncing both GitHub and Google Calendar, `entity_resolve` with `action: "list_candidates"` for a person entity shows cross-source matches with `matchType: "exact_email"` when emails match.
3. `entity_resolve` with `action: "merge", confirmed: true` successfully merges two person entities: primary has all original synapses plus synapses moved from superseded; superseded has `status: "archived"` and `superseded_by` set.
4. `memory_recall` query for a merged person returns results from all source systems via the primary entity.
5. Re-running connector sync after a merge does not un-archive the superseded entity (upsert uses `source_external_id`, superseded entity keeps its `status: "archived"`).

## Impact

- **New file:** `src/enrichment/entity-resolver.ts` (~200 lines)
- **Modified:** `src/db/schema.ts` — add `entity_aliases` table, bump `SCHEMA_VERSION` to 2
- **Modified:** `src/tools/context-tools.ts` — add `entity_resolve` tool
- **Modified:** `src/store.ts` — expose `EntityResolver` instance (~10 lines)
- **No new npm dependencies**
- **Schema change:** `entity_aliases` table (additive, no migration of existing data)
