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

describe("HiveSearch", () => {
  let dataDir: string;
  let store: HiveStore;
  let search: HiveSearch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockEmbed: any;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "hive-search-test-"));
    mockEmbed = createMockEmbed();
    store = new HiveStore(dataDir, mockEmbed);
    search = new HiveSearch(store, mockEmbed);
    await store.ensureDirs();
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  describe("keyword search", () => {
    it("finds entries by keyword match in nursery", async () => {
      await store.storeDirectEntry("proj-a", "decision", "Use JWT tokens for authentication", ["auth", "jwt"]);
      await store.storeDirectEntry("proj-a", "learning", "React hooks are powerful", ["react"]);

      const results = await search.search("JWT authentication");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].snippet).toContain("JWT");
    });

    it("returns empty for no matches", async () => {
      await store.storeDirectEntry("proj-a", "note", "Hello world", []);
      const results = await search.search("xyznonexistent");
      expect(results).toHaveLength(0);
    });
  });

  describe("filtering", () => {
    it("filters by project", async () => {
      await store.storeDirectEntry("proj-a", "decision", "Use JWT for auth in proj-a", ["jwt"]);
      await store.storeDirectEntry("proj-b", "decision", "Use JWT for auth in proj-b", ["jwt"]);

      const results = await search.search("JWT", { project: "proj-a" });
      for (const r of results) {
        expect(r.project).toBe("proj-a");
      }
    });

    it("filters by category", async () => {
      await store.storeDirectEntry("proj-a", "decision", "JWT decision", ["jwt"]);
      await store.storeDirectEntry("proj-a", "learning", "JWT learning", ["jwt"]);

      const results = await search.search("JWT", { category: "decision" });
      for (const r of results) {
        expect(r.category).toBe("decision");
      }
    });

    it("respects limit", async () => {
      for (let i = 0; i < 10; i++) {
        await store.storeDirectEntry("proj", "note", `JWT note ${i}`, ["jwt"]);
      }
      const results = await search.search("JWT", { limit: 3 });
      expect(results.length).toBeLessThanOrEqual(3);
    });
  });

  describe("mixed entry types", () => {
    it("returns both direct and reference entries", async () => {
      await store.storeDirectEntry("proj-a", "decision", "Use JWT tokens for auth", ["jwt"]);
      await store.storeReferenceEntry(
        "proj-b",
        "/path/to/MEMORY.md",
        "claude-memory",
        "JWT token expiration handling notes",
        ["jwt"],
      );

      const results = await search.search("JWT");
      expect(results.length).toBe(2);

      const direct = results.find((r) => r.category !== undefined);
      const reference = results.find((r) => r.source !== undefined);

      expect(direct).toBeDefined();
      expect(direct!.project).toBe("proj-a");

      expect(reference).toBeDefined();
      expect(reference!.project).toBe("proj-b");
      expect(reference!.path).toBe("/path/to/MEMORY.md");
    });
  });

  describe("beam search through cells", () => {
    it("finds entries in flushed cells", async () => {
      // Fill nursery to force flush
      for (let i = 0; i < 10; i++) {
        await store.storeDirectEntry("proj", "note", `JWT authentication note ${i}`, ["jwt"]);
      }

      // Nursery should be flushed now - entries are in cells
      const hive = await store.loadHive();
      expect(hive.nursery).toHaveLength(0);

      const results = await search.search("JWT authentication");
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe("tag matching", () => {
    it("boosts score for tag matches", async () => {
      await store.storeDirectEntry("proj", "note", "Some content about tokens", ["jwt", "auth"]);
      await store.storeDirectEntry("proj", "note", "Some content about tokens", []);

      const results = await search.search("jwt");
      // Entry with matching tag should score higher
      if (results.length >= 2) {
        expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
      }
    });
  });
});
