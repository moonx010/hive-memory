import { readFile, readdir, rename, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { MemoryCategory } from "../types.js";
import type { HiveStore } from "./hive-store.js";
import type { ProjectStore } from "./project-store.js";

interface ReferenceSource {
  source: string;
  path: string;
  description: string;
  tags: string[];
}

/**
 * Migrate legacy knowledge/ markdown files to hive direct entries.
 */
export async function migrateProject(
  dataDir: string,
  projectId: string,
  hiveStore: HiveStore,
): Promise<number> {
  const knowledgeDir = join(dataDir, "projects", projectId, "knowledge");
  if (!existsSync(knowledgeDir)) return 0;

  const categories: MemoryCategory[] = ["decision", "learning", "status", "note"];
  let migrated = 0;

  for (const cat of categories) {
    const filePath = join(knowledgeDir, `${cat}s.md`);
    if (!existsSync(filePath)) continue;

    const content = await readFile(filePath, "utf-8");
    const sections = content.split(/^## /m).filter(Boolean);

    // Skip header section (# Title — project)
    for (const section of sections.slice(1)) {
      const trimmed = section.trim();
      if (!trimmed) continue;

      // Parse tags from "> tags: ..." line
      const tagMatch = trimmed.match(/^> tags:\s*(.+)$/m);
      const tags = tagMatch
        ? tagMatch[1].split(",").map((t) => t.trim()).filter(Boolean)
        : [];

      // Remove the date/id header line and tags line to get content
      const lines = trimmed.split("\n");
      const contentLines = lines.filter(
        (l) => !l.match(/^\d{4}-\d{2}-\d{2}/) && !l.startsWith("> tags:"),
      );
      const entryContent = contentLines.join("\n").trim();
      if (!entryContent) continue;

      await hiveStore.storeDirectEntry(projectId, cat, entryContent, tags);
      migrated++;
    }
  }

  // Rename knowledge/ to knowledge.bak/
  if (migrated > 0) {
    const bakDir = join(dataDir, "projects", projectId, "knowledge.bak");
    if (!existsSync(bakDir)) {
      await rename(knowledgeDir, bakDir);
    }
  }

  return migrated;
}

/**
 * Scan a project directory for external agent memory files
 * and create reference entries in hive.
 */
export async function scanProjectReferences(
  projectId: string,
  projectPath: string,
  hiveStore: HiveStore,
): Promise<number> {
  const sources: ReferenceSource[] = [];

  // 1. Claude Code memory files
  const claudeMemoryDirs = await findClaudeMemoryDirs(projectPath);
  for (const memoryDir of claudeMemoryDirs) {
    const memoryFile = join(memoryDir, "MEMORY.md");
    if (existsSync(memoryFile)) {
      const desc = await extractDescription(memoryFile);
      if (desc) {
        sources.push({
          source: "claude-memory",
          path: memoryFile,
          description: desc,
          tags: ["memory", "claude"],
        });
      }
    }
  }

  // 2. Project CLAUDE.md
  const claudeMd = join(projectPath, "CLAUDE.md");
  if (existsSync(claudeMd)) {
    const desc = await extractDescription(claudeMd);
    if (desc) {
      sources.push({
        source: "claude-project",
        path: claudeMd,
        description: desc,
        tags: ["claude", "instructions"],
      });
    }
  }

  // 3. AGENTS.md (project-level or home)
  const agentsMd = join(projectPath, "AGENTS.md");
  if (existsSync(agentsMd)) {
    const desc = await extractDescription(agentsMd);
    if (desc) {
      sources.push({
        source: "codex-agents",
        path: agentsMd,
        description: desc,
        tags: ["codex", "agents"],
      });
    }
  }

  // 4. Cursor rules
  const cursorRulesDir = join(projectPath, ".cursor", "rules");
  if (existsSync(cursorRulesDir)) {
    try {
      const files = await readdir(cursorRulesDir);
      for (const file of files) {
        const filePath = join(cursorRulesDir, file);
        const desc = await extractDescription(filePath);
        if (desc) {
          sources.push({
            source: "cursor-rules",
            path: filePath,
            description: desc,
            tags: ["cursor", "rules", basename(file, ".md")],
          });
        }
      }
    } catch { /* ignore read errors */ }
  }

  // Remove existing references for this project to avoid duplicates
  for (const src of sources) {
    await hiveStore.removeReferences(projectId, src.source);
  }

  // Store new reference entries
  let stored = 0;
  for (const src of sources) {
    await hiveStore.storeReferenceEntry(
      projectId,
      src.path,
      src.source,
      src.description,
      src.tags,
    );
    stored++;
  }

  return stored;
}

/**
 * Sync existing reference entries for a project.
 * Re-reads files that changed since lastSynced, removes entries for deleted files.
 */
export async function syncReferences(
  projectId: string,
  hiveStore: HiveStore,
): Promise<number> {
  const allEntries = await hiveStore.getAllEntries();
  const refs = allEntries.filter(
    (e) => e.type === "reference" && e.project === projectId,
  );

  let updated = 0;
  const toRemoveSources = new Set<string>();

  for (const ref of refs) {
    if (ref.type !== "reference") continue;

    if (!existsSync(ref.path)) {
      toRemoveSources.add(ref.source);
      updated++;
      continue;
    }

    try {
      const fileStat = await stat(ref.path);
      const fileModified = fileStat.mtime.toISOString();
      if (fileModified > ref.lastSynced) {
        // File changed — remove old and re-add
        const desc = await extractDescription(ref.path);
        if (desc && desc !== ref.description) {
          await hiveStore.removeReferences(projectId, ref.source);
          await hiveStore.storeReferenceEntry(
            projectId,
            ref.path,
            ref.source,
            desc,
            ref.tags,
          );
          updated++;
        }
      }
    } catch {
      // File inaccessible — skip
    }
  }

  // Remove references for deleted files
  for (const source of toRemoveSources) {
    await hiveStore.removeReferences(projectId, source);
  }

  return updated;
}

/**
 * Migrate all existing projects from legacy knowledge/ to hive.
 */
export async function migrateAllProjects(
  dataDir: string,
  projectStore: ProjectStore,
  hiveStore: HiveStore,
): Promise<number> {
  const index = await projectStore.getIndex();
  let totalMigrated = 0;

  for (const proj of index.projects) {
    const migrated = await migrateProject(dataDir, proj.id, hiveStore);
    totalMigrated += migrated;
  }

  return totalMigrated;
}

// ── Helpers ──

async function extractDescription(filePath: string): Promise<string | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    if (!content.trim()) return null;

    // Try heading-based summary first
    const headings = content.match(/^#+\s+.+$/gm);
    if (headings && headings.length >= 2) {
      return headings
        .map((h) => h.replace(/^#+\s+/, ""))
        .slice(0, 5)
        .join("; ");
    }

    // Fall back to first 500 chars
    return content.slice(0, 500).trim();
  } catch {
    return null;
  }
}

async function findClaudeMemoryDirs(projectPath: string): Promise<string[]> {
  const dirs: string[] = [];

  // Check ~/.claude/projects/*/memory/ patterns that might reference this project
  const claudeProjectsDir = join(homedir(), ".claude", "projects");
  if (existsSync(claudeProjectsDir)) {
    try {
      const entries = await readdir(claudeProjectsDir);
      // The directory name is a munged path — look for ones matching our project
      const projectBasename = basename(projectPath);
      for (const entry of entries) {
        if (entry.includes(projectBasename)) {
          const memoryDir = join(claudeProjectsDir, entry, "memory");
          if (existsSync(memoryDir)) {
            dirs.push(memoryDir);
          }
        }
      }
    } catch { /* ignore */ }
  }

  return dirs;
}
