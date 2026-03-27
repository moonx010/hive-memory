# Change: hybrid-search-rag

**Layer:** 1 (Search & Retrieval)
**One-liner:** Combine FTS5 BM25 lexical search with vector cosine similarity via sqlite-vec, fuse with RRF, enrich chunks with contextual prefixes at ingest time, and optionally rerank with a cross-encoder.
**Estimated effort:** 3 weeks
**Dependencies:** None (extends existing `searchEntities` and `memory_recall`)

## Why

Current search is FTS5 BM25 only. It works well for exact keyword matches but fails on:
- **Semantic queries:** "how did we handle the authentication decision" won't find an entity titled "OAuth2 vs API keys trade-off" because no keyword overlap.
- **Typos and synonyms:** "k8s deployment" won't match "Kubernetes rollout."
- **Cross-domain discovery:** Connecting a Slack conversation about performance to a meeting note about infrastructure requires semantic understanding.

Research findings:
- Hybrid search (BM25 + vector) with RRF fusion consistently outperforms either alone by 10-20% on retrieval benchmarks (Anthropic Contextual RAG paper, 2024).
- Contextual RAG (prepending document-level context to each chunk before embedding) reduces retrieval failures by 49% compared to naive chunking.
- Cross-encoder reranking on top-N results adds another 5-10% precision lift at minimal latency cost.

The current spreading activation and synapse graph provide structural relevance; hybrid search adds semantic relevance. Together they cover the full retrieval spectrum.

## 5-Role Design Review

### PM — User Stories & Scope

**Target users:** All hive-memory users (individual and team)

**User stories:**
1. As a developer, I want `memory_recall("how we handle rate limiting")` to find the decision entity about "API throttling strategy" even though the keywords don't overlap.
2. As a team lead, I want cross-domain search to surface a Slack discussion about "database migration" when I recall "PostgreSQL upgrade path."
3. As a developer, I want search results ranked by both textual and semantic relevance, not just keyword frequency.
4. As an admin, I want to choose between local embeddings (Ollama/nomic-embed-text) and API embeddings (OpenAI text-embedding-3-small) based on cost and privacy needs.

**Success metrics:**
- Recall@10 improves by >= 15% over BM25-only on a benchmark of 100 query-entity pairs.
- p50 search latency stays under 200ms for 50K entity corpus (with pre-computed embeddings).
- Zero-config degradation: if no embedding provider is configured, search falls back to BM25-only (current behavior).

**MVP scope:**
- Vector embeddings stored in sqlite-vec extension.
- Embedding at ingest time (memory_store, connector sync).
- Hybrid search: BM25 scores + cosine similarity -> RRF fusion.
- Contextual prefix generation at ingest time (rule-based, not LLM).
- Optional cross-encoder reranking via LLM (uses existing enrichment LLM provider).

**Deferred to v2:**
- LLM-generated contextual prefixes (expensive, requires per-entity LLM call).
- Multi-vector retrieval (ColBERT-style late interaction).
- Approximate nearest neighbor indexes (HNSW) — sqlite-vec brute-force is sufficient for <100K entities.

### Tech Lead — Implementation Approach

**sqlite-vec integration:**

sqlite-vec is a SQLite extension for vector operations. It supports brute-force cosine similarity search on float32 vectors. No external database required.

```bash
npm install sqlite-vec
```

```typescript
// Load extension at database init
import * as sqliteVec from 'sqlite-vec';
sqliteVec.load(db);

// Create virtual table for vector storage
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS entity_embeddings USING vec0(
    entity_id TEXT PRIMARY KEY,
    embedding float[1536]    -- text-embedding-3-small dimension
  );
`);
```

**Embedding at ingest time:**

```typescript
// src/search/embedder.ts
export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

// Providers:
// - OpenAIEmbedder: text-embedding-3-small (1536 dims, $0.02/1M tokens)
// - OllamaEmbedder: nomic-embed-text (768 dims, free, local)
```

**Contextual prefix (rule-based):**

Instead of LLM-generated context, use a structured prefix:

```typescript
function buildContextualPrefix(entity: Entity): string {
  const parts: string[] = [];
  if (entity.project) parts.push(`Project: ${entity.project}`);
  parts.push(`Type: ${entity.entityType}`);
  if (entity.domain !== 'code') parts.push(`Domain: ${entity.domain}`);
  if (entity.tags.length > 0) parts.push(`Topics: ${entity.tags.join(', ')}`);
  if (entity.source.system !== 'agent') parts.push(`Source: ${entity.source.system}`);
  return parts.join(' | ') + '\n\n' + entity.content;
}
```

This prefix is prepended to entity content before embedding. It grounds the embedding in organizational context (project, domain, source) without requiring an LLM call.

**Hybrid search with RRF fusion:**

```typescript
// src/search/hybrid.ts
export interface HybridSearchOptions {
  query: string;
  project?: string;
  limit?: number;
  weights?: { bm25: number; vector: number };  // default { bm25: 0.4, vector: 0.6 }
  rerank?: boolean;
}

export async function hybridSearch(
  db: HiveDatabase,
  embedder: EmbeddingProvider,
  options: HybridSearchOptions,
): Promise<SearchResult[]> {
  const { query, limit = 10 } = options;
  const k = 60; // RRF constant

  // 1. BM25 search (top 50)
  const bm25Results = db.searchEntities(query, { limit: 50, ...filters });

  // 2. Vector search (top 50)
  const queryEmbedding = await embedder.embed(query);
  const vectorResults = db.vectorSearch(queryEmbedding, { limit: 50, ...filters });

  // 3. RRF fusion
  const scores = new Map<string, number>();
  bm25Results.forEach((r, i) => {
    scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (k + i + 1));
  });
  vectorResults.forEach((r, i) => {
    scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (k + i + 1));
  });

  // 4. Sort by fused score, take top-N
  const fused = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  return fused.map(([id, score]) => ({ id, score, entity: db.getEntity(id) }));
}
```

**File changes:**
- `src/search/types.ts` — NEW: EmbeddingProvider, HybridSearchOptions, SearchResult interfaces
- `src/search/embedder.ts` — NEW: OpenAI and Ollama embedding providers
- `src/search/contextual.ts` — NEW: buildContextualPrefix function
- `src/search/hybrid.ts` — NEW: hybridSearch with RRF fusion
- `src/search/reranker.ts` — NEW: cross-encoder reranking via LLM
- `src/db/schema.ts` — MODIFY: add entity_embeddings vec0 table (schema v5/v6)
- `src/db/database.ts` — MODIFY: add vectorSearch method, embed-on-insert in upsertEntity
- `src/store.ts` — MODIFY: use hybridSearch in recall path when embedder is configured
- `src/tools/memory-tools.ts` — MODIFY: memory_recall uses hybrid search

### SRE Engineer — Performance & Operations

**Storage impact:**
- Embedding per entity: 1536 dims x 4 bytes = 6.1 KB (OpenAI) or 768 dims x 4 bytes = 3 KB (Ollama).
- 100K entities with OpenAI embeddings: ~600 MB additional storage.
- 100K entities with Ollama embeddings: ~300 MB additional storage.
- sqlite-vec stores vectors in a separate virtual table, so the main SQLite file growth is minimal.

**Query latency:**
- BM25 search (current): ~5ms for 100K entities.
- sqlite-vec brute-force cosine: ~50ms for 100K entities with 1536-dim vectors. Acceptable for <100K.
- For >100K entities, consider sqlite-vec's IVF index (future optimization).
- RRF fusion: <1ms (in-memory map merge).
- Cross-encoder reranking (20 candidates): ~500ms with API LLM, ~200ms with local Ollama.

**Embedding generation latency:**
- OpenAI text-embedding-3-small: ~100ms per request (batches of 100).
- Ollama nomic-embed-text (local M1 Mac): ~50ms per entity.
- Batch backfill of 10K entities: ~10 minutes (OpenAI) or ~8 minutes (Ollama).

**Cost:**
- OpenAI text-embedding-3-small: $0.02 per 1M tokens. 10K entities x avg 500 tokens = $0.10.
- Ollama: free (local compute).

**Monitoring:**
- Track embedding backlog size (entities without embeddings).
- Track search latency breakdown: BM25 time, vector time, fusion time, rerank time.
- Alert on: embedding provider failure (API errors), search p99 > 500ms.

### Security Engineer — Threat Analysis

**Attack vectors:**
1. **Prompt injection in embedding query.** Attacker crafts a query with adversarial text to manipulate vector similarity. Mitigation: Embeddings are fixed-dimension numerical vectors — prompt injection doesn't apply to cosine similarity math. The reranker (LLM-based) is susceptible, but only runs on already-retrieved entities.
2. **Embedding extraction.** Attacker queries the vector table to reconstruct original text. Mitigation: sqlite-vec embeddings are not directly exposed via MCP tools. `memory_recall` returns entity content, not embeddings. Reconstruction from embeddings is computationally infeasible for modern embedding models.
3. **API key exposure.** OpenAI API key for embeddings stored in env var. Mitigation: same pattern as existing LLM provider keys (`CORTEX_EMBEDDING_API_KEY`). Not logged, not exposed via MCP.
4. **ACL bypass via vector search.** Vector similarity search might return entities the user shouldn't see. Mitigation: ACL WHERE clause applies to both BM25 and vector search paths. The `hybridSearch` function passes ACLContext to both search methods.

### Devil's Advocate — Sanity Check

**Is this over-engineering?**
For a single developer with <1K entities, FTS5 BM25 is sufficient. But the value proposition of hive-memory is "recall anything" — and BM25 fails on semantic queries. Research shows 15-20% recall improvement is achievable with minimal complexity.

**Simplest 80% version:**
- Embedding storage + cosine search + RRF fusion. Skip contextual prefix and cross-encoder reranking.
- This gives: semantic search capability + hybrid fusion. Missing: contextual grounding and precision boost from reranking.
- Recommendation: contextual prefix is cheap (rule-based, no LLM cost) and improves embedding quality. Include it. Defer cross-encoder reranking to v2.

**Can we use an external vector DB instead?**
Yes (Qdrant, Chroma, etc.), but it breaks the "no external services" principle. sqlite-vec keeps everything in one file, one process, zero ops. The performance tradeoff (brute-force vs HNSW) is acceptable under 100K entities.

**What if sqlite-vec becomes unmaintained?**
sqlite-vec is by Alex Garcia (prolific SQLite extension author), MIT licensed. Risk is low. If abandoned, migration to pgvector (Feature 3) covers it. The `EmbeddingProvider` abstraction means the vector storage backend can be swapped.

## Consensus Decision

**Approved scope (adjusted per Devil's Advocate):**
- Phase 1 (Weeks 1-2): Embedding provider abstraction + sqlite-vec storage + contextual prefix + hybrid search with RRF.
- Phase 2 (Week 3): Cross-encoder reranking (optional, LLM-based) + batch backfill CLI + eval benchmark.
- Deferred: LLM-generated contextual prefixes, HNSW indexing, ColBERT.

**Key design decisions:**
1. sqlite-vec for vector storage — keeps the single-file, zero-ops architecture.
2. Rule-based contextual prefix, not LLM-generated — zero cost, 80% of the benefit.
3. RRF fusion (not linear interpolation) — parameter-free, proven effective.
4. Graceful degradation — if no embedding provider configured, falls back to BM25-only.

## Acceptance Criteria

1. `memory_recall("how we handle rate limiting")` finds entity titled "API throttling strategy" (semantic match, no keyword overlap).
2. Hybrid search with RRF fusion returns results ordered by combined BM25 + vector score.
3. When `CORTEX_EMBEDDING_PROVIDER` is not set, `memory_recall` falls back to BM25-only (current behavior).
4. Embedding is generated at ingest time (memory_store, connector sync) with contextual prefix prepended.
5. `hive-memory embed --backfill` generates embeddings for all entities that lack them.
6. Search latency p50 < 200ms for 10K entity corpus with embeddings.
7. Eval benchmark shows >= 15% recall@10 improvement over BM25-only on 50+ query-entity test pairs.

## Impact

- **New directory:** `src/search/` (~5 files, ~600 lines)
- **New npm dependency:** `sqlite-vec` (SQLite extension, ~2 MB)
- **New table:** `entity_embeddings` (vec0 virtual table)
- **Modified:** `src/db/database.ts` — add `vectorSearch`, embed-on-insert (~80 lines)
- **Modified:** `src/db/schema.ts` — add vec0 table creation (~10 lines)
- **Modified:** `src/store.ts` — hybrid search integration (~40 lines)
- **Modified:** `src/tools/memory-tools.ts` — memory_recall uses hybrid search
- **Modified:** `src/cli.ts` — add `embed` subcommand
- **Storage:** +6 KB per entity (OpenAI) or +3 KB per entity (Ollama)
