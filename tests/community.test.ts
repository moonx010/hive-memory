import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectCommunities } from "../src/search/community.js";
import { buildGraphRAGSummaries } from "../src/search/graph-rag.js";
import { HiveDatabase } from "../src/db/database.js";
import type { Entity } from "../src/types.js";

// ── helpers ──

function makeEntities(
  ids: string[],
  keywords: string[] = [],
): Array<{ id: string; keywords: string[] }> {
  return ids.map((id) => ({ id, keywords }));
}

function makeTriangle(): {
  entities: Array<{ id: string; keywords: string[] }>;
  synapses: Array<{ source: string; target: string; weight: number }>;
} {
  const entities = makeEntities(["a", "b", "c"], ["typescript", "node"]);
  const synapses = [
    { source: "a", target: "b", weight: 0.8 },
    { source: "b", target: "c", weight: 0.8 },
    { source: "c", target: "a", weight: 0.8 },
  ];
  return { entities, synapses };
}

// ── unit tests: detectCommunities ──

describe("detectCommunities", () => {
  it("triangle (3 nodes, all connected) → 1 community", () => {
    const { entities, synapses } = makeTriangle();
    const communities = detectCommunities(entities, synapses);

    expect(communities).toHaveLength(1);
    expect(communities[0].entityIds.sort()).toEqual(["a", "b", "c"]);
    expect(communities[0].size).toBe(3);
  });

  it("2 disconnected clusters → 2 communities", () => {
    // Cluster 1: a-b-c (triangle)
    // Cluster 2: x-y-z (triangle)
    const entities = [
      ...makeEntities(["a", "b", "c"], ["frontend", "react"]),
      ...makeEntities(["x", "y", "z"], ["backend", "database"]),
    ];
    const synapses = [
      { source: "a", target: "b", weight: 0.9 },
      { source: "b", target: "c", weight: 0.9 },
      { source: "c", target: "a", weight: 0.9 },
      { source: "x", target: "y", weight: 0.9 },
      { source: "y", target: "z", weight: 0.9 },
      { source: "z", target: "x", weight: 0.9 },
    ];

    const communities = detectCommunities(entities, synapses);

    expect(communities).toHaveLength(2);
    const sizes = communities.map((c) => c.size).sort((a, b) => b - a);
    expect(sizes).toEqual([3, 3]);
  });

  it("isolated node (no synapses) → excluded when minCommunitySize=3", () => {
    const entities = makeEntities(["solo"], ["alone"]);
    const synapses: Array<{ source: string; target: string; weight: number }> = [];

    const communities = detectCommunities(entities, synapses, { minCommunitySize: 3 });

    // solo node has no neighbors so it forms its own group of size 1, which is < 3
    expect(communities).toHaveLength(0);
  });

  it("community label is derived from top keywords", () => {
    const entities = [
      { id: "a", keywords: ["typescript", "node", "backend"] },
      { id: "b", keywords: ["typescript", "node", "api"] },
      { id: "c", keywords: ["typescript", "database", "backend"] },
    ];
    const synapses = [
      { source: "a", target: "b", weight: 0.8 },
      { source: "b", target: "c", weight: 0.8 },
      { source: "c", target: "a", weight: 0.8 },
    ];

    const communities = detectCommunities(entities, synapses);

    expect(communities).toHaveLength(1);
    // "typescript" appears 3 times, should be in label
    expect(communities[0].label).toContain("typescript");
  });

  it("respects minCommunitySize option", () => {
    // 3 nodes in a triangle (size 3) + 2 nodes in a pair (size 2)
    const entities = [
      ...makeEntities(["a", "b", "c"], ["theme"]),
      ...makeEntities(["x", "y"], ["other"]),
    ];
    const synapses = [
      { source: "a", target: "b", weight: 0.9 },
      { source: "b", target: "c", weight: 0.9 },
      { source: "c", target: "a", weight: 0.9 },
      { source: "x", target: "y", weight: 0.9 },
    ];

    const commSize3 = detectCommunities(entities, synapses, { minCommunitySize: 3 });
    expect(commSize3).toHaveLength(1);
    expect(commSize3[0].size).toBe(3);

    const commSize2 = detectCommunities(entities, synapses, { minCommunitySize: 2 });
    expect(commSize2).toHaveLength(2);
  });

  it("result is sorted by size descending", () => {
    // Large cluster: a-b-c-d (square + cross)
    // Small cluster: x-y-z (triangle)
    const entities = [
      ...makeEntities(["a", "b", "c", "d"], ["big"]),
      ...makeEntities(["x", "y", "z"], ["small"]),
    ];
    const synapses = [
      { source: "a", target: "b", weight: 0.9 },
      { source: "b", target: "c", weight: 0.9 },
      { source: "c", target: "d", weight: 0.9 },
      { source: "d", target: "a", weight: 0.9 },
      { source: "a", target: "c", weight: 0.9 },
      { source: "x", target: "y", weight: 0.9 },
      { source: "y", target: "z", weight: 0.9 },
      { source: "z", target: "x", weight: 0.9 },
    ];

    const communities = detectCommunities(entities, synapses, { minCommunitySize: 3 });

    expect(communities[0].size).toBeGreaterThanOrEqual(communities[1]?.size ?? 0);
  });

  it("empty inputs → empty result", () => {
    expect(detectCommunities([], [])).toHaveLength(0);
  });
});

// ── integration tests: buildGraphRAGSummaries ──

describe("buildGraphRAGSummaries", () => {
  let db: HiveDatabase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "community-test-"));
    db = new HiveDatabase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertEntity(
    id: string,
    overrides: Partial<Entity> & Pick<Entity, "entityType" | "content">,
  ): Entity {
    const now = new Date().toISOString();
    const entity: Entity = {
      id,
      namespace: "local",
      tags: [],
      keywords: [],
      attributes: {},
      source: { system: "test" },
      visibility: "personal",
      domain: "engineering",
      confidence: "confirmed",
      createdAt: now,
      updatedAt: now,
      status: "active",
      ...overrides,
    };
    db.insertEntity(entity);
    return entity;
  }

  it("returns communities and globalSummary for a graph with connected entities", () => {
    // Create 3 connected entities (minimum for default minCommunitySize)
    insertEntity("e1", {
      entityType: "decision",
      content: "Use TypeScript for the backend",
      keywords: ["typescript", "backend"],
    });
    insertEntity("e2", {
      entityType: "decision",
      content: "Use Node.js runtime",
      keywords: ["typescript", "node"],
    });
    insertEntity("e3", {
      entityType: "learning",
      content: "TypeScript improves developer experience",
      keywords: ["typescript", "dx"],
    });

    // Connect them
    db.upsertSynapse({ sourceId: "e1", targetId: "e2", axon: "semantic", weight: 0.8 });
    db.upsertSynapse({ sourceId: "e2", targetId: "e3", axon: "semantic", weight: 0.8 });
    db.upsertSynapse({ sourceId: "e3", targetId: "e1", axon: "semantic", weight: 0.8 });

    const result = buildGraphRAGSummaries(db);

    expect(result.communities).toHaveLength(1);
    expect(result.communities[0].size).toBe(3);
    expect(result.communities[0].label).toContain("typescript");
    expect(result.globalSummary).toContain("3 entities");
    expect(result.globalSummary).toContain("1 communities");
  });

  it("returns empty communities for disconnected/sparse graph", () => {
    // 2 isolated entities — no synapses → no community (size < 3)
    insertEntity("solo1", { entityType: "memory", content: "Isolated thought A" });
    insertEntity("solo2", { entityType: "memory", content: "Isolated thought B" });

    const result = buildGraphRAGSummaries(db);

    expect(result.communities).toHaveLength(0);
    expect(result.globalSummary).toContain("0 communities");
  });

  it("community topEntities has at most 5 entries", () => {
    // Create 6-node star cluster (all connected to center)
    const ids = ["c", "n1", "n2", "n3", "n4", "n5", "n6"];
    for (const id of ids) {
      insertEntity(id, {
        entityType: "memory",
        content: `Node ${id}`,
        keywords: ["cluster"],
      });
    }
    // All nodes connected to center
    for (const id of ids.slice(1)) {
      db.upsertSynapse({ sourceId: "c", targetId: id, axon: "semantic", weight: 0.9 });
      db.upsertSynapse({ sourceId: id, targetId: "c", axon: "semantic", weight: 0.9 });
    }

    const result = buildGraphRAGSummaries(db);

    expect(result.communities.length).toBeGreaterThan(0);
    for (const community of result.communities) {
      expect(community.topEntities.length).toBeLessThanOrEqual(5);
    }
  });

  it("globalSummary mentions entity and community counts", () => {
    insertEntity("a", { entityType: "decision", content: "Decision A", keywords: ["arch"] });
    insertEntity("b", { entityType: "decision", content: "Decision B", keywords: ["arch"] });
    insertEntity("c", { entityType: "decision", content: "Decision C", keywords: ["arch"] });
    db.upsertSynapse({ sourceId: "a", targetId: "b", axon: "semantic", weight: 0.9 });
    db.upsertSynapse({ sourceId: "b", targetId: "c", axon: "semantic", weight: 0.9 });
    db.upsertSynapse({ sourceId: "c", targetId: "a", axon: "semantic", weight: 0.9 });

    const result = buildGraphRAGSummaries(db);

    expect(result.globalSummary).toMatch(/\d+ entities/);
    expect(result.globalSummary).toMatch(/\d+ communities/);
  });
});
