# Change: checkpoint-long-sync

**Layer:** 1 (Data Ingestion)
**One-liner:** Persist sync progress to a checkpoint file during long-running initial syncs, enabling resume on failure without re-fetching already-processed pages.
**Estimated effort:** 3 days
**Dependencies:** connector-state-machine (INITIAL phase), content-hash-dedup (skip already-ingested)
**Priority:** P3

## Design Review

### PM Perspective

**User problem:** Initial syncs for large data sources (GitHub repos with 5000+ PRs, Notion workspaces with 1000+ pages) can take 30+ minutes. If the sync fails at 80% due to a network error or rate limit, all progress is lost and the user must restart from scratch. This is especially painful for Notion, which has a 3 req/s rate limit — a 1000-page workspace takes ~15 minutes minimum.

**Success metrics:**
- Failed initial sync can resume from last checkpoint (not from scratch)
- Resume fetches <10% of already-processed pages on retry
- Checkpoint file is human-readable for debugging

**Priority justification:** P3 because this only matters for initial syncs of large workspaces. Once a connector is in incremental mode, syncs are fast. But for users onboarding a large organization, this is a critical UX improvement. Temporal and Dust both use checkpoint-based progress for exactly this reason.

### Tech Lead Perspective

**Implementation approach:**
1. Create a checkpoint file per connector at `~/.cortex/sync-state/{connectorId}.json`
2. Write checkpoint after each page of API results (e.g., after each GitHub pagination page, each Notion page batch)
3. Checkpoint contains: `{ phase, cursor, pageToken, processedIds[], startedAt, lastCheckpointAt }`
4. On resume: load checkpoint, skip to the last page token, skip entities in `processedIds`
5. On successful sync completion: delete the checkpoint file

**File changes:**
- `src/connectors/checkpoint.ts` — NEW: CheckpointManager class
- `src/connectors/types.ts` — Add checkpoint awareness to ConnectorPlugin interface
- `src/store.ts` — Integrate checkpoint save/load in syncConnector()
- Individual connectors (github.ts, notion.ts, slack.ts) — Accept checkpoint for resume

**Risk assessment:** MEDIUM. This adds I/O (file writes) inside the sync hot path. Mitigation: write checkpoints asynchronously and batch writes (every N entities, not every single entity). The checkpoint file is append-friendly.

### Architect Perspective

**System design impact:** Introduces a new file-based state alongside the SQLite database. The checkpoint is ephemeral — it exists only during active syncs and is deleted on completion. It's deliberately NOT in SQLite because:
1. SQLite writes during a long sync could contend with entity inserts (WAL mode helps but still)
2. The checkpoint needs to survive process crashes (file-based is simpler than ensuring SQLite tx commits)
3. It's temporary data that doesn't belong in the permanent store

**Data model:** No SQL changes. Checkpoint is a JSON file:

```json
{
  "connectorId": "github",
  "phase": "initial",
  "startedAt": "2026-03-25T10:00:00Z",
  "lastCheckpointAt": "2026-03-25T10:05:00Z",
  "cursor": null,
  "pagination": {
    "github:owner/repo:pulls": { "lastPage": 3, "pageToken": "abc123" },
    "github:owner/repo:issues": { "lastPage": 5, "pageToken": "def456" }
  },
  "processedExternalIds": ["github:pr:owner/repo:123", "github:pr:owner/repo:124"],
  "counts": { "added": 150, "updated": 0, "skipped": 0, "errors": 2 }
}
```

**Integration points:**
- `syncConnector()` — loads checkpoint on start, saves on each page, deletes on completion
- `ConnectorPlugin.fullSync()` — optionally accepts resume parameters
- `connector_status` — shows checkpoint presence and progress when sync is in progress

### Devil's Advocate

**What could go wrong?**
- Stale checkpoints: If a sync crashes and the user doesn't retry for days, the checkpoint is stale. Source data may have changed. Mitigation: checkpoints expire after 24 hours (configurable).
- Disk space: processedExternalIds list for 5000 entities is ~200KB. Negligible.
- Race conditions: Two concurrent syncs for the same connector could corrupt the checkpoint. Mitigation: use file locking (already have `src/store/lock.ts` pattern).

**Over-engineering concerns:**
- Is this worth building for a local tool? Most users have <1000 entities per connector. Counter: The target is company-wide context (v3 vision). Large orgs have 10k+ GitHub issues, 50k+ Slack messages.
- Could content_hash dedup handle this instead? Partially — on retry, entities already in the DB are skipped via content_hash. But the API re-fetch still happens (slow, rate-limited). Checkpoint skips the API calls entirely.

**Alternative simpler approaches:**
- Don't use a separate file. Store the checkpoint in the `connectors` table `sync_cursor` column. Simpler but loses progress on SQLite write failures and mixes ephemeral state with permanent state. REJECTED.
- Just rely on content_hash dedup for resume. On retry, re-fetch everything but skip DB writes for unchanged content. This is 50% of the benefit (saves DB writes) but not the other 50% (saves API calls). ACCEPTABLE as a fallback if checkpoint implementation is deferred.

### Consensus Decision

**Go** — with scope limitations.

**Scope adjustments:**
- Implement checkpoint for initial syncs only (not incremental/rollback — those are fast enough)
- Checkpoint granularity: per API pagination page, not per entity
- Skip per-entity `processedExternalIds` tracking — rely on content_hash dedup for entities within the same page. This simplifies the checkpoint significantly.
- Implement for GitHub and Notion only (the two connectors with largest datasets). Slack/Calendar can be added later.
- 24-hour checkpoint expiry

**Implementation order:** P3. Implement after all P1 and P2 features are stable.

## Acceptance Criteria

1. During initial sync of GitHub connector, a checkpoint file is written at `~/.cortex/sync-state/github.json` after each pagination page.
2. If initial sync is interrupted, `connector_sync github` resumes from the last checkpoint page.
3. On resume, entities already in the DB are skipped via content_hash dedup (no duplicate inserts).
4. On successful sync completion, the checkpoint file is deleted.
5. Checkpoints older than 24 hours are ignored (treated as expired, full restart).
6. `connector_status` shows `"checkpoint": { "progress": "150/~500", "lastCheckpoint": "..." }` during active syncs.
7. Notion connector checkpoints after each database query page.

## Impact

- **New file:** `src/connectors/checkpoint.ts` (~100 lines)
- **New directory:** `~/.cortex/sync-state/` (runtime, not in source)
- **Modified:** `src/connectors/types.ts` — add checkpoint-related types (~15 lines)
- **Modified:** `src/connectors/github.ts` — accept checkpoint parameters in pagination (~20 lines)
- **Modified:** `src/connectors/notion.ts` — accept checkpoint parameters in pagination (~20 lines)
- **Modified:** `src/store.ts` — integrate checkpoint load/save in syncConnector() (~30 lines)
- **Modified:** `src/tools/connector-tools.ts` — show checkpoint progress in status (~10 lines)
