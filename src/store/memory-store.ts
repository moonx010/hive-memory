import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { MemoryEntry, MemoryCategory } from "../types.js";
import type { EmbedService } from "../embed.js";
import type { ProjectStore } from "./project-store.js";
import type { HiveStore } from "./hive-store.js";
import type { HiveSearch, HiveSearchResult } from "./hive-search.js";
import { capitalize } from "./io.js";

export class MemoryStore {
  constructor(
    private dataDir: string,
    private embed: EmbedService,
    private projectStore: ProjectStore,
    private hiveStore: HiveStore | null = null,
    private hiveSearch: HiveSearch | null = null,
  ) {}

  private projectDir(projectId: string): string {
    return join(this.dataDir, "projects", projectId);
  }

  async storeMemory(
    projectId: string,
    category: MemoryCategory,
    content: string,
    tags: string[],
    agentId?: string,
  ): Promise<MemoryEntry> {
    // Verify project is registered
    const index = await this.projectStore.getIndex();
    if (!index.projects.some((p) => p.id === projectId)) {
      throw new Error(`Project "${projectId}" is not registered. Register it first with project_register.`);
    }

    // Store in hive (primary)
    if (this.hiveStore) {
      return this.hiveStore.storeDirectEntry(projectId, category, content, tags, agentId);
    }

    // Fallback: legacy-only path (no hive available)
    return this.storeLegacy(projectId, category, content, tags);
  }

  async recallMemories(
    query: string,
    projectId?: string,
    limit = 5,
    agentId?: string,
  ): Promise<HiveSearchResult[]> {
    // Use hive search if available
    if (this.hiveSearch) {
      return this.hiveSearch.search(query, { project: projectId, agent: agentId, limit });
    }

    // Fallback: legacy search
    return this.legacyRecall(query, projectId, limit);
  }

  // ── Legacy helpers (fallback when hive unavailable) ──

  private async storeLegacy(
    projectId: string,
    category: MemoryCategory,
    content: string,
    tags: string[],
  ): Promise<MemoryEntry> {
    const knowledgeDir = join(this.projectDir(projectId), "knowledge");
    await mkdir(knowledgeDir, { recursive: true });

    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      id: randomUUID(),
      project: projectId,
      category,
      content,
      tags,
      createdAt: now,
    };

    const filename = `${category}s.md`;
    const path = join(knowledgeDir, filename);
    const tagLine = tags.length > 0 ? `\n> tags: ${tags.join(", ")}` : "";
    const line = `\n## ${now.slice(0, 10)} — id:${entry.id}${tagLine}\n\n${content}\n`;

    if (existsSync(path)) {
      const existing = await readFile(path, "utf-8");
      await writeFile(path, existing + line, "utf-8");
    } else {
      const header = `# ${capitalize(category)}s — ${projectId}\n`;
      await writeFile(path, header + line, "utf-8");
    }

    await this.embed.addText(
      `memory:${projectId}:${category}:${entry.createdAt}`,
      content,
      JSON.stringify({ type: "memory", project: projectId, category, preview: content.slice(0, 300) }),
    );

    return entry;
  }

  private async legacyRecall(
    query: string,
    projectId?: string,
    limit = 5,
  ): Promise<HiveSearchResult[]> {
    const index = await this.projectStore.getIndex();
    const projects = projectId
      ? index.projects.filter((p) => p.id === projectId)
      : index.projects;

    const results: { project: string; category: string; snippet: string; score: number }[] = [];
    const q = query.toLowerCase();

    for (const proj of projects) {
      const knowledgeDir = join(this.projectDir(proj.id), "knowledge");
      if (!existsSync(knowledgeDir)) continue;

      const categories: MemoryCategory[] = ["decision", "learning", "status", "note"];
      for (const cat of categories) {
        const path = join(knowledgeDir, `${cat}s.md`);
        if (!existsSync(path)) continue;

        const content = await readFile(path, "utf-8");
        const sections = content.split(/^## /m).filter(Boolean);

        for (const section of sections.slice(1)) {
          if (section.toLowerCase().includes(q)) {
            results.push({
              project: proj.id,
              category: cat,
              snippet: section.trim().slice(0, 300),
              score: 10,
            });
          }
        }
      }
    }

    const vecHits = await this.embed.search(query, limit * 2);
    for (const hit of vecHits) {
      try {
        const meta = hit.metadata ? JSON.parse(hit.metadata) : null;
        if (meta?.type !== "memory") continue;
        if (projectId && meta.project !== projectId) continue;

        const vecScore = Math.max(0, 15 * (1 - hit.distance));
        const vecDate = hit.id.split(":")[3]?.slice(0, 10) ?? "";
        const existing = results.find(
          (r) => r.project === meta.project && r.category === meta.category &&
            vecDate && r.snippet.includes(vecDate),
        );
        if (existing) {
          existing.score += vecScore;
        } else {
          results.push({
            project: meta.project,
            category: meta.category,
            snippet: meta.preview ?? hit.id,
            score: vecScore,
          });
        }
      } catch { /* ignore */ }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
