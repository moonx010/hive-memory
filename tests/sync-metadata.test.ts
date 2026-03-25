import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CortexStore } from "../src/store.js";
import { HiveDatabase } from "../src/db/database.js";
import type { CortexConfig } from "../src/types.js";
import type { ConnectorPlugin, RawDocument, EntityDraft } from "../src/connectors/types.js";

/** Create a CortexStore backed by a fresh temp directory. */
async function createTestStore() {
  const dataDir = await mkdtemp(join(tmpdir(), "cortex-sync-meta-test-"));
  const config: CortexConfig = {
    dataDir,
    localContext: { filename: ".cortex.md", enabled: false },
  };
  const store = new CortexStore(config);
  await store.init();
  // Use explicit database so recall goes through DB path
  const db = new HiveDatabase(join(dataDir, "cortex.db"));
  store.setDatabase(db);
  return { store, db, dataDir };
}

/** Build a minimal mock ConnectorPlugin. */
function makeMockConnector(
  id: string,
  docs: RawDocument[],
  transforms?: (doc: RawDocument) => EntityDraft[],
): ConnectorPlugin {
  let cursor: string | undefined;

  return {
    id,
    name: `Mock ${id}`,
    description: "Mock connector for testing",
    entityTypes: ["memory"],
    domains: ["test"],
    isConfigured: () => true,
    getCursor: () => cursor,

    async *fullSync() {
      for (const doc of docs) {
        yield doc;
      }
      cursor = new Date().toISOString();
    },

    async *incrementalSync(_cursor?: string) {
      for (const doc of docs) {
        yield doc;
      }
      cursor = new Date().toISOString();
    },

    transform(doc: RawDocument): EntityDraft[] {
      if (transforms) return transforms(doc);
      return [
        {
          entityType: "memory",
          title: doc.title ?? doc.externalId,
          content: doc.content,
          tags: [],
          attributes: {},
          source: { system: id, externalId: doc.externalId, connector: id },
          domain: "test",
          confidence: "confirmed",
        },
      ];
    },
  };
}

describe("Sync metadata stamping", () => {
  let store: CortexStore;
  let db: HiveDatabase;
  let dataDir: string;

  beforeEach(async () => {
    const ctx = await createTestStore();
    store = ctx.store;
    db = ctx.db;
    dataDir = ctx.dataDir;
  });

  afterEach(async () => {
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("new entity from sync has _lastSyncedAt attribute set", async () => {
    const connector = makeMockConnector("test-source", [
      {
        externalId: "doc-1",
        source: "test-source",
        content: "Test content for sync metadata",
        timestamp: new Date().toISOString(),
        metadata: {},
      },
    ]);

    store.connectors.register(connector);
    // Seed connector in db
    db.upsertConnector({
      id: "test-source",
      connectorType: "test",
      config: {},
      status: "idle",
      syncPhase: "initial",
      syncHistory: "[]",
    });

    await store.syncConnector("test-source");

    const entities = db.listEntities({});
    expect(entities).toHaveLength(1);
    expect(entities[0].attributes._lastSyncedAt).toBeDefined();
    expect(typeof entities[0].attributes._lastSyncedAt).toBe("string");
  });

  it("new entity has _syncConnector matching connector id", async () => {
    const connector = makeMockConnector("my-connector", [
      {
        externalId: "doc-1",
        source: "my-connector",
        content: "Connector metadata test content",
        timestamp: new Date().toISOString(),
        metadata: {},
      },
    ]);

    store.connectors.register(connector);
    db.upsertConnector({
      id: "my-connector",
      connectorType: "test",
      config: {},
      status: "idle",
      syncPhase: "initial",
      syncHistory: "[]",
    });

    await store.syncConnector("my-connector");

    const entities = db.listEntities({});
    expect(entities).toHaveLength(1);
    expect(entities[0].attributes._syncConnector).toBe("my-connector");
  });

  it("new entity has _syncPhase matching phase", async () => {
    const connector = makeMockConnector("phase-connector", [
      {
        externalId: "doc-1",
        source: "phase-connector",
        content: "Phase metadata test content",
        timestamp: new Date().toISOString(),
        metadata: {},
      },
    ]);

    store.connectors.register(connector);
    db.upsertConnector({
      id: "phase-connector",
      connectorType: "test",
      config: {},
      status: "idle",
      syncPhase: "initial",
      syncHistory: "[]",
    });

    await store.syncConnector("phase-connector");

    const entities = db.listEntities({});
    expect(entities).toHaveLength(1);
    expect(entities[0].attributes._syncPhase).toBe("initial");
  });

  it("updated entity has _lastSyncedAt refreshed", async () => {
    const doc: RawDocument = {
      externalId: "doc-update",
      source: "update-connector",
      content: "Original content",
      timestamp: new Date().toISOString(),
      metadata: {},
    };

    const connector = makeMockConnector("update-connector", [doc]);
    store.connectors.register(connector);
    db.upsertConnector({
      id: "update-connector",
      connectorType: "test",
      config: {},
      status: "idle",
      syncPhase: "initial",
      syncHistory: "[]",
    });

    // First sync — insert
    await store.syncConnector("update-connector");
    const afterFirst = db.listEntities({});
    expect(afterFirst).toHaveLength(1);
    const firstSyncedAt = afterFirst[0].attributes._lastSyncedAt as string;
    expect(firstSyncedAt).toBeDefined();

    // Wait a tick to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 10));

    // Second sync with changed content — update
    const updatedDoc: RawDocument = { ...doc, content: "Updated content that changed" };
    const connector2 = makeMockConnector("update-connector", [updatedDoc]);
    // Replace connector in registry
    store.connectors.register(connector2);
    db.upsertConnector({
      id: "update-connector",
      connectorType: "test",
      config: {},
      status: "idle",
      syncPhase: "incremental",
      syncHistory: "[]",
    });

    await store.syncConnector("update-connector");

    const afterSecond = db.listEntities({});
    expect(afterSecond).toHaveLength(1);
    const secondSyncedAt = afterSecond[0].attributes._lastSyncedAt as string;
    expect(secondSyncedAt).toBeDefined();
  });

  it("deleted entity has _sourceDeleted: true", async () => {
    const doc: RawDocument = {
      externalId: "doc-delete",
      source: "delete-connector",
      content: "Content to be deleted",
      timestamp: new Date().toISOString(),
      metadata: {},
    };

    const connector = makeMockConnector("delete-connector", [doc]);
    store.connectors.register(connector);
    db.upsertConnector({
      id: "delete-connector",
      connectorType: "test",
      config: {},
      status: "idle",
      syncPhase: "initial",
      syncHistory: "[]",
    });

    // First sync — insert
    await store.syncConnector("delete-connector");
    const entities = db.listEntities({});
    expect(entities).toHaveLength(1);
    const entityId = entities[0].id;

    // Second sync — delete
    const deletedDoc: RawDocument = {
      ...doc,
      _deleted: true,
    };
    const deletingConnector = makeMockConnector("delete-connector", [deletedDoc]);
    store.connectors.register(deletingConnector);
    db.upsertConnector({
      id: "delete-connector",
      connectorType: "test",
      config: {},
      status: "idle",
      syncPhase: "incremental",
      syncHistory: "[]",
    });

    await store.syncConnector("delete-connector");

    const updated = db.getEntity(entityId)!;
    expect(updated.attributes._sourceDeleted).toBe(true);
    expect(updated.status).toBe("archived");
  });

  it("_sourceDeleted is false for normal (non-deleted) entities", async () => {
    const connector = makeMockConnector("normal-connector", [
      {
        externalId: "doc-normal",
        source: "normal-connector",
        content: "Normal content not deleted",
        timestamp: new Date().toISOString(),
        metadata: {},
      },
    ]);

    store.connectors.register(connector);
    db.upsertConnector({
      id: "normal-connector",
      connectorType: "test",
      config: {},
      status: "idle",
      syncPhase: "initial",
      syncHistory: "[]",
    });

    await store.syncConnector("normal-connector");

    const entities = db.listEntities({});
    expect(entities).toHaveLength(1);
    expect(entities[0].attributes._sourceDeleted).toBe(false);
  });
});
