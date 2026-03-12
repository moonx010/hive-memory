import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveStore } from "../src/store/hive-store.js";

// Mock EmbedService
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

// Create a mock embed service with controllable getEmbedding
function createMockEmbed(returnEmbedding: number[] | null = null) {
  return {
    available: !!returnEmbedding,
    async init() {},
    async addText() {},
    async search() { return []; },
    async remove() {},
    async getEmbedding() { return returnEmbedding; },
    count() { return 0; },
    async close() {},
    get backend() { return "none" as const; },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("HiveStore", () => {
  let dataDir: string;
  let store: HiveStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "hive-store-test-"));
    store = new HiveStore(dataDir, createMockEmbed());
    await store.ensureDirs();
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  describe("loadHive / saveHive", () => {
    it("returns empty hive when no file exists", async () => {
      const hive = await store.loadHive();
      expect(hive.version).toBe(1);
      expect(hive.nursery).toHaveLength(0);
      expect(hive.totalEntries).toBe(0);
      expect(Object.keys(hive.cells)).toHaveLength(0);
    });

    it("round-trips hive data", async () => {
      const hive = await store.loadHive();
      hive.totalEntries = 5;
      await store.saveHive(hive);

      const loaded = await store.loadHive();
      expect(loaded.totalEntries).toBe(5);
    });
  });

  describe("storeDirectEntry", () => {
    it("stores a direct entry in nursery", async () => {
      const entry = await store.storeDirectEntry("proj-a", "decision", "Use JWT for auth", ["auth"]);
      expect(entry.id).toBeDefined();
      expect(entry.project).toBe("proj-a");
      expect(entry.category).toBe("decision");
      expect(entry.content).toBe("Use JWT for auth");

      const hive = await store.loadHive();
      expect(hive.nursery).toHaveLength(1);
      expect(hive.totalEntries).toBe(1);
    });

    it("returns a MemoryEntry compatible result", async () => {
      const entry = await store.storeDirectEntry("proj-a", "learning", "Learned X", []);
      expect(entry.id).toBeTruthy();
      expect(entry.createdAt).toBeTruthy();
      expect(entry.tags).toEqual([]);
    });
  });

  describe("storeReferenceEntry", () => {
    it("stores a reference entry in nursery", async () => {
      const entry = await store.storeReferenceEntry(
        "proj-b",
        "/path/to/MEMORY.md",
        "claude-memory",
        "JWT token handling notes",
        ["auth"],
      );
      expect(entry.type).toBe("reference");
      expect(entry.path).toBe("/path/to/MEMORY.md");
      expect(entry.source).toBe("claude-memory");

      const hive = await store.loadHive();
      expect(hive.nursery).toHaveLength(1);
      expect(hive.nursery[0].type).toBe("reference");
    });
  });

  describe("flushNursery", () => {
    it("creates a cell from nursery entries when no cells exist", async () => {
      // Add entries below threshold
      for (let i = 0; i < 5; i++) {
        await store.storeDirectEntry("proj", "note", `Note ${i}`, []);
      }

      const hive = await store.loadHive();
      expect(hive.nursery).toHaveLength(5);

      // Manually flush
      await store.flushNursery(hive);
      await store.saveHive(hive);

      expect(hive.nursery).toHaveLength(0);
      const cellIds = Object.keys(hive.cells);
      expect(cellIds).toHaveLength(1);
      expect(hive.cells[cellIds[0]].type).toBe("leaf");
    });

    it("auto-flushes at threshold", async () => {
      for (let i = 0; i < 10; i++) {
        await store.storeDirectEntry("proj", "note", `Entry ${i}`, []);
      }

      const hive = await store.loadHive();
      // After 10 entries, nursery should have been flushed
      expect(hive.nursery).toHaveLength(0);
      expect(Object.keys(hive.cells).length).toBeGreaterThan(0);
    });
  });

  describe("splitCell", () => {
    it("splits a cell when it exceeds threshold", async () => {
      // Create mock embed that returns distinct embeddings for splitting
      let counter = 0;
      const mockEmbed = createMockEmbed();
      mockEmbed.getEmbedding = async () => {
        counter++;
        // Create two distinct clusters
        if (counter <= 12) {
          return [1, 0, 0, ...new Array(381).fill(0)];
        } else {
          return [0, 0, 1, ...new Array(381).fill(0)];
        }
      };

      const splitStore = new HiveStore(dataDir, mockEmbed);
      await splitStore.ensureDirs();

      // Store > 20 entries to trigger split.
      // Flush happens at 10 entries. After 30 entries:
      //   flush@10 → cell with 10; flush@20 → cell with 20; flush@30 → cell with 30 → split
      for (let i = 0; i < 30; i++) {
        await splitStore.storeDirectEntry("proj", "note", `Entry ${i}`, []);
      }

      const hive = await splitStore.loadHive();
      const branchCells = Object.values(hive.cells).filter((c) => c.type === "branch");
      expect(branchCells.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("loadCellData / saveCellData", () => {
    it("returns empty entries for nonexistent cell", async () => {
      const data = await store.loadCellData("nonexistent");
      expect(data.entries).toHaveLength(0);
    });

    it("round-trips cell data", async () => {
      await store.saveCellData({
        cellId: "test-cell",
        entries: [{
          type: "direct",
          id: "1",
          project: "proj",
          category: "note",
          content: "hello",
          tags: [],
          createdAt: "2026-01-01",
          embedding: [],
        }],
      });

      const loaded = await store.loadCellData("test-cell");
      expect(loaded.entries).toHaveLength(1);
      expect(loaded.entries[0].type).toBe("direct");
    });
  });

  describe("getAllEntries", () => {
    it("returns entries from nursery and cells", async () => {
      // Add some entries that stay in nursery
      for (let i = 0; i < 3; i++) {
        await store.storeDirectEntry("proj", "note", `Nursery ${i}`, []);
      }

      // Manually create a cell with entries
      await store.saveCellData({
        cellId: "manual-cell",
        entries: [{
          type: "direct",
          id: "manual-1",
          project: "proj",
          category: "decision",
          content: "Cell entry",
          tags: [],
          createdAt: "2026-01-01",
          embedding: [],
        }],
      });

      const hive = await store.loadHive();
      hive.cells["manual-cell"] = {
        id: "manual-cell",
        type: "leaf",
        summary: "test",
        keywords: [],
        centroid: [],
        count: 1,
      };
      await store.saveHive(hive);

      const all = await store.getAllEntries();
      expect(all).toHaveLength(4); // 3 nursery + 1 cell
    });
  });

  describe("removeReferences", () => {
    it("removes reference entries for a project from nursery", async () => {
      await store.storeReferenceEntry("proj-a", "/path/a.md", "claude-memory", "desc a", []);
      await store.storeDirectEntry("proj-a", "decision", "Keep this", []);

      await store.removeReferences("proj-a", "claude-memory");

      const hive = await store.loadHive();
      expect(hive.nursery).toHaveLength(1);
      expect(hive.nursery[0].type).toBe("direct");
    });

    it("only removes matching source", async () => {
      await store.storeReferenceEntry("proj-a", "/path/a.md", "claude-memory", "desc a", []);
      await store.storeReferenceEntry("proj-a", "/path/b.md", "codex-agents", "desc b", []);

      await store.removeReferences("proj-a", "claude-memory");

      const hive = await store.loadHive();
      expect(hive.nursery).toHaveLength(1);
      expect(hive.nursery[0].type).toBe("reference");
    });
  });

  describe("cells directory", () => {
    it("creates cells directory on first write", async () => {
      const freshDir = await mkdtemp(join(tmpdir(), "hive-fresh-"));
      try {
        const freshStore = new HiveStore(freshDir, createMockEmbed());
        await freshStore.storeDirectEntry("proj", "note", "test", []);

        const hive = await freshStore.loadHive();
        await freshStore.flushNursery(hive);
        await freshStore.saveHive(hive);

        expect(existsSync(join(freshDir, "cells"))).toBe(true);
      } finally {
        await rm(freshDir, { recursive: true, force: true });
      }
    });
  });
});
