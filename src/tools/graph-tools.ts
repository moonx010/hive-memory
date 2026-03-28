import type { HiveDatabase } from "../db/database.js";
import type { SafeToolFn } from "./index.js";
import { buildGraphRAGSummaries } from "../search/graph-rag.js";

export function registerGraphTools(safeTool: SafeToolFn, db: HiveDatabase): void {
  safeTool(
    "memory_communities",
    "Detect knowledge graph communities and generate GraphRAG-style summaries. Use for global/thematic queries like 'what are the main themes across all our decisions?'",
    {},
    async () => {
      const result = buildGraphRAGSummaries(db);
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
