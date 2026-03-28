import type { HiveDatabase } from "../db/database.js";
import { detectCommunities, type Community } from "./community.js";

export interface GraphRAGResult {
  communities: Array<{
    id: string;
    label: string;
    size: number;
    summary: string;
    topEntities: Array<{ id: string; title: string }>;
  }>;
  globalSummary: string;
}

/**
 * Build community summaries for global/thematic queries.
 * Uses rule-based summarization (no LLM required).
 */
export function buildGraphRAGSummaries(db: HiveDatabase): GraphRAGResult {
  // 1. Load all active entities with keywords
  const entities = db.listEntities({ limit: 1000 }).map((e) => ({
    id: e.id,
    title: e.title ?? e.content.slice(0, 80),
    content: e.content,
    keywords: e.keywords,
    entityType: e.entityType,
  }));

  // 2. Load all synapses
  const allSynapses: Array<{ source: string; target: string; weight: number }> = [];
  for (const e of entities) {
    const synapses = db.getSynapsesByEntry(e.id, "outgoing");
    for (const s of synapses) {
      allSynapses.push({ source: s.source, target: s.target, weight: s.weight });
    }
  }

  // 3. Detect communities
  const communities = detectCommunities(entities, allSynapses);

  // 4. Generate summaries per community
  const entityMap = new Map(entities.map((e) => [e.id, e]));
  const results = communities.map((c: Community) => {
    const members = c.entityIds.map((id) => entityMap.get(id)).filter(Boolean);
    const topEntities = members.slice(0, 5).map((e) => ({ id: e!.id, title: e!.title }));

    // Rule-based summary: entity types + top keywords
    const typeCounts = new Map<string, number>();
    for (const m of members) {
      typeCounts.set(m!.entityType, (typeCounts.get(m!.entityType) ?? 0) + 1);
    }
    const typeStr = [...typeCounts.entries()].map(([t, n]) => `${n} ${t}s`).join(", ");
    const summary = `Community "${c.label}": ${c.size} entities (${typeStr}). Key topics: ${c.label}.`;

    return { id: c.id, label: c.label, size: c.size, summary, topEntities };
  });

  // 5. Global summary
  const globalSummary =
    `Knowledge graph contains ${entities.length} entities in ${communities.length} communities. ` +
    `Top communities: ${communities
      .slice(0, 5)
      .map((c) => `"${c.label}" (${c.size})`)
      .join(", ")}.`;

  return { communities: results, globalSummary };
}
