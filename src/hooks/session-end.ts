import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CortexStore } from "../store.js";
import { parseTranscript } from "./transcript-parser.js";

/**
 * Handle the `hive-memory hook session-end` CLI command.
 * Called by Claude Code's SessionEnd hook to auto-save the session.
 *
 * Usage: hive-memory hook session-end [--transcript <path>] [--cwd <path>]
 */
export async function handleSessionEnd(
  store: CortexStore,
  args: string[],
): Promise<void> {
  await store.init();

  // Parse CLI arguments
  let transcriptPath: string | undefined;
  let cwd: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--transcript" && args[i + 1]) {
      transcriptPath = args[++i];
    } else if (args[i] === "--cwd" && args[i + 1]) {
      cwd = args[++i];
    }
  }

  // Find transcript from Claude Code's default location if not specified
  if (!transcriptPath) {
    transcriptPath = await findLatestTranscript();
  }

  if (!transcriptPath || !existsSync(transcriptPath)) {
    console.error("No transcript found. Provide --transcript <path> or ensure Claude Code transcript exists.");
    process.exit(1);
  }

  // Parse the transcript
  const session = await parseTranscript(transcriptPath);

  // Skip if session_save was already called during the session
  if (session.alreadySaved) {
    console.log("Session already saved during conversation. Skipping auto-capture.");
    return;
  }

  // Determine project path
  const projectPath = cwd ?? session.projectPath;
  if (!projectPath) {
    console.error("Could not determine project directory. Provide --cwd <path>.");
    process.exit(1);
  }

  // Match project by path
  const index = await store.getIndex();
  const project = index.projects.find(
    (p) => projectPath === p.path || projectPath.startsWith(p.path + "/"),
  );
  if (!project) {
    console.log(`No registered project matches path: ${projectPath}. Skipping.`);
    return;
  }

  // Check for duplicate saves (within 5 minutes) using lastActive timestamp
  const diffMs = Date.now() - new Date(project.lastActive).getTime();
  if (diffMs < 5 * 60 * 1000) {
    console.log("Session was saved within the last 5 minutes. Skipping auto-capture.");
    return;
  }

  // Save the session
  const today = new Date().toISOString().slice(0, 10);
  await store.saveSession(project.id, {
    date: today,
    summary: session.summary,
    nextTasks: session.nextTasks,
    decisions: session.decisions,
    learnings: session.learnings,
  });

  console.log(`Auto-saved session for "${project.name}" (${project.id}).`);
}

/**
 * Find the most recently modified transcript file in Claude Code's data directory.
 */
async function findLatestTranscript(): Promise<string | undefined> {
  const home = process.env["HOME"] ?? "";
  const claudeDir = join(home, ".claude", "projects");

  if (!existsSync(claudeDir)) return undefined;

  let latestPath: string | undefined;
  let latestMtime = 0;

  const projectDirs = await readdir(claudeDir);
  for (const dir of projectDirs) {
    const fullDir = join(claudeDir, dir);
    try {
      const s = await stat(fullDir);
      if (!s.isDirectory()) continue;

      const files = await readdir(fullDir);
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const filePath = join(fullDir, file);
        const fileStat = await stat(filePath);
        if (fileStat.mtimeMs > latestMtime) {
          latestMtime = fileStat.mtimeMs;
          latestPath = filePath;
        }
      }
    } catch {
      continue;
    }
  }

  return latestPath;
}
