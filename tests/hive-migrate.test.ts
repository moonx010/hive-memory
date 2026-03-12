import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveStore } from "../src/store/hive-store.js";
import { migrateProject, scanProjectReferences, syncReferences } from "../src/store/hive-migrate.js";

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

describe("hive-migrate", () => {
  let dataDir: string;
  let projectDir: string;
  let hiveStore: HiveStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "hive-migrate-test-"));
    projectDir = await mkdtemp(join(tmpdir(), "hive-migrate-proj-"));
    hiveStore = new HiveStore(dataDir, createMockEmbed());
    await hiveStore.ensureDirs();
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  describe("migrateProject", () => {
    it("returns 0 when no knowledge dir exists", async () => {
      const count = await migrateProject(dataDir, "proj-a", hiveStore);
      expect(count).toBe(0);
    });

    it("migrates legacy markdown entries to hive", async () => {
      // Create legacy knowledge files
      const knowledgeDir = join(dataDir, "projects", "proj-a", "knowledge");
      await mkdir(knowledgeDir, { recursive: true });

      await writeFile(
        join(knowledgeDir, "decisions.md"),
        `# Decisions — proj-a

## 2026-01-15 — id:abc-123
> tags: auth, jwt

Use JWT tokens for service-to-service auth

## 2026-01-20 — id:def-456

Use PostgreSQL for main database
`,
        "utf-8",
      );

      const count = await migrateProject(dataDir, "proj-a", hiveStore);
      expect(count).toBe(2);

      // Verify entries are in hive
      const hive = await hiveStore.loadHive();
      expect(hive.totalEntries).toBe(2);

      // knowledge/ should be renamed to knowledge.bak/
      expect(existsSync(knowledgeDir)).toBe(false);
      expect(existsSync(join(dataDir, "projects", "proj-a", "knowledge.bak"))).toBe(true);
    });

    it("parses tags correctly", async () => {
      const knowledgeDir = join(dataDir, "projects", "proj-a", "knowledge");
      await mkdir(knowledgeDir, { recursive: true });

      await writeFile(
        join(knowledgeDir, "learnings.md"),
        `# Learnings — proj-a

## 2026-02-01 — id:learn-1
> tags: perf, db

Connection pooling improves performance significantly
`,
        "utf-8",
      );

      await migrateProject(dataDir, "proj-a", hiveStore);

      const entries = await hiveStore.getAllEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("direct");
      if (entries[0].type === "direct") {
        expect(entries[0].tags).toEqual(["perf", "db"]);
        expect(entries[0].category).toBe("learning");
      }
    });
  });

  describe("scanProjectReferences", () => {
    it("detects CLAUDE.md as reference", async () => {
      await writeFile(
        join(projectDir, "CLAUDE.md"),
        `# My Project
## Overview
A cool project
## Architecture
Microservices based`,
        "utf-8",
      );

      const count = await scanProjectReferences("proj-a", projectDir, hiveStore);
      expect(count).toBeGreaterThanOrEqual(1);

      const entries = await hiveStore.getAllEntries();
      const refs = entries.filter((e) => e.type === "reference");
      expect(refs.length).toBeGreaterThanOrEqual(1);

      const claudeRef = refs.find(
        (e) => e.type === "reference" && e.source === "claude-project",
      );
      expect(claudeRef).toBeDefined();
    });

    it("detects AGENTS.md as reference", async () => {
      await writeFile(
        join(projectDir, "AGENTS.md"),
        `# Agents
## Coding Standards
Use TypeScript
## Testing
Use vitest`,
        "utf-8",
      );

      const count = await scanProjectReferences("proj-a", projectDir, hiveStore);
      expect(count).toBeGreaterThanOrEqual(1);

      const entries = await hiveStore.getAllEntries();
      const agentsRef = entries.find(
        (e) => e.type === "reference" && e.source === "codex-agents",
      );
      expect(agentsRef).toBeDefined();
    });

    it("detects Cursor rules as references", async () => {
      const rulesDir = join(projectDir, ".cursor", "rules");
      await mkdir(rulesDir, { recursive: true });
      await writeFile(join(rulesDir, "style.md"), "Use consistent formatting", "utf-8");

      const count = await scanProjectReferences("proj-a", projectDir, hiveStore);
      expect(count).toBeGreaterThanOrEqual(1);

      const entries = await hiveStore.getAllEntries();
      const cursorRef = entries.find(
        (e) => e.type === "reference" && e.source === "cursor-rules",
      );
      expect(cursorRef).toBeDefined();
    });

    it("re-scan replaces old references", async () => {
      await writeFile(join(projectDir, "CLAUDE.md"), "Version 1 content", "utf-8");
      await scanProjectReferences("proj-a", projectDir, hiveStore);

      // Update the file
      await writeFile(join(projectDir, "CLAUDE.md"), "Version 2 content", "utf-8");
      await scanProjectReferences("proj-a", projectDir, hiveStore);

      // Should not duplicate
      const entries = await hiveStore.getAllEntries();
      const claudeRefs = entries.filter(
        (e) => e.type === "reference" && e.source === "claude-project",
      );
      expect(claudeRefs).toHaveLength(1);
    });
  });

  describe("syncReferences", () => {
    it("returns 0 when no references exist", async () => {
      const updated = await syncReferences("proj-a", hiveStore);
      expect(updated).toBe(0);
    });

    it("removes references for deleted files", async () => {
      // Create a file, scan it, then delete it
      const tempFile = join(projectDir, "CLAUDE.md");
      await writeFile(tempFile, "# Temp\n## Content\nSome content", "utf-8");
      await scanProjectReferences("proj-a", projectDir, hiveStore);

      // Verify reference exists
      let entries = await hiveStore.getAllEntries();
      expect(entries.some((e) => e.type === "reference")).toBe(true);

      // Delete the file
      await rm(tempFile);

      // Sync should detect deleted file
      const updated = await syncReferences("proj-a", hiveStore);
      expect(updated).toBeGreaterThanOrEqual(1);
    });
  });
});
