import type { CellEntry } from "../types.js";
import type { SynapseStore } from "./synapse-store.js";
import type { HiveStore } from "./hive-store.js";

export interface ActivationResult {
  entryId: string;
  activation: number;
  /** The path of synapse IDs that led to this activation */
  path: string[];
  /** How many hops from the seed */
  depth: number;
}

/**
 * Spreading Activation — brain-inspired graph traversal.
 *
 * Starting from seed entries, propagate activation through the synapse graph.
 * Signal decays with each hop (like neural signal attenuation).
 * Only synapses with sufficient weight carry the signal forward.
 *
 * Algorithm:
 * 1. Seeds get activation = 1.0
 * 2. For each depth level:
 *    - For each activated entry, follow outgoing + incoming synapses
 *    - Signal = parent_activation × synapse_weight × decay
 *    - Only propagate if signal > threshold
 * 3. Return all activated entries sorted by activation score
 */
export async function spreadingActivation(
  seeds: string[],
  synapseStore: SynapseStore,
  options: {
    maxDepth?: number;
    decay?: number;
    threshold?: number;
    maxResults?: number;
  } = {},
): Promise<ActivationResult[]> {
  const maxDepth = options.maxDepth ?? 2;
  const decay = options.decay ?? 0.5;
  const threshold = options.threshold ?? 0.1;
  const maxResults = options.maxResults ?? 20;

  // Activation map: entryId → { activation, path, depth }
  const activations = new Map<
    string,
    { activation: number; path: string[]; depth: number }
  >();

  // Initialize seeds
  for (const seedId of seeds) {
    activations.set(seedId, { activation: 1.0, path: [], depth: 0 });
  }

  let frontier = [...seeds];

  for (let depth = 1; depth <= maxDepth; depth++) {
    const nextFrontier: string[] = [];

    for (const entryId of frontier) {
      const current = activations.get(entryId);
      if (!current) continue;

      // Get all neighbors (both directions — synapses are traversable both ways)
      const neighbors = await synapseStore.getNeighborIds(entryId, "both");

      for (const { neighborId, synapse } of neighbors) {
        const signal = current.activation * synapse.weight * decay;

        if (signal < threshold) continue;

        const existing = activations.get(neighborId);
        if (existing && existing.activation >= signal) continue;

        // Update activation (keep highest signal)
        activations.set(neighborId, {
          activation: signal,
          path: [...current.path, synapse.id],
          depth,
        });

        nextFrontier.push(neighborId);
      }
    }

    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  // Convert to sorted results (exclude seeds from results)
  const seedSet = new Set(seeds);
  return [...activations.entries()]
    .filter(([id]) => !seedSet.has(id))
    .map(([entryId, data]) => ({
      entryId,
      activation: data.activation,
      path: data.path,
      depth: data.depth,
    }))
    .sort((a, b) => b.activation - a.activation)
    .slice(0, maxResults);
}

/**
 * Resolve activated entry IDs to actual CellEntry objects.
 */
export async function resolveActivatedEntries(
  results: ActivationResult[],
  hiveStore: HiveStore,
): Promise<{ entry: CellEntry; activation: number; path: string[]; depth: number }[]> {
  // Load all entries (nursery + cells)
  const allEntries = await hiveStore.getAllEntries();
  const entryMap = new Map(allEntries.map((e) => [e.id, e]));

  return results
    .map((r) => {
      const entry = entryMap.get(r.entryId);
      if (!entry) return null;
      return {
        entry,
        activation: r.activation,
        path: r.path,
        depth: r.depth,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
}
