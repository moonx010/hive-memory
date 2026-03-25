import { z } from "zod";
import type { CortexStore } from "../store.js";
import type { SafeToolFn } from "./index.js";
import type { EntityType } from "../types.js";

export function registerContextTools(
  safeTool: SafeToolFn,
  store: CortexStore,
): void {
  safeTool(
    "context_enrich",
    "Enrich entities with extracted metadata, classifications, and inferred relationships",
    {
      scope: z.enum(["entity", "batch"]),
      entityId: z.string().optional(),
      entityType: z.array(z.string()).optional(),
      since: z.string().optional(),
      limit: z.number().int().positive().max(500).optional(),
    },
    async ({ scope, entityId, entityType, since, limit }) => {
      if (scope === "entity") {
        if (!entityId) throw new Error("entityId required for scope=entity");
        const results = await store.enrichEntity(entityId as string);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ enriched: results.length }),
            },
          ],
        };
      }

      const result = await store.enrichBatch({
        entityType: entityType as EntityType[] | undefined,
        since: since as string | undefined,
        limit: (limit as number | undefined) ?? 100,
        unenrichedOnly: true,
      });

      // Include a sample of recently enriched entities
      const sample = store.database.listEntities({
        limit: 5,
        since: new Date(Date.now() - 60000).toISOString(),
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ...result, sample }),
          },
        ],
      };
    },
  );
}
