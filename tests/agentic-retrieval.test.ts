import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { HiveDatabase } from "../src/db/database.js";
import { agenticRetrieve, decomposeQuery } from "../src/search/agentic-retrieval.js";
import { ruleBasedRewrite } from "../src/search/query-rewriter.js";
import type { Entity } from "../src/types.js";

function makeEntity(overrides: Partial<Entity> & { id: string; content: string }): Entity {
  return {
    entityType: "memory",
    namespace: "local",
    tags: [],
    keywords: [],
    attributes: {},
    source: { system: "test" },
    visibility: "personal",
    domain: "code",
    confidence: "confirmed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "active",
    ...overrides,
  };
}

describe("decomposeQuery", () => {
  it("adds decision sub-queries for decision intent", () => {
    const rewritten = ruleBasedRewrite("why did we choose PostgreSQL");
    // Override intent for test
    const result = decomposeQuery("why did we choose PostgreSQL", { ...rewritten, intent: "decision" });
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.some(q => q.includes("alternatives") || q.includes("rationale"))).toBe(true);
  });

  it("adds temporal sub-queries for temporal intent", () => {
    const rewritten = ruleBasedRewrite("recent changes to API");
    const result = decomposeQuery("recent changes to API", { ...rewritten, intent: "temporal" });
    expect(result.some(q => q.includes("timeline") || q.includes("history") || q.includes("latest"))).toBe(true);
  });

  it("adds person sub-queries for person intent", () => {
    const rewritten = ruleBasedRewrite("who designed the auth system");
    const result = decomposeQuery("who designed the auth system", { ...rewritten, intent: "person" });
    expect(result.some(q => q.includes("contributions") || q.includes("meetings"))).toBe(true);
  });

  it("adds exploratory sub-queries for exploratory intent", () => {
    const rewritten = ruleBasedRewrite("kubernetes deployment strategy");
    const result = decomposeQuery("kubernetes deployment strategy", { ...rewritten, intent: "exploratory" });
    expect(result.some(q => q.includes("related") || q.includes("examples"))).toBe(true);
  });

  it("includes the rewritten query as first entry", () => {
    const rewritten = ruleBasedRewrite("test query");
    const result = decomposeQuery("test query", rewritten);
    expect(result[0]).toBe(rewritten.rewritten);
  });
});

describe("agenticRetrieve", () => {
  let db: HiveDatabase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agentic-test-"));
    db = new HiveDatabase(join(tmpDir, "test.db"));

    // Insert some test entities
    const entities: Entity[] = [
      makeEntity({ id: randomUUID(), content: "We decided to use PostgreSQL for its ACID compliance and JSON support", title: "DB decision" }),
      makeEntity({ id: randomUUID(), content: "PostgreSQL performance tuning guide with connection pooling", title: "DB performance" }),
      makeEntity({ id: randomUUID(), content: "API rate limiting strategy using Redis tokens", title: "API rate limit" }),
      makeEntity({ id: randomUUID(), content: "Frontend authentication flow with JWT tokens", title: "Auth design" }),
      makeEntity({ id: randomUUID(), content: "Database migration timeline and history of schema changes", title: "DB timeline" }),
    ];
    for (const e of entities) db.insertEntity(e);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a single step for short factual queries", async () => {
    // Short factual query (< 8 words): "what is rate limit"
    const result = await agenticRetrieve("what is rate limit", db);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].reasoning).toBe("Direct retrieval");
  });

  it("returns multiple steps for complex exploratory queries", async () => {
    // Long exploratory query (no who/when/decided/what/how/why keywords) should trigger multi-step
    const result = await agenticRetrieve(
      "kubernetes deployment strategy and all related service mesh configurations",
      db,
      { maxSteps: 3 },
    );
    expect(result.steps.length).toBeGreaterThan(1);
  });

  it("respects max_steps limit", async () => {
    const result = await agenticRetrieve(
      "tell me everything about the database architecture decisions and history timeline",
      db,
      { maxSteps: 2 },
    );
    expect(result.steps.length).toBeLessThanOrEqual(2);
  });

  it("deduplicates results across steps", async () => {
    const result = await agenticRetrieve(
      "database PostgreSQL performance and history timeline changes",
      db,
      { maxSteps: 3 },
    );
    // Verify no duplicate IDs in finalResults
    const ids = result.finalResults.map(e => e.id);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
  });

  it("returns finalResults limited to 20", async () => {
    const result = await agenticRetrieve(
      "tell me everything about all possible configurations and settings in detail",
      db,
      { maxSteps: 3 },
    );
    expect(result.finalResults.length).toBeLessThanOrEqual(20);
  });

  it("handles queries with no matching results", async () => {
    const result = await agenticRetrieve("xyznonexistent query that matches nothing", db);
    expect(result.finalResults).toHaveLength(0);
  });
});
