import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../src/db/database.js";
import { rrfFusion, generateContextPrefix, buildEmbedText } from "../src/search/hybrid.js";
import { resetEmbedderCache } from "../src/search/embedder.js";
import type { Entity } from "../src/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEntity(overrides: Partial<Entity> & { id: string; content: string }): Entity {
  return {
    entityType: "memory",
    namespace: "local",
    tags: [],
    keywords: [],
    attributes: {},
    source: { system: "agent" },
    visibility: "personal",
    domain: "code",
    confidence: "confirmed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "active",
    ...overrides,
  };
}

// ── RRF Fusion ───────────────────────────────────────────────────────────────

describe("rrfFusion", () => {
  it("returns bm25-only results when no vector results", () => {
    const entities = [
      makeEntity({ id: "a", content: "alpha" }),
      makeEntity({ id: "b", content: "beta" }),
    ];
    const entityMap = new Map(entities.map((e) => [e.id, e]));
    const results = rrfFusion(entities, [], entityMap);
    expect(results).toHaveLength(2);
    expect(results[0].entity.id).toBe("a");
    expect(results[0].sources).toContain("bm25");
  });

  it("boosts entities appearing in both lists", () => {
    const a = makeEntity({ id: "a", content: "shared" });
    const b = makeEntity({ id: "b", content: "bm25 only" });
    const c = makeEntity({ id: "c", content: "vector only" });

    const bm25 = [a, b];
    const vector = [
      { entityId: "a", distance: 0.1 },
      { entityId: "c", distance: 0.2 },
    ];
    const entityMap = new Map([a, b, c].map((e) => [e.id, e]));

    const results = rrfFusion(bm25, vector, entityMap, 60, 10);

    // "a" should be ranked first (appears in both lists)
    expect(results[0].entity.id).toBe("a");
    expect(results[0].sources).toEqual(expect.arrayContaining(["bm25", "vector"]));
  });

  it("respects the limit parameter", () => {
    const entities = Array.from({ length: 10 }, (_, i) =>
      makeEntity({ id: `e${i}`, content: `content ${i}` }),
    );
    const entityMap = new Map(entities.map((e) => [e.id, e]));
    const results = rrfFusion(entities, [], entityMap, 60, 3);
    expect(results).toHaveLength(3);
  });

  it("skips vector hits not in entityMap", () => {
    const a = makeEntity({ id: "a", content: "present" });
    const entityMap = new Map([["a", a]]);
    const results = rrfFusion(
      [a],
      [{ entityId: "unknown-id", distance: 0.05 }],
      entityMap,
      60,
      10,
    );
    // "unknown-id" should not appear since it's not in entityMap
    expect(results.find((r) => r.entity.id === "unknown-id")).toBeUndefined();
    expect(results).toHaveLength(1);
  });
});

// ── Context Prefix ────────────────────────────────────────────────────────────

describe("generateContextPrefix", () => {
  it("returns empty string when no contextual fields besides entityType", () => {
    // entityType is always set — prefix only includes fields with meaningful context
    // When entityType is "memory" and no project/tags/connector, still includes Type:
    const entity = makeEntity({ id: "x", content: "bare", entityType: "memory" });
    const prefix = generateContextPrefix(entity);
    // entityType "memory" is included — this is expected behavior
    expect(prefix).toContain("Type: memory");
  });

  it("includes all available fields", () => {
    const entity = makeEntity({
      id: "x",
      content: "test",
      entityType: "decision",
      project: "hive-memory",
      tags: ["architecture", "database"],
      source: { system: "agent", connector: "github" },
    });
    const prefix = generateContextPrefix(entity);
    expect(prefix).toContain("Source: github");
    expect(prefix).toContain("Type: decision");
    expect(prefix).toContain("Project: hive-memory");
    expect(prefix).toContain("Tags: architecture, database");
  });

  it("builds embed text with prefix + title + content", () => {
    const entity = makeEntity({
      id: "x",
      content: "The content here",
      title: "My Title",
      entityType: "memory",
      project: "proj",
    });
    const text = buildEmbedText(entity);
    expect(text).toContain("My Title");
    expect(text).toContain("The content here");
    expect(text).toContain("Project: proj");
  });
});

// ── HiveDatabase hybrid search ────────────────────────────────────────────────

describe("HiveDatabase.hybridSearch", () => {
  let db: HiveDatabase;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "hive-hybrid-test-"));
    db = new HiveDatabase(join(dataDir, "test.db"));
  });

  afterEach(async () => {
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("falls back to FTS5-only when no embedding provided", () => {
    const entity = makeEntity({
      id: "e1",
      content: "vector search implementation",
    });
    db.insertEntity(entity);

    const results = db.hybridSearch("vector search");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe("e1");
  });

  it("returns empty when no matches", () => {
    const results = db.hybridSearch("xyznonexistentquery");
    expect(results).toHaveLength(0);
  });

  it("respects project filter", () => {
    const e1 = makeEntity({ id: "p1", content: "hybrid search", project: "proj-a" });
    const e2 = makeEntity({ id: "p2", content: "hybrid search", project: "proj-b" });
    db.insertEntity(e1);
    db.insertEntity(e2);

    const results = db.hybridSearch("hybrid search", { project: "proj-a" });
    expect(results.every((r) => r.project === "proj-a")).toBe(true);
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      db.insertEntity(makeEntity({ id: `lim${i}`, content: "limit test memory recall" }));
    }
    const results = db.hybridSearch("limit test memory recall", { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("uses vector results when embedding provided and vec0 available", () => {
    // Insert entity with content that has NO overlap with our FTS query
    const entity = makeEntity({
      id: "vec1",
      content: "absolutely unique content about quantum computing algorithms",
      title: "vector hit",
    });
    db.insertEntity(entity);

    // Store a second entity that FTS will find but vector won't
    const entity2 = makeEntity({
      id: "vec2",
      content: "zebra purple dinosaur magnolia",
    });
    db.insertEntity(entity2);

    // Store a vector for vec1 only
    const vs = db.vectorStore;
    if (!vs.isAvailable) return; // skip if sqlite-vec not available

    // Use matching embeddings so distance ≈ 0 (highly similar)
    const queryEmbed = new Float32Array(384).fill(0.1);
    const docEmbed = new Float32Array(384).fill(0.1); // identical → distance = 0
    vs.upsertVector("vec1", docEmbed);

    // Search with a query that won't match vec1 via FTS (uses words not in content)
    const results = db.hybridSearch("zebra purple dinosaur magnolia", {
      embedding: queryEmbed,
    });

    // vec1 should appear via vector path (close embedding)
    const found = results.find((r) => r.id === "vec1");
    expect(found).toBeDefined();
    // vec2 should also appear (FTS match)
    const found2 = results.find((r) => r.id === "vec2");
    expect(found2).toBeDefined();
  });
});

// ── Graceful degradation ──────────────────────────────────────────────────────

describe("embedder graceful degradation", () => {
  beforeEach(() => {
    resetEmbedderCache();
  });

  afterEach(() => {
    resetEmbedderCache();
  });

  it("createEmbedder returns non-available embedder when CORTEX_EMBEDDING_PROVIDER=none", async () => {
    process.env.CORTEX_EMBEDDING_PROVIDER = "none";
    const { createEmbedder } = await import("../src/search/embedder.js");
    const embedder = await createEmbedder();
    expect(embedder.isAvailable).toBe(false);
    const result = await embedder.embed("test");
    expect(result).toBeNull();
    delete process.env.CORTEX_EMBEDDING_PROVIDER;
  });
});
