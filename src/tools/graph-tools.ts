import { z } from "zod";
import type { HiveDatabase } from "../db/database.js";
import type { SafeToolFn } from "./index.js";
import { buildGraphRAGSummaries } from "../search/graph-rag.js";
import { resolveACL } from "../acl/resolver.js";

export function registerGraphTools(safeTool: SafeToolFn, db: HiveDatabase): void {
  safeTool(
    "memory_communities",
    "Detect knowledge graph communities and generate GraphRAG-style summaries. Use for global/thematic queries like 'what are the main themes across all our decisions?'",
    {
      org_id: z.string().optional().describe("Scope to organization (tenant isolation)"),
      project: z.string().optional().describe("Scope to project"),
    },
    async (args) => {
      const orgId = args.org_id as string | undefined;
      const project = args.project as string | undefined;
      const acl = resolveACL(db);
      const result = buildGraphRAGSummaries(db, { orgId, project, acl });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );
}
