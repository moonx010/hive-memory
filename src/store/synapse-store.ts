import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  Synapse,
  SynapseIndex,
  CoactivationIndex,
  AxonType,
  CellEntry,
} from "../types.js";
import { readJson, writeJson } from "./io.js";
import { extractKeywords, keywordOverlap, getEntryText } from "./hive-index.js";

/** Auto-create semantic synapse when keyword overlap exceeds this */
const SEMANTIC_THRESHOLD = 0.3;
/** Co-activation count needed before auto-creating a Hebbian synapse */
const HEBBIAN_THRESHOLD = 5;
/** Initial weight for auto-created synapses */
const AUTO_WEIGHT = 0.3;
/** LTP increment per potentiation event */
const LTP_DELTA = 0.1;
/** Decay multiplier applied per flush cycle (LTD) */
const LTD_FACTOR = 0.995;
/** Synapses below this weight are pruned */
const PRUNE_THRESHOLD = 0.05;

export class SynapseStore {
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  private get synapsePath(): string {
    return join(this.dataDir, "synapses.json");
  }

  private get coactivationPath(): string {
    return join(this.dataDir, "coactivation.json");
  }

  async loadSynapses(): Promise<SynapseIndex> {
    if (!existsSync(this.synapsePath)) {
      return {
        version: 1,
        synapses: [],
        adjacency: { outgoing: {}, incoming: {} },
      };
    }
    return readJson<SynapseIndex>(this.synapsePath);
  }

  async saveSynapses(index: SynapseIndex): Promise<void> {
    await writeJson(this.synapsePath, index);
  }

  async loadCoactivation(): Promise<CoactivationIndex> {
    if (!existsSync(this.coactivationPath)) {
      return { version: 1, counts: {} };
    }
    return readJson<CoactivationIndex>(this.coactivationPath);
  }

  async saveCoactivation(index: CoactivationIndex): Promise<void> {
    await writeJson(this.coactivationPath, index);
  }

  // ── Synapse CRUD ──

  /**
   * Form a new synapse (create an edge between two entries).
   */
  async formSynapse(
    source: string,
    target: string,
    axon: AxonType,
    weight = AUTO_WEIGHT,
    metadata?: Record<string, string>,
  ): Promise<Synapse> {
    const index = await this.loadSynapses();

    // Check for existing synapse with same source/target/axon
    const existing = index.synapses.find(
      (s) => s.source === source && s.target === target && s.axon === axon,
    );
    if (existing) {
      // Potentiate existing synapse instead
      existing.weight = Math.min(1.0, existing.weight + LTP_DELTA);
      existing.lastPotentiated = new Date().toISOString();
      if (metadata) {
        existing.metadata = { ...existing.metadata, ...metadata };
      }
      await this.saveSynapses(index);
      return existing;
    }

    const now = new Date().toISOString();
    const synapse: Synapse = {
      id: `syn_${randomUUID().slice(0, 12)}`,
      source,
      target,
      axon,
      weight: Math.min(1.0, Math.max(0, weight)),
      formedAt: now,
      lastPotentiated: now,
      ...(metadata ? { metadata } : {}),
    };

    index.synapses.push(synapse);

    // Update adjacency index
    if (!index.adjacency.outgoing[source]) index.adjacency.outgoing[source] = [];
    index.adjacency.outgoing[source].push(synapse.id);

    if (!index.adjacency.incoming[target]) index.adjacency.incoming[target] = [];
    index.adjacency.incoming[target].push(synapse.id);

    await this.saveSynapses(index);
    return synapse;
  }

  /**
   * Get all synapses connected to an entry.
   */
  async getConnections(
    entryId: string,
    direction: "outgoing" | "incoming" | "both" = "both",
    axonType?: AxonType,
  ): Promise<Synapse[]> {
    const index = await this.loadSynapses();
    const synapseIds = new Set<string>();

    if (direction === "outgoing" || direction === "both") {
      for (const id of index.adjacency.outgoing[entryId] ?? []) {
        synapseIds.add(id);
      }
    }
    if (direction === "incoming" || direction === "both") {
      for (const id of index.adjacency.incoming[entryId] ?? []) {
        synapseIds.add(id);
      }
    }

    const synapseMap = new Map(index.synapses.map((s) => [s.id, s]));
    let results = [...synapseIds]
      .map((id) => synapseMap.get(id))
      .filter((s): s is Synapse => s !== undefined);

    if (axonType) {
      results = results.filter((s) => s.axon === axonType);
    }

    return results.sort((a, b) => b.weight - a.weight);
  }

  /**
   * Get neighbor entry IDs reachable from an entry via synapses.
   */
  async getNeighborIds(
    entryId: string,
    direction: "outgoing" | "incoming" | "both" = "both",
  ): Promise<{ neighborId: string; synapse: Synapse }[]> {
    const connections = await this.getConnections(entryId, direction);
    return connections.map((s) => ({
      neighborId: s.source === entryId ? s.target : s.source,
      synapse: s,
    }));
  }

  // ── LTP / LTD (Synaptic Plasticity) ──

  /**
   * Long-Term Potentiation — strengthen a synapse.
   */
  async potentiate(synapseId: string): Promise<void> {
    const index = await this.loadSynapses();
    const synapse = index.synapses.find((s) => s.id === synapseId);
    if (!synapse) return;

    synapse.weight = Math.min(1.0, synapse.weight + LTP_DELTA);
    synapse.lastPotentiated = new Date().toISOString();
    await this.saveSynapses(index);
  }

  /**
   * Long-Term Depression — apply global decay to all synapses.
   * Called during nursery flush cycles.
   * Also prunes synapses below threshold.
   */
  async applyDecay(): Promise<number> {
    const index = await this.loadSynapses();
    const toRemove: string[] = [];

    for (const synapse of index.synapses) {
      synapse.weight *= LTD_FACTOR;
      if (synapse.weight < PRUNE_THRESHOLD) {
        toRemove.push(synapse.id);
      }
    }

    if (toRemove.length > 0) {
      this.removeSynapses(index, toRemove);
    }

    await this.saveSynapses(index);
    return toRemove.length;
  }

  // ── Auto-Synapse Formation (Consolidation) ──

  /**
   * Called when a new entry is stored.
   * Auto-creates synapses based on:
   * 1. Temporal — link to previous entry in same project
   * 2. Semantic — link to entries with high keyword overlap
   */
  async onEntryStored(
    newEntry: CellEntry,
    recentEntries: CellEntry[],
    allEntries: CellEntry[],
  ): Promise<Synapse[]> {
    const formed: Synapse[] = [];
    const newKeywords = extractKeywords(getEntryText(newEntry));

    // 1. Temporal synapse — link to most recent entry in same project
    const sameProject = recentEntries
      .filter((e) => e.project === newEntry.project && e.id !== newEntry.id)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    if (sameProject.length > 0) {
      const prev = sameProject[0];
      const syn = await this.formSynapse(prev.id, newEntry.id, "temporal", AUTO_WEIGHT);
      formed.push(syn);
    }

    // 2. Semantic synapses — link to entries with high keyword overlap
    for (const entry of allEntries) {
      if (entry.id === newEntry.id) continue;

      const entryKeywords = extractKeywords(getEntryText(entry));
      const overlap = keywordOverlap(newKeywords, entryKeywords);

      if (overlap >= SEMANTIC_THRESHOLD) {
        const weight = overlap * 0.7; // Scale weight by overlap strength
        const syn = await this.formSynapse(
          newEntry.id,
          entry.id,
          "semantic",
          weight,
        );
        formed.push(syn);
      }
    }

    // 3. Refinement — same category + same project + high keyword overlap
    if (newEntry.type === "direct") {
      for (const entry of allEntries) {
        if (entry.id === newEntry.id || entry.type !== "direct") continue;
        if (entry.project !== newEntry.project || entry.category !== newEntry.category) continue;

        const entryKeywords = extractKeywords(getEntryText(entry));
        const overlap = keywordOverlap(newKeywords, entryKeywords);

        if (overlap >= 0.5) {
          await this.formSynapse(entry.id, newEntry.id, "refinement", overlap * 0.5);
        }
      }
    }

    return formed;
  }

  // ── Hebbian Learning (Co-activation) ──

  /**
   * Record that entries were co-activated (returned together in search).
   * When count exceeds threshold, auto-create synapse.
   */
  async recordCoactivation(entryIds: string[]): Promise<void> {
    if (entryIds.length < 2) return;

    const coact = await this.loadCoactivation();
    const newSynapses: { a: string; b: string }[] = [];

    for (let i = 0; i < entryIds.length; i++) {
      for (let j = i + 1; j < entryIds.length; j++) {
        const key = [entryIds[i], entryIds[j]].sort().join(":");
        coact.counts[key] = (coact.counts[key] ?? 0) + 1;

        if (coact.counts[key] === HEBBIAN_THRESHOLD) {
          newSynapses.push({ a: entryIds[i], b: entryIds[j] });
        }
      }
    }

    await this.saveCoactivation(coact);

    // Form Hebbian synapses for newly threshold-crossing pairs
    for (const { a, b } of newSynapses) {
      await this.formSynapse(a, b, "semantic", AUTO_WEIGHT, {
        origin: "hebbian",
      });
    }
  }

  // ── Helpers ──

  private removeSynapses(index: SynapseIndex, ids: string[]): void {
    const toRemoveSet = new Set(ids);

    index.synapses = index.synapses.filter((s) => !toRemoveSet.has(s.id));

    // Rebuild adjacency
    for (const key of Object.keys(index.adjacency.outgoing)) {
      index.adjacency.outgoing[key] = index.adjacency.outgoing[key].filter(
        (id) => !toRemoveSet.has(id),
      );
      if (index.adjacency.outgoing[key].length === 0) {
        delete index.adjacency.outgoing[key];
      }
    }
    for (const key of Object.keys(index.adjacency.incoming)) {
      index.adjacency.incoming[key] = index.adjacency.incoming[key].filter(
        (id) => !toRemoveSet.has(id),
      );
      if (index.adjacency.incoming[key].length === 0) {
        delete index.adjacency.incoming[key];
      }
    }
  }

  /**
   * Remove all synapses referencing a deleted entry.
   */
  async removeSynapsesForEntry(entryId: string): Promise<void> {
    const index = await this.loadSynapses();
    const toRemove = index.synapses
      .filter((s) => s.source === entryId || s.target === entryId)
      .map((s) => s.id);

    if (toRemove.length === 0) return;
    this.removeSynapses(index, toRemove);
    await this.saveSynapses(index);
  }

  /**
   * Get synapse stats for diagnostics.
   */
  async getStats(): Promise<{
    totalSynapses: number;
    byAxon: Record<string, number>;
    avgWeight: number;
  }> {
    const index = await this.loadSynapses();
    const byAxon: Record<string, number> = {};
    let totalWeight = 0;

    for (const s of index.synapses) {
      byAxon[s.axon] = (byAxon[s.axon] ?? 0) + 1;
      totalWeight += s.weight;
    }

    return {
      totalSynapses: index.synapses.length,
      byAxon,
      avgWeight: index.synapses.length > 0 ? totalWeight / index.synapses.length : 0,
    };
  }
}
