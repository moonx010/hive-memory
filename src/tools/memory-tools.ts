import { z } from "zod";
import type { CortexStore } from "../store.js";
import type { MemoryCategory } from "../types.js";
import { validateId } from "../store/io.js";
import type { SafeToolFn } from "./index.js";

export function registerMemoryTools(safeTool: SafeToolFn, store: CortexStore) {
  safeTool(
    "memory_store",
    "Store a piece of knowledge, decision, or learning for a project.",
    {
      project: z.string().describe("Project ID"),
      category: z.enum(["decision", "learning", "status", "note"]).describe("Type of memory to store"),
      content: z.string().describe("The content to store"),
      tags: z.array(z.string()).optional().describe("Optional tags for categorization"),
      agent: z.string().optional().describe("Agent identity (e.g. 'claude', 'codex') — tracks which agent stored this memory"),
    },
    async (args) => {
      validateId(args.project as string);
      const entry = await store.storeMemory(
        args.project as string,
        args.category as MemoryCategory,
        args.content as string,
        (args.tags as string[] | undefined) ?? [],
        args.agent as string | undefined,
      );
      return {
        content: [{ type: "text" as const, text: `Stored ${args.category} for ${args.project} (id: ${entry.id})${args.agent ? ` [agent: ${args.agent}]` : ""}` }],
      };
    },
  );

  safeTool(
    "memory_recall",
    "Search and recall relevant memories across one or all projects using semantic + keyword search.",
    {
      query: z.string().describe("What to search for"),
      project: z.string().optional().describe("Limit search to a specific project (optional)"),
      limit: z.number().optional().describe("Max results (default 5)"),
      agent: z.string().optional().describe("Filter results by agent identity (e.g. 'claude', 'codex')"),
    },
    async (args) => {
      const query = args.query as string;
      const limit = (args.limit as number | undefined) ?? 5;
      const projectId = args.project as string | undefined;
      const agentId = args.agent as string | undefined;
      if (projectId) validateId(projectId);

      const results = await store.recallMemories(query, projectId, limit, agentId);

      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: "No matching memories found." }] };
      }
      const text = results
        .map((r) => {
          if (r.source) {
            // Reference entry
            return `**[${r.project}/${r.source}]** (reference)\n${r.snippet}${r.path ? `\nPath: ${r.path}` : ""}`;
          }
          // Direct entry
          const agentTag = r.agent ? ` (agent: ${r.agent})` : "";
          return `**[${r.project}/${r.category ?? "unknown"}]**${agentTag}\n${r.snippet}`;
        })
        .join("\n\n---\n\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );
}
