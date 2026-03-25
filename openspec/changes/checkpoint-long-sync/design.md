# Design: checkpoint-long-sync

## CheckpointManager

New file: `src/connectors/checkpoint.ts`

```typescript
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface SyncCheckpoint {
  connectorId: string;
  phase: "initial";
  startedAt: string;
  lastCheckpointAt: string;
  /** Per-stream pagination state */
  streams: Record<string, StreamCheckpoint>;
  /** Running counts */
  counts: { added: number; updated: number; skipped: number; errors: number };
}

export interface StreamCheckpoint {
  /** Opaque page token for API pagination resume */
  pageToken?: string;
  /** Number of pages processed in this stream */
  pagesProcessed: number;
  /** Whether this stream is complete */
  complete: boolean;
}

const CHECKPOINT_DIR = join(homedir(), ".cortex", "sync-state");
const CHECKPOINT_EXPIRY_MS = 24 * 60 * 60 * 1000;  // 24 hours

export class CheckpointManager {
  private checkpoint: SyncCheckpoint | null = null;
  private dirty = false;

  constructor(private connectorId: string) {}

  /** Load an existing checkpoint if it exists and hasn't expired. */
  load(): SyncCheckpoint | null {
    const path = this.getPath();
    if (!existsSync(path)) return null;

    try {
      const raw = readFileSync(path, "utf-8");
      const cp = JSON.parse(raw) as SyncCheckpoint;

      // Check expiry
      const age = Date.now() - new Date(cp.lastCheckpointAt).getTime();
      if (age > CHECKPOINT_EXPIRY_MS) {
        console.error(`[checkpoint:${this.connectorId}] Checkpoint expired (${Math.round(age / 3600000)}h old), starting fresh`);
        this.delete();
        return null;
      }

      this.checkpoint = cp;
      return cp;
    } catch {
      this.delete();
      return null;
    }
  }

  /** Create a new checkpoint for a fresh sync. */
  create(): SyncCheckpoint {
    this.checkpoint = {
      connectorId: this.connectorId,
      phase: "initial",
      startedAt: new Date().toISOString(),
      lastCheckpointAt: new Date().toISOString(),
      streams: {},
      counts: { added: 0, updated: 0, skipped: 0, errors: 0 },
    };
    this.save();
    return this.checkpoint;
  }

  /** Update stream pagination state and save to disk. */
  updateStream(streamId: string, update: Partial<StreamCheckpoint>): void {
    if (!this.checkpoint) return;
    const stream = this.checkpoint.streams[streamId] ?? {
      pagesProcessed: 0,
      complete: false,
    };
    Object.assign(stream, update);
    this.checkpoint.streams[streamId] = stream;
    this.checkpoint.lastCheckpointAt = new Date().toISOString();
    this.dirty = true;
  }

  /** Update running counts. */
  updateCounts(delta: { added?: number; updated?: number; skipped?: number; errors?: number }): void {
    if (!this.checkpoint) return;
    const c = this.checkpoint.counts;
    if (delta.added) c.added += delta.added;
    if (delta.updated) c.updated += delta.updated;
    if (delta.skipped) c.skipped += delta.skipped;
    if (delta.errors) c.errors += delta.errors;
    this.dirty = true;
  }

  /** Flush dirty checkpoint to disk. Call after each pagination page. */
  flush(): void {
    if (!this.dirty || !this.checkpoint) return;
    this.save();
    this.dirty = false;
  }

  /** Check if a specific stream was already completed in a previous run. */
  isStreamComplete(streamId: string): boolean {
    return this.checkpoint?.streams[streamId]?.complete ?? false;
  }

  /** Get the resume page token for a stream. */
  getStreamPageToken(streamId: string): string | undefined {
    return this.checkpoint?.streams[streamId]?.pageToken;
  }

  /** Get current progress summary. */
  getProgress(): { totalProcessed: number; streams: number; lastCheckpoint: string } | null {
    if (!this.checkpoint) return null;
    const total = this.checkpoint.counts;
    return {
      totalProcessed: total.added + total.updated + total.skipped,
      streams: Object.keys(this.checkpoint.streams).length,
      lastCheckpoint: this.checkpoint.lastCheckpointAt,
    };
  }

  /** Delete the checkpoint file (called on successful completion). */
  delete(): void {
    const path = this.getPath();
    try {
      unlinkSync(path);
    } catch {
      // File may not exist
    }
    this.checkpoint = null;
  }

  private save(): void {
    mkdirSync(CHECKPOINT_DIR, { recursive: true });
    writeFileSync(this.getPath(), JSON.stringify(this.checkpoint, null, 2));
  }

  private getPath(): string {
    return join(CHECKPOINT_DIR, `${this.connectorId}.json`);
  }
}
```

## GitHub Connector Integration

The GitHub connector's pagination methods need to accept optional resume parameters.

### Stream ID Convention

Each API endpoint gets a unique stream ID:
- `"github:{repo}:pulls"` — PR pagination
- `"github:{repo}:issues"` — Issue pagination
- `"github:{repo}:adr:{path}"` — ADR files (single page, no pagination)

### Modified _syncPRs with checkpoint

```typescript
private async *_syncPRs(
  repo: string,
  since?: string,
  checkpoint?: CheckpointManager,
): AsyncGenerator<RawDocument> {
  const streamId = `github:${repo}:pulls`;

  // Skip if stream was completed in a previous run
  if (checkpoint?.isStreamComplete(streamId)) return;

  const sinceParam = since ? `&since=${since}` : "";
  let url: string | null = `https://api.github.com/repos/${repo}/pulls?state=all&per_page=100&sort=updated&direction=desc${sinceParam}`;

  // Resume from checkpoint page token if available
  const resumeToken = checkpoint?.getStreamPageToken(streamId);
  if (resumeToken) {
    url = resumeToken;  // GitHub Link header URLs are absolute
  }

  while (url) {
    const res = await githubFetch(url, this.token);
    const items = (await res.json()) as GitHubPR[];

    for (const pr of items) {
      if (since && pr.updated_at < since) {
        checkpoint?.updateStream(streamId, { complete: true });
        checkpoint?.flush();
        return;
      }

      yield {
        externalId: `github:pr:${repo}:${pr.number}`,
        // ... rest of RawDocument ...
      };
    }

    // Parse next page URL
    const link = res.headers.get("Link") ?? "";
    const nextMatch = /<([^>]+)>;\s*rel="next"/.exec(link);
    const nextUrl = nextMatch?.[1] ?? null;

    // Checkpoint after each page
    checkpoint?.updateStream(streamId, { pageToken: nextUrl ?? undefined, pagesProcessed: (checkpoint.getProgress()?.streams ?? 0) + 1 });
    checkpoint?.flush();

    url = nextUrl;
  }

  checkpoint?.updateStream(streamId, { complete: true });
  checkpoint?.flush();
}
```

## Notion Connector Integration

Similar pattern — checkpoint after each database query page:

```typescript
private async *_queryDatabase(
  databaseId: string,
  since?: string,
  checkpoint?: CheckpointManager,
): AsyncGenerator<RawDocument> {
  const streamId = `notion:db:${databaseId}`;
  if (checkpoint?.isStreamComplete(streamId)) return;

  let nextCursor: string | undefined = checkpoint?.getStreamPageToken(streamId);

  do {
    await sleep(REQUEST_DELAY_MS);
    const body: Record<string, unknown> = { page_size: 100 };
    if (since) { /* ... filter ... */ }
    if (nextCursor) body["start_cursor"] = nextCursor;

    const res = await notionFetch(`/databases/${databaseId}/query`, this.token, { method: "POST", body });
    const data = (await res.json()) as NotionSearchResponse;

    for (const page of data.results) {
      const doc = await this._pageToRawDocument(page);
      if (doc) yield doc;
    }

    nextCursor = data.next_cursor ?? undefined;

    // Checkpoint after each page
    checkpoint?.updateStream(streamId, { pageToken: nextCursor, pagesProcessed: (checkpoint.getProgress()?.streams ?? 0) + 1 });
    checkpoint?.flush();
  } while (nextCursor);

  checkpoint?.updateStream(streamId, { complete: true });
  checkpoint?.flush();
}
```

## syncConnector() Integration

In `src/store.ts`:

```typescript
async syncConnector(connectorId: string, full = false): Promise<SyncResult> {
  // ... existing setup ...

  const db = this.database;
  const sm = new ConnectorStateMachine(db);
  const phase = sm.getExecutionPhase(connectorId, full);

  // Checkpoint: only for initial phase
  let cpManager: CheckpointManager | undefined;
  if (phase === "initial") {
    cpManager = new CheckpointManager(connectorId);
    const existingCp = cpManager.load();
    if (existingCp) {
      console.error(`[sync:${connectorId}] Resuming from checkpoint (${existingCp.counts.added + existingCp.counts.updated} entities processed)`);
      added = existingCp.counts.added;
      updated = existingCp.counts.updated;
      skipped = existingCp.counts.skipped;
      errors = existingCp.counts.errors;
    } else {
      cpManager.create();
    }
  }

  // ... sync loop with checkpoint.updateCounts() calls ...

  // On success: delete checkpoint
  cpManager?.delete();

  // ... existing completion logic ...
}
```

## connector_status Enhancement

```typescript
// In connector-tools.ts
if (checkpoint) {
  const progress = checkpoint.getProgress();
  status.checkpoint = {
    inProgress: true,
    processed: progress.totalProcessed,
    streams: progress.streams,
    lastCheckpoint: progress.lastCheckpoint,
  };
}
```
