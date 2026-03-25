import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../src/db/database.js";
import { CortexStore } from "../src/store.js";
import { ConnectorStateMachine } from "../src/connectors/state-machine.js";
import type { ConnectorPlugin, RawDocument, EntityDraft } from "../src/connectors/types.js";
import type { CortexConfig } from "../src/types.js";

// ── Test fixture helpers ──────────────────────────────────────────────────────

async function createTestStore() {
  const dataDir = await mkdtemp(join(tmpdir(), "cortex-rollback-integration-"));
  const config: CortexConfig = {
    dataDir,
    localContext: { filename: ".cortex.md", enabled: false },
  };
  const store = new CortexStore(config);
  await store.init();
  const db = new HiveDatabase(join(dataDir, "cortex.db"));
  store.setDatabase(db);
  return { store, db, dataDir };
}

/** Minimal ConnectorPlugin implementation for testing. */
function createMockConnector(opts: {
  id: string;
  docs?: RawDocument[];
  rollbackDocs?: RawDocument[];
  includeRollbackSync?: boolean;
}): ConnectorPlugin & { rollbackSync?: (window: { since: string; until: string }) => AsyncGenerator<RawDocument> } {
  const docs = opts.docs ?? [];
  const rollbackDocs = opts.rollbackDocs ?? [];

  const connector: ConnectorPlugin & { rollbackSync?: (window: { since: string; until: string }) => AsyncGenerator<RawDocument> } = {
    id: opts.id,
    name: opts.id,
    description: `Test connector ${opts.id}`,
    entityTypes: ["document"],
    domains: ["code"],
    isConfigured: () => true,
    getCursor: () => new Date().toISOString(),
    async *fullSync() {
      for (const doc of docs) yield doc;
    },
    async *incrementalSync(_cursor?: string) {
      for (const doc of docs) yield doc;
    },
    transform(doc: RawDocument): EntityDraft[] {
      return [
        {
          entityType: "document",
          title: doc.title ?? doc.externalId,
          content: doc.content,
          tags: ["test"],
          attributes: {},
          source: {
            system: doc.source,
            externalId: doc.externalId,
            connector: opts.id,
          },
          domain: "code",
          confidence: "confirmed",
        },
      ];
    },
  };

  if (opts.includeRollbackSync !== false) {
    connector.rollbackSync = async function* (window: { since: string; until: string }) {
      for (const doc of rollbackDocs) yield doc;
    };
  }

  return connector;
}

function makeDoc(id: string, content: string, source = "test"): RawDocument {
  return {
    externalId: id,
    source,
    content,
    title: id,
    timestamp: new Date().toISOString(),
    metadata: {},
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("rollback sync — integration", () => {
  let store: CortexStore;
  let db: HiveDatabase;
  let dataDir: string;

  beforeEach(async () => {
    const ctx = await createTestStore();
    store = ctx.store;
    db = ctx.db;
    dataDir = ctx.dataDir;
    delete process.env.CORTEX_ROLLBACK_FREQUENCY;
    delete process.env.CORTEX_ROLLBACK_WINDOW_HOURS;
  });

  afterEach(async () => {
    delete process.env.CORTEX_ROLLBACK_FREQUENCY;
    delete process.env.CORTEX_ROLLBACK_WINDOW_HOURS;
    await rm(dataDir, { recursive: true, force: true });
  });

  // ── _deleted flag → archived ──────────────────────────────────────────────

  it("archives entity when _deleted flag is set on the raw document", async () => {
    const doc = makeDoc("doc-1", "initial content");
    const connector = createMockConnector({
      id: "test",
      docs: [doc],
      rollbackDocs: [],
    });
    store.connectors.register(connector);

    // Initial sync: creates the entity
    await store.syncConnector("test", true);
    const entity = db.getByExternalId("test", "doc-1");
    expect(entity).not.toBeNull();
    expect(entity?.status).toBe("active");

    // Now a rollback doc with _deleted=true
    const deletedDoc: RawDocument = { ...doc, _deleted: true };
    const deletingConnector = createMockConnector({
      id: "test",
      docs: [deletedDoc],
      rollbackDocs: [],
    });
    store.connectors.register(deletingConnector);

    const result = await store.syncConnector("test", true);
    expect(result.archived).toBe(1);

    const entityAfter = db.getByExternalId("test", "doc-1");
    expect(entityAfter?.status).toBe("archived");
  });

  it("does not double-archive an already-archived entity", async () => {
    const doc = makeDoc("doc-2", "some content");
    const connector = createMockConnector({ id: "test", docs: [doc] });
    store.connectors.register(connector);
    await store.syncConnector("test", true);

    // First deletion
    const deletedDoc: RawDocument = { ...doc, _deleted: true };
    const deletingConnector = createMockConnector({ id: "test", docs: [deletedDoc] });
    store.connectors.register(deletingConnector);
    const result1 = await store.syncConnector("test", true);
    expect(result1.archived).toBe(1);

    // Second deletion — should not increment archived count since already archived
    const result2 = await store.syncConnector("test", true);
    expect(result2.archived).toBe(0);
  });

  // ── rollback phase calls rollbackSync ─────────────────────────────────────

  it("calls rollbackSync when phase is 'rollback' and connector implements it", async () => {
    let rollbackCalled = false;
    let rollbackWindow: { since: string; until: string } | undefined;

    const connector: ConnectorPlugin & { rollbackSync: (w: { since: string; until: string }) => AsyncGenerator<RawDocument> } = {
      id: "test-rb",
      name: "test-rb",
      description: "test",
      entityTypes: ["document"],
      domains: ["code"],
      isConfigured: () => true,
      getCursor: () => new Date().toISOString(),
      async *fullSync() {},
      async *incrementalSync() {},
      async *rollbackSync(window) {
        rollbackCalled = true;
        rollbackWindow = window;
        yield makeDoc("rb-doc-1", "rollback content", "test-rb");
      },
      transform(doc: RawDocument): EntityDraft[] {
        return [{
          entityType: "document",
          title: doc.title ?? doc.externalId,
          content: doc.content,
          tags: [],
          attributes: {},
          source: { system: "test-rb", externalId: doc.externalId, connector: "test-rb" },
          domain: "code",
          confidence: "confirmed",
        }];
      },
    };

    store.connectors.register(connector);

    // Force rollback phase via DB
    db.upsertConnector({
      id: "test-rb",
      connectorType: "test-rb",
      config: {},
      status: "idle",
      syncPhase: "rollback",
      syncHistory: "[]",
    });

    const result = await store.syncConnector("test-rb", false);
    expect(rollbackCalled).toBe(true);
    expect(rollbackWindow).toBeDefined();
    expect(result.added).toBe(1);
  });

  it("falls back to incrementalSync when rollback phase but connector lacks rollbackSync", async () => {
    let incrementalCalled = false;

    const connector: ConnectorPlugin = {
      id: "test-no-rb",
      name: "test-no-rb",
      description: "test",
      entityTypes: ["document"],
      domains: ["code"],
      isConfigured: () => true,
      getCursor: () => new Date().toISOString(),
      async *fullSync() {},
      async *incrementalSync() {
        incrementalCalled = true;
        yield makeDoc("inc-doc-1", "incremental content", "test-no-rb");
      },
      transform(doc: RawDocument): EntityDraft[] {
        return [{
          entityType: "document",
          title: doc.title ?? doc.externalId,
          content: doc.content,
          tags: [],
          attributes: {},
          source: { system: "test-no-rb", externalId: doc.externalId, connector: "test-no-rb" },
          domain: "code",
          confidence: "confirmed",
        }];
      },
    };

    store.connectors.register(connector);
    db.upsertConnector({
      id: "test-no-rb",
      connectorType: "test-no-rb",
      config: {},
      status: "idle",
      syncPhase: "rollback",
      syncHistory: "[]",
    });

    const result = await store.syncConnector("test-no-rb", false);
    expect(incrementalCalled).toBe(true);
    expect(result.added).toBe(1);
  });

  // ── rollback phase recorded in history ────────────────────────────────────

  it("records rollback phase in sync history", async () => {
    const connector = createMockConnector({
      id: "test-hist",
      docs: [],
      rollbackDocs: [makeDoc("rb-1", "rb content", "test-hist")],
    });
    store.connectors.register(connector);

    db.upsertConnector({
      id: "test-hist",
      connectorType: "test-hist",
      config: {},
      status: "idle",
      syncPhase: "rollback",
      syncHistory: "[]",
    });

    await store.syncConnector("test-hist", false);

    const sm = new ConnectorStateMachine(db);
    const history = sm.getHistory("test-hist");
    expect(history).toHaveLength(1);
    expect(history[0].phase).toBe("rollback");
  });

  // ── content_hash dedup during rollback ────────────────────────────────────

  it("skips unchanged entities during rollback (content_hash dedup)", async () => {
    const doc = makeDoc("dedup-1", "stable content", "test-dedup");
    const connector = createMockConnector({
      id: "test-dedup",
      docs: [doc],
      rollbackDocs: [doc], // same doc, same content
    });
    store.connectors.register(connector);

    // Initial sync: adds the entity
    const initial = await store.syncConnector("test-dedup", true);
    expect(initial.added).toBe(1);

    // Rollback sync: same content → should be skipped
    db.upsertConnector({
      id: "test-dedup",
      connectorType: "test-dedup",
      config: {},
      status: "idle",
      syncPhase: "rollback",
      syncHistory: "[]",
    });
    const rollback = await store.syncConnector("test-dedup", false);
    expect(rollback.added).toBe(0);
    expect(rollback.skipped).toBe(1);
  });
});
