/**
 * CheckpointManager — persists sync progress to disk so long-running
 * connector syncs can resume after interruption.
 *
 * Checkpoint files are stored in ~/.cortex/sync-state/<connectorId>.json
 * and automatically expire after 24 hours.
 */

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
const CHECKPOINT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

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
        console.error(
          `[checkpoint:${this.connectorId}] Checkpoint expired (${Math.round(age / 3600000)}h old), starting fresh`,
        );
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
  updateCounts(delta: {
    added?: number;
    updated?: number;
    skipped?: number;
    errors?: number;
  }): void {
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
  getProgress(): {
    totalProcessed: number;
    streams: number;
    lastCheckpoint: string;
  } | null {
    if (!this.checkpoint) return null;
    const total = this.checkpoint.counts;
    return {
      totalProcessed: total.added + total.updated + total.skipped,
      streams: Object.keys(this.checkpoint.streams).length,
      lastCheckpoint: this.checkpoint.lastCheckpointAt,
    };
  }

  /** Check whether a checkpoint file exists on disk. */
  hasCheckpointFile(): boolean {
    return existsSync(this.getPath());
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
