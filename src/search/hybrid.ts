import type { Entity } from "../types.js";
import type { VectorSearchResult } from "./vector-store.js";

export interface ScoredResult {
  entity: Entity;
  score: number;
  sources: Array<"bm25" | "vector">;
}

/**
 * Reciprocal Rank Fusion — merge BM25 and vector ranked lists.
 * k=60 is the standard constant that limits the influence of rank position.
 */
export function rrfFusion(
  bm25Results: Entity[],
  vectorResults: VectorSearchResult[],
  allEntities: Map<string, Entity>,
  k = 60,
  limit = 20,
): ScoredResult[] {
  const scores = new Map<
    string,
    { score: number; sources: Array<"bm25" | "vector">; entity: Entity }
  >();

  // BM25 ranked list
  for (let i = 0; i < bm25Results.length; i++) {
    const entity = bm25Results[i];
    scores.set(entity.id, {
      score: 1 / (k + i + 1),
      sources: ["bm25"],
      entity,
    });
  }

  // Vector ranked list
  for (let i = 0; i < vectorResults.length; i++) {
    const { entityId } = vectorResults[i];
    const existing = scores.get(entityId);
    if (existing) {
      existing.score += 1 / (k + i + 1);
      existing.sources.push("vector");
    } else {
      const entity = allEntities.get(entityId);
      if (entity) {
        scores.set(entityId, {
          score: 1 / (k + i + 1),
          sources: ["vector"],
          entity,
        });
      }
    }
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entity, score, sources }) => ({ entity, score, sources }));
}

/**
 * Generate a contextual prefix for an entity to improve embedding quality.
 * This prefix is prepended to content before embedding — it gives the model
 * structural context about the entity type, project, and tags.
 */
export function generateContextPrefix(entity: Entity): string {
  const parts: string[] = [];
  if (entity.source?.connector) parts.push(`Source: ${entity.source.connector}`);
  if (entity.entityType) parts.push(`Type: ${entity.entityType}`);
  if (entity.project) parts.push(`Project: ${entity.project}`);
  if (entity.tags?.length) parts.push(`Tags: ${entity.tags.join(", ")}`);
  if (parts.length === 0) return "";
  return parts.join(". ") + ". ";
}

/**
 * Build text for embedding from an entity.
 * Concatenates contextual prefix + title + content.
 */
export function buildEmbedText(entity: Entity): string {
  const prefix = generateContextPrefix(entity);
  const title = entity.title ? `${entity.title}\n` : "";
  return prefix + title + entity.content;
}
