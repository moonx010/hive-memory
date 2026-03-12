import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CortexStore, validateId } from "../src/store.js";
import type { CortexConfig } from "../src/types.js";

// Mock EmbedService to avoid loading transformers.js model in tests
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

/** Create a CortexStore backed by a fresh temp directory. */
async function createTestStore() {
  const dataDir = await mkdtemp(join(tmpdir(), "cortex-test-"));
  const projectDir = await mkdtemp(join(tmpdir(), "cortex-proj-"));
  const config: CortexConfig = {
    dataDir,
    localContext: { filename: ".cortex.md", enabled: true },
  };
  const store = new CortexStore(config);
  await store.init();
  return { store, dataDir, projectDir };
}

/** Register a minimal project for testing. */
async function registerProject(
  store: CortexStore,
  id: string,
  projectDir: string,
) {
  await store.upsertProject({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    path: projectDir,
    description: `${id} project`,
    tags: ["test"],
    lastActive: new Date().toISOString(),
    status: "active",
  });
  await store.saveProjectSummary({
    id,
    oneLiner: `${id} project`,
    techStack: ["TypeScript"],
    modules: ["core"],
    currentFocus: "testing",
    lastSession: null,
    stats: {},
  });
}

describe("CortexStore", () => {
  let store: CortexStore;
  let dataDir: string;
  let projectDir: string;

  beforeEach(async () => {
    const ctx = await createTestStore();
    store = ctx.store;
    dataDir = ctx.dataDir;
    projectDir = ctx.projectDir;
  }, 60_000);

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  // ── upsertProject ─────────────────────────────────────

  describe("upsertProject", () => {
    it("registers a new project", async () => {
      await registerProject(store, "alpha", projectDir);
      const index = await store.getIndex();
      expect(index.projects).toHaveLength(1);
      expect(index.projects[0].id).toBe("alpha");
    });

    it("updates existing project on re-register", async () => {
      await registerProject(store, "alpha", projectDir);
      await store.upsertProject({
        id: "alpha",
        name: "Alpha Updated",
        path: projectDir,
        description: "updated description",
        tags: ["updated"],
        lastActive: new Date().toISOString(),
        status: "active",
      });
      const index = await store.getIndex();
      expect(index.projects).toHaveLength(1);
      expect(index.projects[0].name).toBe("Alpha Updated");
      expect(index.projects[0].description).toBe("updated description");
    });
  });

  // ── searchProjects ────────────────────────────────────

  describe("searchProjects", () => {
    it("empty query returns all projects", async () => {
      await registerProject(store, "alpha", projectDir);
      const dir2 = await mkdtemp(join(tmpdir(), "cortex-proj2-"));
      try {
        await registerProject(store, "beta", dir2);
        const results = await store.searchProjects("", 50);
        expect(results).toHaveLength(2);
      } finally {
        await rm(dir2, { recursive: true, force: true });
      }
    });

    it("finds project by name", async () => {
      await registerProject(store, "alpha", projectDir);
      const results = await store.searchProjects("alpha");
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("alpha");
    });
  });

  // ── getCrossProjectContext (semantic, no groups) ──────

  describe("getCrossProjectContext", () => {
    it("returns decision/learning from other projects via keyword match", async () => {
      const siblingDir = await mkdtemp(join(tmpdir(), "cortex-sib-"));
      try {
        await registerProject(store, "proj-a", projectDir);
        await registerProject(store, "proj-b", siblingDir);

        // Store a decision in proj-b that matches proj-a's focus ("testing")
        await store.storeMemory("proj-b", "decision", "Use vitest for testing performance", []);

        // proj-a should see proj-b's decision (keyword match on "testing")
        const insights = await store.getCrossProjectContext("proj-a");
        expect(insights.length).toBeGreaterThanOrEqual(1);
        expect(insights.some((i) => i.project === "proj-b" && i.category === "decision")).toBe(true);
      } finally {
        await rm(siblingDir, { recursive: true, force: true });
      }
    });

    it("excludes self from results", async () => {
      await registerProject(store, "solo", projectDir);
      await store.storeMemory("solo", "decision", "A testing decision for solo", []);

      const insights = await store.getCrossProjectContext("solo");
      for (const i of insights) {
        expect(i.project).not.toBe("solo");
      }
    });

    it("filters out status/note categories", async () => {
      const siblingDir = await mkdtemp(join(tmpdir(), "cortex-sib-"));
      try {
        await registerProject(store, "proj-c", projectDir);
        await registerProject(store, "proj-d", siblingDir);

        // Store status and note in proj-d (with "testing" keyword for match)
        await store.storeMemory("proj-d", "status", "Currently testing", []);
        await store.storeMemory("proj-d", "note", "Remember testing note", []);

        const insights = await store.getCrossProjectContext("proj-c");
        for (const insight of insights) {
          expect(insight.category).not.toBe("status");
          expect(insight.category).not.toBe("note");
        }
      } finally {
        await rm(siblingDir, { recursive: true, force: true });
      }
    });
  });

  // ── recallMemories ────────────────────────────────────

  describe("recallMemories", () => {
    it("returns keyword matches", async () => {
      await registerProject(store, "alpha", projectDir);
      await store.storeMemory("alpha", "decision", "Use REST over GraphQL", []);

      const results = await store.recallMemories("REST", undefined, 5);
      expect(results.length).toBeGreaterThanOrEqual(1);
      for (const r of results) {
        expect(r.score).toBeGreaterThan(0);
      }
    });

    it("scopes to a project when projectId is given", async () => {
      const dir2 = await mkdtemp(join(tmpdir(), "cortex-proj2-"));
      try {
        await registerProject(store, "alpha", projectDir);
        await registerProject(store, "beta", dir2);
        await store.storeMemory("alpha", "decision", "REST for alpha", []);
        await store.storeMemory("beta", "decision", "REST for beta", []);

        const results = await store.recallMemories("REST", "alpha", 5);
        for (const r of results) {
          expect(r.project).toBe("alpha");
        }
      } finally {
        await rm(dir2, { recursive: true, force: true });
      }
    });
  });

  // ── syncLocalContext ─────────────────────────────────

  describe("syncLocalContext", () => {
    it("writes .cortex.md into project directory", async () => {
      await registerProject(store, "alpha", projectDir);
      const localPath = await store.syncLocalContext("alpha");
      expect(localPath).not.toBeNull();

      const content = await readFile(localPath!, "utf-8");
      expect(content).toContain("Alpha — Cortex Context");
      expect(content).toContain("## Overview");
    });

    it("includes Cross-Project Context section when other projects have matching memories", async () => {
      const siblingDir = await mkdtemp(join(tmpdir(), "cortex-sib-"));
      try {
        await registerProject(store, "alpha", projectDir);
        await registerProject(store, "beta", siblingDir);

        await store.storeMemory("beta", "decision", "Use JWT for authentication across services", []);

        // Update alpha's focus to a keyword that matches beta's memory
        const summary = await store.getProjectSummary("alpha");
        summary!.currentFocus = "authentication";
        await store.saveProjectSummary(summary!);

        const localPath = await store.syncLocalContext("alpha");
        expect(localPath).not.toBeNull();

        const content = await readFile(localPath!, "utf-8");
        expect(content).toContain("## Cross-Project Context");
        expect(content).toContain("beta");
      } finally {
        await rm(siblingDir, { recursive: true, force: true });
      }
    });
  });

  // ── storeMemory persistence ────────────────────────────

  describe("storeMemory", () => {
    it("persists entry with tags in hive", async () => {
      await registerProject(store, "alpha", projectDir);
      const entry = await store.storeMemory("alpha", "decision", "Use REST API", ["api", "rest"]);

      expect(entry.id).toBeTruthy();
      expect(entry.project).toBe("alpha");
      expect(entry.category).toBe("decision");
      expect(entry.content).toBe("Use REST API");
      expect(entry.tags).toEqual(["api", "rest"]);
    });

    it("works without tags", async () => {
      await registerProject(store, "alpha", projectDir);
      const entry = await store.storeMemory("alpha", "learning", "Learned something", []);

      expect(entry.id).toBeTruthy();
      expect(entry.project).toBe("alpha");
      expect(entry.tags).toEqual([]);
    });
  });

  // ── validateId ─────────────────────────────────────────

  describe("validateId", () => {
    it("accepts valid IDs", () => {
      expect(() => validateId("my-project")).not.toThrow();
      expect(() => validateId("project123")).not.toThrow();
      expect(() => validateId("a.b-c_d")).not.toThrow();
    });

    it("rejects path traversal", () => {
      expect(() => validateId("../etc/passwd")).toThrow();
      expect(() => validateId("foo/../bar")).toThrow();
    });

    it("rejects invalid characters", () => {
      expect(() => validateId("My Project")).toThrow();
      expect(() => validateId("/absolute/path")).toThrow();
      expect(() => validateId("")).toThrow();
    });
  });

  // ── saveSession overwrite protection ───────────────────

  describe("saveSession", () => {
    it("does not overwrite same-day sessions", async () => {
      await registerProject(store, "alpha", projectDir);
      const today = new Date().toISOString().slice(0, 10);

      await store.saveSession("alpha", {
        date: today,
        summary: "First session",
        nextTasks: [],
        decisions: [],
        learnings: [],
      });

      await store.saveSession("alpha", {
        date: today,
        summary: "Second session",
        nextTasks: [],
        decisions: [],
        learnings: [],
      });

      const sessionsDir = join(dataDir, "projects", "alpha", "sessions");
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(sessionsDir);
      expect(files.length).toBe(2);
    });
  });
});
