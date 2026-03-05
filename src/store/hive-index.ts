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

export function computeCentroid(embeddings: number[][]): number[] {
  if (embeddings.length === 0) return [];
  const dim = embeddings[0].length;
  const result = new Array<number>(dim).fill(0);
  for (const vec of embeddings) {
    for (let i = 0; i < dim; i++) {
      result[i] += vec[i];
    }
  }
  const n = embeddings.length;
  for (let i = 0; i < dim; i++) {
    result[i] /= n;
  }
  return result;
}

export function cosineSim(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

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
 * k-means with k=2, 5 iterations of Lloyd's algorithm.
 * Returns two groups of indices.
 */
export function kMeans2(embeddings: number[][]): [number[], number[]] {
  if (embeddings.length <= 2) {
    return [[0], embeddings.length > 1 ? [1] : []];
  }

  const dim = embeddings[0].length;

  // Initialize centroids: first and farthest
  let c0 = embeddings[0];
  let maxDist = -1;
  let farthestIdx = 1;
  for (let i = 1; i < embeddings.length; i++) {
    const d = 1 - cosineSim(c0, embeddings[i]);
    if (d > maxDist) {
      maxDist = d;
      farthestIdx = i;
    }
  }
  let c1 = embeddings[farthestIdx];

  const assignments = new Array<number>(embeddings.length).fill(0);

  for (let iter = 0; iter < 5; iter++) {
    // Assign
    for (let i = 0; i < embeddings.length; i++) {
      const d0 = cosineSim(embeddings[i], c0);
      const d1 = cosineSim(embeddings[i], c1);
      assignments[i] = d0 >= d1 ? 0 : 1;
    }

    // Recompute centroids
    const sum0 = new Array<number>(dim).fill(0);
    const sum1 = new Array<number>(dim).fill(0);
    let count0 = 0;
    let count1 = 0;

    for (let i = 0; i < embeddings.length; i++) {
      const target = assignments[i] === 0 ? sum0 : sum1;
      for (let d = 0; d < dim; d++) {
        target[d] += embeddings[i][d];
      }
      if (assignments[i] === 0) count0++;
      else count1++;
    }

    if (count0 > 0) {
      c0 = sum0.map((v) => v / count0);
    }
    if (count1 > 0) {
      c1 = sum1.map((v) => v / count1);
    }
  }

  const group0: number[] = [];
  const group1: number[] = [];
  for (let i = 0; i < assignments.length; i++) {
    if (assignments[i] === 0) group0.push(i);
    else group1.push(i);
  }

  // Ensure no empty cluster
  if (group0.length === 0) return [group1.slice(0, 1), group1.slice(1)];
  if (group1.length === 0) return [group0.slice(0, 1), group0.slice(1)];

  return [group0, group1];
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
  const hash = crypto.randomUUID().slice(0, 8);
  return `${slug || "cell"}-${hash}`;
}

export function getEntryText(entry: CellEntry): string {
  return entry.type === "direct" ? entry.content : entry.description;
}
