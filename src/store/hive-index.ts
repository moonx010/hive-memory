import { randomUUID } from "node:crypto";
import type { CellEntry } from "../types.js";

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "out", "off", "over",
  "under", "again", "further", "then", "once", "here", "there", "when",
  "where", "why", "how", "all", "each", "every", "both", "few", "more",
  "most", "other", "some", "such", "no", "nor", "not", "only", "own",
  "same", "so", "than", "too", "very", "just", "because", "but", "and",
  "or", "if", "while", "about", "up", "that", "this", "it", "its",
  "i", "me", "my", "we", "our", "you", "your", "he", "him", "his",
  "she", "her", "they", "them", "their", "what", "which", "who", "whom",
  "use", "used", "using", "get", "set", "new", "make", "like",
]);

export function extractKeywords(text: string): string[] {
  const lower = text.toLowerCase();

  // Split on whitespace and punctuation, keeping Unicode word characters (Korean, etc.)
  const words = lower
    .split(/[\s,;:!?.()[\]{}"'`~@#$%^&*+=<>|/\\]+/)
    .filter((w) => {
      if (!w || w.length === 0) return false;
      // For ASCII words: require length > 2 and not a stop word
      if (/^[a-z0-9-]+$/.test(w)) return w.length > 2 && !STOP_WORDS.has(w);
      // For non-ASCII (Korean, etc.): require length >= 1
      return true;
    });

  const freq = new Map<string, number>();
  for (const w of words) {
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}

export function keywordOverlap(queryKeywords: string[], cellKeywords: string[]): number {
  if (queryKeywords.length === 0 && cellKeywords.length === 0) return 0;
  const setA = new Set(queryKeywords);
  const setB = new Set(cellKeywords);
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Keyword-based 2-split — partition entries into two groups
 * by finding the most discriminative keyword and splitting on it.
 *
 * Replaces the old kMeans2 that required vector embeddings.
 */
export function keywordSplit2(entries: CellEntry[]): [number[], number[]] {
  if (entries.length <= 2) {
    return [[0], entries.length > 1 ? [1] : []];
  }

  // Extract keyword sets for each entry
  const entryKeywords = entries.map((e) => new Set(extractKeywords(getEntryText(e))));

  // Collect all keywords with their document frequency
  const docFreq = new Map<string, number>();
  for (const kwSet of entryKeywords) {
    for (const kw of kwSet) {
      docFreq.set(kw, (docFreq.get(kw) ?? 0) + 1);
    }
  }

  // Find the most discriminative keyword (closest to 50% of docs)
  const n = entries.length;
  const halfN = n / 2;
  let bestKeyword = "";
  let bestScore = Infinity;

  for (const [kw, freq] of docFreq) {
    // Skip keywords that appear in all or one entry
    if (freq <= 1 || freq >= n) continue;
    const score = Math.abs(freq - halfN);
    if (score < bestScore) {
      bestScore = score;
      bestKeyword = kw;
    }
  }

  // If no discriminative keyword found, fall back to simple halving
  if (!bestKeyword) {
    const mid = Math.ceil(n / 2);
    return [
      Array.from({ length: mid }, (_, i) => i),
      Array.from({ length: n - mid }, (_, i) => i + mid),
    ];
  }

  // Split by the discriminative keyword
  const groupA: number[] = [];
  const groupB: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (entryKeywords[i].has(bestKeyword)) {
      groupA.push(i);
    } else {
      groupB.push(i);
    }
  }

  // Ensure no empty group
  if (groupA.length === 0) return [groupB.slice(0, 1), groupB.slice(1)];
  if (groupB.length === 0) return [groupA.slice(0, 1), groupA.slice(1)];

  return [groupA, groupB];
}

export function generateCellId(summary: string): string {
  const slug = summary
    .toLowerCase()
    .split(/[\s,;:!?.]+/)
    .filter((w) => {
      if (!w) return false;
      if (/^[a-z0-9-]+$/.test(w)) return w.length > 2 && !STOP_WORDS.has(w);
      return w.length >= 1;
    })
    .slice(0, 3)
    .map((w) => w.replace(/[^a-z0-9\u3131-\uD79D-]/g, ""))
    .filter(Boolean)
    .join("-");
  const hash = randomUUID().slice(0, 8);
  return `${slug || "cell"}-${hash}`;
}

export function getEntryText(entry: CellEntry): string {
  return entry.type === "direct" ? entry.content : entry.description;
}
