# Change: sync-metadata-columns

**Layer:** 1 (Data Ingestion)
**One-liner:** Add `_sync_cursor`, `_source_deleted`, and `_last_synced_at` metadata columns to entities for a complete audit trail of sync provenance.
**Estimated effort:** 2 days
**Dependencies:** content-hash-dedup (content_hash column), rollback-sync-window (_deleted detection)
**Priority:** P2

## Design Review

### PM Perspective

**User problem:** When debugging data quality issues, users cannot determine when an entity was last synced, what cursor value was active during its sync, or whether the source system has deleted the original. The `updated_at` timestamp reflects hive-memory's update time, not the sync event. Users need an audit trail to answer: "Is this entity stale? When was it last verified against the source?"

**Success metrics:**
- Every connector-sourced entity has `_last_synced_at` showing when it was last checked
- `memory_inspect` shows sync provenance metadata for connector-sourced entities
- Data quality audit (`memory_audit`) can identify entities not synced in >7 days

**Priority justification:** This is the observability layer for the sync pipeline. Without it, content-hash-dedup and rollback-sync silently skip entities with no record of when they were last checked. Airbyte's `_ab_cdc_*` columns are what make their incremental sync debuggable.

### Tech Lead Perspective

**Implementation approach:** Store sync metadata in the entity's `attributes` JSON column using underscore-prefixed keys (consistent with existing `_enrichedAt`, `_enrichedBy` pattern). No schema change needed.

**Fields to add:**
- `_lastSyncedAt: string` — ISO timestamp of when this entity was last encountered during a sync (even if content was unchanged)
- `_syncCursor: string` — The sync cursor value that was active when this entity was ingested
- `_sourceDeleted: boolean` — True when the source system reports this entity as deleted/archived
- `_syncPhase: string` — Which phase (initial/incremental/rollback) produced this entity
- `_syncConnector: string` — Which connector synced this entity (redundant with `source_connector` but useful for multi-connector scenarios)

**File changes:**
- `src/store.ts` — Stamp metadata attributes during sync loop (~15 lines)
- `src/tools/browse-tools.ts` — Show sync metadata in `memory_inspect` output (~10 lines)
- `src/steward/index.ts` — Use `_lastSyncedAt` for staleness detection in audit (~10 lines)

**Risk assessment:** LOW. This only adds attributes to the existing JSON column. No schema migration, no breaking changes.

### Architect Perspective

**System design impact:** Minimal. Attributes are stored in the existing `attributes TEXT` JSON column. No new tables or columns.

**Data model changes:** None at the SQL level. At the application level, these become conventional attribute keys:

```typescript
// After sync, entity.attributes will include:
{
  _lastSyncedAt: "2026-03-25T10:02:30Z",
  _syncCursor: "2026-03-25T10:00:00Z",
  _syncPhase: "incremental",
  _sourceDeleted: false,
  // ... existing attributes ...
}
```

**Integration points:**
- `syncConnector()` — stamps all metadata on every entity encounter (insert, update, or skip)
- `memory_inspect` tool — displays sync metadata section
- `memory_audit` steward — flags entities with `_lastSyncedAt` older than threshold

### Devil's Advocate

**What could go wrong?**
- Attribute bloat: 5 new keys per entity. At ~200 bytes per entity, this is negligible for SQLite.
- Updating attributes on skipped entities: When content_hash dedup skips an update, we still want to stamp `_lastSyncedAt` to record that we checked. This means a lightweight `updateEntityAttributes()` call even for skipped entities.

**Over-engineering concerns:**
- Is `_syncPhase` necessary? It's already in `sync_history` on the connector. Counter: The per-entity record answers "which phase produced THIS entity" without cross-referencing connector history.

**Alternative simpler approaches:**
- Store only `_lastSyncedAt` and skip the other fields. This covers 80% of the debugging use case. ACCEPTABLE as a scope reduction if time-constrained.
- Use dedicated SQL columns instead of attributes. REJECTED — five nullable columns for metadata that only applies to connector-sourced entities is wasteful schema-wise.

### Consensus Decision

**Go** — Unanimous.

**Scope adjustments:**
- Implement all 5 fields. The marginal cost of each additional field is ~3 lines of code.
- Stamp `_lastSyncedAt` even on skipped (content-unchanged) entities — this is the primary value.
- Do NOT add SQL columns — attributes JSON is the right place for connector-specific metadata.

**Implementation order:** Second P2 feature, after rollback-sync-window. Can be implemented in parallel with enrichment-pipeline-stages since they touch different code paths.

## Acceptance Criteria

1. After sync, every processed entity (added, updated, or skipped) has `_lastSyncedAt` attribute set.
2. `_syncCursor` attribute matches the connector's cursor value at sync start time.
3. `_sourceDeleted` is set to `true` for entities marked as deleted during rollback sync.
4. `memory_inspect` for connector-sourced entities shows a "Sync Provenance" section with all metadata fields.
5. `memory_audit` reports entities with `_lastSyncedAt` older than 7 days as "stale" in its audit output.

## Impact

- **Modified:** `src/store.ts` — stamp sync metadata in sync loop (~15 lines)
- **Modified:** `src/tools/browse-tools.ts` — display sync metadata in inspect (~10 lines)
- **Modified:** `src/steward/index.ts` — staleness detection using `_lastSyncedAt` (~10 lines)
- **No schema changes** — uses existing `attributes` JSON column
- **No new files**
