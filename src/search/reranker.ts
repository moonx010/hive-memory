/**
 * Cross-encoder reranking for search results.
 * Reranks top-N results using a more expensive but accurate model.
 *
 * When CORTEX_RERANKER is set:
 * - "cohere": Use Cohere Rerank API
 * - "local": Use a simple TF-IDF cosine similarity reranker (no external deps)
 * - undefined/none: Skip reranking (default)
 */

export interface RerankResult {
  entityId: string;
  score: number;
  originalRank: number;
}

export async function rerankResults(
  query: string,
  results: Array<{ id: string; content: string; title?: string }>,
  topK?: number,
): Promise<RerankResult[]> {
  const reranker = process.env.CORTEX_RERANKER;
  if (!reranker || reranker === "none") {
    // No reranking — return original order with normalized scores
    return results.map((r, i) => ({ entityId: r.id, score: 1 / (1 + i), originalRank: i }));
  }

  if (reranker === "local") {
    return localRerank(query, results, topK);
  }

  if (reranker === "cohere") {
    return cohereRerank(query, results, topK);
  }

  return results.map((r, i) => ({ entityId: r.id, score: 1 / (1 + i), originalRank: i }));
}

/** Simple TF-IDF cosine similarity reranker (no external deps) */
function localRerank(query: string, results: Array<{ id: string; content: string; title?: string }>, topK?: number): RerankResult[] {
  const queryTerms = new Set(query.toLowerCase().split(/\s+/).filter(t => t.length > 2));

  const scored = results.map((r, i) => {
    const text = `${r.title ?? ""} ${r.content}`.toLowerCase();
    const docTerms = text.split(/\s+/);
    const matchCount = docTerms.filter(t => queryTerms.has(t)).length;
    const score = matchCount / (docTerms.length || 1);
    return { entityId: r.id, score, originalRank: i };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK ?? results.length);
}

/** Cohere Rerank API */
async function cohereRerank(query: string, results: Array<{ id: string; content: string; title?: string }>, topK?: number): Promise<RerankResult[]> {
  const apiKey = process.env.COHERE_API_KEY;
  if (!apiKey) return results.map((r, i) => ({ entityId: r.id, score: 1 / (1 + i), originalRank: i }));

  const documents = results.map(r => `${r.title ?? ""}\n${r.content}`.slice(0, 500));

  const res = await fetch("https://api.cohere.ai/v1/rerank", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "rerank-english-v3.0",
      query,
      documents,
      top_n: topK ?? results.length,
    }),
  });

  if (!res.ok) return results.map((r, i) => ({ entityId: r.id, score: 1 / (1 + i), originalRank: i }));

  const data = await res.json() as { results: Array<{ index: number; relevance_score: number }> };
  return data.results.map(r => ({
    entityId: results[r.index].id,
    score: r.relevance_score,
    originalRank: r.index,
  }));
}
