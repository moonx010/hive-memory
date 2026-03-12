import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveStore } from "../src/store/hive-store.js";
import { HiveSearch } from "../src/store/hive-search.js";

vi.mock("../src/embed.js", () => ({
  EmbedService: class {
    available = false;
    async init() {}
    async addText() {}
    async search() { return []; }
    async remove() {}
    async getEmbedding() { return null; }
    count() { return 0; }
    async close() {}
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockEmbed(): any {
  return {
    available: false,
    async init() {},
    async addText() {},
    async search() { return []; },
    async remove() {},
    async getEmbedding() { return null; },
    count() { return 0; },
    async close() {},
  };
}

/** Helper: create a mock embed that returns controlled embeddings */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createEmbedWithVectors(vectors: Map<string, number[]>): any {
  let callIdx = 0;
  const orderedVectors = [...vectors.values()];
  return {
    available: true,
    async init() {},
    async addText() {},
    async search() { return []; },
    async remove() {},
    async getEmbedding(text: string) {
      // Try exact match first
      for (const [key, vec] of vectors) {
        if (text.includes(key)) return vec;
      }
      // Fallback: return by call order
      return orderedVectors[callIdx++ % orderedVectors.length] ?? null;
    },
    count() { return 0; },
    async close() {},
  };
}

const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000;

describe("Memory Lifecycle — TTL", () => {
  let dataDir: string;
  let store: HiveStore;
  let search: HiveSearch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockEmbed: any;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "lifecycle-test-"));
    mockEmbed = createMockEmbed();
    store = new HiveStore(dataDir, mockEmbed);
    search = new HiveSearch(store, mockEmbed);
    await store.ensureDirs();
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("excludes expired status entries from search", async () => {
    // Store a status entry, then manually backdate it
    await store.storeDirectEntry("proj", "status", "old status update", ["status"]);

    // Backdate the entry in the nursery
    const hive = await store.loadHive();
    const entry = hive.nursery[0];
    expect(entry.type).toBe("direct");
    if (entry.type === "direct") {
      entry.createdAt = new Date(Date.now() - THIRTY_ONE_DAYS_MS).toISOString();
    }
    await store.saveHive(hive);

    const results = await search.search("status update");
    expect(results).toHaveLength(0);
  });

  it("includes non-expired status entries in search", async () => {
    await store.storeDirectEntry("proj", "status", "fresh status update", ["status"]);

    const results = await search.search("status update");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].snippet).toContain("fresh status update");
  });

  it("never expires decision entries regardless of age", async () => {
    await store.storeDirectEntry("proj", "decision", "use PostgreSQL for database", ["db"]);

    // Backdate the decision entry
    const hive = await store.loadHive();
    const entry = hive.nursery[0];
    if (entry.type === "direct") {
      entry.createdAt = new Date(Date.now() - THIRTY_ONE_DAYS_MS).toISOString();
    }
    await store.saveHive(hive);

    const results = await search.search("PostgreSQL database");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].snippet).toContain("PostgreSQL");
  });

  it("never expires learning entries regardless of age", async () => {
    await store.storeDirectEntry("proj", "learning", "React hooks pattern", ["react"]);

    const hive = await store.loadHive();
    const entry = hive.nursery[0];
    if (entry.type === "direct") {
      entry.createdAt = new Date(Date.now() - THIRTY_ONE_DAYS_MS).toISOString();
    }
    await store.saveHive(hive);

    const results = await search.search("React hooks");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Memory Lifecycle — Cleanup", () => {
  let dataDir: string;
  let store: HiveStore;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockEmbed: any;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cleanup-test-"));
    mockEmbed = createMockEmbed();
    store = new HiveStore(dataDir, mockEmbed);
    await store.ensureDirs();
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("removes expired status entries via removeEntries", async () => {
    // Create some entries
    await store.storeDirectEntry("proj", "status", "old status", []);
    await store.storeDirectEntry("proj", "decision", "keep this decision", []);
    await store.storeDirectEntry("proj", "status", "fresh status", []);

    // Backdate the first status entry
    const hive = await store.loadHive();
    const statusEntry = hive.nursery.find(
      (e) => e.type === "direct" && e.category === "status" && (e as any).content === "old status",
    );
    expect(statusEntry).toBeDefined();
    statusEntry!.createdAt = new Date(Date.now() - THIRTY_ONE_DAYS_MS).toISOString();
    await store.saveHive(hive);

    const STATUS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const removed = await store.removeEntries((entry) =>
      entry.type === "direct" &&
      entry.category === "status" &&
      now - new Date(entry.createdAt).getTime() > STATUS_TTL_MS,
    );

    expect(removed).toBe(1);

    // Verify remaining entries
    const updatedHive = await store.loadHive();
    expect(updatedHive.nursery).toHaveLength(2);
    expect(updatedHive.totalEntries).toBe(2);
  });

  it("removes expired entries from flushed cells", async () => {
    // Fill nursery to force flush (threshold is 10)
    for (let i = 0; i < 9; i++) {
      await store.storeDirectEntry("proj", "note", `note ${i}`, ["note"]);
    }
    // Add an old status entry as the 10th to trigger flush
    await store.storeDirectEntry("proj", "status", "old cell status", ["status"]);

    // Verify flush happened
    let hive = await store.loadHive();
    expect(hive.nursery).toHaveLength(0);

    // Backdate the status entry in the cell
    const leafIds = Object.keys(hive.cells).filter((id) => hive.cells[id].type === "leaf");
    for (const leafId of leafIds) {
      const cellData = await store.loadCellData(leafId);
      for (const entry of cellData.entries) {
        if (entry.type === "direct" && entry.category === "status") {
          entry.createdAt = new Date(Date.now() - THIRTY_ONE_DAYS_MS).toISOString();
        }
      }
      await store.saveCellData(cellData);
    }

    const STATUS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const removed = await store.removeEntries((entry) =>
      entry.type === "direct" &&
      entry.category === "status" &&
      now - new Date(entry.createdAt).getTime() > STATUS_TTL_MS,
    );

    expect(removed).toBe(1);

    hive = await store.loadHive();
    expect(hive.totalEntries).toBe(9);
  });

  it("reports zero when nothing to clean", async () => {
    await store.storeDirectEntry("proj", "decision", "keep me", []);

    const removed = await store.removeEntries(() => false);
    expect(removed).toBe(0);
  });
});

describe("Memory Lifecycle — Conflict Detection", () => {
  let dataDir: string;
  let store: HiveStore;
  let search: HiveSearch;

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("detects conflict between decision entries from different agents with high similarity", async () => {
    // Create embeddings that are very similar (cosine sim > 0.85)
    const vecA = [1, 0, 0, 0]; // normalized
    const vecB = [0.95, 0.05, 0.05, 0.05]; // very similar to vecA

    const vectors = new Map<string, number[]>();
    vectors.set("Use PostgreSQL", vecA);
    vectors.set("Use MySQL", vecB);
    vectors.set("database", vecA); // query embedding

    const mockEmbed = createEmbedWithVectors(vectors);
    dataDir = await mkdtemp(join(tmpdir(), "conflict-test-"));
    store = new HiveStore(dataDir, mockEmbed);
    search = new HiveSearch(store, mockEmbed);
    await store.ensureDirs();

    await store.storeDirectEntry("proj", "decision", "Use PostgreSQL for main database", ["db"], "claude");
    await store.storeDirectEntry("proj", "decision", "Use MySQL for main database", ["db"], "codex");

    const results = await search.search("database choice");

    // Both entries should be marked as conflicting
    const conflicting = results.filter((r) => r.conflict === true);
    expect(conflicting).toHaveLength(2);
    expect(conflicting.map((r) => r.agent).sort()).toEqual(["claude", "codex"]);
  });

  it("does not flag conflict when agents are the same", async () => {
    const vec = [1, 0, 0, 0];
    const vectors = new Map<string, number[]>();
    vectors.set("PostgreSQL", vec);
    vectors.set("database", vec);

    const mockEmbed = createEmbedWithVectors(vectors);
    dataDir = await mkdtemp(join(tmpdir(), "conflict-same-agent-"));
    store = new HiveStore(dataDir, mockEmbed);
    search = new HiveSearch(store, mockEmbed);
    await store.ensureDirs();

    await store.storeDirectEntry("proj", "decision", "Use PostgreSQL v1", ["db"], "claude");
    await store.storeDirectEntry("proj", "decision", "Use PostgreSQL v2", ["db"], "claude");

    const results = await search.search("database");
    const conflicting = results.filter((r) => r.conflict === true);
    expect(conflicting).toHaveLength(0);
  });

  it("does not flag conflict for non-decision categories", async () => {
    const vec = [1, 0, 0, 0];
    const vectors = new Map<string, number[]>();
    vectors.set("React", vec);
    vectors.set("hooks", vec);

    const mockEmbed = createEmbedWithVectors(vectors);
    dataDir = await mkdtemp(join(tmpdir(), "conflict-non-decision-"));
    store = new HiveStore(dataDir, mockEmbed);
    search = new HiveSearch(store, mockEmbed);
    await store.ensureDirs();

    await store.storeDirectEntry("proj", "learning", "React hooks are great", ["react"], "claude");
    await store.storeDirectEntry("proj", "learning", "React hooks pattern", ["react"], "codex");

    const results = await search.search("React hooks");
    const conflicting = results.filter((r) => r.conflict === true);
    expect(conflicting).toHaveLength(0);
  });

  it("does not flag conflict for different projects", async () => {
    const vec = [1, 0, 0, 0];
    const vectors = new Map<string, number[]>();
    vectors.set("PostgreSQL", vec);
    vectors.set("database", vec);

    const mockEmbed = createEmbedWithVectors(vectors);
    dataDir = await mkdtemp(join(tmpdir(), "conflict-diff-project-"));
    store = new HiveStore(dataDir, mockEmbed);
    search = new HiveSearch(store, mockEmbed);
    await store.ensureDirs();

    await store.storeDirectEntry("proj-a", "decision", "Use PostgreSQL here", ["db"], "claude");
    await store.storeDirectEntry("proj-b", "decision", "Use PostgreSQL there", ["db"], "codex");

    const results = await search.search("database PostgreSQL");
    const conflicting = results.filter((r) => r.conflict === true);
    expect(conflicting).toHaveLength(0);
  });

  it("does not flag conflict when entries lack agentId", async () => {
    const vec = [1, 0, 0, 0];
    const vectors = new Map<string, number[]>();
    vectors.set("PostgreSQL", vec);
    vectors.set("database", vec);

    const mockEmbed = createEmbedWithVectors(vectors);
    dataDir = await mkdtemp(join(tmpdir(), "conflict-no-agent-"));
    store = new HiveStore(dataDir, mockEmbed);
    search = new HiveSearch(store, mockEmbed);
    await store.ensureDirs();

    // No agentId provided
    await store.storeDirectEntry("proj", "decision", "Use PostgreSQL v1", ["db"]);
    await store.storeDirectEntry("proj", "decision", "Use PostgreSQL v2", ["db"]);

    const results = await search.search("database PostgreSQL");
    const conflicting = results.filter((r) => r.conflict === true);
    expect(conflicting).toHaveLength(0);
  });
});
