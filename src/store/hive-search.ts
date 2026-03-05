import type { HiveIndex, CellEntry } from "../types.js";
import type { EmbedService } from "../embed.js";
import type { HiveStore } from "./hive-store.js";
import {
  cosineSim,
  extractKeywords,
  keywordOverlap,
  getEntryText,
} from "./hive-index.js";

export interface HiveSearchResult {
  project: string;
  category?: string;
  source?: string;
  path?: string;
  snippet: string;
  score: number;
}

export interface HiveSearchOptions {
  project?: string;
  category?: string;
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
    const results: HiveSearchResult[] = [];

    // 1. Search nursery (brute force)
    for (const entry of hive.nursery) {
      const score = this.scoreEntry(entry, queryEmbedding, queryKeywords);
      if (score > 0) {
        results.push(this.entryToResult(entry, score));
      }
    }

    // 2. Beam search through tree
    const leafCellIds = await this.beamSearch(
      hive,
      queryEmbedding,
      queryKeywords,
    );

    // 3. Load matching leaf cells and score individual entries
    for (const cellId of leafCellIds) {
      const cellData = await this.hiveStore.loadCellData(cellId);
      for (const entry of cellData.entries) {
        const score = this.scoreEntry(entry, queryEmbedding, queryKeywords);
        if (score > 0) {
          results.push(this.entryToResult(entry, score));
        }
      }
    }

    // 4. Apply filters
    let filtered = results;
    if (options.project) {
      filtered = filtered.filter((r) => r.project === options.project);
    }
    if (options.category) {
      filtered = filtered.filter(
        (r) => r.category === options.category,
      );
    }

    // 5. Sort and limit
    return filtered.sort((a, b) => b.score - a.score).slice(0, limit);
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

  private entryToResult(entry: CellEntry, score: number): HiveSearchResult {
    if (entry.type === "direct") {
      return {
        project: entry.project,
        category: entry.category,
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
