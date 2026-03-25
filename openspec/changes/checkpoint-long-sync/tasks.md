# Tasks: checkpoint-long-sync

**Estimated effort:** 3 days
**Dependencies:** connector-state-machine, content-hash-dedup

## Day 1: CheckpointManager

- [ ] **TASK-CP-01**: Implement CheckpointManager class
  - Create `src/connectors/checkpoint.ts`
  - Implement `load()`: read checkpoint file, check 24h expiry, parse JSON
  - Implement `create()`: initialize fresh checkpoint, write to disk
  - Implement `updateStream(streamId, update)`: update per-stream pagination state
  - Implement `updateCounts(delta)`: increment running counters
  - Implement `flush()`: write dirty checkpoint to disk
  - Implement `isStreamComplete(streamId)`: check if stream was finished in previous run
  - Implement `getStreamPageToken(streamId)`: get resume page token
  - Implement `getProgress()`: return summary for status display
  - Implement `delete()`: remove checkpoint file on completion
  - Checkpoint directory: `~/.cortex/sync-state/`

- [ ] **TASK-CP-02**: Add checkpoint types to connector types
  - Add `SyncCheckpoint` and `StreamCheckpoint` interfaces to `src/connectors/checkpoint.ts`
  - Export types for use by connectors

## Day 2: Connector Integration

- [ ] **TASK-CP-03**: Add checkpoint support to GitHub connector
  - Modify `_syncPRs()` to accept optional `CheckpointManager`
  - Skip completed streams, resume from page token
  - Flush checkpoint after each pagination page
  - Mark stream as complete when pagination ends
  - Apply same pattern to `_syncIssues()`, `_syncADRFiles()`
  - Modify `fullSync()` to accept and pass through checkpoint

- [ ] **TASK-CP-04**: Add checkpoint support to Notion connector
  - Modify `_queryDatabase()` to accept optional `CheckpointManager`
  - Resume from `start_cursor` stored in checkpoint
  - Flush checkpoint after each page
  - Modify `_searchPages()` similarly
  - Modify `fullSync()` to accept and pass through checkpoint

- [ ] **TASK-CP-05**: Integrate checkpoint into syncConnector()
  - In `src/store.ts`, create `CheckpointManager` for initial phase syncs
  - Load existing checkpoint on start; log resume message
  - Restore counters from checkpoint on resume
  - Pass checkpoint to connector's `fullSync()` method
  - Call `checkpoint.updateCounts()` after each entity processed
  - Delete checkpoint on successful completion
  - Preserve checkpoint on error (for future resume)

## Day 3: Status + Tests

- [ ] **TASK-CP-06**: Show checkpoint progress in connector_status
  - In `src/tools/connector-tools.ts`, check for active checkpoint file
  - Display progress: processed count, stream count, last checkpoint time
  - Show "Resumable" indicator when checkpoint exists but sync is not running

- [ ] **TASK-CP-07**: Unit tests for CheckpointManager
  - Test: `create()` writes checkpoint file to disk
  - Test: `load()` returns null when no file exists
  - Test: `load()` returns null for expired checkpoint (>24h)
  - Test: `updateStream()` + `flush()` persists stream state
  - Test: `isStreamComplete()` returns true for completed streams
  - Test: `getStreamPageToken()` returns saved token
  - Test: `delete()` removes the file
  - Test: `updateCounts()` correctly increments counters

- [ ] **TASK-CP-08**: Integration tests for checkpoint resume
  - Test: interrupt sync mid-stream (mock API failure after N pages)
  - Test: resume sync loads checkpoint and skips completed streams
  - Test: resume sync produces correct final counts (checkpoint + new)
  - Test: successful sync deletes checkpoint file
  - Test: content_hash dedup handles entities seen in previous attempt
