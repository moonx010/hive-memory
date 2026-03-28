import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../src/db/database.js";
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

describe("Temporal Entity Validity", () => {
  let db: HiveDatabase;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "temporal-test-"));
    db = new HiveDatabase(join(tempDir, "test.db"));
  });

  afterEach(async () => {
    db.close();
    try { await rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe("supersede()", () => {
    it("marks old entity with valid_to and status=superseded", () => {
      const old = makeEntity({ id: "old-1", content: "old fact" });
      const newer = makeEntity({ id: "new-1", content: "new fact" });
      db.insertEntity(old);
      db.insertEntity(newer);

      db.supersede("old-1", "new-1");

      const updated = db.getEntity("old-1");
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("superseded");
      expect(updated!.validTo).toBeDefined();
      expect(updated!.supersededBy).toBe("new-1");
    });

    it("sets superseded_by to the new entity ID", () => {
      const old = makeEntity({ id: "old-2", content: "old content" });
      const newer = makeEntity({ id: "new-2", content: "new content" });
      db.insertEntity(old);
      db.insertEntity(newer);

      db.supersede("old-2", "new-2");

      const updated = db.getEntity("old-2");
      expect(updated!.supersededBy).toBe("new-2");
    });

    it("creates a refinement synapse from new → old", () => {
      const old = makeEntity({ id: "old-3", content: "old fact" });
      const newer = makeEntity({ id: "new-3", content: "new fact" });
      db.insertEntity(old);
      db.insertEntity(newer);

      db.supersede("old-3", "new-3");

      const synapses = db.getSynapsesByEntry("new-3", "outgoing");
      const refinement = synapses.find((s) => s.axon === "refinement" && s.target === "old-3");
      expect(refinement).toBeDefined();
      expect(refinement!.weight).toBe(1.0);
    });
  });

  describe("search excludes superseded entities by default", () => {
    it("listEntities excludes entities with valid_to set", () => {
      const old = makeEntity({ id: "old-4", content: "outdated fact" });
      const newer = makeEntity({ id: "new-4", content: "updated fact" });
      db.insertEntity(old);
      db.insertEntity(newer);

      db.supersede("old-4", "new-4");

      const results = db.listEntities({ status: undefined });
      const ids = results.map((e) => e.id);
      expect(ids).not.toContain("old-4");
      expect(ids).toContain("new-4");
    });

    it("listEntities with includeSuperseded=true returns entities with valid_to set", () => {
      const old = makeEntity({ id: "old-5", content: "outdated fact" });
      const newer = makeEntity({ id: "new-5", content: "updated fact" });
      db.insertEntity(old);
      db.insertEntity(newer);

      db.supersede("old-5", "new-5");

      // includeSuperseded bypasses the valid_to IS NULL filter;
      // pass status: "superseded" to also include the old entity's status
      const supersededResults = db.listEntities({ status: "superseded", includeSuperseded: true });
      const supersededIds = supersededResults.map((e) => e.id);
      expect(supersededIds).toContain("old-5");

      // Active new entity still appears in normal search
      const activeResults = db.listEntities({ includeSuperseded: true });
      const activeIds = activeResults.map((e) => e.id);
      expect(activeIds).toContain("new-5");
    });
  });

  describe("backfill sets valid_from on existing entities", () => {
    it("newly inserted entity has valid_from set to createdAt", () => {
      const entity = makeEntity({ id: "fresh-1", content: "fresh content" });
      db.insertEntity(entity);

      const fetched = db.getEntity("fresh-1");
      expect(fetched!.validFrom).toBeDefined();
      expect(fetched!.validFrom).toBe(entity.createdAt);
    });

    it("entity with explicit validFrom keeps it", () => {
      const past = "2020-01-01T00:00:00.000Z";
      const entity = makeEntity({ id: "past-1", content: "historical fact", validFrom: past });
      db.insertEntity(entity);

      const fetched = db.getEntity("past-1");
      expect(fetched!.validFrom).toBe(past);
    });
  });

  describe("getSynapsesByAxon()", () => {
    it("returns synapses for the given axon type", () => {
      const a = makeEntity({ id: "syn-a" });
      const b = makeEntity({ id: "syn-b" });
      db.insertEntity(a);
      db.insertEntity(b);

      db.upsertSynapse({ sourceId: "syn-a", targetId: "syn-b", axon: "conflict", weight: 0.8 });

      const conflicts = db.getSynapsesByAxon("conflict");
      expect(conflicts.length).toBeGreaterThanOrEqual(1);
      const found = conflicts.find((s) => s.source === "syn-a" && s.target === "syn-b");
      expect(found).toBeDefined();
    });

    it("does not return synapses of other axon types", () => {
      const a = makeEntity({ id: "syn-c" });
      const b = makeEntity({ id: "syn-d" });
      db.insertEntity(a);
      db.insertEntity(b);

      db.upsertSynapse({ sourceId: "syn-c", targetId: "syn-d", axon: "causal", weight: 0.5 });

      const conflicts = db.getSynapsesByAxon("conflict");
      const found = conflicts.find((s) => s.source === "syn-c" && s.target === "syn-d");
      expect(found).toBeUndefined();
    });
  });
});
