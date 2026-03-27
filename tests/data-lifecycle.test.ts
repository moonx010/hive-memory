import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../src/db/database.js";
import { DataLifecycleManager } from "../src/pipeline/lifecycle.js";
import type { Entity } from "../src/types.js";

function makeEntity(overrides: Partial<Entity> = {}): Entity {
  const now = new Date().toISOString();
  return {
    id: Math.random().toString(36).slice(2),
    entityType: "memory",
    namespace: "local",
    content: "test entity content",
    tags: [],
    keywords: [],
    attributes: {},
    source: { system: "agent" },
    visibility: "personal",
    domain: "code",
    confidence: "confirmed",
    createdAt: now,
    updatedAt: now,
    status: "active",
    ...overrides,
  };
}

describe("DataLifecycleManager", () => {
  let db: HiveDatabase;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "lifecycle-mgr-"));
    db = new HiveDatabase(join(tempDir, "test.db"));
  });

  afterEach(async () => {
    db.close();
    try { await rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe("runLifecycle", () => {
    it("archives entities older than warmDays", () => {
      const oldDate = new Date(Date.now() - 400 * 86400000).toISOString();
      const entity = makeEntity({ updatedAt: oldDate, createdAt: oldDate });
      db.insertEntity(entity);

      const manager = new DataLifecycleManager(db, { hotDays: 30, warmDays: 365 });
      const result = manager.runLifecycle();

      expect(result.archived).toBe(1);

      const archived = db.listEntities({ status: "archived" });
      expect(archived).toHaveLength(1);
      expect(archived[0].id).toBe(entity.id);
    });

    it("does not archive recent entities", () => {
      const recentEntity = makeEntity();
      db.insertEntity(recentEntity);

      const manager = new DataLifecycleManager(db, { hotDays: 30, warmDays: 365 });
      const result = manager.runLifecycle();

      expect(result.archived).toBe(0);

      const active = db.listEntities({ status: "active" });
      expect(active).toHaveLength(1);
    });

    it("preserves decision entities regardless of age", () => {
      const oldDate = new Date(Date.now() - 400 * 86400000).toISOString();
      const decision = makeEntity({
        entityType: "decision",
        updatedAt: oldDate,
        createdAt: oldDate,
      });
      db.insertEntity(decision);

      const manager = new DataLifecycleManager(db, { hotDays: 30, warmDays: 365 });
      const result = manager.runLifecycle();

      expect(result.archived).toBe(0);
      const active = db.listEntities({ status: "active", entityType: "decision" });
      expect(active).toHaveLength(1);
    });

    it("preserves task entities regardless of age", () => {
      const oldDate = new Date(Date.now() - 400 * 86400000).toISOString();
      const task = makeEntity({
        entityType: "task",
        updatedAt: oldDate,
        createdAt: oldDate,
      });
      db.insertEntity(task);

      const manager = new DataLifecycleManager(db, { hotDays: 30, warmDays: 365 });
      const result = manager.runLifecycle();

      expect(result.archived).toBe(0);
    });

    it("preserves high-signal entities", () => {
      const oldDate = new Date(Date.now() - 400 * 86400000).toISOString();
      const highSignal = makeEntity({
        updatedAt: oldDate,
        createdAt: oldDate,
        attributes: { "high-signal": true },
      });
      db.insertEntity(highSignal);

      const manager = new DataLifecycleManager(db, { hotDays: 30, warmDays: 365 });
      const result = manager.runLifecycle();

      expect(result.archived).toBe(0);
    });

    it("returns hot and warm counts", () => {
      const recentDate = new Date().toISOString();
      const oldDate = new Date(Date.now() - 60 * 86400000).toISOString();

      db.insertEntity(makeEntity({ updatedAt: recentDate, createdAt: recentDate }));
      db.insertEntity(makeEntity({ updatedAt: recentDate, createdAt: recentDate }));
      db.insertEntity(makeEntity({ updatedAt: oldDate, createdAt: oldDate }));

      const manager = new DataLifecycleManager(db, { hotDays: 30, warmDays: 365 });
      const result = manager.runLifecycle();

      expect(result.hotCount).toBe(2);
      expect(result.warmCount).toBe(1);
    });
  });

  describe("getStats", () => {
    it("returns correct stats across tiers", () => {
      const recentDate = new Date().toISOString();
      const oldDate = new Date(Date.now() - 60 * 86400000).toISOString();

      db.insertEntity(makeEntity({ updatedAt: recentDate, createdAt: recentDate }));
      db.insertEntity(makeEntity({ updatedAt: oldDate, createdAt: oldDate }));

      const manager = new DataLifecycleManager(db, { hotDays: 30, warmDays: 365 });

      // Manually archive one to test stats
      const veryOldDate = new Date(Date.now() - 400 * 86400000).toISOString();
      const oldEntity = makeEntity({ updatedAt: veryOldDate, createdAt: veryOldDate });
      db.insertEntity(oldEntity);
      manager.runLifecycle(); // archives the very old one

      const stats = manager.getStats();

      expect(stats.total).toBeGreaterThanOrEqual(2);
      expect(stats.archived).toBeGreaterThanOrEqual(1);
      expect(stats.hot + stats.warm).toBe(stats.total);
    });

    it("returns zero counts for empty database", () => {
      const manager = new DataLifecycleManager(db);
      const stats = manager.getStats();

      expect(stats.total).toBe(0);
      expect(stats.hot).toBe(0);
      expect(stats.warm).toBe(0);
      expect(stats.archived).toBe(0);
    });
  });
});
