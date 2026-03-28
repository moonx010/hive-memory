import { z } from "zod";
import type { CortexStore } from "../store.js";
import type { SafeToolFn } from "./index.js";
import type { EntityType } from "../types.js";
import type { EnrichmentStage } from "../enrichment/types.js";
import { resolveACL } from "../acl/resolver.js";

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
      stage: z.enum(["classify", "extract", "stitch", "resolve"]).optional(),
    },
    async ({ scope, entityId, entityType, since, limit, stage }) => {
      const stageValue = stage as EnrichmentStage | undefined;

      if (scope === "entity") {
        if (!entityId) throw new Error("entityId required for scope=entity");
        const results = await store.enrichEntity(entityId as string, { stage: stageValue });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ enriched: results.length, stage: stageValue }),
            },
          ],
        };
      }

      const result = await store.enrichBatch({
        entityType: entityType as EntityType[] | undefined,
        since: since as string | undefined,
        limit: (limit as number | undefined) ?? 100,
        unenrichedOnly: !stageValue, // When stage is specified, don't filter by unenriched
        stage: stageValue,
      });

      // Include a sample of recently enriched entities
      const acl = resolveACL(store.database);
      const sample = store.database.listEntities({
        limit: 5,
        since: new Date(Date.now() - 60000).toISOString(),
        acl,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ...result, stage: stageValue, sample }),
          },
        ],
      };
    },
  );

  safeTool(
    "entity_resolve",
    "Discover cross-source identity matches and merge duplicate person entities",
    {
      action: z.enum(["list_candidates", "merge", "list_aliases"]),
      entityId: z.string(),
      mergeIntoId: z.string().optional(),
      confirmed: z.boolean().optional(),
    },
    async ({ action, entityId, mergeIntoId, confirmed }) => {
      const acl = resolveACL(store.database);
      const entity = store.database.getEntity(entityId as string, acl);
      if (!entity) throw new Error(`Entity not found: ${entityId}`);

      if (action === "list_candidates") {
        const candidates = store.entityResolver.findCandidates(entity);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                entityId,
                entityTitle: entity.title,
                candidates: candidates.map((c) => ({
                  entityId: c.entity.id,
                  title: c.entity.title,
                  source: c.entity.source.system,
                  matchType: c.matchType,
                  confidence: c.confidence,
                })),
              }),
            },
          ],
        };
      }

      if (action === "merge") {
        if (!mergeIntoId)
          throw new Error("mergeIntoId required for action=merge");
        if (confirmed !== true)
          throw new Error("entity_resolve merge requires confirmed: true");
        const result = store.entityResolver.merge(
          mergeIntoId as string,
          entityId as string,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ merged: true, ...result }),
            },
          ],
        };
      }

      if (action === "list_aliases") {
        const aliases = store.entityResolver.getAliases(entityId as string);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ entityId, aliases }),
            },
          ],
        };
      }

      throw new Error(`Unknown action: ${action}`);
    },
  );
}
