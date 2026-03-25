import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HiveDatabase } from "../src/db/database.js";
import { EnrichmentEngine } from "../src/enrichment/engine.js";
import { ClassifyProvider } from "../src/enrichment/providers/classify.js";
import type {
  Entity,
  EnrichmentContext,
  EnrichmentProvider,
  EnrichmentResult,
  EntityType,
} from "../src/enrichment/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createTestEntity(
  db: HiveDatabase,
  overrides: Partial<Entity> = {},
): Entity {
  const id = randomUUID();
  const now = new Date().toISOString();
  const entity: Entity = {
    id,
    entityType: "memory",
    namespace: "local",
    content: "Test content that is long enough to pass the 20 char threshold for classification",
    tags: [],
    keywords: [],
    attributes: {},
    source: { system: "test" },
    visibility: "personal",
    domain: "code",
    confidence: "confirmed",
    createdAt: now,
    updatedAt: now,
    status: "active",
    ...overrides,
  };
  db.insertEntity(entity);
  return entity;
}

describe("EnrichmentEngine", () => {
  let db: HiveDatabase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hive-enrich-test-"));
    db = new HiveDatabase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs providers in priority order", async () => {
    const order: string[] = [];

    const providerA: EnrichmentProvider = {
      id: "a",
      name: "A",
      applicableTo: ["*"] as ["*"],
      priority: 200,
      shouldEnrich: () => true,
      enrich: async () => {
        order.push("a");
        return {};
      },
    };

    const providerB: EnrichmentProvider = {
      id: "b",
      name: "B",
      applicableTo: ["*"] as ["*"],
      priority: 100,
      shouldEnrich: () => true,
      enrich: async () => {
        order.push("b");
        return {};
      },
    };

    const engine = new EnrichmentEngine(db);
    engine.register(providerA);
    engine.register(providerB);

    const entity = createTestEntity(db);
    await engine.enrichEntity(entity.id);

    expect(order).toEqual(["b", "a"]);
  });

  it("stamps _enrichedAt on entity attributes", async () => {
    const engine = new EnrichmentEngine(db);
    engine.register(new ClassifyProvider());

    const entity = createTestEntity(db, {
      content: "We decided to use PostgreSQL for the new project database",
    });

    await engine.enrichEntity(entity.id);

    const updated = db.getEntity(entity.id)!;
    expect(updated.attributes._enrichedAt).toBeDefined();
    expect(updated.attributes._enrichedBy).toEqual(["classify"]);
  });

  it("enrichBatch with unenrichedOnly skips enriched entities", async () => {
    const engine = new EnrichmentEngine(db);
    engine.register(new ClassifyProvider());

    const e1 = createTestEntity(db, {
      content: "Already enriched entity content that is long enough to be processed",
    });
    db.updateEntityAttributes(e1.id, {
      _enrichedAt: new Date().toISOString(),
    });

    createTestEntity(db, {
      content: "New entity that has not been enriched yet and is also long enough",
    });

    const result = await engine.enrichBatch({ unenrichedOnly: true });
    expect(result.enriched).toBe(1);
    expect(result.processed).toBe(1);
  });

  it("provider throwing does not crash batch", async () => {
    const failProvider: EnrichmentProvider = {
      id: "fail",
      name: "Fail",
      applicableTo: ["*"] as ["*"],
      priority: 100,
      shouldEnrich: () => true,
      enrich: async () => {
        throw new Error("intentional failure");
      },
    };

    const engine = new EnrichmentEngine(db);
    engine.register(failProvider);

    createTestEntity(db);
    createTestEntity(db);

    const result = await engine.enrichBatch();
    expect(result.processed).toBe(2);
    expect(result.errors).toBe(0); // errors counted at enrichBatch level, not per-provider
    expect(result.enriched).toBe(0);
  });

  it("enrichBatch returns correct BatchResult shape", async () => {
    const engine = new EnrichmentEngine(db);
    engine.register(new ClassifyProvider());

    createTestEntity(db, { content: "function hello() { return 42; } // code pattern" });
    createTestEntity(db, { content: "short" }); // too short, won't be enriched

    const result = await engine.enrichBatch();
    expect(result).toHaveProperty("processed");
    expect(result).toHaveProperty("enriched");
    expect(result).toHaveProperty("errors");
    expect(result).toHaveProperty("batchId");
    expect(typeof result.batchId).toBe("string");
  });
});

describe("ClassifyProvider", () => {
  const provider = new ClassifyProvider();
  const mockCtx = {} as EnrichmentContext;

  it("tags high-signal for entity with many replies", async () => {
    const entity = {
      content: "This is a Slack message with lots of engagement from the team",
      attributes: { replyCount: 15 },
    } as unknown as Entity;

    const result = await provider.enrich(entity, mockCtx);
    expect(result.tags).toContain("high-signal");
  });

  it("tags high-signal for entity with many reactions", async () => {
    const entity = {
      content: "This is a Slack message with lots of reactions from the team",
      attributes: { reactions: 8 },
    } as unknown as Entity;

    const result = await provider.enrich(entity, mockCtx);
    expect(result.tags).toContain("high-signal");
  });

  it("detects code domain", async () => {
    const entity = {
      content: "export function calculateTotal(items: Item[]): number { return items.reduce((sum, i) => sum + i.price, 0); }",
      attributes: {},
    } as unknown as Entity;

    const result = await provider.enrich(entity, mockCtx);
    expect(result.attributes?.domain).toBe("code");
  });

  it("tags decision", async () => {
    const entity = {
      content: "We decided to use PostgreSQL as the primary database for this project",
      attributes: {},
    } as unknown as Entity;

    const result = await provider.enrich(entity, mockCtx);
    expect(result.tags).toContain("decision");
  });

  it("tags time-sensitive", async () => {
    const entity = {
      content: "The migration needs to be completed by Friday at the latest",
      attributes: {},
    } as unknown as Entity;

    const result = await provider.enrich(entity, mockCtx);
    expect(result.tags).toContain("time-sensitive");
  });

  it("detects meetings domain", async () => {
    const entity = {
      content: "Weekly standup meeting: discussed the agenda and reviewed the action items from last sprint",
      attributes: {},
    } as unknown as Entity;

    const result = await provider.enrich(entity, mockCtx);
    expect(result.attributes?.domain).toBe("meetings");
  });

  it("shouldEnrich returns false for short content", () => {
    const entity = { content: "Too short" } as Entity;
    expect(provider.shouldEnrich(entity)).toBe(false);
  });

  it("shouldEnrich returns true for adequate content", () => {
    const entity = {
      content: "This is long enough content for the classifier to process",
    } as Entity;
    expect(provider.shouldEnrich(entity)).toBe(true);
  });
});

describe("HiveDatabase enrichment methods", () => {
  let db: HiveDatabase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hive-db-enrich-test-"));
    db = new HiveDatabase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("updateEntityAttributes merges attributes", () => {
    const entity = createTestEntity(db, {
      attributes: { existing: "value" },
    });

    db.updateEntityAttributes(entity.id, { added: "new" });

    const updated = db.getEntity(entity.id)!;
    expect(updated.attributes.existing).toBe("value");
    expect(updated.attributes.added).toBe("new");
  });

  it("addEntityTags deduplicates", () => {
    const entity = createTestEntity(db, { tags: ["a", "b"] });

    db.addEntityTags(entity.id, ["b", "c"]);

    const updated = db.getEntity(entity.id)!;
    expect(updated.tags).toEqual(["a", "b", "c"]);
  });

  it("addEntityKeywords deduplicates", () => {
    const entity = createTestEntity(db, { keywords: ["x", "y"] });

    db.addEntityKeywords(entity.id, ["y", "z"]);

    const updated = db.getEntity(entity.id)!;
    expect(updated.keywords).toEqual(["x", "y", "z"]);
  });

  it("upsertSynapse creates with set-weight semantics", () => {
    const e1 = createTestEntity(db);
    const e2 = createTestEntity(db);

    db.upsertSynapse({
      sourceId: e1.id,
      targetId: e2.id,
      axon: "related",
      weight: 0.8,
    });

    const synapses = db.getSynapsesByEntry(e1.id, "outgoing");
    expect(synapses).toHaveLength(1);
    expect(synapses[0].weight).toBe(0.8);

    // Upsert again with different weight — should SET, not accumulate
    db.upsertSynapse({
      sourceId: e1.id,
      targetId: e2.id,
      axon: "related",
      weight: 0.5,
    });

    const updated = db.getSynapsesByEntry(e1.id, "outgoing");
    expect(updated).toHaveLength(1);
    expect(updated[0].weight).toBe(0.5);
  });

  it("upsertEntity creates entity from draft and returns id", () => {
    const id = db.upsertEntity({
      entityType: "decision",
      content: "We chose TypeScript over JavaScript for type safety",
      tags: ["tech-choice"],
      attributes: { reason: "type safety" },
      source: { system: "enrichment", externalId: "test-1" },
      domain: "code",
      confidence: "inferred",
    });

    expect(typeof id).toBe("string");
    const entity = db.getEntity(id)!;
    expect(entity.entityType).toBe("decision");
    expect(entity.tags).toEqual(["tech-choice"]);
  });

  it("listEntities with unenrichedOnly filter", () => {
    const e1 = createTestEntity(db);
    const e2 = createTestEntity(db);

    db.updateEntityAttributes(e1.id, {
      _enrichedAt: new Date().toISOString(),
    });

    const unenriched = db.listEntities({ unenrichedOnly: true });
    expect(unenriched).toHaveLength(1);
    expect(unenriched[0].id).toBe(e2.id);
  });

  it("listEntities with entityType array filter", () => {
    createTestEntity(db, { entityType: "memory" });
    createTestEntity(db, { entityType: "decision" });
    createTestEntity(db, { entityType: "person" });

    const result = db.listEntities({
      entityType: ["memory", "decision"],
    });
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.entityType).sort()).toEqual([
      "decision",
      "memory",
    ]);
  });
});
