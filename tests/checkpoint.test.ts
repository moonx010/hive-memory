import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { CheckpointManager } from "../src/connectors/checkpoint.js";
import type { SyncCheckpoint } from "../src/connectors/checkpoint.js";

describe("CheckpointManager", () => {
  let connectorId: string;

  beforeEach(() => {
    // Use a unique connector ID per test to avoid collisions
    connectorId = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    // Clean up the checkpoint file created by CheckpointManager
    const cp = new CheckpointManager(connectorId);
    cp.delete(); // safe even if file doesn't exist
  });

  // ── create() ─────────────────────────────────────────────────────────────

  it("create() writes checkpoint file to disk", () => {
    const cp = new CheckpointManager(connectorId);
    const checkpoint = cp.create();

    expect(checkpoint.connectorId).toBe(connectorId);
    expect(checkpoint.phase).toBe("initial");
    expect(checkpoint.counts).toEqual({ added: 0, updated: 0, skipped: 0, errors: 0 });
    expect(checkpoint.streams).toEqual({});

    // File must exist after create()
    expect(cp.hasCheckpointFile()).toBe(true);
  });

  // ── load() ────────────────────────────────────────────────────────────────

  it("load() returns null when no file exists", () => {
    const cp = new CheckpointManager(connectorId);
    expect(cp.load()).toBeNull();
  });

  it("load() returns the checkpoint after create()", () => {
    const cp = new CheckpointManager(connectorId);
    cp.create();

    const loaded = cp.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.connectorId).toBe(connectorId);
  });

  it("load() returns null for expired checkpoint (>24h)", () => {
    const cp = new CheckpointManager(connectorId);
    cp.create();

    // Manually write a stale checkpoint
    const stale: SyncCheckpoint = {
      connectorId,
      phase: "initial",
      startedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
      lastCheckpointAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
      streams: {},
      counts: { added: 5, updated: 0, skipped: 0, errors: 0 },
    };

    // Write directly via the internal path by reusing a fresh manager
    const cp2 = new CheckpointManager(connectorId);
    // We need to write the stale file manually since there's no public setter
    // Get the path by creating and then overwriting
    cp2.create();
    const cpPath = getCheckpointPath(connectorId);
    writeFileSync(cpPath, JSON.stringify(stale, null, 2));

    const loaded = cp2.load();
    expect(loaded).toBeNull();
  });

  // ── updateStream() + flush() ──────────────────────────────────────────────

  it("updateStream() + flush() persists stream state", () => {
    const cp = new CheckpointManager(connectorId);
    cp.create();

    cp.updateStream("github:repo:pulls", { pageToken: "https://api.github.com/page=2", pagesProcessed: 1 });
    cp.flush();

    // Load fresh manager to confirm it was written
    const cp2 = new CheckpointManager(connectorId);
    const loaded = cp2.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.streams["github:repo:pulls"]).toBeDefined();
    expect(loaded!.streams["github:repo:pulls"].pageToken).toBe("https://api.github.com/page=2");
    expect(loaded!.streams["github:repo:pulls"].pagesProcessed).toBe(1);
  });

  // ── isStreamComplete() ────────────────────────────────────────────────────

  it("isStreamComplete() returns false for unknown stream", () => {
    const cp = new CheckpointManager(connectorId);
    cp.create();
    expect(cp.isStreamComplete("github:repo:pulls")).toBe(false);
  });

  it("isStreamComplete() returns true for completed streams", () => {
    const cp = new CheckpointManager(connectorId);
    cp.create();

    cp.updateStream("github:repo:pulls", { complete: true });
    expect(cp.isStreamComplete("github:repo:pulls")).toBe(true);
  });

  // ── getStreamPageToken() ──────────────────────────────────────────────────

  it("getStreamPageToken() returns undefined for unknown stream", () => {
    const cp = new CheckpointManager(connectorId);
    cp.create();
    expect(cp.getStreamPageToken("github:repo:pulls")).toBeUndefined();
  });

  it("getStreamPageToken() returns saved token", () => {
    const cp = new CheckpointManager(connectorId);
    cp.create();

    cp.updateStream("github:repo:pulls", { pageToken: "https://api.github.com/page=3" });
    expect(cp.getStreamPageToken("github:repo:pulls")).toBe("https://api.github.com/page=3");
  });

  // ── updateCounts() ────────────────────────────────────────────────────────

  it("updateCounts() correctly increments counters", () => {
    const cp = new CheckpointManager(connectorId);
    cp.create();

    cp.updateCounts({ added: 10, updated: 5, skipped: 2, errors: 1 });
    cp.flush();

    const cp2 = new CheckpointManager(connectorId);
    const loaded = cp2.load();
    expect(loaded!.counts).toEqual({ added: 10, updated: 5, skipped: 2, errors: 1 });
  });

  it("updateCounts() accumulates across multiple calls", () => {
    const cp = new CheckpointManager(connectorId);
    cp.create();

    cp.updateCounts({ added: 10 });
    cp.updateCounts({ added: 5, updated: 3 });
    cp.flush();

    const cp2 = new CheckpointManager(connectorId);
    const loaded = cp2.load();
    expect(loaded!.counts.added).toBe(15);
    expect(loaded!.counts.updated).toBe(3);
  });

  // ── delete() ──────────────────────────────────────────────────────────────

  it("delete() removes the checkpoint file", () => {
    const cp = new CheckpointManager(connectorId);
    cp.create();
    expect(cp.hasCheckpointFile()).toBe(true);

    cp.delete();
    expect(cp.hasCheckpointFile()).toBe(false);
  });

  it("delete() is safe when file does not exist", () => {
    const cp = new CheckpointManager(connectorId);
    // Should not throw
    expect(() => cp.delete()).not.toThrow();
  });

  // ── getProgress() ─────────────────────────────────────────────────────────

  it("getProgress() returns null before create()", () => {
    const cp = new CheckpointManager(connectorId);
    expect(cp.getProgress()).toBeNull();
  });

  it("getProgress() returns correct summary after updates", () => {
    const cp = new CheckpointManager(connectorId);
    cp.create();
    cp.updateCounts({ added: 10, updated: 5, skipped: 3 });
    cp.updateStream("stream:a", { complete: true });
    cp.updateStream("stream:b", { pagesProcessed: 2 });

    const progress = cp.getProgress();
    expect(progress).not.toBeNull();
    expect(progress!.totalProcessed).toBe(18); // 10 + 5 + 3
    expect(progress!.streams).toBe(2);
  });

  // ── flush() — dirty flag ──────────────────────────────────────────────────

  it("flush() only writes when dirty", () => {
    const cp = new CheckpointManager(connectorId);
    cp.create();

    // flush with no dirty flag should be a no-op (no error)
    expect(() => cp.flush()).not.toThrow();
  });

  // ── checkpoint survives simulated failure ─────────────────────────────────

  it("checkpoint survives simulated failure and can be resumed", () => {
    // Simulate: sync starts, processes 10 entities, then crashes
    const cp = new CheckpointManager(connectorId);
    cp.create();
    cp.updateCounts({ added: 5, updated: 5 });
    cp.updateStream("github:repo:pulls", { pageToken: "https://api.github.com/page=2", pagesProcessed: 1 });
    cp.flush();
    // Simulate crash — cp object is discarded without calling delete()

    // Resume: create new manager with same connectorId
    const cp2 = new CheckpointManager(connectorId);
    const loaded = cp2.load();

    expect(loaded).not.toBeNull();
    expect(loaded!.counts.added).toBe(5);
    expect(loaded!.counts.updated).toBe(5);
    expect(cp2.getStreamPageToken("github:repo:pulls")).toBe("https://api.github.com/page=2");
    expect(cp2.isStreamComplete("github:repo:pulls")).toBe(false);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Get the checkpoint file path used by CheckpointManager for a given connectorId. */
function getCheckpointPath(connectorId: string): string {
  return join(homedir(), ".cortex", "sync-state", `${connectorId}.json`);
}
