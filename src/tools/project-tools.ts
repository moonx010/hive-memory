import { z } from "zod";
import { isAbsolute } from "node:path";
import type { CortexStore } from "../store.js";
import { validateId } from "../store/io.js";
import type { SafeToolFn } from "./index.js";

export function registerProjectTools(safeTool: SafeToolFn, store: CortexStore) {
  safeTool(
    "project_register",
    "Register or update a project. If the project ID already exists, updates its metadata (upsert).",
    {
      id: z.string().describe("Short unique ID for the project (e.g. 'acme-api', 'dashboard')"),
      name: z.string().describe("Display name (e.g. 'Acme API')"),
      path: z.string().describe("Absolute path to the project directory"),
      description: z.string().describe("One-line description of what the project is"),
      tags: z.array(z.string()).optional().describe("Tags for search (e.g. ['rust', 'dsl', 'compiler'])"),
      techStack: z.array(z.string()).optional().describe("Technologies used (e.g. ['Rust', 'tokio'])"),
      modules: z.array(z.string()).optional().describe("Key modules/components (e.g. ['lexer', 'parser', 'runtime'])"),
      status: z.enum(["active", "paused", "archived"]).optional().describe("Project status (default: active)"),
    },
    async (args) => {
      const id = args.id as string;
      validateId(id);
      const name = args.name as string;
      const path = args.path as string;
      if (!isAbsolute(path)) {
        throw new Error(`Path must be absolute: "${path}"`);
      }
      const description = args.description as string;
      const tags = (args.tags as string[] | undefined) ?? [];
      const techStack = (args.techStack as string[] | undefined) ?? [];
      const modules = (args.modules as string[] | undefined) ?? [];
      const status = (args.status as "active" | "paused" | "archived" | undefined) ?? "active";

      const existing = await store.getProjectSummary(id);
      const isUpdate = !!existing;

      await store.upsertProject({
        id, name, path, description, tags,
        lastActive: new Date().toISOString(),
        status,
      });

      await store.saveProjectSummary({
        id,
        oneLiner: description,
        techStack: techStack.length > 0 ? techStack : (existing?.techStack ?? []),
        modules: modules.length > 0 ? modules : (existing?.modules ?? []),
        currentFocus: existing?.currentFocus ?? "Project just registered",
        lastSession: existing?.lastSession ?? null,
        stats: existing?.stats ?? {},
      });

      const syncResult = await store.syncLocalContext(id);

      const localNote = syncResult
        ? `\n  Local context written to: ${syncResult}`
        : store.localSyncEnabled
          ? `\n  Local context skipped (project directory not found)`
          : `\n  Mode: central-only (local .cortex.md sync disabled)`;
      const verb = isUpdate ? "updated" : "registered";
      return {
        content: [{
          type: "text" as const,
          text: `Project "${name}" (${id}) ${verb}.\n  Path: ${path}\n  Tags: ${tags.join(", ")}${localNote}`,
        }],
      };
    },
  );

  safeTool(
    "project_search",
    "Search for projects by name, description, or tags. Call with empty query to list all projects.",
    {
      query: z.string().describe('Search query — project name, keyword, or description. Empty string returns all projects.'),
      limit: z.number().optional().describe("Max results to return (default 10 for list, 3 for search)"),
    },
    async (args) => {
      const query = (args.query as string).trim();
      const defaultLimit = query === "" ? 50 : 3;
      const limit = (args.limit as number | undefined) ?? defaultLimit;
      const results = await store.searchProjects(query, limit);

      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: query === "" ? "No projects registered yet. Use project_register to add one." : "No matching projects found." }] };
      }

      const lines: string[] = [];
      for (const p of results) {
        const summary = await store.getProjectSummary(p.id);
        const focus = summary?.currentFocus ?? "—";
        const daysSince = Math.floor((Date.now() - new Date(p.lastActive).getTime()) / 86400000);
        const ago = daysSince === 0 ? "today" : `${daysSince}d ago`;
        const statusIcon = p.status === "active" ? "●" : p.status === "paused" ? "○" : "◌";
        lines.push(`${statusIcon} **${p.name}** (${p.id}) — ${ago}\n  ${p.description}\n  Focus: ${focus}`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n\n") }] };
    },
  );

  safeTool(
    "project_status",
    "Get current status and context of a specific project. Returns summary, current focus, recent session, and cross-project insights via semantic search.",
    {
      project: z.string().describe("Project ID"),
      detail: z.enum(["brief", "full"]).optional().describe("brief = summary only, full = summary + status + recent session (default: brief)"),
    },
    async (args) => {
      const projectId = args.project as string;
      validateId(projectId);
      const detail = (args.detail as "brief" | "full" | undefined) ?? "brief";
      const summary = await store.getProjectSummary(projectId);
      if (!summary) {
        return { content: [{ type: "text" as const, text: `Project "${projectId}" not found.` }] };
      }

      let text = `# ${summary.id}\n\n`;
      text += `${summary.oneLiner}\n\n`;
      text += `**Tech**: ${summary.techStack.join(", ")}\n`;
      text += `**Modules**: ${summary.modules.join(", ")}\n`;
      text += `**Current Focus**: ${summary.currentFocus}\n`;

      if (summary.lastSession) {
        text += `\n## Last Session (${summary.lastSession.date})\n\n`;
        text += `${summary.lastSession.summary}\n`;
        if (summary.lastSession.nextTasks.length > 0) {
          text += `\n**Next tasks**:\n`;
          for (const t of summary.lastSession.nextTasks) {
            text += `- ${t}\n`;
          }
        }
      }

      if (detail === "full") {
        const status = await store.getProjectStatus(projectId);
        if (status) {
          text += `\n## Detailed Status\n\n${status}`;
        }
      }

      // Cross-project insights via semantic search (full mode only for performance)
      if (detail === "full") {
        const crossInsights = await store.getCrossProjectContext(projectId);
        if (crossInsights.length > 0) {
          text += `\n## Cross-Project Insights\n\n`;
          for (const insight of crossInsights) {
            const label = insight.source
              ? `${insight.project}/${insight.source}`
              : `${insight.project}/${insight.category ?? "unknown"}`;
            text += `- **[${label}]** ${insight.snippet.slice(0, 200)}\n`;
          }
        }
      }

      return { content: [{ type: "text" as const, text }] };
    },
  );

  safeTool(
    "project_onboard",
    "Scan a directory to discover projects and auto-detect their tech stack. Returns candidates ready for registration.",
    {
      path: z.string().describe("Directory to scan (e.g. '~/Desktop/project')"),
      depth: z.number().optional().describe("How deep to scan subdirectories (default: 2)"),
      register: z.boolean().optional().describe("If true, auto-register all unregistered candidates (default: false — just scan)"),
    },
    async (args) => {
      const scanPath = (args.path as string).replace(/^~/, process.env["HOME"] ?? "");
      const depth = (args.depth as number | undefined) ?? 2;
      const autoRegister = (args.register as boolean | undefined) ?? false;

      const candidates = await store.scanForProjects(scanPath, depth);

      if (candidates.length === 0) {
        return { content: [{ type: "text" as const, text: `No projects detected under ${scanPath}` }] };
      }

      const newCandidates = candidates.filter((c) => !c.alreadyRegistered);
      const existing = candidates.filter((c) => c.alreadyRegistered);

      if (autoRegister && newCandidates.length > 0) {
        for (const c of newCandidates) {
          await store.upsertProject({
            id: c.suggestedId, name: c.suggestedName, path: c.path,
            description: c.description, tags: c.tags,
            lastActive: new Date().toISOString(), status: "active",
          });
          await store.saveProjectSummary({
            id: c.suggestedId, oneLiner: c.description, techStack: c.techStack,
            modules: c.modules, currentFocus: "Just onboarded",
            lastSession: null, stats: {},
          });
          await store.syncLocalContext(c.suggestedId);
          // Scan for agent memory files (MEMORY.md, AGENTS.md, .cursor/rules, etc.)
          await store.scanProjectReferences(c.suggestedId, c.path);
        }

        let text = `Registered ${newCandidates.length} project(s):\n\n`;
        for (const c of newCandidates) {
          text += `- **${c.suggestedName}** (${c.suggestedId}) — ${c.techStack.join(", ")}\n  ${c.path}\n`;
        }
        if (existing.length > 0) {
          text += `\nAlready registered (${existing.length}): ${existing.map((c) => c.suggestedId).join(", ")}`;
        }
        return { content: [{ type: "text" as const, text }] };
      }

      let text = `Found ${candidates.length} project(s) under ${scanPath}:\n\n`;
      if (newCandidates.length > 0) {
        text += `### New (${newCandidates.length})\n\n`;
        for (const c of newCandidates) {
          text += `- **${c.suggestedName}** → id: \`${c.suggestedId}\`\n`;
          text += `  Path: ${c.path}\n`;
          text += `  Tech: ${c.techStack.join(", ") || "unknown"}\n`;
          if (c.modules.length > 0) text += `  Modules: ${c.modules.join(", ")}\n`;
          text += `  Description: ${c.description}\n\n`;
        }
        text += `→ Call project_onboard("${scanPath}", register=true) to register all\n`;
        text += `→ Or project_register(...) individually to customize\n`;
      }
      if (existing.length > 0) {
        text += `\n### Already registered (${existing.length})\n\n`;
        for (const c of existing) {
          text += `- ~~${c.suggestedName}~~ (${c.suggestedId})\n`;
        }
      }

      return { content: [{ type: "text" as const, text }] };
    },
  );
}
