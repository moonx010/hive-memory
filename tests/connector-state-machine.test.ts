import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../src/db/database.js";
import { ConnectorStateMachine } from "../src/connectors/state-machine.js";
import type { SyncPhase, SyncHistoryEntry } from "../src/connectors/types.js";

/** Create a HiveDatabase backed by a fresh temp directory. */
async function createTestDb() {
  const dataDir = await mkdtemp(join(tmpdir(), "cortex-sm-test-"));
  const db = new HiveDatabase(join(dataDir, "test.db"));
  return { db, dataDir };
}

/** Seed a connector into the DB so getConnector() returns a row. */
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

describe("ConnectorStateMachine", () => {
  let db: HiveDatabase;
  let dataDir: string;
  let sm: ConnectorStateMachine;

  beforeEach(async () => {
    const ctx = await createTestDb();
    db = ctx.db;
    dataDir = ctx.dataDir;
    sm = new ConnectorStateMachine(db);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  // ── getPhase ──────────────────────────────────────────────────────────────

  describe("getPhase", () => {
    it("returns 'initial' for unknown connector", () => {
      expect(sm.getPhase("nonexistent")).toBe("initial");
    });

    it("returns 'initial' for fresh connector", () => {
      seedConnector(db, "github");
      expect(sm.getPhase("github")).toBe("initial");
    });

    it("returns stored phase when set to 'incremental'", () => {
      seedConnector(db, "github", { syncPhase: "incremental" });
      expect(sm.getPhase("github")).toBe("incremental");
    });

    it("returns stored phase when set to 'rollback'", () => {
      seedConnector(db, "github", { syncPhase: "rollback" });
      expect(sm.getPhase("github")).toBe("rollback");
    });
  });

  // ── getHistory ────────────────────────────────────────────────────────────

  describe("getHistory", () => {
    it("returns empty array for unknown connector", () => {
      expect(sm.getHistory("nonexistent")).toEqual([]);
    });

    it("returns empty array for fresh connector", () => {
      seedConnector(db, "github");
      expect(sm.getHistory("github")).toEqual([]);
    });

    it("returns parsed history entries", () => {
      const entry: SyncHistoryEntry = {
        phase: "initial",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:01:00.000Z",
        added: 10,
        updated: 0,
        skipped: 0,
        errors: 0,
      };
      db.upsertConnector({
        id: "github",
        connectorType: "github",
        config: {},
        status: "idle",
        syncPhase: "incremental",
        syncHistory: JSON.stringify([entry]),
      });
      const history = sm.getHistory("github");
      expect(history).toHaveLength(1);
      expect(history[0].phase).toBe("initial");
      expect(history[0].added).toBe(10);
    });
  });

  // ── startSync ─────────────────────────────────────────────────────────────

  describe("startSync", () => {
    it("marks connector as syncing with the given phase", () => {
      seedConnector(db, "github");
      sm.startSync("github", "initial");
      const connector = db.getConnector("github");
      expect(connector?.status).toBe("syncing");
      expect(connector?.syncPhase).toBe("initial");
    });

    it("creates connector row if not exists", () => {
      sm.startSync("new-connector", "incremental");
      const connector = db.getConnector("new-connector");
      expect(connector?.status).toBe("syncing");
      expect(connector?.syncPhase).toBe("incremental");
    });
  });

  // ── completeSync — phase transitions ──────────────────────────────────────

  describe("completeSync phase transitions", () => {
    it("transitions initial → incremental on success", () => {
      seedConnector(db, "github", { syncPhase: "initial" });
      sm.completeSync("github", { added: 100, updated: 0, skipped: 0, errors: 0 });
      expect(sm.getPhase("github")).toBe("incremental");
    });

    it("stays in initial on error (retry)", () => {
      seedConnector(db, "github", { syncPhase: "initial" });
      sm.completeSync("github", { added: 0, updated: 0, skipped: 0, errors: 1, lastError: "network error" });
      expect(sm.getPhase("github")).toBe("initial");
    });

    it("stays in incremental on success", () => {
      seedConnector(db, "github", { syncPhase: "incremental" });
      sm.completeSync("github", { added: 5, updated: 2, skipped: 93, errors: 0 });
      expect(sm.getPhase("github")).toBe("incremental");
    });

    it("stays in incremental on error", () => {
      seedConnector(db, "github", { syncPhase: "incremental" });
      sm.completeSync("github", { added: 0, updated: 0, skipped: 0, errors: 1 });
      expect(sm.getPhase("github")).toBe("incremental");
    });

    it("transitions rollback → incremental on success", () => {
      seedConnector(db, "github", { syncPhase: "rollback" });
      sm.completeSync("github", { added: 0, updated: 5, skipped: 95, errors: 0 });
      expect(sm.getPhase("github")).toBe("incremental");
    });

    it("stays in rollback on error", () => {
      seedConnector(db, "github", { syncPhase: "rollback" });
      sm.completeSync("github", { added: 0, updated: 0, skipped: 0, errors: 1 });
      expect(sm.getPhase("github")).toBe("rollback");
    });
  });

  // ── completeSync — history recording ──────────────────────────────────────

  describe("completeSync history recording", () => {
    it("appends a history entry on each sync", () => {
      seedConnector(db, "github", { syncPhase: "initial" });
      sm.completeSync("github", { added: 50, updated: 0, skipped: 0, errors: 0 });

      const history = sm.getHistory("github");
      expect(history).toHaveLength(1);
      expect(history[0].phase).toBe("initial");
      expect(history[0].added).toBe(50);
      expect(history[0].completedAt).toBeDefined();
    });

    it("accumulates history across multiple syncs", () => {
      seedConnector(db, "github", { syncPhase: "initial" });
      sm.completeSync("github", { added: 100, updated: 0, skipped: 0, errors: 0 });
      sm.completeSync("github", { added: 5, updated: 2, skipped: 93, errors: 0 });

      const history = sm.getHistory("github");
      expect(history).toHaveLength(2);
      expect(history[0].phase).toBe("initial");
      expect(history[1].phase).toBe("incremental");
    });

    it("caps sync history at 50 entries", () => {
      seedConnector(db, "github", { syncPhase: "incremental" });

      // Run 60 syncs
      for (let i = 0; i < 60; i++) {
        sm.completeSync("github", { added: 1, updated: 0, skipped: 0, errors: 0 });
      }

      const history = sm.getHistory("github");
      expect(history).toHaveLength(50);
    });

    it("preserves lastError in history entry", () => {
      seedConnector(db, "github", { syncPhase: "initial" });
      sm.completeSync("github", { added: 0, updated: 0, skipped: 0, errors: 1, lastError: "API rate limit" });

      const history = sm.getHistory("github");
      expect(history[0].errors).toBe(1);
      expect(history[0].lastError).toBe("API rate limit");
    });
  });

  // ── getExecutionPhase ─────────────────────────────────────────────────────

  describe("getExecutionPhase", () => {
    it("returns 'initial' when forceInitial=true regardless of stored phase", () => {
      seedConnector(db, "github", { syncPhase: "incremental" });
      expect(sm.getExecutionPhase("github", true)).toBe("initial");
    });

    it("returns stored phase when forceInitial=false", () => {
      seedConnector(db, "github", { syncPhase: "incremental" });
      expect(sm.getExecutionPhase("github", false)).toBe("incremental");
    });

    it("returns 'initial' for unknown connector when forceInitial=false", () => {
      expect(sm.getExecutionPhase("nonexistent", false)).toBe("initial");
    });
  });

  // ── canTransition ─────────────────────────────────────────────────────────

  describe("canTransition", () => {
    it("allows initial → initial (retry)", () => {
      expect(sm.canTransition("initial", "initial")).toBe(true);
    });

    it("allows initial → incremental", () => {
      expect(sm.canTransition("initial", "incremental")).toBe(true);
    });

    it("does not allow initial → rollback", () => {
      expect(sm.canTransition("initial", "rollback")).toBe(false);
    });

    it("allows incremental → incremental", () => {
      expect(sm.canTransition("incremental", "incremental")).toBe(true);
    });

    it("allows incremental → rollback", () => {
      expect(sm.canTransition("incremental", "rollback")).toBe(true);
    });

    it("does not allow incremental → initial", () => {
      expect(sm.canTransition("incremental", "initial")).toBe(false);
    });

    it("allows rollback → incremental", () => {
      expect(sm.canTransition("rollback", "incremental")).toBe(true);
    });

    it("allows rollback → rollback (retry)", () => {
      expect(sm.canTransition("rollback", "rollback")).toBe(true);
    });

    it("does not allow rollback → initial", () => {
      expect(sm.canTransition("rollback", "initial")).toBe(false);
    });
  });
});
