import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { HiveDatabase } from "../src/db/database.js";
import { handleApiRequest } from "../src/dashboard/api.js";
import type { Entity } from "../src/types.js";

function makeEntity(overrides: Partial<Entity> = {}): Entity {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    entityType: "memory",
    namespace: "local",
    content: "test content",
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

describe("Dashboard API", () => {
  let db: HiveDatabase;

  beforeEach(() => {
    db = new HiveDatabase(":memory:");
    // Insert test data
    const e1 = makeEntity({ title: "Auth decision", entityType: "decision", project: "jarvis" });
    const e2 = makeEntity({ title: "API design", entityType: "memory", project: "jarvis" });
    const e3 = makeEntity({ title: "Deploy notes", entityType: "note", project: "hive" });
    db.insertEntity(e1);
    db.insertEntity(e2);
    db.insertEntity(e3);
    db.insertSynapse({
      id: randomUUID(),
      source: e1.id,
      target: e2.id,
      axon: "semantic",
      weight: 0.5,
      metadata: {},
      formedAt: new Date().toISOString(),
      lastPotentiated: new Date().toISOString(),
    });
  });

  it("/api/stats returns entity and synapse counts", () => {
    const result = handleApiRequest(db, "/api/stats", new URLSearchParams()) as {
      totalEntities: number;
      byType: Array<{ key: string; count: number }>;
      byProject: Array<{ key: string; count: number }>;
      synapses: { total: number };
    };
    expect(result.totalEntities).toBe(3);
    expect(result.byType.length).toBeGreaterThanOrEqual(2);
    expect(result.byProject.length).toBe(2);
    expect(result.synapses.total).toBe(1);
  });

  it("/api/graph returns nodes and edges", () => {
    const result = handleApiRequest(db, "/api/graph", new URLSearchParams()) as {
      nodes: Array<{ id: string; type: string }>;
      edges: Array<{ source: string; target: string }>;
    };
    expect(result.nodes.length).toBe(3);
    expect(result.edges.length).toBe(1);
  });

  it("/api/graph filters by project", () => {
    const params = new URLSearchParams({ project: "hive" });
    const result = handleApiRequest(db, "/api/graph", params) as {
      nodes: Array<{ id: string }>;
    };
    expect(result.nodes.length).toBe(1);
  });

  it("/api/timeline returns date-grouped entries", () => {
    const result = handleApiRequest(db, "/api/timeline", new URLSearchParams()) as {
      dates: Array<{ date: string; entities: unknown[] }>;
    };
    expect(result.dates.length).toBeGreaterThanOrEqual(1);
    const totalEntities = result.dates.reduce((s, d) => s + d.entities.length, 0);
    expect(totalEntities).toBe(3);
  });

  it("throws on unknown route", () => {
    expect(() => handleApiRequest(db, "/api/unknown", new URLSearchParams())).toThrow();
  });
});
