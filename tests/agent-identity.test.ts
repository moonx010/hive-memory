import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveStore } from "../src/store/hive-store.js";
import { HiveSearch } from "../src/store/hive-search.js";
import type { DirectEntry } from "../src/types.js";

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

describe("Agent Identity", () => {
  let dataDir: string;
  let store: HiveStore;
  let search: HiveSearch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockEmbed: any;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "agent-identity-test-"));
    mockEmbed = createMockEmbed();
    store = new HiveStore(dataDir, mockEmbed);
    search = new HiveSearch(store, mockEmbed);
    await store.ensureDirs();
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  describe("storeDirectEntry with agentId", () => {
    it("stores entry without agentId (backward compatible)", async () => {
      const result = await store.storeDirectEntry("proj-a", "decision", "Use REST API", ["api"]);
      expect(result.id).toBeDefined();
      expect(result.project).toBe("proj-a");

      const hive = await store.loadHive();
      const entry = hive.nursery[0] as DirectEntry;
      expect(entry.agentId).toBeUndefined();
    });

    it("stores entry with agentId", async () => {
      const result = await store.storeDirectEntry("proj-a", "learning", "React hooks pattern", ["react"], "claude");
      expect(result.id).toBeDefined();

      const hive = await store.loadHive();
      const entry = hive.nursery[0] as DirectEntry;
      expect(entry.agentId).toBe("claude");
    });

    it("stores entries with different agentIds", async () => {
      await store.storeDirectEntry("proj-a", "decision", "Use TypeScript", ["ts"], "claude");
      await store.storeDirectEntry("proj-a", "decision", "Use ESLint", ["lint"], "codex");
      await store.storeDirectEntry("proj-a", "note", "General note", []);

      const hive = await store.loadHive();
      expect(hive.nursery).toHaveLength(3);

      const entries = hive.nursery as DirectEntry[];
      expect(entries[0].agentId).toBe("claude");
      expect(entries[1].agentId).toBe("codex");
      expect(entries[2].agentId).toBeUndefined();
    });
  });

  describe("search with agent filter", () => {
    it("returns all entries when no agent filter", async () => {
      await store.storeDirectEntry("proj-a", "decision", "Use JWT tokens for auth", ["auth"], "claude");
      await store.storeDirectEntry("proj-a", "decision", "Use OAuth for auth", ["auth"], "codex");
      await store.storeDirectEntry("proj-a", "learning", "Auth best practices", ["auth"]);

      const results = await search.search("auth");
      expect(results.length).toBe(3);
    });

    it("filters results by agent", async () => {
      await store.storeDirectEntry("proj-a", "decision", "Use JWT tokens for auth", ["auth"], "claude");
      await store.storeDirectEntry("proj-a", "decision", "Use OAuth for auth", ["auth"], "codex");
      await store.storeDirectEntry("proj-a", "learning", "Auth best practices", ["auth"]);

      const claudeResults = await search.search("auth", { agent: "claude" });
      expect(claudeResults.length).toBe(1);
      expect(claudeResults[0].agent).toBe("claude");
      expect(claudeResults[0].snippet).toContain("JWT");

      const codexResults = await search.search("auth", { agent: "codex" });
      expect(codexResults.length).toBe(1);
      expect(codexResults[0].agent).toBe("codex");
      expect(codexResults[0].snippet).toContain("OAuth");
    });

    it("excludes entries without agentId when filtering by agent", async () => {
      await store.storeDirectEntry("proj-a", "note", "General auth note", ["auth"]);
      await store.storeDirectEntry("proj-a", "decision", "Claude auth decision", ["auth"], "claude");

      const results = await search.search("auth", { agent: "claude" });
      expect(results.length).toBe(1);
      expect(results[0].agent).toBe("claude");
    });

    it("includes agent field in search results", async () => {
      await store.storeDirectEntry("proj-a", "decision", "Use TypeScript", ["ts"], "claude");

      const results = await search.search("TypeScript");
      expect(results.length).toBe(1);
      expect(results[0].agent).toBe("claude");
      expect(results[0].project).toBe("proj-a");
      expect(results[0].category).toBe("decision");
    });

    it("does not include agent field for entries without agentId", async () => {
      await store.storeDirectEntry("proj-a", "note", "Plain note about TypeScript", ["ts"]);

      const results = await search.search("TypeScript");
      expect(results.length).toBe(1);
      expect(results[0].agent).toBeUndefined();
    });
  });
});
