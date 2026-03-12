import type { HiveIndex, CellEntry, DirectEntry } from "../types.js";
import type { EmbedService } from "../embed.js";
import type { HiveStore } from "./hive-store.js";
import {
  cosineSim,
  extractKeywords,
  keywordOverlap,
  getEntryText,
} from "./hive-index.js";

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
}

export interface HiveSearchOptions {
  project?: string;
  category?: string;
  agent?: string;
  limit?: number;
}

const BEAM_WIDTH = 3;
const VECTOR_WEIGHT = 0.7;
const KEYWORD_WEIGHT = 0.3;

export class HiveSearch {
  constructor(
    private hiveStore: HiveStore,
    private embed: EmbedService,
  ) {}

  async search(
    query: string,
    options: HiveSearchOptions = {},
  ): Promise<HiveSearchResult[]> {
    const limit = options.limit ?? 5;
    const queryEmbedding = (await this.embed.getEmbedding(query)) ?? [];
    const queryKeywords = extractKeywords(query);

    const hive = await this.hiveStore.loadHive();
    const now = Date.now();

    // Collect all candidate entries from nursery + leaf cells
    const allEntries: CellEntry[] = [...hive.nursery];

    // 1. Beam search through tree to find relevant leaf cells
    const leafCellIds = await this.beamSearch(
      hive,
      queryEmbedding,
      queryKeywords,
    );

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

    // 3. Score entries and build paired results
    const paired: { result: HiveSearchResult; entry: CellEntry }[] = [];
    for (const entry of liveEntries) {
      const score = this.scoreEntry(entry, queryEmbedding, queryKeywords);
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

    // 5. Detect conflicts among decision entries from different agents
    this.detectConflicts(filteredPairs);

    // 6. Sort and limit
    return filteredPairs
      .map((p) => p.result)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private async beamSearch(
    hive: HiveIndex,
    queryEmbedding: number[],
    queryKeywords: string[],
  ): Promise<string[]> {
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
      // Score and rank current candidates
      const scored = currentIds.map((id) => {
        const cell = hive.cells[id];
        if (!cell) return { id, score: 0 };

        const vectorScore =
          queryEmbedding.length > 0 && cell.centroid.length > 0
            ? cosineSim(queryEmbedding, cell.centroid)
            : 0;
        const kwScore = keywordOverlap(queryKeywords, cell.keywords);
        const score =
          VECTOR_WEIGHT * vectorScore + KEYWORD_WEIGHT * kwScore;
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
    queryEmbedding: number[],
    queryKeywords: string[],
  ): number {
    let score = 0;

    // Vector similarity
    if (queryEmbedding.length > 0 && entry.embedding.length > 0) {
      const sim = cosineSim(queryEmbedding, entry.embedding);
      score += Math.max(0, sim * 15);
    }

    // Keyword match on text
    const text = getEntryText(entry).toLowerCase();
    for (const kw of queryKeywords) {
      if (text.includes(kw)) score += 3;
    }

    // Tag match
    for (const tag of entry.tags) {
      if (queryKeywords.includes(tag.toLowerCase())) score += 2;
    }

    return score;
  }

  private detectConflicts(
    pairs: { result: HiveSearchResult; entry: CellEntry }[],
  ): void {
    // Only consider direct decision entries with agentId
    const decisionPairs = pairs.filter(
      (p) =>
        p.entry.type === "direct" &&
        p.entry.category === "decision" &&
        p.entry.agentId,
    );

    for (let i = 0; i < decisionPairs.length; i++) {
      for (let j = i + 1; j < decisionPairs.length; j++) {
        const a = decisionPairs[i];
        const b = decisionPairs[j];
        const entryA = a.entry as DirectEntry;
        const entryB = b.entry as DirectEntry;

        if (
          entryA.project === entryB.project &&
          entryA.agentId !== entryB.agentId &&
          entryA.embedding.length > 0 &&
          entryB.embedding.length > 0 &&
          cosineSim(entryA.embedding, entryB.embedding) > 0.85
        ) {
          a.result.conflict = true;
          b.result.conflict = true;
        }
      }
    }
  }

  private entryToResult(entry: CellEntry, score: number): HiveSearchResult {
    if (entry.type === "direct") {
      return {
        project: entry.project,
        category: entry.category,
        ...(entry.agentId ? { agent: entry.agentId } : {}),
        snippet: entry.content.slice(0, 300),
        score,
      };
    } else {
      return {
        project: entry.project,
        source: entry.source,
        path: entry.path,
        snippet: entry.description.slice(0, 300),
        score,
      };
    }
  }
}
