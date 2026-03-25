import { readFile, readdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HiveDatabase } from "./database.js";
import type { Entity } from "../types.js";

// ── V2 data shape types ───────────────────────────────────────────────────────

interface V2DirectEntry {
  id: string;
  type: "direct";
  project: string;
  category: "decision" | "learning" | "status" | "note";
  content: string;
  tags: string[];
  createdAt: string;
  agentId?: string;
  embedding?: number[];
}

interface V2ReferenceEntry {
  id: string;
  type: "reference";
  project: string;
  path: string;
  source: string;
  description: string;
  tags: string[];
  createdAt: string;
  lastSynced: string;
  embedding?: number[];
}

type V2CellEntry = V2DirectEntry | V2ReferenceEntry;

interface V2HiveLeafCell {
  id: string;
  type: "leaf";
  summary: string;
  keywords: string[];
  count: number;
  centroid?: number[];
}

interface V2HiveBranchCell {
  id: string;
  type: "branch";
  summary: string;
  keywords: string[];
  count: number;
  children: string[];
  centroid?: number[];
}

type V2HiveCell = V2HiveLeafCell | V2HiveBranchCell;

interface V2HiveIndex {
  version: 1;
  cells: Record<string, V2HiveCell>;
  nursery: V2CellEntry[];
  totalEntries: number;
}

interface V2HiveCellData {
  cellId: string;
  entries: V2CellEntry[];
}

interface V2Synapse {
  id: string;
  source: string;
  target: string;
  axon: string;
  weight: number;
  metadata?: Record<string, string>;
  formedAt: string;
  lastPotentiated: string;
}

interface V2SynapseIndex {
  version: 1;
  synapses: V2Synapse[];
  adjacency: {
    outgoing: Record<string, string[]>;
    incoming: Record<string, string[]>;
  };
}

interface V2CoactivationIndex {
  version: 1;
  counts: Record<string, number>;
}

interface V2ProjectEntry {
  id: string;
  name: string;
  path: string;
  description: string;
  tags: string[];
  lastActive: string;
  status: "active" | "paused" | "archived";
}

interface V2ProjectIndex {
  projects: V2ProjectEntry[];
}

interface V2ProjectSummary {
  id: string;
  oneLiner: string;
  techStack: string[];
  modules: string[];
  currentFocus: string;
  lastSession: {
    date: string;
    summary: string;
    nextTasks: string[];
  } | null;
  stats: Record<string, unknown>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readJsonSafe<T>(filePath: string): Promise<T | null> {
  if (!existsSync(filePath)) return null;
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function mapCellEntryToEntity(entry: V2CellEntry): Entity {
  const now = new Date().toISOString();

  if (entry.type === "direct") {
    const entityType =
      entry.category === "decision" ? "decision" : "memory";

    return {
      id: entry.id,
      entityType,
      project: entry.project,
      namespace: "local",
      content: entry.content,
      tags: entry.tags,
      keywords: [],
      attributes:
        entry.category !== "decision"
          ? { kind: entry.category }
          : {},
      source: {
        system: "agent",
        ...(entry.agentId ? { externalId: entry.agentId } : {}),
      },
      visibility: "personal",
      domain: "code",
      confidence: "confirmed",
      createdAt: entry.createdAt,
      updatedAt: entry.createdAt,
      status: "active",
    };
  } else {
    return {
      id: entry.id,
      entityType: "reference",
      project: entry.project,
      namespace: "local",
      title: entry.path,
      content: entry.description,
      tags: entry.tags,
      keywords: [],
      attributes: {
        path: entry.path,
        lastSynced: entry.lastSynced,
      },
      source: {
        system: entry.source,
        url: entry.path,
      },
      visibility: "personal",
      domain: "code",
      confidence: "confirmed",
      createdAt: entry.createdAt,
      updatedAt: entry.lastSynced ?? entry.createdAt ?? now,
      status: "active",
    };
  }
}

function parseSessionMarkdown(
  content: string,
  filename: string,
): {
  date: string;
  summary: string;
  nextTasks: string[];
  decisions: string[];
  learnings: string[];
} | null {
  // Filename: 2024-01-15.md or 2024-01-15_2024-01-15T12-00-00.md
  const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!dateMatch) return null;

  const date = dateMatch[1];

  // Parse summary section
  const summaryMatch = content.match(/^## Summary\s*\n+([\s\S]*?)(?=^##|$)/m);
  const summary = summaryMatch ? summaryMatch[1].trim() : "";
  if (!summary) return null;

  // Parse bullet-list sections
  function parseList(sectionTitle: string): string[] {
    const re = new RegExp(
      `^## ${sectionTitle}\\s*\\n+([\\s\\S]*?)(?=^##|$)`,
      "m",
    );
    const match = content.match(re);
    if (!match) return [];
    return match[1]
      .split("\n")
      .map((l) => l.replace(/^[-*]\s+/, "").trim())
      .filter(Boolean);
  }

  return {
    date,
    summary,
    nextTasks: parseList("Next Tasks"),
    decisions: parseList("Decisions"),
    learnings: parseList("Learnings"),
  };
}

// ── Main migration function ───────────────────────────────────────────────────

export async function migrateFromV2(
  dataDir: string,
  db: HiveDatabase,
): Promise<{
  entities: number;
  synapses: number;
  coactivations: number;
  projects: number;
  sessions: number;
}> {
  const counts = {
    entities: 0,
    synapses: 0,
    coactivations: 0,
    projects: 0,
    sessions: 0,
  };

  const filesToBackup: string[] = [];

  // ── 1. Load hive.json (nursery + cell tree) ────────────────────────────────
  const hivePath = join(dataDir, "hive.json");
  const hive = await readJsonSafe<V2HiveIndex>(hivePath);

  const allEntries: V2CellEntry[] = [];

  if (hive) {
    // Collect nursery entries
    allEntries.push(...hive.nursery);

    // Collect entries from cell files
    const cellsDir = join(dataDir, "cells");
    if (existsSync(cellsDir)) {
      for (const cellId of Object.keys(hive.cells)) {
        const cellPath = join(cellsDir, `${cellId}.json`);
        const cellData = await readJsonSafe<V2HiveCellData>(cellPath);
        if (cellData) {
          allEntries.push(...cellData.entries);
          filesToBackup.push(cellPath);
        }
      }
    }

    filesToBackup.push(hivePath);
  }

  // Insert entities (deduplicate by ID)
  const seenIds = new Set<string>();
  for (const entry of allEntries) {
    if (seenIds.has(entry.id)) continue;
    seenIds.add(entry.id);

    const entity = mapCellEntryToEntity(entry);
    try {
      db.insertEntity(entity);
      counts.entities++;
    } catch {
      // Skip duplicate / constraint violation
    }
  }

  // ── 2. Load synapses.json ──────────────────────────────────────────────────
  const synapsePath = join(dataDir, "synapses.json");
  const synapseIndex = await readJsonSafe<V2SynapseIndex>(synapsePath);

  if (synapseIndex) {
    for (const syn of synapseIndex.synapses) {
      // Only insert if both ends exist in entities
      const srcExists = db.getEntity(syn.source) !== null;
      const tgtExists = db.getEntity(syn.target) !== null;
      if (!srcExists || !tgtExists) continue;

      try {
        db.insertSynapse({
          id: syn.id,
          source: syn.source,
          target: syn.target,
          axon: syn.axon,
          weight: syn.weight,
          metadata: (syn.metadata as Record<string, unknown>) ?? {},
          formedAt: syn.formedAt,
          lastPotentiated: syn.lastPotentiated,
        });
        counts.synapses++;
      } catch {
        // Skip duplicates
      }
    }
    filesToBackup.push(synapsePath);
  }

  // ── 3. Load coactivation.json ──────────────────────────────────────────────
  const coactivationPath = join(dataDir, "coactivation.json");
  const coactivation = await readJsonSafe<V2CoactivationIndex>(coactivationPath);

  if (coactivation) {
    // Batch insert coactivations by reconstructing pair arrays
    for (const [pairKey, count] of Object.entries(coactivation.counts)) {
      const [a, b] = pairKey.split(":");
      if (!a || !b) continue;

      // Simulate recording count times by inserting directly if possible
      for (let i = 0; i < Math.min(count, 100); i++) {
        db.recordCoactivation([a, b]);
      }
      counts.coactivations++;
    }
    filesToBackup.push(coactivationPath);
  }

  // ── 4. Load index.json (projects) + summary.json ──────────────────────────
  const indexPath = join(dataDir, "index.json");
  const projectIndex = await readJsonSafe<V2ProjectIndex>(indexPath);

  if (projectIndex) {
    for (const proj of projectIndex.projects) {
      const summaryPath = join(
        dataDir,
        "projects",
        proj.id,
        "summary.json",
      );
      const summary = await readJsonSafe<V2ProjectSummary>(summaryPath);

      db.upsertProject({
        id: proj.id,
        name: proj.name,
        path: proj.path,
        description: proj.description,
        tags: proj.tags,
        lastActive: proj.lastActive,
        status: proj.status,
        oneLiner: summary?.oneLiner ?? "",
        techStack: summary?.techStack ?? [],
        modules: summary?.modules ?? [],
        currentFocus: summary?.currentFocus ?? "",
        lastSession: summary?.lastSession ?? null,
        stats: summary?.stats ?? {},
      });
      counts.projects++;

      if (summaryPath && existsSync(summaryPath)) {
        filesToBackup.push(summaryPath);
      }

      // ── 5. Load sessions/*.md ────────────────────────────────────────────
      const sessionsDir = join(dataDir, "projects", proj.id, "sessions");
      if (existsSync(sessionsDir)) {
        let sessionFiles: string[];
        try {
          sessionFiles = await readdir(sessionsDir);
        } catch {
          sessionFiles = [];
        }

        for (const filename of sessionFiles) {
          if (!filename.endsWith(".md")) continue;
          const sessionPath = join(sessionsDir, filename);
          const content = await readFile(sessionPath, "utf-8").catch(
            () => null,
          );
          if (!content) continue;

          const parsed = parseSessionMarkdown(content, filename);
          if (!parsed) continue;

          const now = new Date().toISOString();
          try {
            db.insertSession(proj.id, {
              date: parsed.date,
              summary: parsed.summary,
              nextTasks: parsed.nextTasks,
              decisions: parsed.decisions,
              learnings: parsed.learnings,
              createdAt: now,
            });
            counts.sessions++;
            filesToBackup.push(sessionPath);
          } catch {
            // Skip duplicates
          }
        }
      }
    }

    filesToBackup.push(indexPath);
  }

  // ── 6. Rename migrated files to *.v2.bak ──────────────────────────────────
  for (const filePath of filesToBackup) {
    if (!existsSync(filePath)) continue;
    try {
      await rename(filePath, `${filePath}.v2.bak`);
    } catch {
      // Best-effort — don't fail migration if backup fails
    }
  }

  return counts;
}
