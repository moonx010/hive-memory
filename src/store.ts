import { readFile, writeFile, rename, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import type {
  ProjectIndex,
  ProjectEntry,
  ProjectSummary,
  SessionSummary,
  MemoryEntry,
  MemoryCategory,
  CortexConfig,
  GroupEntry,
  GroupIndex,
  OnboardCandidate,
} from "./types.js";
import { EmbedService } from "./embed.js";

export class CortexStore {
  private dataDir: string;
  private localContextFilename: string;
  private localContextEnabled: boolean;
  private embed = new EmbedService();

  constructor(config: CortexConfig) {
    this.dataDir = config.dataDir;
    this.localContextFilename = config.localContext.filename;
    this.localContextEnabled = config.localContext.enabled ?? true;
  }

  get localSyncEnabled(): boolean {
    return this.localContextEnabled;
  }

  async init(): Promise<void> {
    const dirs = [
      this.dataDir,
      join(this.dataDir, "projects"),
      join(this.dataDir, "groups"),
      join(this.dataDir, "global"),
    ];
    for (const dir of dirs) {
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
    }
    if (!existsSync(this.indexPath)) {
      await this.writeJson(this.indexPath, { projects: [] });
    }

    // Initialize semantic search (no-op if native module unavailable)
    await this.embed.init(this.dataDir);
    if (this.embed.available && this.embed.count() === 0) {
      await this.reindexAll();
    }
  }

  // --- Project Index ---

  private get indexPath(): string {
    return join(this.dataDir, "index.json");
  }

  async getIndex(): Promise<ProjectIndex> {
    return this.readJson<ProjectIndex>(this.indexPath);
  }

  async saveIndex(index: ProjectIndex): Promise<void> {
    await this.writeJson(this.indexPath, index);
  }

  async searchProjects(query: string, limit = 3): Promise<ProjectEntry[]> {
    const index = await this.getIndex();
    const q = query.toLowerCase().trim();

    // Empty query → return all projects sorted by lastActive
    if (q === "") {
      return index.projects
        .sort(
          (a, b) =>
            new Date(b.lastActive).getTime() -
            new Date(a.lastActive).getTime(),
        )
        .slice(0, limit);
    }

    // Find groups matching the query for member project boosting
    const groupIndex = await this.getGroupIndex();
    const matchingGroupProjectIds = new Set<string>();
    for (const g of groupIndex.groups) {
      if (
        g.name.toLowerCase().includes(q) ||
        g.id.toLowerCase().includes(q) ||
        g.description.toLowerCase().includes(q) ||
        g.tags.some((t) => t.toLowerCase().includes(q))
      ) {
        for (const pid of g.projectIds) {
          matchingGroupProjectIds.add(pid);
        }
      }
    }

    // Build vector score map for semantic boosting
    const vectorScores = new Map<string, number>();
    const vecHits = await this.embed.search(query, limit * 2);
    for (const hit of vecHits) {
      try {
        const meta = hit.metadata ? JSON.parse(hit.metadata) : null;
        if (meta?.type === "project") {
          // Convert distance to a 0-15 score (lower distance = higher score)
          vectorScores.set(meta.project, Math.max(0, 15 * (1 - hit.distance)));
        }
      } catch { /* ignore parse errors */ }
    }

    const scored = index.projects.map((p) => {
      let score = 0;
      if (p.name.toLowerCase().includes(q)) score += 10;
      if (p.id.toLowerCase().includes(q)) score += 10;
      if (p.description.toLowerCase().includes(q)) score += 5;
      for (const tag of p.tags) {
        if (tag.toLowerCase().includes(q)) score += 3;
      }
      // Boost projects that belong to a matching group
      if (matchingGroupProjectIds.has(p.id)) score += 7;
      // Boost recently active projects
      const daysSince =
        (Date.now() - new Date(p.lastActive).getTime()) / 86400000;
      if (daysSince < 1) score += 3;
      else if (daysSince < 7) score += 1;
      // Semantic vector boost
      score += vectorScores.get(p.id) ?? 0;
      return { project: p, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.project);
  }

  async listProjects(
    statusFilter?: "active" | "paused" | "archived",
  ): Promise<ProjectEntry[]> {
    const index = await this.getIndex();
    let projects = index.projects;
    if (statusFilter) {
      projects = projects.filter((p) => p.status === statusFilter);
    }
    return projects.sort(
      (a, b) =>
        new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime(),
    );
  }

  async upsertProject(entry: ProjectEntry): Promise<void> {
    const index = await this.getIndex();
    const idx = index.projects.findIndex((p) => p.id === entry.id);
    if (idx >= 0) {
      index.projects[idx] = entry;
    } else {
      index.projects.push(entry);
    }
    await this.saveIndex(index);

    await this.embed.addText(
      `project:${entry.id}`,
      `${entry.name} ${entry.description} ${entry.tags.join(" ")}`,
      JSON.stringify({ type: "project", project: entry.id }),
    );
  }

  async updateProjectStatus(
    projectId: string,
    status: "active" | "paused" | "archived",
  ): Promise<boolean> {
    const index = await this.getIndex();
    const proj = index.projects.find((p) => p.id === projectId);
    if (!proj) return false;
    proj.status = status;
    await this.saveIndex(index);
    return true;
  }

  async updateProjectMeta(
    projectId: string,
    updates: Partial<Pick<ProjectEntry, "name" | "description" | "tags" | "path">>,
  ): Promise<boolean> {
    const index = await this.getIndex();
    const proj = index.projects.find((p) => p.id === projectId);
    if (!proj) return false;
    if (updates.name !== undefined) proj.name = updates.name;
    if (updates.description !== undefined) proj.description = updates.description;
    if (updates.tags !== undefined) proj.tags = updates.tags;
    if (updates.path !== undefined) proj.path = updates.path;
    await this.saveIndex(index);
    return true;
  }

  // --- Project Summary ---

  private projectDir(projectId: string): string {
    return join(this.dataDir, "projects", projectId);
  }

  async getProjectSummary(
    projectId: string,
  ): Promise<ProjectSummary | null> {
    const path = join(this.projectDir(projectId), "summary.json");
    if (!existsSync(path)) return null;
    return this.readJson<ProjectSummary>(path);
  }

  async saveProjectSummary(summary: ProjectSummary): Promise<void> {
    const dir = this.projectDir(summary.id);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await this.writeJson(join(dir, "summary.json"), summary);
  }

  // --- Status (Markdown) ---

  async getProjectStatus(projectId: string): Promise<string | null> {
    const path = join(this.projectDir(projectId), "status.md");
    if (!existsSync(path)) return null;
    return readFile(path, "utf-8");
  }

  async saveProjectStatus(
    projectId: string,
    content: string,
  ): Promise<void> {
    const dir = this.projectDir(projectId);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "status.md"), content, "utf-8");
  }

  // --- Sessions ---

  async saveSession(
    projectId: string,
    session: SessionSummary,
  ): Promise<void> {
    const sessionsDir = join(this.projectDir(projectId), "sessions");
    if (!existsSync(sessionsDir)) await mkdir(sessionsDir, { recursive: true });
    const filename = `${session.date}.md`;
    const content = formatSessionMarkdown(session);
    await writeFile(join(sessionsDir, filename), content, "utf-8");

    // Update project summary with latest session
    const summary = await this.getProjectSummary(projectId);
    if (summary) {
      summary.lastSession = {
        date: session.date,
        summary: session.summary,
        nextTasks: session.nextTasks,
      };
      if (session.nextTasks.length > 0) {
        summary.currentFocus = session.nextTasks[0];
      }
      await this.saveProjectSummary(summary);
    }

    // Update lastActive in index
    const index = await this.getIndex();
    const proj = index.projects.find((p) => p.id === projectId);
    if (proj) {
      proj.lastActive = new Date().toISOString();
      await this.saveIndex(index);
    }

    // Sync local context file into project directory
    await this.syncLocalContext(projectId);
  }

  // --- Memory Entries ---

  async storeMemory(
    projectId: string,
    category: MemoryCategory,
    content: string,
    tags: string[],
  ): Promise<MemoryEntry> {
    const knowledgeDir = join(this.projectDir(projectId), "knowledge");
    if (!existsSync(knowledgeDir))
      await mkdir(knowledgeDir, { recursive: true });

    const entry: MemoryEntry = {
      id: crypto.randomUUID(),
      project: projectId,
      category,
      content,
      tags,
      createdAt: new Date().toISOString(),
    };

    // Append to category file
    const filename = `${category}s.md`;
    const path = join(knowledgeDir, filename);
    const line = `\n## ${new Date().toISOString().slice(0, 10)}\n\n${content}\n`;

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
      JSON.stringify({ type: "memory", project: projectId, category }),
    );

    return entry;
  }

  async recallMemories(
    query: string,
    projectId?: string,
    limit = 5,
  ): Promise<{ project: string; category: string; snippet: string; score?: number }[]> {
    const index = await this.getIndex();
    const projects = projectId
      ? index.projects.filter((p) => p.id === projectId)
      : index.projects;

    const results: { project: string; category: string; snippet: string; score: number }[] =
      [];
    const q = query.toLowerCase();

    // Keyword search (existing logic)
    for (const proj of projects) {
      const knowledgeDir = join(this.projectDir(proj.id), "knowledge");
      if (!existsSync(knowledgeDir)) continue;

      const categories: MemoryCategory[] = [
        "decision",
        "learning",
        "status",
        "note",
      ];
      for (const cat of categories) {
        const path = join(knowledgeDir, `${cat}s.md`);
        if (!existsSync(path)) continue;

        const content = await readFile(path, "utf-8");
        const sections = content.split(/^## /m).filter(Boolean);

        for (const section of sections) {
          if (section.toLowerCase().includes(q)) {
            results.push({
              project: proj.id,
              category: cat,
              snippet: section.trim().slice(0, 300),
              score: 10, // keyword match base score
            });
          }
        }
      }
    }

    // Vector search — merge with keyword results
    const vecHits = await this.embed.search(query, limit * 2);
    for (const hit of vecHits) {
      try {
        const meta = hit.metadata ? JSON.parse(hit.metadata) : null;
        if (meta?.type !== "memory") continue;
        if (projectId && meta.project !== projectId) continue;

        const vecScore = Math.max(0, 15 * (1 - hit.distance));
        // Check if this memory already found by keyword
        const existing = results.find(
          (r) => r.project === meta.project && r.category === meta.category &&
            r.snippet.includes(hit.id.split(":").slice(-1)[0]?.slice(0, 10) ?? ""),
        );
        if (existing) {
          existing.score += vecScore;
        } else {
          // Vector-only result: extract snippet from ID
          results.push({
            project: meta.project,
            category: meta.category,
            snippet: `[semantic match] ${hit.id}`,
            score: vecScore,
          });
        }
      } catch { /* ignore */ }
    }

    // Re-rank by combined score
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // --- Local Context Sync ---

  /**
   * Write file atomically via temp + rename to prevent corruption
   * from concurrent writers (last-write-wins, no partial writes).
   */
  private async atomicWriteFile(
    filePath: string,
    data: string,
  ): Promise<void> {
    const tmp = `${filePath}.${process.pid}.tmp`;
    await writeFile(tmp, data, "utf-8");
    await rename(tmp, filePath);
  }

  /**
   * Write a .cortex.md into the project's actual directory.
   * This gives Claude Code immediate detailed context when opening that project.
   */
  async syncLocalContext(projectId: string): Promise<string | null> {
    if (!this.localContextEnabled) return null;

    const index = await this.getIndex();
    const proj = index.projects.find((p) => p.id === projectId);
    if (!proj || !existsSync(proj.path)) return null;

    const summary = await this.getProjectSummary(projectId);
    const status = await this.getProjectStatus(projectId);

    // Gather recent knowledge
    const knowledgeDir = join(this.projectDir(projectId), "knowledge");
    let recentDecisions = "";
    let recentLearnings = "";
    if (existsSync(knowledgeDir)) {
      const decisionsPath = join(knowledgeDir, "decisions.md");
      const learningsPath = join(knowledgeDir, "learnings.md");
      if (existsSync(decisionsPath)) {
        const content = await readFile(decisionsPath, "utf-8");
        recentDecisions = getLastNSections(content, 5);
      }
      if (existsSync(learningsPath)) {
        const content = await readFile(learningsPath, "utf-8");
        recentLearnings = getLastNSections(content, 5);
      }
    }

    // Get last 3 session logs
    const sessionsDir = join(this.projectDir(projectId), "sessions");
    let recentSessions = "";
    if (existsSync(sessionsDir)) {
      const files = (await readdir(sessionsDir))
        .filter((f) => f.endsWith(".md"))
        .sort()
        .slice(-3);
      for (const file of files) {
        const content = await readFile(join(sessionsDir, file), "utf-8");
        recentSessions += content + "\n---\n\n";
      }
    }

    // Build the local context document
    let md = `<!-- Auto-generated by Cortex. Do not edit manually. -->\n`;
    md += `<!-- Last synced: ${new Date().toISOString()} -->\n\n`;
    md += `# ${proj.name} — Cortex Context\n\n`;

    if (summary) {
      md += `## Overview\n\n`;
      md += `${summary.oneLiner}\n\n`;
      md += `- **Tech**: ${summary.techStack.join(", ")}\n`;
      md += `- **Modules**: ${summary.modules.join(", ")}\n`;
      md += `- **Current Focus**: ${summary.currentFocus}\n\n`;
    }

    if (summary?.lastSession) {
      md += `## Current Status\n\n`;
      md += `Last session: ${summary.lastSession.date}\n\n`;
      md += `${summary.lastSession.summary}\n\n`;
      if (summary.lastSession.nextTasks.length > 0) {
        md += `### Next Tasks\n\n`;
        for (const t of summary.lastSession.nextTasks) {
          md += `- [ ] ${t}\n`;
        }
        md += "\n";
      }
    }

    if (status) {
      md += `## Detailed Status\n\n${status}\n\n`;
    }

    if (recentDecisions) {
      md += `## Recent Decisions\n\n${recentDecisions}\n`;
    }

    if (recentLearnings) {
      md += `## Recent Learnings\n\n${recentLearnings}\n`;
    }

    if (recentSessions) {
      md += `## Recent Sessions\n\n${recentSessions}`;
    }

    // Group context section (guide names only for token efficiency)
    if (proj.groupIds && proj.groupIds.length > 0) {
      const groupIndex = await this.getGroupIndex();
      md += `## Groups\n\n`;
      for (const gid of proj.groupIds) {
        const group = groupIndex.groups.find((g) => g.id === gid);
        if (!group) continue;
        md += `- **${group.name}** (${gid})\n`;
        const guidesDir = join(this.groupDir(gid), "guides");
        if (existsSync(guidesDir)) {
          const guideFiles = (await readdir(guidesDir)).filter((f) =>
            f.endsWith(".md"),
          );
          if (guideFiles.length > 0) {
            md += `  Shared: ${guideFiles.map((f) => f.replace(/\.md$/, "")).join(", ")}\n`;
          }
        }
        md += `  → group_context("${gid}") for details\n`;
      }
      md += "\n";
    }

    const localPath = join(proj.path, this.localContextFilename);
    await this.atomicWriteFile(localPath, md);
    return localPath;
  }

  // --- Group Index ---

  private get groupIndexPath(): string {
    return join(this.dataDir, "groups.json");
  }

  private groupDir(groupId: string): string {
    return join(this.dataDir, "groups", groupId);
  }

  async getGroupIndex(): Promise<GroupIndex> {
    if (!existsSync(this.groupIndexPath)) {
      return { groups: [] };
    }
    return this.readJson<GroupIndex>(this.groupIndexPath);
  }

  async saveGroupIndex(index: GroupIndex): Promise<void> {
    await this.writeJson(this.groupIndexPath, index);
  }

  async createGroup(
    entry: Omit<GroupEntry, "createdAt" | "lastActive">,
  ): Promise<GroupEntry> {
    const now = new Date().toISOString();
    const group: GroupEntry = {
      ...entry,
      createdAt: now,
      lastActive: now,
    };

    // Save to groups.json
    const groupIndex = await this.getGroupIndex();
    groupIndex.groups.push(group);
    await this.saveGroupIndex(groupIndex);

    // Create group directory structure
    const dir = this.groupDir(group.id);
    await mkdir(join(dir, "guides"), { recursive: true });
    await mkdir(join(dir, "knowledge"), { recursive: true });

    // Write default overview.md
    await writeFile(
      join(dir, "overview.md"),
      `# ${group.name}\n\n${group.description}\n`,
      "utf-8",
    );

    // Add bidirectional references to projects
    if (group.projectIds.length > 0) {
      const projectIndex = await this.getIndex();
      for (const pid of group.projectIds) {
        const proj = projectIndex.projects.find((p) => p.id === pid);
        if (proj) {
          if (!proj.groupIds) proj.groupIds = [];
          if (!proj.groupIds.includes(group.id)) {
            proj.groupIds.push(group.id);
          }
        }
      }
      await this.saveIndex(projectIndex);
    }

    await this.embed.addText(
      `group:${group.id}`,
      `${group.name} ${group.description} ${group.tags.join(" ")}`,
      JSON.stringify({ type: "group", group: group.id }),
    );

    return group;
  }

  async getGroupContext(
    groupId: string,
    detail: "brief" | "full" = "brief",
  ): Promise<string | null> {
    const groupIndex = await this.getGroupIndex();
    const group = groupIndex.groups.find((g) => g.id === groupId);
    if (!group) return null;

    const dir = this.groupDir(groupId);
    let md = `# ${group.name}\n\n`;
    md += `${group.description}\n\n`;
    md += `**Tags**: ${group.tags.join(", ")}\n\n`;

    // Overview
    const overviewPath = join(dir, "overview.md");
    if (existsSync(overviewPath)) {
      const overview = await readFile(overviewPath, "utf-8");
      // Skip the auto-generated header line if it matches the name
      const lines = overview.split("\n");
      const body = lines.slice(lines[0]?.startsWith("# ") ? 1 : 0).join("\n").trim();
      if (body && body !== group.description) {
        md += `## Overview\n\n${body}\n\n`;
      }
    }

    // Guides
    const guidesDir = join(dir, "guides");
    if (existsSync(guidesDir)) {
      const guideFiles = (await readdir(guidesDir)).filter((f) =>
        f.endsWith(".md"),
      );
      if (guideFiles.length > 0) {
        md += `## Shared Guides\n\n`;
        if (detail === "brief") {
          for (const f of guideFiles) {
            md += `- ${f.replace(/\.md$/, "")}\n`;
          }
          md += `\n→ Use group_context("${groupId}", detail="full") for full guide contents\n\n`;
        } else {
          for (const f of guideFiles) {
            const content = await readFile(join(guidesDir, f), "utf-8");
            md += `### ${f.replace(/\.md$/, "")}\n\n${content}\n\n`;
          }
        }
      }
    }

    // Knowledge (group-level memories)
    if (detail === "full") {
      const knowledgeDir = join(dir, "knowledge");
      if (existsSync(knowledgeDir)) {
        const knowledgeFiles = (await readdir(knowledgeDir)).filter((f) =>
          f.endsWith(".md"),
        );
        if (knowledgeFiles.length > 0) {
          md += `## Group Knowledge\n\n`;
          for (const f of knowledgeFiles) {
            const content = await readFile(join(knowledgeDir, f), "utf-8");
            md += `### ${f.replace(/\.md$/, "")}\n\n${content}\n\n`;
          }
        }
      }
    }

    // Member projects
    if (group.projectIds.length > 0) {
      md += `## Member Projects\n\n`;
      const projectIndex = await this.getIndex();
      for (const pid of group.projectIds) {
        const proj = projectIndex.projects.find((p) => p.id === pid);
        if (proj) {
          const summary = await this.getProjectSummary(pid);
          const focus = summary?.currentFocus ?? "—";
          md += `- **${proj.name}** (${pid}) — ${focus}\n`;
        }
      }
      md += "\n";
    }

    // Update lastActive
    group.lastActive = new Date().toISOString();
    await this.saveGroupIndex(groupIndex);

    return md;
  }

  async addProjectToGroup(
    groupId: string,
    projectId: string,
  ): Promise<boolean> {
    const groupIndex = await this.getGroupIndex();
    const group = groupIndex.groups.find((g) => g.id === groupId);
    if (!group) return false;

    if (!group.projectIds.includes(projectId)) {
      group.projectIds.push(projectId);
      group.lastActive = new Date().toISOString();
      await this.saveGroupIndex(groupIndex);
    }

    // Update project side
    const projectIndex = await this.getIndex();
    const proj = projectIndex.projects.find((p) => p.id === projectId);
    if (proj) {
      if (!proj.groupIds) proj.groupIds = [];
      if (!proj.groupIds.includes(groupId)) {
        proj.groupIds.push(groupId);
        await this.saveIndex(projectIndex);
      }
    }

    return true;
  }

  async removeProjectFromGroup(
    groupId: string,
    projectId: string,
  ): Promise<boolean> {
    const groupIndex = await this.getGroupIndex();
    const group = groupIndex.groups.find((g) => g.id === groupId);
    if (!group) return false;

    group.projectIds = group.projectIds.filter((id) => id !== projectId);
    group.lastActive = new Date().toISOString();
    await this.saveGroupIndex(groupIndex);

    // Update project side
    const projectIndex = await this.getIndex();
    const proj = projectIndex.projects.find((p) => p.id === projectId);
    if (proj && proj.groupIds) {
      proj.groupIds = proj.groupIds.filter((id) => id !== groupId);
      if (proj.groupIds.length === 0) delete proj.groupIds;
      await this.saveIndex(projectIndex);
    }

    return true;
  }

  async searchGroups(query: string): Promise<GroupEntry[]> {
    const groupIndex = await this.getGroupIndex();
    const q = query.toLowerCase().trim();
    if (q === "") return groupIndex.groups;

    // Build vector score map
    const vectorScores = new Map<string, number>();
    const vecHits = await this.embed.search(query, 10);
    for (const hit of vecHits) {
      try {
        const meta = hit.metadata ? JSON.parse(hit.metadata) : null;
        if (meta?.type === "group") {
          vectorScores.set(meta.group, Math.max(0, 15 * (1 - hit.distance)));
        }
      } catch { /* ignore */ }
    }

    const scored = groupIndex.groups.map((g) => {
      let score = 0;
      if (g.name.toLowerCase().includes(q)) score += 10;
      if (g.id.toLowerCase().includes(q)) score += 10;
      if (g.description.toLowerCase().includes(q)) score += 5;
      if (g.tags.some((t) => t.toLowerCase().includes(q))) score += 3;
      score += vectorScores.get(g.id) ?? 0;
      return { group: g, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.group);
  }

  async saveGroupGuide(
    groupId: string,
    filename: string,
    content: string,
  ): Promise<string> {
    const guidesDir = join(this.groupDir(groupId), "guides");
    if (!existsSync(guidesDir))
      await mkdir(guidesDir, { recursive: true });

    const safeName = filename.endsWith(".md") ? filename : `${filename}.md`;
    const path = join(guidesDir, safeName);
    await writeFile(path, content, "utf-8");

    // Update lastActive
    const groupIndex = await this.getGroupIndex();
    const group = groupIndex.groups.find((g) => g.id === groupId);
    if (group) {
      group.lastActive = new Date().toISOString();
      await this.saveGroupIndex(groupIndex);
    }

    await this.embed.addText(
      `guide:${groupId}:${safeName}`,
      content,
      JSON.stringify({ type: "guide", group: groupId, file: safeName }),
    );

    return path;
  }

  async storeGroupMemory(
    groupId: string,
    category: MemoryCategory,
    content: string,
    tags: string[],
  ): Promise<MemoryEntry> {
    const knowledgeDir = join(this.groupDir(groupId), "knowledge");
    if (!existsSync(knowledgeDir))
      await mkdir(knowledgeDir, { recursive: true });

    const entry: MemoryEntry = {
      id: crypto.randomUUID(),
      project: `group:${groupId}`,
      category,
      content,
      tags,
      createdAt: new Date().toISOString(),
    };

    const filename = `${category}s.md`;
    const path = join(knowledgeDir, filename);
    const line = `\n## ${new Date().toISOString().slice(0, 10)}\n\n${content}\n`;

    if (existsSync(path)) {
      const existing = await readFile(path, "utf-8");
      await writeFile(path, existing + line, "utf-8");
    } else {
      const header = `# ${capitalize(category)}s — group:${groupId}\n`;
      await writeFile(path, header + line, "utf-8");
    }

    await this.embed.addText(
      `gmem:${groupId}:${category}:${entry.createdAt}`,
      content,
      JSON.stringify({ type: "gmemory", group: groupId, category }),
    );

    return entry;
  }

  async recallGroupMemories(
    groupId: string,
    query: string,
    limit = 5,
  ): Promise<{ project: string; category: string; snippet: string; score?: number }[]> {
    const results: { project: string; category: string; snippet: string; score: number }[] = [];
    const q = query.toLowerCase();

    // Search group-level knowledge (keyword)
    const knowledgeDir = join(this.groupDir(groupId), "knowledge");
    if (existsSync(knowledgeDir)) {
      const categories: MemoryCategory[] = ["decision", "learning", "status", "note"];
      for (const cat of categories) {
        const path = join(knowledgeDir, `${cat}s.md`);
        if (!existsSync(path)) continue;
        const content = await readFile(path, "utf-8");
        const sections = content.split(/^## /m).filter(Boolean);
        for (const section of sections) {
          if (section.toLowerCase().includes(q)) {
            results.push({
              project: `group:${groupId}`,
              category: cat,
              snippet: section.trim().slice(0, 300),
              score: 10,
            });
          }
        }
      }
    }

    // Vector search for group memories
    const vecHits = await this.embed.search(query, limit * 2);
    for (const hit of vecHits) {
      try {
        const meta = hit.metadata ? JSON.parse(hit.metadata) : null;
        if (meta?.type === "gmemory" && meta.group === groupId) {
          const vecScore = Math.max(0, 15 * (1 - hit.distance));
          results.push({
            project: `group:${groupId}`,
            category: meta.category,
            snippet: `[semantic match] ${hit.id}`,
            score: vecScore,
          });
        }
      } catch { /* ignore */ }
    }

    // Also search member projects
    const groupIndex = await this.getGroupIndex();
    const group = groupIndex.groups.find((g) => g.id === groupId);
    if (group) {
      for (const pid of group.projectIds) {
        const projectMemories = await this.recallMemories(query, pid, limit);
        results.push(...projectMemories.map((m) => ({ ...m, score: m.score ?? 0 })));
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // --- Onboarding ---

  async scanForProjects(
    rootPath: string,
    depth = 1,
  ): Promise<OnboardCandidate[]> {
    const index = await this.getIndex();
    const registeredPaths = new Set(index.projects.map((p) => p.path));
    const registeredIds = new Set(index.projects.map((p) => p.id));
    const candidates: OnboardCandidate[] = [];

    const scan = async (dir: string, currentDepth: number) => {
      if (currentDepth > depth) return;
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return;
      }

      // Check if this directory itself is a project
      const detected = await this.detectProject(dir);
      if (detected) {
        detected.alreadyRegistered =
          registeredPaths.has(dir) || registeredIds.has(detected.suggestedId);
        candidates.push(detected);
        return; // Don't recurse into detected projects
      }

      // Recurse into subdirectories
      for (const entry of entries) {
        if (entry.startsWith(".") || entry === "node_modules" || entry === "target" || entry === "dist") continue;
        const fullPath = join(dir, entry);
        try {
          const s = await stat(fullPath);
          if (s.isDirectory()) {
            await scan(fullPath, currentDepth + 1);
          }
        } catch {
          continue;
        }
      }
    };

    await scan(rootPath, 0);
    return candidates;
  }

  private async detectProject(dir: string): Promise<OnboardCandidate | null> {
    const hasFile = (name: string) => existsSync(join(dir, name));

    const hasPackageJson = hasFile("package.json");
    const hasCargoToml = hasFile("Cargo.toml");
    const hasGit = hasFile(".git");
    const hasPyproject = hasFile("pyproject.toml");
    const hasGoMod = hasFile("go.mod");

    // Must have at least one project marker
    if (!hasPackageJson && !hasCargoToml && !hasGit && !hasPyproject && !hasGoMod) {
      return null;
    }

    const dirName = basename(dir);
    let suggestedName = dirName;
    let description = "";
    const techStack: string[] = [];
    const modules: string[] = [];
    const tags: string[] = [];

    // Detect from package.json
    if (hasPackageJson) {
      try {
        const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf-8"));
        if (pkg.name) suggestedName = pkg.name.replace(/^@[^/]+\//, "");
        if (pkg.description) description = pkg.description;
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps["react"] || deps["react-dom"]) techStack.push("React");
        if (deps["next"]) techStack.push("Next.js");
        if (deps["vue"]) techStack.push("Vue");
        if (deps["svelte"]) techStack.push("Svelte");
        if (deps["typescript"]) techStack.push("TypeScript");
        if (deps["@anthropic-ai/sdk"]) techStack.push("Anthropic SDK");
        if (deps["@modelcontextprotocol/sdk"]) techStack.push("MCP SDK");
        if (deps["express"] || deps["fastify"] || deps["hono"]) techStack.push("Node.js");
        if (deps["tailwindcss"]) tags.push("tailwind");
        if (deps["@tauri-apps/api"]) techStack.push("Tauri");
        if (deps["vitest"] || deps["jest"]) tags.push("tested");
        if (!techStack.includes("TypeScript") && !techStack.includes("Node.js")) {
          techStack.push("Node.js");
        }
      } catch { /* ignore parse errors */ }
    }

    // Detect from Cargo.toml
    if (hasCargoToml) {
      try {
        const cargo = await readFile(join(dir, "Cargo.toml"), "utf-8");
        techStack.push("Rust");
        const nameMatch = cargo.match(/^name\s*=\s*"(.+)"/m);
        if (nameMatch && !hasPackageJson) suggestedName = nameMatch[1];
        const descMatch = cargo.match(/^description\s*=\s*"(.+)"/m);
        if (descMatch && !description) description = descMatch[1];
        if (cargo.includes("tokio")) techStack.push("tokio");
        if (cargo.includes("[workspace]")) {
          // Detect workspace members
          const membersMatch = cargo.match(/members\s*=\s*\[([\s\S]*?)\]/);
          if (membersMatch) {
            const members = membersMatch[1].match(/"([^"]+)"/g);
            if (members) {
              modules.push(...members.map((m) => m.replace(/"/g, "").replace(/.*\//, "")));
            }
          }
        }
      } catch { /* ignore */ }
    }

    // Detect from pyproject.toml
    if (hasPyproject) {
      try {
        const content = await readFile(join(dir, "pyproject.toml"), "utf-8");
        techStack.push("Python");
        const nameMatch = content.match(/^name\s*=\s*"(.+)"/m);
        if (nameMatch && !hasPackageJson && !hasCargoToml) suggestedName = nameMatch[1];
        const descMatch = content.match(/^description\s*=\s*"(.+)"/m);
        if (descMatch && !description) description = descMatch[1];
        if (content.includes("torch")) techStack.push("PyTorch");
        if (content.includes("fastapi")) techStack.push("FastAPI");
      } catch { /* ignore */ }
    }

    // Detect from go.mod
    if (hasGoMod) {
      techStack.push("Go");
    }

    // Generate a clean ID
    const suggestedId = dirName
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

    // Add generic tags from dir name
    tags.push(...techStack.map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, "")));

    if (!description) {
      description = `${suggestedName} project`;
    }

    return {
      path: dir,
      suggestedId,
      suggestedName,
      description,
      techStack: [...new Set(techStack)],
      modules,
      tags: [...new Set(tags)],
      alreadyRegistered: false,
    };
  }

  // --- Reindex (initial population of vector index) ---

  private async reindexAll(): Promise<void> {
    if (!this.embed.available) return;

    // Index all projects
    const index = await this.getIndex();
    for (const p of index.projects) {
      await this.embed.addText(
        `project:${p.id}`,
        `${p.name} ${p.description} ${p.tags.join(" ")}`,
        JSON.stringify({ type: "project", project: p.id }),
      );
    }

    // Index all groups
    const groupIndex = await this.getGroupIndex();
    for (const g of groupIndex.groups) {
      await this.embed.addText(
        `group:${g.id}`,
        `${g.name} ${g.description} ${g.tags.join(" ")}`,
        JSON.stringify({ type: "group", group: g.id }),
      );

      // Index group guides
      const guidesDir = join(this.groupDir(g.id), "guides");
      if (existsSync(guidesDir)) {
        const files = (await readdir(guidesDir)).filter((f) => f.endsWith(".md"));
        for (const file of files) {
          const content = await readFile(join(guidesDir, file), "utf-8");
          await this.embed.addText(
            `guide:${g.id}:${file}`,
            content,
            JSON.stringify({ type: "guide", group: g.id, file }),
          );
        }
      }
    }

    // Index all memories (split by ## sections)
    for (const proj of index.projects) {
      const knowledgeDir = join(this.projectDir(proj.id), "knowledge");
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
          // Extract date from first line if present
          const dateMatch = section.match(/^(\d{4}-\d{2}-\d{2})/);
          const ts = dateMatch ? dateMatch[1] : `s${i}`;
          await this.embed.addText(
            `memory:${proj.id}:${cat}:${ts}`,
            section,
            JSON.stringify({ type: "memory", project: proj.id, category: cat }),
          );
        }
      }
    }

    // Index group memories
    for (const g of groupIndex.groups) {
      const knowledgeDir = join(this.groupDir(g.id), "knowledge");
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
            `gmem:${g.id}:${cat}:${ts}`,
            section,
            JSON.stringify({ type: "gmemory", group: g.id, category: cat }),
          );
        }
      }
    }
  }

  // --- Helpers ---

  private async readJson<T>(path: string): Promise<T> {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  }

  private async writeJson(path: string, data: unknown): Promise<void> {
    await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function getLastNSections(content: string, n: number): string {
  const sections = content.split(/^## /m).filter(Boolean);
  return sections
    .slice(-n)
    .map((s) => `## ${s}`)
    .join("");
}

function formatSessionMarkdown(session: SessionSummary): string {
  let md = `# Session ${session.date}\n\n`;
  md += `## Summary\n\n${session.summary}\n\n`;

  if (session.nextTasks.length > 0) {
    md += `## Next Tasks\n\n`;
    for (const task of session.nextTasks) {
      md += `- [ ] ${task}\n`;
    }
    md += "\n";
  }

  if (session.decisions.length > 0) {
    md += `## Decisions\n\n`;
    for (const d of session.decisions) {
      md += `- ${d}\n`;
    }
    md += "\n";
  }

  if (session.learnings.length > 0) {
    md += `## Learnings\n\n`;
    for (const l of session.learnings) {
      md += `- ${l}\n`;
    }
    md += "\n";
  }

  return md;
}
