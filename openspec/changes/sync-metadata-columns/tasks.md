# Tasks: sync-metadata-columns

**Estimated effort:** 2 days
**Dependencies:** content-hash-dedup, rollback-sync-window

## Day 1: Implementation

- [ ] **TASK-META-01**: Stamp sync metadata in syncConnector()
  - Build `syncMeta` object with `_lastSyncedAt`, `_syncCursor`, `_syncPhase`, `_syncConnector`, `_sourceDeleted`
  - For new entities: merge syncMeta into `draft.attributes` at insert time
  - For updated entities: merge syncMeta into attributes at update time
  - For skipped entities (content_hash match): call `db.updateEntityAttributes(id, syncMeta)` to stamp check time
  - For deleted entities: stamp syncMeta with `_sourceDeleted: true` before archiving

- [ ] **TASK-META-02**: Show sync provenance in memory_inspect
  - In `src/tools/browse-tools.ts`, detect connector-sourced entities (`entity.source?.connector`)
  - Add "Sync Provenance" section with table showing all metadata fields
  - Include abbreviated content_hash for reference
  - Skip section for non-connector entities (agent-created memories, sessions)

- [ ] **TASK-META-03**: Add staleness detection to memory_audit
  - In `src/steward/index.ts`, add `checkStaleness()` function
  - Query active connector-sourced entities, check `_lastSyncedAt` against 7-day threshold
  - Report stale entity count with top 10 examples (id, title, lastSynced, connector)
  - Entities without `_lastSyncedAt` are treated as stale (never synced in new system)

## Day 2: Tests

- [ ] **TASK-META-04**: Tests for sync metadata stamping
  - Test: new entity from sync has `_lastSyncedAt` attribute set
  - Test: updated entity has `_lastSyncedAt` refreshed
  - Test: skipped (content-unchanged) entity still gets `_lastSyncedAt` updated
  - Test: deleted entity has `_sourceDeleted: true`
  - Test: `_syncPhase` matches the phase that produced the entity
  - Test: `_syncCursor` matches the cursor value at sync start

- [ ] **TASK-META-05**: Tests for staleness detection
  - Test: entity synced 8 days ago is flagged as stale
  - Test: entity synced 2 days ago is not flagged
  - Test: non-connector entity (agent-created) is not checked for staleness
  - Test: entity without `_lastSyncedAt` is treated as stale
