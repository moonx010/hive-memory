import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../src/db/database.js";
import { ConnectorStateMachine } from "../src/connectors/state-machine.js";
import type { SyncPhase } from "../src/connectors/types.js";

/** Create a HiveDatabase backed by a fresh temp directory. */
async function createTestDb() {
  const dataDir = await mkdtemp(join(tmpdir(), "cortex-rollback-test-"));
  const db = new HiveDatabase(join(dataDir, "test.db"));
  return { db, dataDir };
}

/** Seed a connector with a given phase. */
function seedConnector(db: HiveDatabase, id: string, opts: { syncPhase?: SyncPhase } = {}) {
  db.upsertConnector({
    id,
    connectorType: id,
    config: {},
    status: "idle",
    syncPhase: opts.syncPhase ?? "initial",
    syncHistory: "[]",
  });
}

describe("ConnectorStateMachine — rollback scheduling", () => {
  let db: HiveDatabase;
  let dataDir: string;
  let sm: ConnectorStateMachine;

  beforeEach(async () => {
    const ctx = await createTestDb();
    db = ctx.db;
    dataDir = ctx.dataDir;
    sm = new ConnectorStateMachine(db);
    // Ensure rollback frequency env vars are unset (use defaults)
    delete process.env.CORTEX_ROLLBACK_FREQUENCY;
    delete process.env.CORTEX_ROLLBACK_WINDOW_HOURS;
  });

  afterEach(async () => {
    delete process.env.CORTEX_ROLLBACK_FREQUENCY;
    delete process.env.CORTEX_ROLLBACK_WINDOW_HOURS;
    await rm(dataDir, { recursive: true, force: true });
  });

  // ── shouldRollback via getExecutionPhase ──────────────────────────────────

  describe("getExecutionPhase with rollback injection", () => {
    it("returns 'incremental' when fewer than 5 incremental syncs have run (default freq=5)", () => {
      seedConnector(db, "github", { syncPhase: "incremental" });
      // Run 4 incremental syncs (below threshold of 5)
      for (let i = 0; i < 4; i++) {
        sm.completeSync("github", { added: 1, updated: 0, skipped: 0, errors: 0 });
      }
      expect(sm.getExecutionPhase("github", false)).toBe("incremental");
    });

    it("returns 'rollback' after 5 consecutive incremental syncs (default freq=5)", () => {
      seedConnector(db, "github", { syncPhase: "incremental" });
      // Run 5 incremental syncs to trigger rollback
      for (let i = 0; i < 5; i++) {
        sm.completeSync("github", { added: 1, updated: 0, skipped: 0, errors: 0 });
      }
      expect(sm.getExecutionPhase("github", false)).toBe("rollback");
    });

    it("resets rollback counter after a rollback sync", () => {
      seedConnector(db, "github", { syncPhase: "incremental" });
      // 5 incrementals → triggers rollback
      for (let i = 0; i < 5; i++) {
        sm.completeSync("github", { added: 1, updated: 0, skipped: 0, errors: 0 });
      }
      // Simulate rollback completion
      db.upsertConnector({
        id: "github",
        connectorType: "github",
        config: {},
        status: "idle",
        syncPhase: "rollback",
        syncHistory: sm["db"].getConnector("github")?.syncHistory ?? "[]",
      });
      sm.completeSync("github", { added: 0, updated: 2, skipped: 98, errors: 0 });
      // Now the counter resets; need 5 more incrementals
      expect(sm.getExecutionPhase("github", false)).toBe("incremental");
    });

    it("disables rollback when CORTEX_ROLLBACK_FREQUENCY=0", () => {
      process.env.CORTEX_ROLLBACK_FREQUENCY = "0";
      seedConnector(db, "github", { syncPhase: "incremental" });
      // Run 10 incrementals — rollback should never trigger
      for (let i = 0; i < 10; i++) {
        sm.completeSync("github", { added: 1, updated: 0, skipped: 0, errors: 0 });
      }
      expect(sm.getExecutionPhase("github", false)).toBe("incremental");
    });

    it("respects custom CORTEX_ROLLBACK_FREQUENCY", () => {
      process.env.CORTEX_ROLLBACK_FREQUENCY = "3";
      seedConnector(db, "github", { syncPhase: "incremental" });
      // 2 incrementals — below threshold of 3
      for (let i = 0; i < 2; i++) {
        sm.completeSync("github", { added: 1, updated: 0, skipped: 0, errors: 0 });
      }
      expect(sm.getExecutionPhase("github", false)).toBe("incremental");
      // 3rd incremental pushes count to 3 → triggers rollback
      sm.completeSync("github", { added: 1, updated: 0, skipped: 0, errors: 0 });
      expect(sm.getExecutionPhase("github", false)).toBe("rollback");
    });
  });

  // ── getRollbackWindow ─────────────────────────────────────────────────────

  describe("getRollbackWindow", () => {
    it("returns a 6-hour window by default", () => {
      const before = Date.now();
      const window = sm.getRollbackWindow();
      const after = Date.now();

      const since = new Date(window.since).getTime();
      const until = new Date(window.until).getTime();

      // Window duration should be ~6 hours
      const diffHours = (until - since) / (60 * 60 * 1000);
      expect(diffHours).toBeCloseTo(6, 0);

      // 'until' should be around now
      expect(until).toBeGreaterThanOrEqual(before);
      expect(until).toBeLessThanOrEqual(after + 100);
    });

    it("respects custom CORTEX_ROLLBACK_WINDOW_HOURS", () => {
      process.env.CORTEX_ROLLBACK_WINDOW_HOURS = "12";
      const window = sm.getRollbackWindow();
      const since = new Date(window.since).getTime();
      const until = new Date(window.until).getTime();
      const diffHours = (until - since) / (60 * 60 * 1000);
      expect(diffHours).toBeCloseTo(12, 0);
    });
  });
});
