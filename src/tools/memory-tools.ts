import { z } from "zod";
import type { CortexStore } from "../store.js";
import type { MemoryCategory, AxonType } from "../types.js";
import { validateId } from "../store/io.js";
import type { SafeToolFn } from "./index.js";
import { getCurrentRequestContext } from "../request-context.js";
import { agenticRetrieve } from "../search/agentic-retrieval.js";

export function registerMemoryTools(safeTool: SafeToolFn, store: CortexStore) {
  safeTool(
    "memory_store",
    "Store knowledge that is NOT derivable from git history. Good: decisions with rationale (WHY not WHAT), verbal/meeting agreements, cross-project insights, people/ownership context, debugging dead-ends worth remembering, design trade-offs considered but rejected. Bad: 'added feature X' or 'fixed bug Y' — git log already has those.",
    {
      project: z.string().describe("Project ID"),
      category: z.enum(["decision", "learning", "status", "note"]).describe("Type of memory to store"),
      content: z.string().describe("The content to store — focus on context, rationale, and information that cannot be recovered from code or git history"),
      tags: z.array(z.string()).optional().describe("Optional tags for categorization"),
      agent: z.string().optional().describe("Agent identity (e.g. 'claude', 'codex') — tracks which agent stored this memory"),
    },
    async (args) => {
      validateId(args.project as string);
      // If a user is authenticated, use their name as the author (entity attribution).
      const agentArg = args.agent as string | undefined;
      const resolvedAgent = getCurrentRequestContext().userName ?? agentArg;
      const entry = await store.storeMemory(
        args.project as string,
        args.category as MemoryCategory,
        args.content as string,
        (args.tags as string[] | undefined) ?? [],
        resolvedAgent,
      );
      return {
        content: [{ type: "text" as const, text: `Stored ${args.category} for ${args.project} (id: ${entry.id})${resolvedAgent ? ` [agent: ${resolvedAgent}]` : ""}` }],
      };
    },
  );

  safeTool(
    "memory_recall",
    "Search and recall relevant memories using keyword matching + graph traversal (spreading activation). Returns memories found via both direct keyword match and synaptic connections.",
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
          const depthTag = r.graphDepth !== undefined && r.graphDepth > 0
            ? ` 🔗depth:${r.graphDepth}`
            : "";
          if (r.source) {
            return `**[${r.project}/${r.source}]** (reference)${depthTag}\n${r.snippet}${r.path ? `\nPath: ${r.path}` : ""}`;
          }
          const agentTag = r.agent ? ` (agent: ${r.agent})` : "";
          const conflictTag = r.conflict ? " ⚠️CONFLICT" : "";
          return `**[${r.project}/${r.category ?? "unknown"}]**${agentTag}${conflictTag}${depthTag}\n${r.snippet}`;
        })
        .join("\n\n---\n\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );

  safeTool(
    "memory_link",
    "Form a synapse (explicit connection) between two memory entries. Creates a directed, weighted edge in the memory graph.",
    {
      source: z.string().describe("Source entry ID (pre-synaptic)"),
      target: z.string().describe("Target entry ID (post-synaptic)"),
      axon: z.enum(["temporal", "causal", "semantic", "refinement", "conflict", "dependency", "derived"])
        .describe("Type of connection: temporal (A→B in time), causal (A caused B), semantic (related topic), refinement (B updates A), conflict (A contradicts B), dependency (B depends on A), derived (B came from A)"),
      weight: z.number().optional().describe("Connection strength 0.0-1.0 (default 0.3)"),
      metadata: z.record(z.string(), z.string()).optional().describe("Optional key-value metadata about this connection"),
    },
    async (args) => {
      const synapse = await store.formSynapse(
        args.source as string,
        args.target as string,
        args.axon as AxonType,
        args.weight as number | undefined,
        args.metadata as Record<string, string> | undefined,
      );
      return {
        content: [{
          type: "text" as const,
          text: `Synapse formed: ${synapse.source} —[${synapse.axon}:${synapse.weight.toFixed(2)}]→ ${synapse.target} (id: ${synapse.id})`,
        }],
      };
    },
  );

  safeTool(
    "memory_traverse",
    "Deep graph traversal using spreading activation. Finds memories connected through synaptic pathways that keyword search alone wouldn't find. Best for exploring related context across projects.",
    {
      query: z.string().describe("Starting query to find seed memories"),
      project: z.string().optional().describe("Limit to a specific project"),
      depth: z.number().optional().describe("Max graph traversal depth (default 3)"),
      decay: z.number().optional().describe("Signal decay per hop, 0.0-1.0 (default 0.5)"),
      limit: z.number().optional().describe("Max results (default 10)"),
    },
    async (args) => {
      const projectId = args.project as string | undefined;
      if (projectId) validateId(projectId);

      const results = await store.traverseMemories(
        args.query as string,
        projectId,
        (args.limit as number | undefined) ?? 10,
        (args.depth as number | undefined) ?? 3,
        (args.decay as number | undefined) ?? 0.5,
      );

      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: "No memories found via graph traversal." }] };
      }

      const text = results
        .map((r) => {
          const depth = r.graphDepth !== undefined ? ` [depth:${r.graphDepth}]` : "";
          if (r.source) {
            return `**[${r.project}/${r.source}]**${depth}\n${r.snippet}`;
          }
          return `**[${r.project}/${r.category ?? "unknown"}]**${depth}\n${r.snippet}`;
        })
        .join("\n\n---\n\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );

  safeTool(
    "memory_deep_search",
    "Deep multi-step search with query rewriting and agentic retrieval. Use for complex questions that need multiple search passes.",
    {
      query: z.string().describe("The complex query to search for"),
      max_steps: z.number().optional().describe("Maximum number of retrieval steps (default 3)"),
    },
    async (args) => {
      const query = args.query as string;
      const maxSteps = (args.max_steps as number | undefined) ?? 3;
      const db = store.database;

      // Resolve ACL for the current request
      const { resolveACL } = await import("../acl/resolver.js");
      const acl = resolveACL(db);
      const result = await agenticRetrieve(query, db, { maxSteps, acl });

      if (result.finalResults.length === 0) {
        return { content: [{ type: "text" as const, text: "No matching memories found." }] };
      }

      const stepsText = result.steps
        .map((s, i) => `Step ${i + 1} [${s.query}] → ${s.results.length} results (${s.reasoning})`)
        .join("\n");

      const resultsText = result.finalResults
        .map((e, i) => {
          const title = e.title ? `**${e.title}**\n` : "";
          return `${i + 1}. ${title}${e.content.slice(0, 300)}`;
        })
        .join("\n\n---\n\n");

      const text = `## Search Steps\n${stepsText}\n\n## Results (${result.finalResults.length})\n\n${resultsText}`;
      return { content: [{ type: "text" as const, text }] };
    },
  );

  safeTool(
    "memory_supersede",
    "Mark an entity as superseded by a newer entity. The old entity remains in the graph but is excluded from search by default. Use when a fact has been updated or replaced.",
    {
      old_id: z.string().describe("ID of the entity being superseded (the old/outdated fact)"),
      new_id: z.string().describe("ID of the entity that supersedes it (the new/updated fact)"),
      reason: z.string().optional().describe("Optional reason for supersession"),
    },
    async (args) => {
      const oldId = args.old_id as string;
      const newId = args.new_id as string;
      const reason = args.reason as string | undefined;

      const db = store.database;
      const oldEntity = db.getEntity(oldId);
      const newEntity = db.getEntity(newId);

      if (!oldEntity) {
        return { content: [{ type: "text" as const, text: `Error: Entity not found: ${oldId}` }], isError: true };
      }
      if (!newEntity) {
        return { content: [{ type: "text" as const, text: `Error: Entity not found: ${newId}` }], isError: true };
      }

      db.supersede(oldId, newId);

      const reasonText = reason ? ` Reason: ${reason}` : "";
      return {
        content: [{
          type: "text" as const,
          text: `Superseded: ${oldId} → ${newId}.${reasonText}\nOld entity marked with valid_to and status=superseded. Refinement synapse created.`,
        }],
      };
    },
  );

  safeTool(
    "memory_connections",
    "View the synaptic connections of a specific memory entry. Shows how a memory is linked to other memories in the graph.",
    {
      entry_id: z.string().describe("The memory entry ID to inspect"),
      direction: z.enum(["outgoing", "incoming", "both"]).optional().describe("Which connections to show (default: both)"),
      axon_type: z.enum(["temporal", "causal", "semantic", "refinement", "conflict", "dependency", "derived"]).optional()
        .describe("Filter by connection type"),
    },
    async (args) => {
      const connections = await store.getConnections(
        args.entry_id as string,
        (args.direction as "outgoing" | "incoming" | "both" | undefined) ?? "both",
        args.axon_type as AxonType | undefined,
      );

      if (connections.length === 0) {
        return { content: [{ type: "text" as const, text: "No synaptic connections found for this entry." }] };
      }

      const lines = connections.map((s) => {
        const dir = s.source === args.entry_id ? "→" : "←";
        const other = s.source === args.entry_id ? s.target : s.source;
        return `${dir} **${s.axon}** (w:${s.weight.toFixed(2)}) ${other} | formed: ${s.formedAt.slice(0, 10)}`;
      });

      const stats = await store.getSynapseStats();
      const footer = `\n---\nGraph: ${stats.totalSynapses} synapses | avg weight: ${stats.avgWeight.toFixed(3)}`;

      return {
        content: [{ type: "text" as const, text: lines.join("\n") + footer }],
      };
    },
  );
}
