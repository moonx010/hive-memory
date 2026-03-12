import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ProjectIndex,
  ProjectEntry,
  ProjectSummary,
  SessionSummary,
  MemoryEntry,
  MemoryCategory,
  CortexConfig,
  OnboardCandidate,
} from "./types.js";
import { EmbedService } from "./embed.js";
import { writeJson } from "./store/io.js";
import { ProjectStore } from "./store/project-store.js";
import { MemoryStore } from "./store/memory-store.js";
import { SessionStore } from "./store/session-store.js";
import { ContextSync } from "./store/context-sync.js";
import type { CrossProjectInsight } from "./store/context-sync.js";
import { OnboardScanner } from "./store/onboard.js";
import { HiveStore } from "./store/hive-store.js";
import { HiveSearch } from "./store/hive-search.js";
import type { HiveSearchResult } from "./store/hive-search.js";
import { migrateAllProjects, scanProjectReferences, syncReferences } from "./store/hive-migrate.js";

// Re-export for backwards compatibility
export { validateId } from "./store/io.js";

/**
 * Facade over domain-specific stores.
 * Preserves the original public API so existing tests and tools keep working.
 */
export class CortexStore {
  private dataDir: string;
  private localContextEnabled: boolean;
  private embed = new EmbedService();

  private projects!: ProjectStore;
  private memories!: MemoryStore;
  private sessions!: SessionStore;
  private context!: ContextSync;
  private onboard!: OnboardScanner;
  private hive!: HiveStore;
  private hiveSearch!: HiveSearch;

  constructor(config: CortexConfig) {
    this.dataDir = config.dataDir;
    this.localContextEnabled = config.localContext.enabled ?? true;

    // Wire up sub-stores
    this.projects = new ProjectStore(this.dataDir, this.embed);
    this.hive = new HiveStore(this.dataDir, this.embed);
    this.hiveSearch = new HiveSearch(this.hive, this.embed);
    this.memories = new MemoryStore(this.dataDir, this.embed, this.projects, this.hive, this.hiveSearch);
    this.sessions = new SessionStore(this.dataDir, this.projects);
    this.context = new ContextSync(
      this.dataDir,
      config.localContext.filename,
      this.localContextEnabled,
      this.projects,
      this.memories,
    );
    this.onboard = new OnboardScanner(this.projects);
  }

  get localSyncEnabled(): boolean {
    return this.localContextEnabled;
  }

  async init(): Promise<void> {
    await this.initDirs();
    await this.embed.init(this.dataDir);
    await this.hive.ensureDirs();

    // Auto-migrate legacy knowledge/ → hive on first run
    const hiveIndex = await this.hive.loadHive();
    if (hiveIndex.totalEntries === 0) {
      await migrateAllProjects(this.dataDir, this.projects, this.hive);
    }

    if (this.embed.available && this.embed.count() === 0) {
      await this.reindexAll();
    }
  }

  /** Init without loading embedding model — for fast CLI commands (keyword-only search). */
  async initWithoutEmbed(): Promise<void> {
    await this.initDirs();
    await this.hive.ensureDirs();
  }

  private async initDirs(): Promise<void> {
    const dirs = [
      this.dataDir,
      join(this.dataDir, "projects"),
      join(this.dataDir, "global"),
    ];
    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }
    const indexPath = join(this.dataDir, "index.json");
    if (!existsSync(indexPath)) {
      await writeJson(indexPath, { projects: [] });
    }
  }

  // --- Delegated project methods ---

  async getIndex(): Promise<ProjectIndex> { return this.projects.getIndex(); }
  async saveIndex(index: ProjectIndex): Promise<void> { return this.projects.saveIndex(index); }
  async searchProjects(query: string, limit?: number): Promise<ProjectEntry[]> { return this.projects.searchProjects(query, limit); }
  async upsertProject(entry: ProjectEntry): Promise<void> { return this.projects.upsertProject(entry); }
  async getProjectSummary(id: string): Promise<ProjectSummary | null> { return this.projects.getProjectSummary(id); }
  async saveProjectSummary(summary: ProjectSummary): Promise<void> { return this.projects.saveProjectSummary(summary); }
  async getProjectStatus(id: string): Promise<string | null> { return this.projects.getProjectStatus(id); }

  // --- Delegated memory methods ---

  async storeMemory(projectId: string, category: MemoryCategory, content: string, tags: string[], agentId?: string): Promise<MemoryEntry> {
    return this.memories.storeMemory(projectId, category, content, tags, agentId);
  }
  async recallMemories(query: string, projectId?: string, limit?: number, agentId?: string): Promise<HiveSearchResult[]> {
    return this.memories.recallMemories(query, projectId, limit, agentId);
  }

  // --- Delegated session methods ---

  async saveSession(projectId: string, session: SessionSummary): Promise<void> {
    await this.sessions.saveSession(projectId, session);
    await this.context.syncLocalContext(projectId);
  }

  // --- Delegated context methods ---

  async getCrossProjectContext(projectId: string, limit?: number): Promise<CrossProjectInsight[]> {
    return this.context.getCrossProjectContext(projectId, limit);
  }
  async syncLocalContext(projectId: string): Promise<string | null> {
    return this.context.syncLocalContext(projectId);
  }

  // --- Delegated onboard methods ---

  async scanForProjects(rootPath: string, depth?: number): Promise<OnboardCandidate[]> {
    return this.onboard.scanForProjects(rootPath, depth);
  }

  // --- Hive: reference scan on onboard ---

  async scanProjectReferences(projectId: string, projectPath: string): Promise<number> {
    return scanProjectReferences(projectId, projectPath, this.hive);
  }

  async syncReferences(projectId: string): Promise<number> {
    return syncReferences(projectId, this.hive);
  }

  // --- Cleanup ---

  /**
   * Remove expired status entries (older than 30 days).
   * Returns the count of removed entries.
   */
  async cleanupExpiredEntries(): Promise<number> {
    const STATUS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    return this.hive.removeEntries((entry) =>
      entry.type === "direct" &&
      entry.category === "status" &&
      now - new Date(entry.createdAt).getTime() > STATUS_TTL_MS,
    );
  }

  // --- Reindex ---

  private async reindexAll(): Promise<void> {
    if (!this.embed.available) return;

    const index = await this.projects.getIndex();
    for (const p of index.projects) {
      await this.embed.addText(
        `project:${p.id}`,
        `${p.name} ${p.description} ${p.tags.join(" ")}`,
        JSON.stringify({ type: "project", project: p.id }),
      );
    }

    const { readFile } = await import("node:fs/promises");
    for (const proj of index.projects) {
      const knowledgeDir = join(this.dataDir, "projects", proj.id, "knowledge");
      if (!existsSync(knowledgeDir)) continue;

      const categories: MemoryCategory[] = ["decision", "learning", "status", "note"];
      for (const cat of categories) {
        const path = join(knowledgeDir, `${cat}s.md`);
        if (!existsSync(path)) continue;

        const content = await readFile(path, "utf-8");
        const sections = content.split(/^## /m).filter(Boolean);
        for (let i = 0; i < sections.length; i++) {
          const section = sections[i].trim();
          if (!section) continue;
          const dateMatch = section.match(/^(\d{4}-\d{2}-\d{2})/);
          const ts = dateMatch ? dateMatch[1] : `s${i}`;
          await this.embed.addText(
            `memory:${proj.id}:${cat}:${ts}`,
            section,
            JSON.stringify({ type: "memory", project: proj.id, category: cat, preview: section.slice(0, 300) }),
          );
        }
      }
    }
  }
}
