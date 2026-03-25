# Change: rollback-sync-window

**Layer:** 1 (Data Ingestion)
**One-liner:** Add a rollback sync phase that re-checks entities from the past N hours to catch retroactive edits, deletes, and status changes that incremental sync misses.
**Estimated effort:** 3 days
**Dependencies:** connector-state-machine (ROLLBACK phase), content-hash-dedup (skip unchanged)
**Priority:** P2

## Design Review

### PM Perspective

**User problem:** Incremental syncs only capture changes since the last cursor. But users frequently edit GitHub PR descriptions after creation, retroactively close Slack threads, or update Notion page properties. These retroactive changes are invisible to incremental sync until the next full sync (which may never happen after initial load). Stale data erodes trust in the memory system.

**Success metrics:**
- Entities retroactively edited in the source system are updated within `rollback_window_hours` (default: 6)
- Entities deleted in source system get `status: "archived"` within the rollback window
- Rollback sync adds <20% overhead to incremental sync time (leverages content_hash to skip unchanged)

**Priority justification:** This is the cheapest way to maintain data freshness without running expensive full syncs. Fivetran's rollback window is what makes their "reliable sync" claim credible. Combined with content_hash dedup, the rollback window only re-processes actually-changed entities.

### Tech Lead Perspective

**Implementation approach:**
1. Add `rollback_window_hours` to connector config (default: 6, configurable per connector)
2. Implement `rollbackSync()` on `ConnectorPlugin` interface — re-fetches entities from `[now - window, now]`
3. The state machine alternates: every Nth incremental sync triggers a rollback phase
4. Rollback sync uses the same transform + upsert logic but with content_hash dedup to skip unchanged
5. For deleted entities: source connectors emit a `_deleted: true` flag on RawDocument; syncConnector marks these as `status: "archived"`

**File changes:**
- `src/connectors/types.ts` — Add `_deleted?: boolean` to `RawDocument`, document `rollbackSync()` contract
- `src/connectors/github.ts` — Implement `rollbackSync()`: re-fetch PRs/issues updated in window
- `src/connectors/slack.ts` — Implement `rollbackSync()`: re-fetch messages in window
- `src/connectors/notion.ts` — Implement `rollbackSync()`: re-query with `last_edited_time` filter
- `src/connectors/calendar.ts` — Implement `rollbackSync()`: re-fetch events updated in window
- `src/connectors/outlook.ts` — Implement `rollbackSync()`: re-fetch events with `lastModifiedDateTime` filter
- `src/connectors/state-machine.ts` — Add rollback scheduling logic
- `src/store.ts` — Handle `_deleted` flag in sync loop

**Risk assessment:** LOW-MEDIUM. The rollback sync reuses existing API endpoints with different time filters. The main risk is API rate limits from re-fetching overlapping data, mitigated by content_hash dedup (API calls happen but DB writes are skipped for unchanged content).

### Architect Perspective

**System design impact:** The rollback phase slots into the existing state machine. No new tables or fundamental architecture changes.

**Data model changes:** None beyond what connector-state-machine already adds. The `_deleted` detection uses existing `status` column (`"archived"`).

**Integration points:**
- State machine triggers rollback every N incremental syncs (configurable)
- Each connector implements `rollbackSync()` using its existing API methods with modified time filters
- `syncConnector()` handles `_deleted` entities by setting `status: "archived"`

### Devil's Advocate

**What could go wrong?**
- API rate limiting: Rollback re-fetches recent data that was already fetched. For GitHub (5000 req/hr), this is fine. For Slack (tier 3, ~50 req/min), this could be tight with many channels. Mitigation: rollback window is configurable per connector.
- Soft deletes vs hard deletes: Some APIs don't report deleted items (GitHub closed issues are "closed", not deleted). Mitigation: connectors only mark entities as `"archived"` for source-reported deletions. For APIs that don't support delete detection, rollback still catches edits.

**Over-engineering concerns:**
- Automatic rollback scheduling (every Nth sync) might be unnecessary if users can just trigger `connector_sync --rollback` manually. Counter: Manual triggers defeat the purpose of reliable automation.

**Alternative simpler approaches:**
- Just run full sync periodically instead of a targeted rollback window. This works but is O(total entities) instead of O(window entities). REJECTED for connectors with >1000 entities.
- Use webhook-based updates instead of polling. Ideal but requires external infrastructure setup (webhook endpoints, Slack Event API subscription). OUT OF SCOPE for now.

### Consensus Decision

**Go** — Unanimous.

**Scope adjustments:**
- Default rollback window: 6 hours
- Rollback frequency: every 5th incremental sync (configurable)
- Delete detection: implement for GitHub (state=closed) and Notion (archived pages). Slack and Calendar: edits only, no delete detection.
- Skip rollback for connectors that don't implement `rollbackSync()` — just continue with incremental

**Implementation order:** First P2 feature, after both P1 features are complete.

## Acceptance Criteria

1. GitHub connector's `rollbackSync()` re-fetches PRs and issues updated within the window; entities edited retroactively are updated in hive-memory.
2. Notion connector's `rollbackSync()` re-queries pages with `last_edited_time >= window_start`; property changes are reflected.
3. State machine triggers rollback phase every 5th incremental sync (configurable via `CORTEX_ROLLBACK_FREQUENCY`).
4. Entities whose content_hash is unchanged during rollback are skipped (0 DB writes).
5. Entities marked `_deleted` in source get `status: "archived"` in hive-memory.
6. `connector_status` shows when last rollback ran and what it found.
7. Rollback window is configurable per connector via `CORTEX_ROLLBACK_WINDOW_HOURS` (default: 6).

## Impact

- **Modified:** `src/connectors/types.ts` — add `_deleted?` to RawDocument, document `rollbackSync()` (~5 lines)
- **Modified:** `src/connectors/github.ts` — implement `rollbackSync()` (~30 lines)
- **Modified:** `src/connectors/slack.ts` — implement `rollbackSync()` (~20 lines)
- **Modified:** `src/connectors/notion.ts` — implement `rollbackSync()` (~20 lines)
- **Modified:** `src/connectors/calendar.ts` — implement `rollbackSync()` (~20 lines)
- **Modified:** `src/connectors/outlook.ts` — implement `rollbackSync()` (~20 lines)
- **Modified:** `src/connectors/state-machine.ts` — add rollback scheduling logic (~25 lines)
- **Modified:** `src/store.ts` — handle `_deleted` flag in sync loop (~10 lines)
