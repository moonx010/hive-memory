import { z } from "zod";
import type { CortexStore } from "./store.js";
import type { MemoryCategory } from "./types.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function wrapHandler(handler: ToolHandler): ToolHandler {
  return async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  };
}

export function registerTools(
  server: {
    tool: (
      name: string,
      description: string,
      schema: Record<string, z.ZodType>,
      handler: ToolHandler,
    ) => void;
  },
  store: CortexStore,
) {
  const safeTool = (
    name: string,
    description: string,
    schema: Record<string, z.ZodType>,
    handler: ToolHandler,
  ) => server.tool(name, description, schema, wrapHandler(handler));

  // --- Project Management ---

  safeTool(
    "project_register",
    "Register a new project with Cortex. Call this when starting work on a project for the first time.",
    {
      id: z.string().describe("Short unique ID for the project (e.g. 'acme-api', 'dashboard')"),
      name: z.string().describe("Display name (e.g. 'Acme API')"),
      path: z.string().describe("Absolute path to the project directory"),
      description: z.string().describe("One-line description of what the project is"),
      tags: z.array(z.string()).optional().describe("Tags for search (e.g. ['rust', 'dsl', 'compiler'])"),
      techStack: z.array(z.string()).optional().describe("Technologies used (e.g. ['Rust', 'tokio'])"),
      modules: z.array(z.string()).optional().describe("Key modules/components (e.g. ['lexer', 'parser', 'runtime'])"),
      groupIds: z.array(z.string()).optional().describe("Group IDs to add this project to (e.g. ['web-team'])"),
    },
    async (args) => {
      const id = args.id as string;
      const name = args.name as string;
      const path = args.path as string;
      const description = args.description as string;
      const tags = (args.tags as string[] | undefined) ?? [];
      const techStack = (args.techStack as string[] | undefined) ?? [];
      const modules = (args.modules as string[] | undefined) ?? [];
      const groupIds = (args.groupIds as string[] | undefined) ?? [];

      // Check if already exists
      const existing = await store.getProjectSummary(id);
      if (existing) {
        return { content: [{ type: "text", text: `Project "${id}" already exists. Use project_update to modify it.` }] };
      }

      // Register in index
      await store.upsertProject({
        id,
        name,
        path,
        description,
        tags,
        lastActive: new Date().toISOString(),
        status: "active",
        ...(groupIds.length > 0 ? { groupIds } : {}),
      });

      // Create initial summary
      await store.saveProjectSummary({
        id,
        oneLiner: description,
        techStack,
        modules,
        currentFocus: "Project just registered",
        lastSession: null,
        stats: {},
      });

      // Add to groups (bidirectional)
      for (const gid of groupIds) {
        await store.addProjectToGroup(gid, id);
      }

      // Sync local context
      await store.syncLocalContext(id);

      return {
        content: [{
          type: "text",
          text: `Project "${name}" (${id}) registered.\n  Path: ${path}\n  Tags: ${tags.join(", ")}${groupIds.length > 0 ? `\n  Groups: ${groupIds.join(", ")}` : ""}\n  Local context written to: ${path}/.cortex.md`,
        }],
      };
    },
  );

  safeTool(
    "project_list",
    "List all registered projects, optionally filtered by status. Shows project name, status, last active date, and current focus.",
    {
      status: z.enum(["active", "paused", "archived"]).optional().describe("Filter by status (default: show all)"),
    },
    async (args) => {
      const statusFilter = args.status as "active" | "paused" | "archived" | undefined;
      const projects = await store.listProjects(statusFilter);
      if (projects.length === 0) {
        return { content: [{ type: "text", text: "No projects registered yet. Use project_register to add one." }] };
      }

      const lines: string[] = [];
      for (const p of projects) {
        const summary = await store.getProjectSummary(p.id);
        const focus = summary?.currentFocus ?? "—";
        const daysSince = Math.floor((Date.now() - new Date(p.lastActive).getTime()) / 86400000);
        const ago = daysSince === 0 ? "today" : `${daysSince}d ago`;
        const statusIcon = p.status === "active" ? "●" : p.status === "paused" ? "○" : "◌";
        const groupLabel = p.groupIds && p.groupIds.length > 0 ? `  Groups: ${p.groupIds.join(", ")}` : "";
        lines.push(`${statusIcon} **${p.name}** (${p.id}) — ${ago}\n  ${p.description}\n  Focus: ${focus}${groupLabel}`);
      }

      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    },
  );

  safeTool(
    "project_update",
    "Update a project's metadata (name, description, tags, path) or status (active/paused/archived).",
    {
      project: z.string().describe("Project ID"),
      name: z.string().optional().describe("New display name"),
      description: z.string().optional().describe("New description"),
      tags: z.array(z.string()).optional().describe("New tags (replaces existing)"),
      path: z.string().optional().describe("New project path"),
      status: z.enum(["active", "paused", "archived"]).optional().describe("New status"),
    },
    async (args) => {
      const projectId = args.project as string;
      const updates: Record<string, unknown> = {};
      if (args.name !== undefined) updates.name = args.name;
      if (args.description !== undefined) updates.description = args.description;
      if (args.tags !== undefined) updates.tags = args.tags;
      if (args.path !== undefined) updates.path = args.path;

      let changed = false;
      if (Object.keys(updates).length > 0) {
        changed = await store.updateProjectMeta(
          projectId,
          updates as Partial<Pick<import("./types.js").ProjectEntry, "name" | "description" | "tags" | "path">>,
        );
      }
      if (args.status !== undefined) {
        changed = await store.updateProjectStatus(projectId, args.status as "active" | "paused" | "archived");
      }

      if (!changed) {
        return { content: [{ type: "text", text: `Project "${projectId}" not found.` }] };
      }

      return { content: [{ type: "text", text: `Project "${projectId}" updated.` }] };
    },
  );

  // --- Search & Status ---

  safeTool(
    "project_search",
    "Search for a project by name, description, or tags. Also matches group names — member projects of matching groups get score boosted.",
    {
      query: z.string().describe('Search query — project name, keyword, or description (e.g. "acme-api", "go backend")'),
      limit: z.number().optional().describe("Max results to return (default 3)"),
    },
    async (args) => {
      const query = args.query as string;
      const limit = (args.limit as number | undefined) ?? 3;
      const results = await store.searchProjects(query, limit);
      if (results.length === 0) {
        return { content: [{ type: "text", text: "No matching projects found." }] };
      }
      const text = results
        .map(
          (p) => {
            const groupLabel = p.groupIds && p.groupIds.length > 0 ? `\n  Groups: ${p.groupIds.join(", ")}` : "";
            return `**${p.name}** (${p.id})\n  ${p.description}\n  Tags: ${p.tags.join(", ")}\n  Last active: ${p.lastActive}\n  Path: ${p.path}${groupLabel}`;
          },
        )
        .join("\n\n");
      return { content: [{ type: "text", text }] };
    },
  );

  safeTool(
    "project_status",
    "Get current status and context of a specific project. Returns summary, current focus, and recent session info.",
    {
      project: z.string().describe("Project ID"),
      detail: z.enum(["brief", "full"]).optional().describe("brief = summary only, full = summary + status + recent session (default: brief)"),
    },
    async (args) => {
      const projectId = args.project as string;
      const detail = (args.detail as "brief" | "full" | undefined) ?? "brief";
      const summary = await store.getProjectSummary(projectId);
      if (!summary) {
        return { content: [{ type: "text", text: `Project "${projectId}" not found.` }] };
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

      // Groups section (progressive disclosure — Level 1: hints only)
      const index = await store.getIndex();
      const proj = index.projects.find((p) => p.id === projectId);
      if (proj?.groupIds && proj.groupIds.length > 0) {
        const groupIndex = await store.getGroupIndex();
        text += `\n## Groups\n\n`;
        for (const gid of proj.groupIds) {
          const group = groupIndex.groups.find((g) => g.id === gid);
          if (!group) continue;
          text += `- **${group.name}** (${gid})\n`;
          // Show guide names as hints
          const groupContext = await store.getGroupContext(gid, "brief");
          const guideMatch = groupContext?.match(/^- .+$/gm);
          if (guideMatch && guideMatch.length > 0) {
            const guideNames = guideMatch
              .map((l) => l.replace(/^- /, "").trim())
              .filter((n) => !n.startsWith("**")); // skip member project lines
            if (guideNames.length > 0) {
              text += `  Shared: ${guideNames.join(", ")}\n`;
            }
          }
          text += `  → group_context("${gid}") for details\n`;
        }
      }

      return { content: [{ type: "text", text }] };
    },
  );

  safeTool(
    "memory_store",
    "Store a piece of knowledge, decision, or learning for a project.",
    {
      project: z.string().describe("Project ID"),
      category: z.enum(["decision", "learning", "status", "note"]).describe("Type of memory to store"),
      content: z.string().describe("The content to store"),
      tags: z.array(z.string()).optional().describe("Optional tags for categorization"),
    },
    async (args) => {
      const entry = await store.storeMemory(
        args.project as string,
        args.category as MemoryCategory,
        args.content as string,
        (args.tags as string[] | undefined) ?? [],
      );
      return {
        content: [{ type: "text", text: `Stored ${args.category} for ${args.project} (id: ${entry.id})` }],
      };
    },
  );

  safeTool(
    "memory_recall",
    "Search and recall relevant memories across one or all projects. Use group parameter to search group-level knowledge + all member projects.",
    {
      query: z.string().describe("What to search for"),
      project: z.string().optional().describe("Limit search to a specific project (optional)"),
      group: z.string().optional().describe("Search group-level knowledge + all member projects (optional)"),
      limit: z.number().optional().describe("Max results (default 5)"),
    },
    async (args) => {
      const query = args.query as string;
      const limit = (args.limit as number | undefined) ?? 5;
      const groupId = args.group as string | undefined;

      let results: { project: string; category: string; snippet: string }[];

      if (groupId) {
        results = await store.recallGroupMemories(groupId, query, limit);
      } else {
        results = await store.recallMemories(
          query,
          args.project as string | undefined,
          limit,
        );
      }

      if (results.length === 0) {
        return { content: [{ type: "text", text: "No matching memories found." }] };
      }
      const text = results
        .map((r) => `**[${r.project}/${r.category}]**\n${r.snippet}`)
        .join("\n\n---\n\n");
      return { content: [{ type: "text", text }] };
    },
  );

  safeTool(
    "session_save",
    "Save session progress for a project — what was done and what's next. Call this at the end of a work session.",
    {
      project: z.string().describe("Project ID"),
      summary: z.string().describe("What was accomplished in this session"),
      nextTasks: z.array(z.string()).optional().describe("Tasks to do next"),
      decisions: z.array(z.string()).optional().describe("Decisions made during this session"),
      learnings: z.array(z.string()).optional().describe("Things learned during this session"),
    },
    async (args) => {
      const projectId = args.project as string;
      const today = new Date().toISOString().slice(0, 10);
      await store.saveSession(projectId, {
        date: today,
        summary: args.summary as string,
        nextTasks: (args.nextTasks as string[] | undefined) ?? [],
        decisions: (args.decisions as string[] | undefined) ?? [],
        learnings: (args.learnings as string[] | undefined) ?? [],
      });
      // saveSession already calls syncLocalContext internally
      return {
        content: [
          { type: "text", text: `Session saved for ${projectId} (${today}). ${(args.nextTasks as string[] | undefined)?.length ?? 0} next tasks recorded. Local .cortex.md synced.` },
        ],
      };
    },
  );

  // --- Group Management ---

  safeTool(
    "group_create",
    "Create a new group to organize related projects. Groups enable shared guides, knowledge, and context across member projects.",
    {
      id: z.string().describe("Short unique ID for the group (e.g. 'web-team', 'ml-projects')"),
      name: z.string().describe("Display name (e.g. 'Web Team')"),
      description: z.string().describe("One-line description of the group"),
      tags: z.array(z.string()).optional().describe("Tags for search"),
      projectIds: z.array(z.string()).optional().describe("Initial project IDs to include in this group"),
    },
    async (args) => {
      const id = args.id as string;
      const name = args.name as string;
      const description = args.description as string;
      const tags = (args.tags as string[] | undefined) ?? [];
      const projectIds = (args.projectIds as string[] | undefined) ?? [];

      // Check if already exists
      const existing = await store.getGroupIndex();
      if (existing.groups.some((g) => g.id === id)) {
        return { content: [{ type: "text", text: `Group "${id}" already exists. Use group_update to modify it.` }] };
      }

      const group = await store.createGroup({
        id,
        name,
        description,
        tags,
        projectIds,
      });

      return {
        content: [{
          type: "text",
          text: `Group "${name}" (${id}) created.\n  Members: ${group.projectIds.length} projects\n  Tags: ${tags.join(", ")}\n  Use group_guide_save to add shared guides.`,
        }],
      };
    },
  );

  safeTool(
    "group_list",
    "List all groups with member count and last activity.",
    {},
    async () => {
      const groupIndex = await store.getGroupIndex();
      if (groupIndex.groups.length === 0) {
        return { content: [{ type: "text", text: "No groups yet. Use group_create to add one." }] };
      }

      const lines: string[] = [];
      for (const g of groupIndex.groups) {
        const daysSince = Math.floor(
          (Date.now() - new Date(g.lastActive).getTime()) / 86400000,
        );
        const ago = daysSince === 0 ? "today" : `${daysSince}d ago`;
        lines.push(
          `**${g.name}** (${g.id}) — ${ago}\n  ${g.description}\n  Members: ${g.projectIds.length} projects | Tags: ${g.tags.join(", ")}`,
        );
      }

      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    },
  );

  safeTool(
    "group_update",
    "Update a group's metadata or manage member projects (add/remove).",
    {
      group: z.string().describe("Group ID"),
      name: z.string().optional().describe("New display name"),
      description: z.string().optional().describe("New description"),
      tags: z.array(z.string()).optional().describe("New tags (replaces existing)"),
      addProjects: z.array(z.string()).optional().describe("Project IDs to add to the group"),
      removeProjects: z.array(z.string()).optional().describe("Project IDs to remove from the group"),
    },
    async (args) => {
      const groupId = args.group as string;
      const groupIndex = await store.getGroupIndex();
      const group = groupIndex.groups.find((g) => g.id === groupId);
      if (!group) {
        return { content: [{ type: "text", text: `Group "${groupId}" not found.` }] };
      }

      // Update metadata
      if (args.name !== undefined) group.name = args.name as string;
      if (args.description !== undefined) group.description = args.description as string;
      if (args.tags !== undefined) group.tags = args.tags as string[];
      group.lastActive = new Date().toISOString();
      await store.saveGroupIndex(groupIndex);

      // Add projects
      const addProjects = (args.addProjects as string[] | undefined) ?? [];
      for (const pid of addProjects) {
        await store.addProjectToGroup(groupId, pid);
      }

      // Remove projects
      const removeProjects = (args.removeProjects as string[] | undefined) ?? [];
      for (const pid of removeProjects) {
        await store.removeProjectFromGroup(groupId, pid);
      }

      const changes: string[] = [];
      if (args.name !== undefined || args.description !== undefined || args.tags !== undefined) {
        changes.push("metadata updated");
      }
      if (addProjects.length > 0) changes.push(`${addProjects.length} project(s) added`);
      if (removeProjects.length > 0) changes.push(`${removeProjects.length} project(s) removed`);

      return {
        content: [{ type: "text", text: `Group "${groupId}" updated: ${changes.join(", ") || "no changes"}.` }],
      };
    },
  );

  safeTool(
    "group_context",
    "Get group context with shared guides and member projects. brief = overview + guide list; full = overview + full guide contents + knowledge.",
    {
      group: z.string().describe("Group ID"),
      detail: z.enum(["brief", "full"]).optional().describe("brief = overview + guide names, full = + guide contents + knowledge (default: brief)"),
    },
    async (args) => {
      const groupId = args.group as string;
      const detail = (args.detail as "brief" | "full" | undefined) ?? "brief";
      const context = await store.getGroupContext(groupId, detail);
      if (!context) {
        return { content: [{ type: "text", text: `Group "${groupId}" not found.` }] };
      }
      return { content: [{ type: "text", text: context }] };
    },
  );

  safeTool(
    "group_guide_save",
    "Save a shared guide document for a group (e.g. bedrock-framework.md, design-policy.md). Accessible to all member projects.",
    {
      group: z.string().describe("Group ID"),
      filename: z.string().describe("Guide filename (e.g. 'bedrock-framework' or 'bedrock-framework.md')"),
      content: z.string().describe("Full content of the guide document (Markdown)"),
    },
    async (args) => {
      const groupId = args.group as string;
      const filename = args.filename as string;
      const content = args.content as string;

      const groupIndex = await store.getGroupIndex();
      if (!groupIndex.groups.some((g) => g.id === groupId)) {
        return { content: [{ type: "text", text: `Group "${groupId}" not found.` }] };
      }

      const path = await store.saveGroupGuide(groupId, filename, content);
      return {
        content: [{ type: "text", text: `Guide saved: ${path}\nAccess via group_context("${groupId}", detail="full")` }],
      };
    },
  );

  // --- Onboarding ---

  safeTool(
    "project_onboard",
    "Scan a directory to discover projects and auto-detect their tech stack. Returns candidates ready for registration. Use this when setting up Cortex for an existing workspace.",
    {
      path: z.string().describe("Directory to scan (e.g. '~/Desktop/project')"),
      depth: z.number().optional().describe("How deep to scan subdirectories (default: 2)"),
      register: z.boolean().optional().describe("If true, auto-register all unregistered candidates (default: false — just scan)"),
      groupId: z.string().optional().describe("Group ID to add all discovered projects to"),
    },
    async (args) => {
      const scanPath = (args.path as string).replace(/^~/, process.env["HOME"] ?? "");
      const depth = (args.depth as number | undefined) ?? 2;
      const autoRegister = (args.register as boolean | undefined) ?? false;
      const groupId = args.groupId as string | undefined;

      const candidates = await store.scanForProjects(scanPath, depth);

      if (candidates.length === 0) {
        return { content: [{ type: "text", text: `No projects detected under ${scanPath}` }] };
      }

      const newCandidates = candidates.filter((c) => !c.alreadyRegistered);
      const existing = candidates.filter((c) => c.alreadyRegistered);

      if (autoRegister && newCandidates.length > 0) {
        const registered: string[] = [];
        for (const c of newCandidates) {
          await store.upsertProject({
            id: c.suggestedId,
            name: c.suggestedName,
            path: c.path,
            description: c.description,
            tags: c.tags,
            lastActive: new Date().toISOString(),
            status: "active",
            ...(groupId ? { groupIds: [groupId] } : {}),
          });
          await store.saveProjectSummary({
            id: c.suggestedId,
            oneLiner: c.description,
            techStack: c.techStack,
            modules: c.modules,
            currentFocus: "Just onboarded",
            lastSession: null,
            stats: {},
          });
          if (groupId) {
            await store.addProjectToGroup(groupId, c.suggestedId);
          }
          registered.push(c.suggestedId);
        }

        let text = `Registered ${registered.length} project(s):\n\n`;
        for (const c of newCandidates) {
          text += `- **${c.suggestedName}** (${c.suggestedId}) — ${c.techStack.join(", ")}\n  ${c.path}\n`;
        }
        if (existing.length > 0) {
          text += `\nAlready registered (${existing.length}): ${existing.map((c) => c.suggestedId).join(", ")}`;
        }
        return { content: [{ type: "text", text }] };
      }

      // Just scan — return candidates for review
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

      return { content: [{ type: "text", text }] };
    },
  );
}
