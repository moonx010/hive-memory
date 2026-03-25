# Tasks: connector-state-machine

**Estimated effort:** 4 days
**Dependencies:** content-hash-dedup (shared schema v3 migration)

## Day 1: Types + Schema + State Machine Class

- [ ] **TASK-SM-01**: Add SyncPhase type and interface extensions
  - Add `SyncPhase = "initial" | "incremental" | "rollback"` to `src/connectors/types.ts`
  - Add `SyncHistoryEntry` interface with phase, timestamps, counts
  - Add optional `rollbackSync?(window)` method to `ConnectorPlugin` interface
  - Ensure backward compatibility: existing connectors don't need changes

- [ ] **TASK-SM-02**: Schema migration for connectors table
  - Add `sync_phase TEXT NOT NULL DEFAULT 'initial'` to connectors table
  - Add `sync_history TEXT NOT NULL DEFAULT '[]'` to connectors table
  - Include in schema v3 migration alongside content-hash-dedup changes
  - Update `ConnectorRow` interface in `src/db/database.ts`

- [ ] **TASK-SM-03**: Implement ConnectorStateMachine class
  - Create `src/connectors/state-machine.ts`
  - Implement `getPhase(connectorId)` — reads from DB, defaults to "initial"
  - Implement `getHistory(connectorId)` — parses JSON from sync_history column
  - Implement `startSync(connectorId, phase)` — marks connector as syncing with phase
  - Implement `completeSync(connectorId, result)` — handles phase transitions, appends history, caps at 50 entries
  - Implement `getExecutionPhase(connectorId, forceInitial)` — determines which phase to run
  - Implement `canTransition(from, to)` — validates legal transitions
  - Phase transition rules: initial→incremental on success, rollback→incremental on success, stay on error

## Day 2: syncConnector Refactor

- [ ] **TASK-SM-04**: Refactor syncConnector() to use state machine
  - Import `ConnectorStateMachine` in `src/store.ts`
  - Replace `full` boolean logic with `sm.getExecutionPhase(connectorId, full)`
  - Call `sm.startSync()` before sync loop
  - Call `sm.completeSync()` after sync loop with result counts
  - Select generator based on phase: initial→fullSync, incremental→incrementalSync, rollback→rollbackSync (fallback to incrementalSync)
  - Add `skipped` to return type (from content-hash-dedup integration)

- [ ] **TASK-SM-05**: Update connector DB methods
  - Update `upsertConnector()` in `src/db/database.ts` to handle `syncPhase` and `syncHistory` fields
  - Update `getConnector()` to return new fields
  - Update `getConnectorStatuses()` to include `syncPhase`

## Day 3: Status Tool + Integration

- [ ] **TASK-SM-06**: Update connector_status tool
  - In `src/tools/connector-tools.ts`, add `syncPhase` field to status output
  - When `detail: "full"`, include last 5 entries from `syncHistory`
  - Format history entries with phase, timestamps, and counts

- [ ] **TASK-SM-07**: Update connector_sync tool
  - Show phase in sync start message: `"Starting ${phase} sync for ${connectorId}"`
  - Show phase transition in completion message: `"Sync complete. Phase: ${oldPhase} → ${newPhase}"`
  - Include `skipped` count in result output

## Day 4: Tests

- [ ] **TASK-SM-08**: Unit tests for ConnectorStateMachine
  - Test: new connector starts in "initial" phase
  - Test: successful initial sync transitions to "incremental"
  - Test: failed initial sync stays in "initial" (retry)
  - Test: successful rollback transitions to "incremental"
  - Test: `canTransition("initial", "rollback")` returns false
  - Test: `canTransition("incremental", "rollback")` returns true
  - Test: sync history is capped at 50 entries
  - Test: `getHistory()` returns empty array for unknown connector

- [ ] **TASK-SM-09**: Integration tests for syncConnector with state machine
  - Test: first sync uses fullSync(), sets phase to "incremental"
  - Test: subsequent sync uses incrementalSync() (phase is "incremental")
  - Test: `full=true` override forces fullSync() regardless of phase
  - Test: connector without rollbackSync falls back to incrementalSync in rollback phase
  - Test: sync error preserves current phase (no transition)
  - Test: sync history is persisted across multiple syncs
