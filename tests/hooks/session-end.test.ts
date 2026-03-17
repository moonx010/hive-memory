import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CortexStore } from "../../src/store.js";
import type { CortexConfig } from "../../src/types.js";
import { parseTranscript } from "../../src/hooks/transcript-parser.js";
import { handleSessionEnd } from "../../src/hooks/session-end.js";

// No need to mock EmbedService — embeddings have been removed

async function createTestStore() {
  const dataDir = await mkdtemp(join(tmpdir(), "cortex-hook-"));
  const projectDir = await mkdtemp(join(tmpdir(), "cortex-proj-"));
  const config: CortexConfig = {
    dataDir,
    localContext: { filename: ".cortex.md", enabled: true },
  };
  const store = new CortexStore(config);
  await store.init();
  return { store, dataDir, projectDir };
}

async function registerProject(store: CortexStore, id: string, projectDir: string) {
  // Set lastActive to 10 minutes ago to avoid 5-minute dedup check
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await store.upsertProject({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    path: projectDir,
    description: `${id} project`,
    tags: ["test"],
    lastActive: tenMinAgo,
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

describe("transcript-parser", () => {
  it("parses a minimal transcript", async () => {
    const tmpFile = join(tmpdir(), `test-transcript-${Date.now()}.jsonl`);
    const lines = [
      JSON.stringify({ role: "user", content: "Hello" }),
      JSON.stringify({ role: "assistant", content: "I will help you refactor the authentication module to use JWT tokens instead of sessions. This involves changes to the middleware and the user model." }),
      JSON.stringify({ tool: "Bash", args: { command: "cd /projects/alpha" } }),
      JSON.stringify({ tool: "memory_store", args: { project: "alpha", category: "decision", content: "Switch to JWT tokens" } }),
    ];
    await writeFile(tmpFile, lines.join("\n"), "utf-8");

    try {
      const parsed = await parseTranscript(tmpFile);
      expect(parsed.projectPath).toBe("/projects/alpha");
      expect(parsed.decisions).toContain("Switch to JWT tokens");
      expect(parsed.alreadySaved).toBe(false);
      expect(parsed.summary.length).toBeGreaterThan(0);
    } finally {
      await rm(tmpFile, { force: true });
    }
  });

  it("detects already-saved sessions", async () => {
    const tmpFile = join(tmpdir(), `test-transcript-${Date.now()}.jsonl`);
    const lines = [
      JSON.stringify({ role: "assistant", content: "Done" }),
      JSON.stringify({ tool: "session_save", args: { project: "alpha", summary: "Done" } }),
    ];
    await writeFile(tmpFile, lines.join("\n"), "utf-8");

    try {
      const parsed = await parseTranscript(tmpFile);
      expect(parsed.alreadySaved).toBe(true);
    } finally {
      await rm(tmpFile, { force: true });
    }
  });
});

describe("handleSessionEnd", () => {
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
    try { await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    await rm(projectDir, { recursive: true, force: true });
  });

  it("auto-saves session from transcript", async () => {
    await registerProject(store, "alpha", projectDir);

    const tmpFile = join(tmpdir(), `test-transcript-${Date.now()}.jsonl`);
    const lines = [
      JSON.stringify({ role: "assistant", content: "I refactored the authentication module to use JWT tokens. Updated middleware and user model. Added proper error handling for expired tokens." }),
      JSON.stringify({ tool: "memory_store", args: { project: "alpha", category: "decision", content: "Use JWT tokens" } }),
    ];
    await writeFile(tmpFile, lines.join("\n"), "utf-8");

    try {
      await handleSessionEnd(store, ["--transcript", tmpFile, "--cwd", projectDir]);

      // Verify session was saved
      const sessionsDir = join(dataDir, "projects", "alpha", "sessions");
      const files = await readdir(sessionsDir);
      expect(files.length).toBe(1);

      // Verify summary was updated
      const summary = await store.getProjectSummary("alpha");
      expect(summary!.lastSession).not.toBeNull();
    } finally {
      await rm(tmpFile, { force: true });
    }
  });

  it("skips when session_save already called", async () => {
    await registerProject(store, "alpha", projectDir);

    const tmpFile = join(tmpdir(), `test-transcript-${Date.now()}.jsonl`);
    const lines = [
      JSON.stringify({ role: "assistant", content: "Done" }),
      JSON.stringify({ tool: "session_save", args: { project: "alpha", summary: "Manual save" } }),
    ];
    await writeFile(tmpFile, lines.join("\n"), "utf-8");

    try {
      await handleSessionEnd(store, ["--transcript", tmpFile, "--cwd", projectDir]);

      // No session should be saved (the tool save was in transcript, not actually executed)
      const summary = await store.getProjectSummary("alpha");
      expect(summary!.lastSession).toBeNull();
    } finally {
      await rm(tmpFile, { force: true });
    }
  });
});
