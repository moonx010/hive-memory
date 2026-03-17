import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectIndex, ProjectEntry, ProjectSummary } from "../types.js";
import { readJson, writeJson } from "./io.js";

export class ProjectStore {
  constructor(private dataDir: string) {}

  private get indexPath(): string {
    return join(this.dataDir, "index.json");
  }

  private projectDir(projectId: string): string {
    return join(this.dataDir, "projects", projectId);
  }

  async getIndex(): Promise<ProjectIndex> {
    return readJson<ProjectIndex>(this.indexPath);
  }

  async saveIndex(index: ProjectIndex): Promise<void> {
    await writeJson(this.indexPath, index);
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

    const scored = index.projects.map((p) => {
      let score = 0;
      if (p.name.toLowerCase().includes(q)) score += 10;
      if (p.id.toLowerCase().includes(q)) score += 10;
      if (p.description.toLowerCase().includes(q)) score += 5;
      for (const tag of p.tags) {
        if (tag.toLowerCase().includes(q)) score += 3;
      }
      const daysSince =
        (Date.now() - new Date(p.lastActive).getTime()) / 86400000;
      if (daysSince < 1) score += 3;
      else if (daysSince < 7) score += 1;
      return { project: p, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.project);
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
  }

  async getProjectSummary(projectId: string): Promise<ProjectSummary | null> {
    const path = join(this.projectDir(projectId), "summary.json");
    if (!existsSync(path)) return null;
    return readJson<ProjectSummary>(path);
  }

  async saveProjectSummary(summary: ProjectSummary): Promise<void> {
    const dir = this.projectDir(summary.id);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeJson(join(dir, "summary.json"), summary);
  }

  async getProjectStatus(projectId: string): Promise<string | null> {
    const path = join(this.projectDir(projectId), "status.md");
    if (!existsSync(path)) return null;
    return readFile(path, "utf-8");
  }
}
