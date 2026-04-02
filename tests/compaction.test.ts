import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { HiveDatabase } from "../src/db/database.js";
import { runCompaction } from "../src/pipeline/compaction.js";
import type { Entity } from "../src/types.js";

function makeEntity(overrides: Partial<Entity> = {}): Entity {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    entityType: "memory",
    namespace: "local",
    content: "test content for compaction " + randomUUID(),
    tags: [],
    keywords: [],
    attributes: {},
    source: { system: "agent" },
    visibility: "team",
    domain: "code",
    confidence: "confirmed",
    createdAt: now,
    updatedAt: now,
    status: "active",
    ...overrides,
  };
}

describe("Memory Compaction", () => {
  let db: HiveDatabase;

  beforeEach(() => {
    db = new HiveDatabase(":memory:");
  });

  it("creates semantic links between entities with keyword overlap", () => {
    const e1 = makeEntity({ keywords: ["react", "typescript", "frontend", "hooks"] });
    const e2 = makeEntity({ keywords: ["react", "typescript", "component", "hooks"] });
    const e3 = makeEntity({ keywords: ["python", "django", "backend"] });
    db.insertEntity(e1);
    db.insertEntity(e2);
    db.insertEntity(e3);

    const result = runCompaction(db, { dryRun: false, linkThreshold: 0.4 });
    expect(result.linksCreated).toBe(1); // e1-e2 share 3/5 keywords = 0.6 Jaccard

    // e3 should NOT be linked (no overlap)
    const e3synapses = db.getSynapsesByEntry(e3.id, "both");
    expect(e3synapses.length).toBe(0);
  });

  it("merges exact content duplicates", () => {
    const content = "Exact same content for duplicate test";
    const e1 = makeEntity({ content, createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z" });
    const e2 = makeEntity({ content, createdAt: "2025-06-01T00:00:00Z", updatedAt: "2025-06-01T00:00:00Z" });
    db.insertEntity(e1);
    db.insertEntity(e2);

    const result = runCompaction(db, { dryRun: false });
    expect(result.duplicatesMerged).toBe(1);

    // The newer entity should be superseded
    const superseded = db.getEntity(e2.id);
    expect(superseded?.status).toBe("superseded");
  });

  it("prunes weak edges below threshold", () => {
    const e1 = makeEntity();
    const e2 = makeEntity();
    db.insertEntity(e1);
    db.insertEntity(e2);
    db.insertSynapse({
      id: randomUUID(),
      source: e1.id,
      target: e2.id,
      axon: "temporal",
      weight: 0.01, // Below default threshold of 0.05
      metadata: {},
      formedAt: new Date().toISOString(),
      lastPotentiated: new Date().toISOString(),
    });

    const result = runCompaction(db, { dryRun: false });
    expect(result.edgesPruned).toBe(1);

    const remaining = db.getSynapsesByEntry(e1.id, "both");
    expect(remaining.length).toBe(0);
  });

  it("archives stale entities with few connections", () => {
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const stale = makeEntity({ createdAt: oldDate, updatedAt: oldDate });
    db.insertEntity(stale);

    const result = runCompaction(db, { dryRun: false, staleDays: 180 });
    expect(result.entitiesArchived).toBe(1);

    const archived = db.getEntity(stale.id);
    expect(archived?.status).toBe("archived");
  });

  it("does NOT archive person entities", () => {
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const person = makeEntity({ entityType: "person", title: "John", createdAt: oldDate, updatedAt: oldDate });
    db.insertEntity(person);

    const result = runCompaction(db, { dryRun: false, staleDays: 180 });
    expect(result.entitiesArchived).toBe(0);
  });

  it("dry run reports changes without applying", () => {
    const content = "Dry run duplicate content";
    db.insertEntity(makeEntity({ content }));
    db.insertEntity(makeEntity({ content }));

    const result = runCompaction(db, { dryRun: true });
    expect(result.duplicatesMerged).toBe(1);

    // Both entities should still be active
    const entities = db.listEntities({ limit: 100 });
    const active = entities.filter(e => e.status === "active");
    expect(active.length).toBe(2);
  });

  it("returns zero counts on empty database", () => {
    const result = runCompaction(db, { dryRun: false });
    expect(result.linksCreated).toBe(0);
    expect(result.duplicatesMerged).toBe(0);
    expect(result.edgesPruned).toBe(0);
    expect(result.entitiesArchived).toBe(0);
    expect(result.orphansRemoved).toBe(0);
  });
});
