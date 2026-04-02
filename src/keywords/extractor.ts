/**
 * Keyword extractor — combines YAKE with corpus frequency filtering.
 *
 * Features:
 * - YAKE statistical keyword extraction (no GPU/ML needed)
 * - Corpus frequency filter: removes keywords appearing in >30% of entities
 * - Returns clean, discriminative keywords for entity linking
 */

import type { HiveDatabase } from "../db/database.js";
import { extractKeywords as yakeExtract } from "./yake.js";

export interface ExtractorOptions {
  /** Max keywords per entity (default 15) */
  maxKeywords?: number;
  /** Max corpus frequency ratio — keywords above this are too common (default 0.3) */
  maxCorpusFrequency?: number;
  /** Max n-gram size (default 2) */
  maxNgram?: number;
}

/**
 * Extract keywords from a single text using YAKE.
 * No corpus filtering — use for single-entity extraction.
 */
export function extractKeywordsFromText(
  text: string,
  options?: ExtractorOptions,
): string[] {
  const maxKeywords = options?.maxKeywords ?? 15;
  const maxNgram = options?.maxNgram ?? 2;

  const scored = yakeExtract(text, { maxKeywords: maxKeywords * 2, maxNgram });
  return scored.slice(0, maxKeywords).map((s) => s.keyword);
}

/**
 * Re-extract keywords for all active entities in the database.
 * Applies YAKE + corpus frequency filtering.
 * Returns { processed, updated } counts.
 */
export function reextractAllKeywords(
  db: HiveDatabase,
  options?: ExtractorOptions,
): { processed: number; updated: number } {
  const maxKeywords = options?.maxKeywords ?? 15;
  const maxCorpusFreq = options?.maxCorpusFrequency ?? 0.3;
  const maxNgram = options?.maxNgram ?? 2;

  // 1. Load all active entities
  const entities = db.rawDb
    .prepare(
      `SELECT id, title, content FROM entities
       WHERE status = 'active' AND valid_to IS NULL`,
    )
    .all() as Array<{ id: string; title: string | null; content: string }>;

  if (entities.length === 0) return { processed: 0, updated: 0 };

  // 2. Extract raw keywords per entity
  const entityKeywords = new Map<string, string[]>();
  for (const e of entities) {
    const text = (e.title ? e.title + ". " : "") + e.content;
    const scored = yakeExtract(text, { maxKeywords: maxKeywords * 2, maxNgram });
    entityKeywords.set(e.id, scored.map((s) => s.keyword));
  }

  // 3. Build corpus frequency map
  const corpusFreq = new Map<string, number>();
  for (const keywords of entityKeywords.values()) {
    const uniqueInEntity = new Set(keywords);
    for (const kw of uniqueInEntity) {
      corpusFreq.set(kw, (corpusFreq.get(kw) ?? 0) + 1);
    }
  }

  const totalEntities = entities.length;
  const maxCount = Math.max(Math.floor(totalEntities * maxCorpusFreq), 1);

  // 4. Filter and update
  const now = new Date().toISOString();
  let updated = 0;

  const updateStmt = db.rawDb.prepare(
    "UPDATE entities SET keywords = @keywords, updated_at = @now WHERE id = @id",
  );

  const transaction = db.rawDb.transaction(() => {
    for (const e of entities) {
      const raw = entityKeywords.get(e.id) ?? [];
      const filtered = raw.filter((kw) => {
        const freq = corpusFreq.get(kw) ?? 0;
        return freq <= maxCount;
      });

      const finalKeywords = filtered.slice(0, maxKeywords);
      const keywordsJson = JSON.stringify(finalKeywords);

      updateStmt.run({ id: e.id, keywords: keywordsJson, now });
      updated++;
    }
  });

  transaction();

  return { processed: entities.length, updated };
}
