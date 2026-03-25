# Design: rollback-sync-window

## RawDocument Extension

In `src/connectors/types.ts`:

```typescript
export interface RawDocument {
  externalId: string;
  source: string;
  content: string;
  title?: string;
  url?: string;
  author?: string;
  timestamp: string;
  metadata: Record<string, unknown>;
  /** Set to true when the source system reports this entity as deleted/archived.
   *  syncConnector() will mark the corresponding entity as status: "archived". */
  _deleted?: boolean;
}
```

## Rollback Scheduling in State Machine

In `src/connectors/state-machine.ts`, add rollback frequency tracking:

```typescript
const DEFAULT_ROLLBACK_FREQUENCY = 5;  // every 5th incremental sync
const DEFAULT_ROLLBACK_WINDOW_HOURS = 6;

export class ConnectorStateMachine {
  // ... existing methods ...

  /** Determine execution phase, potentially injecting a rollback. */
  getExecutionPhase(connectorId: string, forceInitial: boolean): SyncPhase {
    if (forceInitial) return "initial";

    const phase = this.getPhase(connectorId);
    if (phase !== "incremental") return phase;

    // Check if it's time for a rollback
    if (this.shouldRollback(connectorId)) {
      return "rollback";
    }

    return "incremental";
  }

  private shouldRollback(connectorId: string): boolean {
    const freq = parseInt(
      process.env.CORTEX_ROLLBACK_FREQUENCY ?? String(DEFAULT_ROLLBACK_FREQUENCY),
      10,
    );
    if (freq <= 0) return false;  // disabled

    const history = this.getHistory(connectorId);
    const incrementalsSinceLastRollback = this.countIncrementalsSinceLastRollback(history);
    return incrementalsSinceLastRollback >= freq;
  }

  private countIncrementalsSinceLastRollback(history: SyncHistoryEntry[]): number {
    let count = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].phase === "rollback") break;
      if (history[i].phase === "incremental") count++;
    }
    return count;
  }

  /** Get the rollback window timestamps. */
  getRollbackWindow(): { since: string; until: string } {
    const hours = parseInt(
      process.env.CORTEX_ROLLBACK_WINDOW_HOURS ?? String(DEFAULT_ROLLBACK_WINDOW_HOURS),
      10,
    );
    const now = new Date();
    const since = new Date(now.getTime() - hours * 60 * 60 * 1000);
    return { since: since.toISOString(), until: now.toISOString() };
  }
}
```

## Connector rollbackSync() Implementations

### GitHub

```typescript
// In src/connectors/github.ts
async *rollbackSync(window: { since: string; until: string }): AsyncGenerator<RawDocument> {
  // Re-fetch PRs and issues updated within the rollback window
  for (const repo of this.repos) {
    yield* this._syncPRs(repo, window.since);
    yield* this._syncIssues(repo, window.since);
    // ADRs and CODEOWNERS don't need rollback (rarely change)
  }
}
```

GitHub's existing `_syncPRs` and `_syncIssues` already accept a `since` parameter, so rollbackSync reuses them directly with the window start time. The content_hash dedup in syncConnector() ensures unchanged entities aren't re-written.

### Slack

```typescript
// In src/connectors/slack.ts
async *rollbackSync(window: { since: string; until: string }): AsyncGenerator<RawDocument> {
  const oldest = (new Date(window.since).getTime() / 1000).toString();
  yield* this._syncChannels(oldest);
}
```

Slack's `_syncChannels` already accepts an `oldest` timestamp parameter.

### Notion

```typescript
// In src/connectors/notion.ts
async *rollbackSync(window: { since: string; until: string }): AsyncGenerator<RawDocument> {
  this.cursor = new Date().toISOString();
  yield* this._searchAll(window.since);
}
```

Notion's `_searchAll` already filters by `last_edited_time >= since`.

### Calendar (Google)

```typescript
// In src/connectors/calendar.ts
async *rollbackSync(window: { since: string; until: string }): AsyncGenerator<RawDocument> {
  this._lastSyncStart = new Date().toISOString();
  this._syncedDrafts = [];
  yield* this.fetchEvents({ updatedMin: window.since });
}
```

### Calendar (Outlook)

```typescript
// In src/connectors/outlook.ts
async *rollbackSync(window: { since: string; until: string }): AsyncGenerator<RawDocument> {
  this._lastSyncStart = new Date().toISOString();
  this._syncedDrafts = [];
  yield* this.fetchEvents({ lastModifiedSince: window.since });
}
```

## Delete Detection

### syncConnector() Changes

In `src/store.ts`, within the sync loop, after `connector.transform(doc)`:

```typescript
for (const doc of gen) {
  // Check for source-reported deletion
  if (doc._deleted) {
    const existing = db.getByExternalId(/* source */, doc.externalId);
    if (existing && existing.status !== "archived") {
      db.updateEntity(existing.id, {
        status: "archived",
        updatedAt: new Date().toISOString(),
      });
      archived++;
    }
    continue;
  }

  // ... existing transform + upsert logic ...
}
```

Add `archived: number` to the return type.

### GitHub Delete Detection

GitHub doesn't truly delete PRs/issues, but state changes are detectable:
- PR `state: "closed"` without `merged_at` = potentially abandoned (mark with tag, not archive)
- Issue `state: "closed"` = resolved (mark with tag, not archive)

True deletion detection is not possible via GitHub API. We mark state changes via attributes, not status.

### Notion Delete Detection

Notion's search API excludes archived pages by default. During rollback, we can detect "missing" entities:
- Entities that exist in hive-memory with `source_system: "notion"` but were not returned by the rollback query are potentially archived.
- This requires a set-difference check after rollback sync completes.

```typescript
// After rollback sync for Notion
const notionEntities = db.listEntities({
  source_system: "notion",
  since: window.since,
});
const returnedIds = new Set(/* externalIds from rollback */);
for (const entity of notionEntities) {
  if (!returnedIds.has(entity.source.externalId) && entity.status === "active") {
    // Potentially archived in Notion — mark for review
    db.updateEntityAttributes(entity.id, { _potentiallyArchived: true });
  }
}
```

## Configuration

Environment variables:
- `CORTEX_ROLLBACK_FREQUENCY` — Run rollback every N incremental syncs (default: 5, 0 = disabled)
- `CORTEX_ROLLBACK_WINDOW_HOURS` — How far back to look (default: 6)

Per-connector override possible via connector config JSON:
```json
{
  "rollbackFrequency": 3,
  "rollbackWindowHours": 12
}
```
