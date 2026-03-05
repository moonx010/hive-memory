import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SessionSummary } from "../types.js";
import type { ProjectStore } from "./project-store.js";

export class SessionStore {
  constructor(
    private dataDir: string,
    private projectStore: ProjectStore,
  ) {}

  private projectDir(projectId: string): string {
    return join(this.dataDir, "projects", projectId);
  }

  async saveSession(
    projectId: string,
    session: SessionSummary,
  ): Promise<void> {
    const sessionsDir = join(this.projectDir(projectId), "sessions");
    await mkdir(sessionsDir, { recursive: true });
    let filename = `${session.date}.md`;
    if (existsSync(join(sessionsDir, filename))) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      filename = `${session.date}_${ts}.md`;
    }
    const content = formatSessionMarkdown(session);
    await writeFile(join(sessionsDir, filename), content, "utf-8");

    // Update project summary with latest session
    const summary = await this.projectStore.getProjectSummary(projectId);
    if (summary) {
      summary.lastSession = {
        date: session.date,
        summary: session.summary,
        nextTasks: session.nextTasks,
      };
      if (session.nextTasks.length > 0) {
        summary.currentFocus = session.nextTasks[0];
      }
      await this.projectStore.saveProjectSummary(summary);
    }

    // Update lastActive in index
    const index = await this.projectStore.getIndex();
    const proj = index.projects.find((p) => p.id === projectId);
    if (proj) {
      proj.lastActive = new Date().toISOString();
      await this.projectStore.saveIndex(index);
    }
  }
}

export function formatSessionMarkdown(session: SessionSummary): string {
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
