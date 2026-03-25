# Tasks: rollback-sync-window

**Estimated effort:** 3 days
**Dependencies:** connector-state-machine, content-hash-dedup

## Day 1: Types + State Machine + Store Changes

- [ ] **TASK-RB-01**: Add `_deleted` flag to RawDocument
  - Add optional `_deleted?: boolean` to `RawDocument` interface in `src/connectors/types.ts`
  - Document the contract: when `_deleted` is true, entity should be archived

- [ ] **TASK-RB-02**: Add rollback scheduling to ConnectorStateMachine
  - Implement `shouldRollback(connectorId)` — count incremental syncs since last rollback
  - Implement `getRollbackWindow()` — compute window from env var
  - Modify `getExecutionPhase()` to inject rollback phase every N incrementals
  - Read `CORTEX_ROLLBACK_FREQUENCY` (default 5) and `CORTEX_ROLLBACK_WINDOW_HOURS` (default 6)

- [ ] **TASK-RB-03**: Handle _deleted and rollback in syncConnector()
  - In `src/store.ts` sync loop, check `doc._deleted` flag before transform
  - If deleted: find existing entity, set `status: "archived"`, increment `archived` counter
  - Add `archived: number` to syncConnector return type
  - Pass rollback window to `connector.rollbackSync()` when phase is "rollback"

## Day 2: Connector Implementations

- [ ] **TASK-RB-04**: Implement rollbackSync() for GitHub connector
  - Re-use `_syncPRs(repo, since)` and `_syncIssues(repo, since)` with window.since
  - Skip ADR and CODEOWNERS syncing during rollback (static content)
  - Content_hash dedup handles skipping unchanged entities automatically

- [ ] **TASK-RB-05**: Implement rollbackSync() for Slack connector
  - Convert window.since to Unix timestamp and pass to `_syncChannels(oldest)`
  - Skip member syncing during rollback (members don't change frequently)

- [ ] **TASK-RB-06**: Implement rollbackSync() for Notion connector
  - Pass window.since to `_searchAll(since)` which already filters by `last_edited_time`
  - Notion API handles the filtering natively

- [ ] **TASK-RB-07**: Implement rollbackSync() for Calendar connectors
  - Google Calendar: use `fetchEvents({ updatedMin: window.since })`
  - Outlook Calendar: use `fetchEvents({ lastModifiedSince: window.since })`
  - Both already support update-based filtering

## Day 3: Tests

- [ ] **TASK-RB-08**: Unit tests for rollback scheduling
  - Test: `shouldRollback` returns true after 5 incremental syncs (default frequency)
  - Test: `shouldRollback` returns false after 3 incremental syncs
  - Test: `shouldRollback` resets count after a rollback sync
  - Test: `CORTEX_ROLLBACK_FREQUENCY=0` disables rollback
  - Test: `getRollbackWindow()` returns correct 6-hour window by default

- [ ] **TASK-RB-09**: Integration tests for rollback sync
  - Test: modify an entity's source content after initial sync → rollback detects change
  - Test: rollback with unchanged content → skipped count matches entity count (content_hash dedup)
  - Test: `_deleted` entity gets `status: "archived"` after rollback
  - Test: connector without `rollbackSync()` falls back to incrementalSync during rollback phase
  - Test: rollback results appear in sync_history with `phase: "rollback"`
