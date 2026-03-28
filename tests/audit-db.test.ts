import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../src/db/database.js";

async function createTestDb(): Promise<{ db: HiveDatabase; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cortex-audit-db-test-"));
  const db = new HiveDatabase(join(dir, "test.db"));
  return { db, dir };
}

describe("audit_log DB persistence", () => {
  let db: HiveDatabase;
  let dir: string;

  beforeEach(async () => {
    const ctx = await createTestDb();
    db = ctx.db;
    dir = ctx.dir;
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("insertAuditEntry persists a full entry to the DB", () => {
    db.insertAuditEntry({
      timestamp: "2024-01-01T00:00:00.000Z",
      userId: "user-1",
      action: "search",
      toolName: "memory_recall",
      query: "test query",
      resultCount: 5,
    });

    const entries = db.queryAuditLog({ limit: 10 });
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.userId).toBe("user-1");
    expect(entry.action).toBe("search");
    expect(entry.toolName).toBe("memory_recall");
    expect(entry.query).toBe("test query");
    expect(entry.resultCount).toBe(5);
  });

  it("queryAuditLog filters by userId", () => {
    db.insertAuditEntry({ timestamp: new Date().toISOString(), userId: "user-a", action: "read" });
    db.insertAuditEntry({ timestamp: new Date().toISOString(), userId: "user-b", action: "write" });
    db.insertAuditEntry({ timestamp: new Date().toISOString(), userId: "user-a", action: "search" });

    const results = db.queryAuditLog({ userId: "user-a" });
    expect(results).toHaveLength(2);
    expect(results.every(e => e.userId === "user-a")).toBe(true);
  });

  it("queryAuditLog filters by time range", () => {
    db.insertAuditEntry({ timestamp: "2024-01-01T00:00:00.000Z", action: "read" });
    db.insertAuditEntry({ timestamp: "2024-06-01T00:00:00.000Z", action: "write" });
    db.insertAuditEntry({ timestamp: "2024-12-31T00:00:00.000Z", action: "admin" });

    const results = db.queryAuditLog({
      since: "2024-02-01T00:00:00.000Z",
      until: "2024-11-01T00:00:00.000Z",
    });
    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("write");
  });

  it("audit log survives restart — reads from DB after reconnect", () => {
    const dbPath = join(dir, "test.db");

    db.insertAuditEntry({
      timestamp: "2024-03-15T10:00:00.000Z",
      userId: "persistent-user",
      action: "write",
      toolName: "memory_store",
    });
    db.close();

    // Reopen the same DB file
    const db2 = new HiveDatabase(dbPath);
    const entries = db2.queryAuditLog({ userId: "persistent-user" });
    expect(entries).toHaveLength(1);
    expect(entries[0].toolName).toBe("memory_store");
    db2.close();
  });

  it("queryAuditLog respects limit", () => {
    for (let i = 0; i < 10; i++) {
      db.insertAuditEntry({ timestamp: new Date().toISOString(), action: "read" });
    }

    const results = db.queryAuditLog({ limit: 3 });
    expect(results).toHaveLength(3);
  });

  it("insertAuditEntry stores minimal entry without optional fields", () => {
    db.insertAuditEntry({
      timestamp: new Date().toISOString(),
      action: "read",
    });

    const entries = db.queryAuditLog({ limit: 1 });
    expect(entries).toHaveLength(1);
    expect(entries[0].userId).toBeUndefined();
    expect(entries[0].toolName).toBeUndefined();
    expect(entries[0].query).toBeUndefined();
    expect(entries[0].metadata).toEqual({});
  });
});
