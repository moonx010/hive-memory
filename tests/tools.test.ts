import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CortexStore } from "../src/store.js";
import { registerTools } from "../src/tools.js";
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

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: "text"; text: string }[];
  isError?: boolean;
}>;

/** Create a store + capture tool handlers via a mock server. */
async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "cortex-tools-"));
  const projectDir = await mkdtemp(join(tmpdir(), "cortex-proj-"));
  const config: CortexConfig = {
    dataDir,
    localContext: { filename: ".cortex.md", enabled: true },
  };
  const store = new CortexStore(config);
  await store.init();

  // Capture registered tool handlers
  const handlers = new Map<string, ToolHandler>();
  const mockServer = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  registerTools(mockServer as Parameters<typeof registerTools>[0], store);

  return { store, dataDir, projectDir, handlers };
}

/** Register a minimal project via tool handler. */
async function registerProject(
  handlers: Map<string, ToolHandler>,
  id: string,
  projectDir: string,
) {
  const handler = handlers.get("project_register")!;
  await handler({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    path: projectDir,
    description: `${id} project`,
    tags: ["test"],
    techStack: ["TypeScript"],
    modules: ["core"],
  });
}

describe("Tool handlers", () => {
  let dataDir: string;
  let projectDir: string;
  let handlers: Map<string, ToolHandler>;
  let store: CortexStore;

  beforeEach(async () => {
    const ctx = await setup();
    dataDir = ctx.dataDir;
    projectDir = ctx.projectDir;
    handlers = ctx.handlers;
    store = ctx.store;
  }, 60_000);

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  // ── Only 7 tools registered ───────────────────────────

  it("registers exactly 7 tools", () => {
    expect(handlers.size).toBe(7);
    expect([...handlers.keys()].sort()).toEqual([
      "memory_recall",
      "memory_store",
      "project_onboard",
      "project_register",
      "project_search",
      "project_status",
      "session_save",
    ]);
  });

  // ── project_register (upsert) ─────────────────────────

  describe("project_register", () => {
    it("registers a new project", async () => {
      await registerProject(handlers, "alpha", projectDir);
      const index = await store.getIndex();
      expect(index.projects).toHaveLength(1);
      expect(index.projects[0].id).toBe("alpha");
    });

    it("upserts existing project", async () => {
      await registerProject(handlers, "alpha", projectDir);
      const handler = handlers.get("project_register")!;
      const result = await handler({
        id: "alpha",
        name: "Alpha v2",
        path: projectDir,
        description: "updated description",
        tags: ["updated"],
      });

      expect(result.content[0].text).toContain("updated");
      const index = await store.getIndex();
      expect(index.projects).toHaveLength(1);
      expect(index.projects[0].name).toBe("Alpha v2");
    });
  });

  // ── project_search ────────────────────────────────────

  describe("project_search", () => {
    it("empty query lists all projects", async () => {
      await registerProject(handlers, "alpha", projectDir);
      const dir2 = await mkdtemp(join(tmpdir(), "cortex-proj2-"));
      try {
        await registerProject(handlers, "beta", dir2);
        const handler = handlers.get("project_search")!;
        const result = await handler({ query: "" });
        expect(result.content[0].text).toContain("alpha");
        expect(result.content[0].text).toContain("beta");
      } finally {
        await rm(dir2, { recursive: true, force: true });
      }
    });

    it("searches by name", async () => {
      await registerProject(handlers, "alpha", projectDir);
      const handler = handlers.get("project_search")!;
      const result = await handler({ query: "alpha" });
      expect(result.content[0].text).toContain("alpha");
    });

    it("returns no-projects message when empty", async () => {
      const handler = handlers.get("project_search")!;
      const result = await handler({ query: "" });
      expect(result.content[0].text).toContain("No projects registered");
    });
  });

  // ── project_status ────────────────────────────────────

  describe("project_status", () => {
    it("returns project summary", async () => {
      await registerProject(handlers, "alpha", projectDir);
      const handler = handlers.get("project_status")!;
      const result = await handler({ project: "alpha" });
      expect(result.content[0].text).toContain("alpha");
      expect(result.content[0].text).toContain("TypeScript");
    });

    it("returns not found for unknown project", async () => {
      const handler = handlers.get("project_status")!;
      const result = await handler({ project: "nonexistent" });
      expect(result.content[0].text).toContain("not found");
    });

    it("includes Cross-Project Insights from other projects", async () => {
      const siblingDir = await mkdtemp(join(tmpdir(), "cortex-sib-"));
      try {
        await registerProject(handlers, "proj-x", projectDir);
        await registerProject(handlers, "proj-y", siblingDir);

        const memoryHandler = handlers.get("memory_store")!;
        await memoryHandler({
          project: "proj-y",
          category: "decision",
          content: "Use gRPC for internal service communication",
        });

        // Update proj-x focus to a keyword that matches proj-y's memory
        const summary = await store.getProjectSummary("proj-x");
        if (summary) {
          summary.currentFocus = "gRPC";
          await store.saveProjectSummary(summary);
        }

        const statusHandler = handlers.get("project_status")!;
        const result = await statusHandler({ project: "proj-x", detail: "full" });

        expect(result.content[0].text).toContain("## Cross-Project Insights");
        expect(result.content[0].text).toContain("proj-y");
      } finally {
        await rm(siblingDir, { recursive: true, force: true });
      }
    });
  });

  // ── security: validateId enforcement ─────────────────

  describe("security", () => {
    it("project_register rejects relative path", async () => {
      const handler = handlers.get("project_register")!;
      const result = await handler({
        id: "bad-path",
        name: "Bad",
        path: "relative/path",
        description: "test",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("absolute");
    });

    it("project_register rejects invalid ID", async () => {
      const handler = handlers.get("project_register")!;
      const result = await handler({
        id: "../traversal",
        name: "Bad",
        path: "/tmp/bad",
        description: "test",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid ID");
    });

    it("memory_store rejects invalid project ID", async () => {
      const handler = handlers.get("memory_store")!;
      const result = await handler({
        project: "../evil",
        category: "decision",
        content: "test",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid ID");
    });

    it("memory_recall rejects invalid project ID", async () => {
      const handler = handlers.get("memory_recall")!;
      const result = await handler({
        query: "test",
        project: "../evil",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid ID");
    });

    it("session_save rejects invalid project ID", async () => {
      const handler = handlers.get("session_save")!;
      const result = await handler({
        project: "../evil",
        summary: "test",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid ID");
    });

    it("project_status rejects invalid project ID", async () => {
      const handler = handlers.get("project_status")!;
      const result = await handler({
        project: "../evil",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid ID");
    });

    it("memory_store rejects unregistered project", async () => {
      const handler = handlers.get("memory_store")!;
      const result = await handler({
        project: "nonexistent",
        category: "decision",
        content: "test",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not registered");
    });
  });

  // ── memory_recall ─────────────────────────────────────

  describe("memory_recall", () => {
    it("finds stored memories", async () => {
      await registerProject(handlers, "alpha", projectDir);
      const memoryHandler = handlers.get("memory_store")!;
      await memoryHandler({
        project: "alpha",
        category: "learning",
        content: "Connection pooling improves database performance",
      });

      const recallHandler = handlers.get("memory_recall")!;
      const result = await recallHandler({ query: "Connection pooling" });
      expect(result.content[0].text).toContain("alpha");
      expect(result.content[0].text).toContain("learning");
    });

    it("returns no-match message when empty", async () => {
      const recallHandler = handlers.get("memory_recall")!;
      const result = await recallHandler({ query: "nonexistent query xyz" });
      expect(result.content[0].text).toContain("No matching memories");
    });
  });

  // ── session_save ──────────────────────────────────────

  describe("session_save", () => {
    it("saves a session and reports task count", async () => {
      await registerProject(handlers, "alpha", projectDir);
      const handler = handlers.get("session_save")!;
      const result = await handler({
        project: "alpha",
        summary: "Finished refactoring",
        nextTasks: ["Write tests", "Deploy"],
        decisions: ["Use vitest"],
        learnings: ["Vitest is fast"],
      });

      expect(result.content[0].text).toContain("Session saved");
      expect(result.content[0].text).toContain("2 next tasks");
    });
  });
});
