/**
 * YAKE! (Yet Another Keyword Extractor) — TypeScript implementation.
 *
 * Based on: Campos et al., "YAKE! Keyword extraction from single documents
 * using multiple local features", Information Sciences, 2020.
 *
 * Key features:
 * - Unsupervised, no corpus needed
 * - Statistical features: position, frequency, relatedness, sentence spread
 * - Lower score = more important keyword
 * - Supports 1-gram and n-gram candidates
 */

import { ENGLISH_STOPWORDS, KOREAN_PARTICLES, KOREAN_STOPWORDS } from "./stopwords.js";

export interface YakeOptions {
  /** Max number of keywords to return (default 15) */
  maxKeywords?: number;
  /** Max n-gram size (default 3) */
  maxNgram?: number;
  /** Deduplication threshold — Jaccard similarity to consider n-grams overlapping (default 0.8) */
  dedupThreshold?: number;
  /** Minimum word length to consider (default 3) */
  minWordLength?: number;
}

export interface ScoredKeyword {
  keyword: string;
  score: number;
}

const SENTENCE_DELIMITERS = /[.!?。！？\n]+/;
const WORD_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;
const KOREAN_CHAR = /[\uAC00-\uD7AF]/;

/**
 * Extract keywords from text using YAKE algorithm.
 * Returns keywords sorted by importance (lower score = more important).
 */
export function extractKeywords(text: string, options: YakeOptions = {}): ScoredKeyword[] {
  const maxKeywords = options.maxKeywords ?? 15;
  const maxNgram = options.maxNgram ?? 3;
  const dedupThreshold = options.dedupThreshold ?? 0.8;
  const minWordLength = options.minWordLength ?? 3;

  if (!text || text.trim().length < 10) return [];

  // 1. Pre-process: split into sentences, tokenize
  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];

  const tokenizedSentences = sentences.map((s) => tokenize(s, minWordLength));

  // 2. Build vocabulary with features
  const vocab = buildVocabulary(tokenizedSentences, sentences.length);

  // 3. Score individual terms
  const termScores = scoreTerms(vocab, sentences.length);

  // 4. Generate and score n-gram candidates
  const candidates = generateCandidates(tokenizedSentences, termScores, maxNgram, minWordLength);

  // 5. Deduplicate overlapping candidates
  const deduped = deduplicateCandidates(candidates, dedupThreshold);

  // 6. Return top-k
  return deduped.slice(0, maxKeywords);
}

// ── Pre-processing ───────────────────────────────────────────────────────────

function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_DELIMITERS)
    .map((s) => s.trim())
    .filter((s) => s.length > 5);
}

function tokenize(sentence: string, minLength: number): string[] {
  const words: string[] = [];
  const raw = sentence.match(WORD_PATTERN) || [];

  for (const word of raw) {
    const lower = word.toLowerCase();

    // Skip stopwords
    if (ENGLISH_STOPWORDS.has(lower)) continue;
    if (KOREAN_STOPWORDS.has(lower)) continue;

    // Korean: strip particles from end
    const cleaned = stripKoreanParticles(word);
    const cleanedLower = cleaned.toLowerCase();

    // Skip too short
    if (cleanedLower.length < minLength) continue;

    // Skip pure numbers
    if (/^\d+$/.test(cleanedLower)) continue;

    // Skip URLs and user IDs
    if (/^[uc]\d[a-z0-9]+$/i.test(cleanedLower)) continue;
    if (/^https?$/i.test(cleanedLower)) continue;

    words.push(cleanedLower);
  }

  return words;
}

function stripKoreanParticles(word: string): string {
  if (!KOREAN_CHAR.test(word)) return word;

  // Try removing known particle suffixes (longest first)
  const suffixes = [...KOREAN_PARTICLES].sort((a, b) => b.length - a.length);
  for (const suffix of suffixes) {
    if (word.endsWith(suffix) && word.length > suffix.length + 1) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

// ── Vocabulary Building ──────────────────────────────────────────────────────

interface TermFeatures {
  /** Term frequency */
  tf: number;
  /** Number of sentences containing this term */
  sf: number;
  /** Position of first occurrence (sentence index, 0-based) */
  firstPosition: number;
  /** Ratio of uppercase occurrences */
  caseRatio: number;
  /** Left context diversity: unique words appearing before this term */
  leftContext: Set<string>;
  /** Right context diversity: unique words appearing after this term */
  rightContext: Set<string>;
}

function buildVocabulary(
  tokenizedSentences: string[][],
  _totalSentences: number,
): Map<string, TermFeatures> {
  const vocab = new Map<string, TermFeatures>();

  for (let si = 0; si < tokenizedSentences.length; si++) {
    const tokens = tokenizedSentences[si];
    const seenInSentence = new Set<string>();

    for (let ti = 0; ti < tokens.length; ti++) {
      const term = tokens[ti];

      let features = vocab.get(term);
      if (!features) {
        features = {
          tf: 0,
          sf: 0,
          firstPosition: si,
          caseRatio: 0,
          leftContext: new Set(),
          rightContext: new Set(),
        };
        vocab.set(term, features);
      }

      features.tf++;

      if (!seenInSentence.has(term)) {
        features.sf++;
        seenInSentence.add(term);
      }

      // Context words
      if (ti > 0) features.leftContext.add(tokens[ti - 1]);
      if (ti < tokens.length - 1) features.rightContext.add(tokens[ti + 1]);
    }
  }

  return vocab;
}

// ── Term Scoring ─────────────────────────────────────────────────────────────

function scoreTerms(
  vocab: Map<string, TermFeatures>,
  totalSentences: number,
): Map<string, number> {
  const scores = new Map<string, number>();
  const maxTf = Math.max(...[...vocab.values()].map((v) => v.tf), 1);

  for (const [term, feat] of vocab) {
    // Feature 1: Position — earlier terms are more important
    // Normalized to [0, 1] — position 0 = most important
    const positionScore = Math.log2(2 + feat.firstPosition);

    // Feature 2: Frequency — moderate frequency preferred
    // Normalized TF penalizing both very rare and very common
    const tfNorm = feat.tf / maxTf;

    // Feature 3: Sentence spread — terms appearing in many sentences are more topical
    const sfNorm = feat.sf / Math.max(totalSentences, 1);

    // Feature 4: Context diversity (relatedness) — terms with diverse context are more generic
    // High diversity = likely a stopword-like term that appears in many contexts
    const contextDiv = (feat.leftContext.size + feat.rightContext.size) / (2 * Math.max(feat.tf, 1));

    // Feature 5: Term length bonus — longer terms are often more specific
    const lengthBonus = 1 / Math.log2(2 + term.length);

    // YAKE score: lower = more important
    // Combine: position * (contextDiv / (1 + tfNorm * sfNorm)) * lengthBonus
    const score =
      positionScore *
      (contextDiv + 1e-6) /
      (1 + tfNorm * sfNorm * (1 + feat.tf)) *
      lengthBonus;

    scores.set(term, score);
  }

  return scores;
}

// ── N-gram Candidate Generation ──────────────────────────────────────────────

function generateCandidates(
  tokenizedSentences: string[][],
  termScores: Map<string, number>,
  maxNgram: number,
  _minWordLength: number,
): ScoredKeyword[] {
  const candidateScores = new Map<string, number>();

  for (const tokens of tokenizedSentences) {
    for (let n = 1; n <= Math.min(maxNgram, tokens.length); n++) {
      for (let i = 0; i <= tokens.length - n; i++) {
        const gram = tokens.slice(i, i + n);
        const key = gram.join(" ");

        // N-gram score = product of individual term scores / n
        // (dividing by n favors longer phrases)
        let score = 1;
        let allScored = true;
        for (const word of gram) {
          const ws = termScores.get(word);
          if (ws === undefined) {
            allScored = false;
            break;
          }
          score *= ws;
        }

        if (!allScored) continue;
        score = score / n;

        // Keep best score for this candidate
        const existing = candidateScores.get(key);
        if (existing === undefined || score < existing) {
          candidateScores.set(key, score);
        }
      }
    }
  }

  return [...candidateScores.entries()]
    .map(([keyword, score]) => ({ keyword, score }))
    .sort((a, b) => a.score - b.score);
}

// ── Deduplication ────────────────────────────────────────────────────────────

function deduplicateCandidates(
  candidates: ScoredKeyword[],
  threshold: number,
): ScoredKeyword[] {
  const selected: ScoredKeyword[] = [];

  for (const candidate of candidates) {
    const words = new Set(candidate.keyword.split(" "));

    let isDuplicate = false;
    for (const existing of selected) {
      const existingWords = new Set(existing.keyword.split(" "));

      // Jaccard similarity between word sets
      const intersection = [...words].filter((w) => existingWords.has(w)).length;
      const union = new Set([...words, ...existingWords]).size;
      const jaccard = intersection / union;

      if (jaccard >= threshold) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      selected.push(candidate);
    }
  }

  return selected;
}
