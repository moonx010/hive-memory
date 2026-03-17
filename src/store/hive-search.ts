import type { HiveIndex, CellEntry, DirectEntry } from "../types.js";
import type { HiveStore } from "./hive-store.js";
import type { SynapseStore } from "./synapse-store.js";
import {
  extractKeywords,
  keywordOverlap,
  getEntryText,
} from "./hive-index.js";
import { spreadingActivation } from "./activation.js";

/** 30 days in milliseconds */
const STATUS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface HiveSearchResult {
  project: string;
  category?: string;
  agent?: string;
  source?: string;
  path?: string;
  snippet: string;
  score: number;
  conflict?: boolean;
  /** Entry ID — exposed for synapse linking */
  entryId?: string;
  /** Graph depth (if found via spreading activation) */
  graphDepth?: number;
}

export interface HiveSearchOptions {
  project?: string;
  category?: string;
  agent?: string;
  limit?: number;
}

const BEAM_WIDTH = 3;

export class HiveSearch {
  constructor(
    private hiveStore: HiveStore,
    private synapseStore: SynapseStore,
  ) {}

  async search(
    query: string,
    options: HiveSearchOptions = {},
  ): Promise<HiveSearchResult[]> {
    const limit = options.limit ?? 5;
    const queryKeywords = extractKeywords(query);

    const hive = await this.hiveStore.loadHive();
    const now = Date.now();

    // Collect all candidate entries from nursery + leaf cells
    const allEntries: CellEntry[] = [...hive.nursery];

    // 1. Beam search through tree to find relevant leaf cells (keyword-based)
    const leafCellIds = this.beamSearch(hive, queryKeywords);

    for (const cellId of leafCellIds) {
      const cellData = await this.hiveStore.loadCellData(cellId);
      allEntries.push(...cellData.entries);
    }

    // 2. Filter out expired status entries (TTL: 30 days)
    const liveEntries = allEntries.filter((entry) => {
      if (
        entry.type === "direct" &&
        entry.category === "status" &&
        now - new Date(entry.createdAt).getTime() > STATUS_TTL_MS
      ) {
        return false;
      }
      return true;
    });

    // 3. Score entries by keyword matching
    const paired: { result: HiveSearchResult; entry: CellEntry }[] = [];
    for (const entry of liveEntries) {
      const score = this.scoreEntry(entry, queryKeywords);
      if (score > 0) {
        paired.push({ result: this.entryToResult(entry, score), entry });
      }
    }

    // 4. Apply filters
    let filteredPairs = paired;
    if (options.project) {
      filteredPairs = filteredPairs.filter((p) => p.result.project === options.project);
    }
    if (options.category) {
      filteredPairs = filteredPairs.filter(
        (p) => p.result.category === options.category,
      );
    }
    if (options.agent) {
      filteredPairs = filteredPairs.filter((p) => p.result.agent === options.agent);
    }

    // 5. Get keyword seed entry IDs for spreading activation
    const keywordSeedIds = filteredPairs
      .sort((a, b) => b.result.score - a.result.score)
      .slice(0, 3)
      .map((p) => p.entry.id);

    // 6. Spreading activation — find graph-connected entries
    let graphResults: HiveSearchResult[] = [];
    if (keywordSeedIds.length > 0) {
      const activated = await spreadingActivation(keywordSeedIds, this.synapseStore, {
        maxDepth: 2,
        decay: 0.5,
        threshold: 0.1,
        maxResults: limit * 2,
      });

      // Resolve activated entries
      const allEntriesForLookup = await this.hiveStore.getAllEntries();
      const entryMap = new Map(allEntriesForLookup.map((e) => [e.id, e]));

      for (const act of activated) {
        const entry = entryMap.get(act.entryId);
        if (!entry) continue;

        // Apply same filters
        if (options.project && entry.project !== options.project) continue;
        if (options.category && entry.type === "direct" && entry.category !== options.category) continue;
        if (options.agent && entry.type === "direct" && entry.agentId !== options.agent) continue;

        // Skip expired status
        if (
          entry.type === "direct" &&
          entry.category === "status" &&
          now - new Date(entry.createdAt).getTime() > STATUS_TTL_MS
        ) continue;

        const result = this.entryToResult(entry, act.activation * 10);
        result.graphDepth = act.depth;
        graphResults.push(result);
      }
    }

    // 7. RRF fusion — merge keyword results and graph results
    const keywordRanked = filteredPairs
      .map((p) => p.result)
      .sort((a, b) => b.score - a.score);

    const merged = this.rrfFusion(keywordRanked, graphResults, limit);

    // 8. Record co-activation for Hebbian learning
    const coactIds = merged
      .filter((r) => r.entryId)
      .map((r) => r.entryId!);
    if (coactIds.length >= 2) {
      this.synapseStore.recordCoactivation(coactIds).catch(() => {});
    }

    // 9. Detect conflicts
    this.detectConflicts(merged, liveEntries);

    return merged.slice(0, limit);
  }

  /**
   * Search specifically for graph traversal (used by memory_traverse tool).
   * Keyword seed → spreading activation only.
   */
  async traverse(
    query: string,
    options: HiveSearchOptions & { depth?: number; decay?: number } = {},
  ): Promise<HiveSearchResult[]> {
    const limit = options.limit ?? 10;
    const queryKeywords = extractKeywords(query);

    // Find seed entries via keyword search
    const hive = await this.hiveStore.loadHive();
    const allEntries: CellEntry[] = [...hive.nursery];
    const leafCellIds = this.beamSearch(hive, queryKeywords);
    for (const cellId of leafCellIds) {
      const cellData = await this.hiveStore.loadCellData(cellId);
      allEntries.push(...cellData.entries);
    }

    // Score and get top seeds
    const scored = allEntries
      .map((entry) => ({ entry, score: this.scoreEntry(entry, queryKeywords) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    // Apply filters
    let filtered = scored;
    if (options.project) {
      filtered = filtered.filter((s) => s.entry.project === options.project);
    }

    const seedIds = filtered.slice(0, 3).map((s) => s.entry.id);
    if (seedIds.length === 0) return [];

    // Spreading activation
    const activated = await spreadingActivation(seedIds, this.synapseStore, {
      maxDepth: options.depth ?? 3,
      decay: options.decay ?? 0.5,
      threshold: 0.05,
      maxResults: limit * 2,
    });

    // Resolve and build results
    const entryMap = new Map(allEntries.map((e) => [e.id, e]));
    // Also load entries not in the keyword results
    const allEntriesFull = await this.hiveStore.getAllEntries();
    for (const e of allEntriesFull) {
      if (!entryMap.has(e.id)) entryMap.set(e.id, e);
    }

    const results: HiveSearchResult[] = [];

    // Include seeds first
    for (const s of filtered.slice(0, 3)) {
      const result = this.entryToResult(s.entry, s.score);
      result.graphDepth = 0;
      results.push(result);
    }

    // Then activated entries
    for (const act of activated) {
      const entry = entryMap.get(act.entryId);
      if (!entry) continue;
      if (options.project && entry.project !== options.project) continue;

      const result = this.entryToResult(entry, act.activation * 10);
      result.graphDepth = act.depth;
      results.push(result);
    }

    return results.slice(0, limit);
  }

  private beamSearch(
    hive: HiveIndex,
    queryKeywords: string[],
  ): string[] {
    // Find root cells (cells not referenced as children of any branch)
    const childIds = new Set<string>();
    for (const cell of Object.values(hive.cells)) {
      if (cell.type === "branch") {
        for (const childId of cell.children) {
          childIds.add(childId);
        }
      }
    }

    let currentIds = Object.keys(hive.cells).filter(
      (id) => !childIds.has(id),
    );

    if (currentIds.length === 0) return [];

    const leafResults: string[] = [];

    while (currentIds.length > 0) {
      // Score and rank by keyword overlap
      const scored = currentIds.map((id) => {
        const cell = hive.cells[id];
        if (!cell) return { id, score: 0 };
        const score = keywordOverlap(queryKeywords, cell.keywords);
        return { id, score };
      });

      scored.sort((a, b) => b.score - a.score);
      const topCandidates = scored.slice(0, BEAM_WIDTH);

      const nextIds: string[] = [];

      for (const { id } of topCandidates) {
        const cell = hive.cells[id];
        if (!cell) continue;

        if (cell.type === "leaf") {
          leafResults.push(id);
        } else if (cell.type === "branch") {
          nextIds.push(...cell.children);
        }
      }

      currentIds = nextIds;
    }

    return leafResults;
  }

  private scoreEntry(
    entry: CellEntry,
    queryKeywords: string[],
  ): number {
    let score = 0;

    // Keyword match on text
    const text = getEntryText(entry).toLowerCase();
    for (const kw of queryKeywords) {
      if (text.includes(kw)) score += 3;
    }

    // Tag match
    for (const tag of entry.tags) {
      if (queryKeywords.includes(tag.toLowerCase())) score += 2;
    }

    // Project name match
    for (const kw of queryKeywords) {
      if (entry.project.toLowerCase().includes(kw)) score += 1;
    }

    return score;
  }

  /**
   * Reciprocal Rank Fusion — merge keyword and graph results.
   */
  private rrfFusion(
    keywordResults: HiveSearchResult[],
    graphResults: HiveSearchResult[],
    limit: number,
  ): HiveSearchResult[] {
    const k = 60; // standard RRF constant
    const scoreMap = new Map<string, { score: number; result: HiveSearchResult }>();

    // Keyword rank scores
    for (let i = 0; i < keywordResults.length; i++) {
      const r = keywordResults[i];
      const key = r.entryId ?? `kw-${i}`;
      const rrfScore = 1 / (k + i + 1);
      const existing = scoreMap.get(key);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(key, { score: rrfScore, result: r });
      }
    }

    // Graph rank scores
    for (let i = 0; i < graphResults.length; i++) {
      const r = graphResults[i];
      const key = r.entryId ?? `gr-${i}`;
      const rrfScore = 1 / (k + i + 1);
      const existing = scoreMap.get(key);
      if (existing) {
        existing.score += rrfScore;
        // Preserve graphDepth if from graph
        if (r.graphDepth !== undefined) {
          existing.result.graphDepth = r.graphDepth;
        }
      } else {
        scoreMap.set(key, { score: rrfScore, result: r });
      }
    }

    return [...scoreMap.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ result, score }) => ({ ...result, score }));
  }

  private detectConflicts(
    results: HiveSearchResult[],
    allEntries: CellEntry[],
  ): void {
    const entryMap = new Map(allEntries.map((e) => [e.id, e]));

    // Only consider direct decision entries with agentId
    const decisionResults = results.filter((r) => {
      if (!r.entryId) return false;
      const entry = entryMap.get(r.entryId);
      return (
        entry?.type === "direct" &&
        entry.category === "decision" &&
        entry.agentId
      );
    });

    for (let i = 0; i < decisionResults.length; i++) {
      for (let j = i + 1; j < decisionResults.length; j++) {
        const a = decisionResults[i];
        const b = decisionResults[j];
        const entryA = entryMap.get(a.entryId!) as DirectEntry;
        const entryB = entryMap.get(b.entryId!) as DirectEntry;

        if (
          entryA.project === entryB.project &&
          entryA.agentId !== entryB.agentId
        ) {
          // Use keyword overlap to detect conflicts (replaces cosine similarity)
          const kwA = extractKeywords(entryA.content);
          const kwB = extractKeywords(entryB.content);
          if (keywordOverlap(kwA, kwB) > 0.6) {
            a.conflict = true;
            b.conflict = true;
          }
        }
      }
    }
  }

  private entryToResult(entry: CellEntry, score: number): HiveSearchResult {
    if (entry.type === "direct") {
      return {
        project: entry.project,
        category: entry.category,
        entryId: entry.id,
        ...(entry.agentId ? { agent: entry.agentId } : {}),
        snippet: entry.content.slice(0, 300),
        score,
      };
    } else {
      return {
        project: entry.project,
        source: entry.source,
        path: entry.path,
        entryId: entry.id,
        snippet: entry.description.slice(0, 300),
        score,
      };
    }
  }
}
