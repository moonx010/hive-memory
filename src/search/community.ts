export interface Community {
  id: string;
  entityIds: string[];
  label: string; // auto-generated from top keywords
  size: number;
}

/**
 * Detect communities in the synapse graph using label propagation.
 *
 * Algorithm:
 * 1. Initialize each entity with its own label
 * 2. Iterate: each entity adopts the most common label among its neighbors
 * 3. Repeat until stable (or max iterations)
 * 4. Group entities by final label → communities
 */
export function detectCommunities(
  entities: Array<{ id: string; keywords: string[] }>,
  synapses: Array<{ source: string; target: string; weight: number }>,
  options?: { maxIterations?: number; minCommunitySize?: number },
): Community[] {
  const maxIterations = options?.maxIterations ?? 10;
  const minSize = options?.minCommunitySize ?? 3;

  // Initialize: each entity = its own label
  const labels = new Map<string, string>();
  for (const e of entities) labels.set(e.id, e.id);

  // Build adjacency list
  const neighbors = new Map<string, Array<{ id: string; weight: number }>>();
  for (const s of synapses) {
    if (!neighbors.has(s.source)) neighbors.set(s.source, []);
    if (!neighbors.has(s.target)) neighbors.set(s.target, []);
    neighbors.get(s.source)!.push({ id: s.target, weight: s.weight });
    neighbors.get(s.target)!.push({ id: s.source, weight: s.weight });
  }

  // Iterate
  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;
    for (const e of entities) {
      const neighs = neighbors.get(e.id) ?? [];
      if (neighs.length === 0) continue;

      // Count label frequencies weighted by synapse weight
      const labelCounts = new Map<string, number>();
      for (const n of neighs) {
        const nl = labels.get(n.id) ?? n.id;
        labelCounts.set(nl, (labelCounts.get(nl) ?? 0) + n.weight);
      }

      // Adopt most common label
      let bestLabel = labels.get(e.id)!;
      let bestCount = 0;
      for (const [l, c] of labelCounts) {
        if (c > bestCount) {
          bestLabel = l;
          bestCount = c;
        }
      }

      if (bestLabel !== labels.get(e.id)) {
        labels.set(e.id, bestLabel);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Group by label
  const groups = new Map<string, string[]>();
  for (const [entityId, label] of labels) {
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(entityId);
  }

  // Filter by min size + generate labels from keywords
  const entityMap = new Map(entities.map((e) => [e.id, e]));
  const communities: Community[] = [];
  let communityIdx = 0;

  for (const [, memberIds] of groups) {
    if (memberIds.length < minSize) continue;

    // Extract top keywords from community members
    const keywordCounts = new Map<string, number>();
    for (const id of memberIds) {
      const e = entityMap.get(id);
      for (const kw of e?.keywords ?? []) {
        keywordCounts.set(kw, (keywordCounts.get(kw) ?? 0) + 1);
      }
    }
    const topKeywords = [...keywordCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([kw]) => kw);

    communities.push({
      id: `community-${communityIdx++}`,
      entityIds: memberIds,
      label: topKeywords.join(", ") || `cluster-${communityIdx}`,
      size: memberIds.length,
    });
  }

  return communities.sort((a, b) => b.size - a.size);
}
