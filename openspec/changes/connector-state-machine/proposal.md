# Change: connector-state-machine

**Layer:** 1 (Data Ingestion)
**One-liner:** Formalize the connector sync lifecycle into a 3-phase state machine (Initial/Incremental/Rollback) with persisted sync_phase and cursor, replacing the current ad-hoc syncing/idle/error status.
**Estimated effort:** 4 days
**Dependencies:** content-hash-dedup (uses content_hash for rollback diff detection)
**Priority:** P1

## Design Review

### PM Perspective

**User problem:** The current connector model has two implicit modes (full sync vs incremental sync) controlled by a `full` boolean parameter. There is no concept of sync phases, no visibility into where a sync is in its lifecycle, and no structured handling of initial vs. steady-state syncs. When `connector_status` reports `status: "error"`, users have no way to know whether the connector was in initial load or incremental mode, making troubleshooting difficult.

**Success metrics:**
- `connector_status` shows current `sync_phase` (initial | incremental | rollback) alongside status
- After a successful initial sync, connector automatically transitions to `incremental` phase
- Rollback phase (Feature 3) can be triggered on incremental syncs to catch retroactive edits
- Users can see sync history with phase transitions via `connector_status` with `detail: "full"`

**Priority justification:** The state machine is the structural foundation for Features 3-6. Without explicit phases, rollback sync (Feature 3) has no hook point, and checkpoint-based long sync (Feature 6) has no phase to checkpoint within. Fivetran's 3-phase model is proven at scale.

### Tech Lead Perspective

**Implementation approach:**
1. Add `sync_phase TEXT` column to `connectors` table (values: `initial`, `incremental`, `rollback`)
2. Add `sync_history TEXT` (JSON array) to `connectors` table for audit trail
3. Create `ConnectorStateMachine` class in new file `src/connectors/state-machine.ts` that manages phase transitions
4. Refactor `syncConnector()` in `src/store.ts` to use the state machine instead of the `full` boolean parameter
5. Update `ConnectorPlugin` interface to support phase-aware sync methods

**File changes:**
- `src/db/schema.ts` — Add `sync_phase`, `sync_history` columns to connectors table (can be part of schema v3 migration with content-hash-dedup)
- `src/connectors/state-machine.ts` — NEW: ConnectorStateMachine class
- `src/connectors/types.ts` — Add `SyncPhase` type, extend `ConnectorPlugin` with optional `rollbackSync()` method
- `src/store.ts` — Refactor `syncConnector()` to delegate to state machine
- `src/tools/connector-tools.ts` — Show `sync_phase` in `connector_status` output
- `src/db/database.ts` — Update connector CRUD methods for new columns

**Risk assessment:** MEDIUM. This refactors the core sync loop in `syncConnector()`. The refactoring is additive (existing `fullSync()`/`incrementalSync()` methods are preserved), but the control flow changes. Mitigation: keep existing ConnectorPlugin interface backward-compatible by making `rollbackSync()` optional.

### Architect Perspective

**System design impact:** This introduces a proper lifecycle model for connectors. The state machine pattern is well-understood and maps directly to Fivetran's 3-phase model:

```
INITIAL ──(complete)──> INCREMENTAL ──(schedule)──> INCREMENTAL
                              │
                              └──(rollback trigger)──> ROLLBACK ──(complete)──> INCREMENTAL
```

**Data model changes:**
```sql
ALTER TABLE connectors ADD COLUMN sync_phase TEXT NOT NULL DEFAULT 'initial';
ALTER TABLE connectors ADD COLUMN sync_history TEXT NOT NULL DEFAULT '[]';
```

`sync_history` stores the last N sync runs:
```json
[
  {
    "phase": "incremental",
    "startedAt": "2026-03-25T10:00:00Z",
    "completedAt": "2026-03-25T10:02:30Z",
    "added": 5,
    "updated": 2,
    "skipped": 43,
    "errors": 0
  }
]
```

**Integration points:**
- `syncConnector()` — delegates to state machine for phase selection
- `connector_status` tool — shows phase and history
- Future: rollback sync (Feature 3) hooks into ROLLBACK phase
- Future: checkpoint sync (Feature 6) hooks into INITIAL phase

### Devil's Advocate

**What could go wrong?**
- Complexity overhead: A state machine for 3 states is arguably over-engineered. Counter: The state machine also encodes transition validation (e.g., can't go from INITIAL directly to ROLLBACK) which prevents invalid states.
- Backward compatibility: Existing connectors don't have `rollbackSync()`. Counter: It's optional on the interface, and the state machine falls back to `incrementalSync()` when `rollbackSync()` is not implemented.
- Schema migration timing: If content-hash-dedup and this feature both modify the schema, they should be in the same migration. Counter: Both can be part of schema v3 migration.

**Over-engineering concerns:**
- The `sync_history` JSON column could grow unbounded. Mitigation: Cap at last 50 entries and trim on each sync completion.
- Full state machine class with transition tables might be overkill for 3 states. Counter: A simple class with `getNextPhase()` and `transition()` methods is <80 lines. Not a framework, just a coordinator.

**Alternative simpler approaches:**
- Keep the `full` boolean and just add `sync_phase` as a read-only status column. This loses the automatic phase progression but is simpler. REJECTED — the automatic `initial → incremental` transition is the core value.
- Use a simple function instead of a class. ACCEPTABLE but a class encapsulates the state + transitions more cleanly.

### Consensus Decision

**Go** — Unanimous.

**Scope adjustments:**
- Keep the state machine simple: no event-driven transitions, just a `getPhase()` / `completePhase()` / `failPhase()` API
- Cap `sync_history` at 50 entries
- Rollback phase is defined in the state machine but not implemented until Feature 3

**Implementation order:** Second P1 feature, after content-hash-dedup. Both share schema v3 migration.

## Acceptance Criteria

1. New connector starts in `sync_phase: "initial"`. After first successful full sync, automatically transitions to `sync_phase: "incremental"`.
2. `connector_status` tool output includes `sync_phase` field showing current phase.
3. `syncConnector()` uses `sync_phase` to determine whether to call `fullSync()` or `incrementalSync()` — the `full` parameter becomes an override, not the primary control.
4. `sync_history` contains the last 50 sync runs with phase, timestamps, and counts.
5. State machine prevents invalid transitions (e.g., `rollback` when no incremental has ever run).
6. Existing connectors (github, slack, notion, calendar, outlook) work without changes — they don't implement `rollbackSync()` so the state machine skips the ROLLBACK phase.
7. `connector_status` with `detail: "full"` shows last 5 sync history entries.

## Impact

- **New file:** `src/connectors/state-machine.ts` (~80 lines)
- **Modified:** `src/db/schema.ts` — add columns (part of v3 migration, ~5 lines)
- **Modified:** `src/connectors/types.ts` — add `SyncPhase`, optional `rollbackSync()` (~10 lines)
- **Modified:** `src/store.ts` — refactor `syncConnector()` to use state machine (~40 lines changed)
- **Modified:** `src/db/database.ts` — update connector row mapping (~10 lines)
- **Modified:** `src/tools/connector-tools.ts` — show phase in status output (~10 lines)
