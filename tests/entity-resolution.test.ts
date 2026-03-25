import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HiveDatabase } from "../src/db/database.js";
import { EntityResolver, levenshtein } from "../src/enrichment/entity-resolver.js";
import type { Entity } from "../src/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createPerson(
  db: HiveDatabase,
  opts: {
    id?: string;
    title: string;
    email?: string;
    handle?: string;
    sourceSystem: string;
    externalId?: string;
  },
): Entity {
  const id = opts.id ?? randomUUID();
  const now = new Date().toISOString();
  const entity: Entity = {
    id,
    entityType: "person",
    namespace: "local",
    title: opts.title,
    content: `${opts.title} (${opts.email ?? ""})`,
    tags: [],
    keywords: [],
    attributes: {
      ...(opts.email && { email: opts.email }),
      ...(opts.handle && { handle: opts.handle }),
    },
    source: {
      system: opts.sourceSystem,
      externalId: opts.externalId,
    },
    visibility: "personal",
    domain: "meetings",
    confidence: "confirmed",
    createdAt: now,
    updatedAt: now,
    status: "active",
  };
  db.insertEntity(entity);
  return entity;
}

describe("EntityResolver", () => {
  let db: HiveDatabase;
  let tmpDir: string;
  let resolver: EntityResolver;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hive-resolve-test-"));
    db = new HiveDatabase(join(tmpDir, "test.db"));
    resolver = new EntityResolver(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("findCandidates", () => {
    it("returns empty for non-person entity", () => {
      const entity = {
        id: "test",
        entityType: "memory",
        source: { system: "test" },
      } as Entity;
      expect(resolver.findCandidates(entity)).toEqual([]);
    });

    it("finds candidate by exact email match", () => {
      const alice1 = createPerson(db, {
        title: "Alice Smith",
        email: "alice@example.com",
        sourceSystem: "slack",
      });
      const alice2 = createPerson(db, {
        title: "Alice S.",
        email: "alice@example.com",
        sourceSystem: "github",
      });

      const candidates = resolver.findCandidates(alice2);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].matchType).toBe("exact_email");
      expect(candidates[0].entity.id).toBe(alice1.id);
      expect(candidates[0].confidence).toBe("confirmed");
    });

    it("finds candidate by exact name match", () => {
      const bob1 = createPerson(db, {
        title: "Bob Johnson",
        sourceSystem: "slack",
      });
      const bob2 = createPerson(db, {
        title: "Bob Johnson",
        sourceSystem: "github",
      });

      const candidates = resolver.findCandidates(bob2);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].matchType).toBe("exact_name");
    });

    it("finds candidate by handle match", () => {
      createPerson(db, {
        title: "Charlie",
        handle: "charlie123",
        sourceSystem: "slack",
      });
      const charlie2 = createPerson(db, {
        title: "Charlie D.",
        handle: "charlie123",
        sourceSystem: "github",
      });

      const candidates = resolver.findCandidates(charlie2);
      expect(candidates.some((c) => c.matchType === "handle")).toBe(true);
    });

    it("excludes entities from the same source system", () => {
      createPerson(db, {
        title: "Dave",
        email: "dave@example.com",
        sourceSystem: "slack",
      });
      const dave2 = createPerson(db, {
        title: "Dave",
        email: "dave@example.com",
        sourceSystem: "slack", // Same system
      });

      const candidates = resolver.findCandidates(dave2);
      expect(candidates).toHaveLength(0);
    });
  });

  describe("merge", () => {
    it("merges entities: archives superseded, moves synapses, creates aliases", () => {
      const primary = createPerson(db, {
        id: "primary-id",
        title: "Alice Smith",
        email: "alice@example.com",
        sourceSystem: "slack",
        externalId: "slack:alice",
      });
      const superseded = createPerson(db, {
        id: "superseded-id",
        title: "Alice S.",
        email: "alice@example.com",
        sourceSystem: "github",
        externalId: "github:alice",
      });

      // Create a synapse from superseded
      const meeting = createPerson(db, {
        id: "meeting-id",
        title: "Meeting",
        sourceSystem: "calendar",
      });
      db.upsertSynapse({
        sourceId: superseded.id,
        targetId: meeting.id,
        axon: "attended",
        weight: 1.0,
      });

      const result = resolver.merge(primary.id, superseded.id);

      expect(result.primaryId).toBe(primary.id);
      expect(result.supersededId).toBe(superseded.id);
      expect(result.synapsesMoved).toBeGreaterThanOrEqual(1);

      // Superseded is archived
      const archivedEntity = db.getEntity(superseded.id)!;
      expect(archivedEntity.status).toBe("archived");
      expect(archivedEntity.supersededBy).toBe(primary.id);

      // Primary has the moved synapse
      const primarySynapses = db.getSynapsesByEntry(primary.id, "outgoing", "attended");
      expect(primarySynapses).toHaveLength(1);
      expect(primarySynapses[0].target).toBe(meeting.id);

      // Aliases created
      const aliases = resolver.getAliases(primary.id);
      expect(aliases.length).toBeGreaterThanOrEqual(1);
    });

    it("is idempotent - merging already-merged entities is a no-op", () => {
      const primary = createPerson(db, {
        id: "p1",
        title: "Eve",
        sourceSystem: "slack",
      });
      const superseded = createPerson(db, {
        id: "s1",
        title: "Eve K.",
        email: "eve@example.com",
        sourceSystem: "github",
        externalId: "github:eve",
      });

      resolver.merge(primary.id, superseded.id);
      // Second merge should not error
      const result2 = resolver.merge(primary.id, superseded.id);
      expect(result2.synapsesMoved).toBe(0);
    });
  });
});

describe("HiveDatabase alias methods", () => {
  let db: HiveDatabase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hive-alias-test-"));
    db = new HiveDatabase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("upsertAlias + getAliases round-trip", () => {
    const entity = createPerson(db, {
      id: "canonical-1",
      title: "Test",
      sourceSystem: "test",
    });

    const inserted = db.upsertAlias({
      canonicalId: entity.id,
      aliasSystem: "github",
      aliasValue: "github:testuser",
      aliasType: "external_id",
      confidence: "confirmed",
    });
    expect(inserted).toBe(true);

    const aliases = db.getAliases(entity.id);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].aliasValue).toBe("github:testuser");
    expect(aliases[0].aliasType).toBe("external_id");
  });

  it("upsertAlias returns false for duplicate", () => {
    const entity = createPerson(db, {
      id: "canonical-2",
      title: "Test2",
      sourceSystem: "test",
    });

    db.upsertAlias({
      canonicalId: entity.id,
      aliasSystem: "slack",
      aliasValue: "slack:user1",
      aliasType: "handle",
      confidence: "inferred",
    });

    const inserted = db.upsertAlias({
      canonicalId: entity.id,
      aliasSystem: "slack",
      aliasValue: "slack:user1",
      aliasType: "handle",
      confidence: "confirmed",
    });
    expect(inserted).toBe(false);
  });
});

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("alice", "alice")).toBe(0);
  });

  it("returns 1 for single char difference", () => {
    expect(levenshtein("alice", "alicee")).toBe(1);
  });

  it("returns correct distance for different strings", () => {
    expect(levenshtein("alice", "bob")).toBe(5);
  });

  it("handles empty strings", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
    expect(levenshtein("", "")).toBe(0);
  });
});
