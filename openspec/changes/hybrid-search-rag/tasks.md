# Tasks: hybrid-search-rag

**Estimated effort:** 3 weeks
**Dependencies:** None (extends existing search infrastructure)

## Phase 1: Embedding Infrastructure (Week 1)

- [ ] **TASK-HSR-01**: Create `src/search/types.ts`
  - Define `EmbeddingProvider` interface: `name`, `dimensions`, `embed(text)`, `embedBatch(texts)`
  - Define `SearchResult` interface: `id`, `entity`, `score`, `sources: { bm25Rank, vectorRank, rerankerScore }`
  - Define `HybridSearchOptions` interface: `query`, `project?`, `entityType?`, `domain?`, `namespace?`, `limit?`, `acl?`, `rerank?`, `rrf?`
  - Define `VectorSearchOptions` interface: `limit`, filters, `acl`
  - Export all types

- [ ] **TASK-HSR-02**: Implement OpenAI embedder in `src/search/embedder.ts`
  - `OpenAIEmbedder` class implementing `EmbeddingProvider`
  - Constructor: `(apiKey: string, model = 'text-embedding-3-small')`
  - `embed(text)`: POST to `https://api.openai.com/v1/embeddings`, parse `data[0].embedding`
  - `embedBatch(texts, batchSize = 100)`: chunked requests, concatenate results
  - Handle rate limits (429) with exponential backoff (max 3 retries)
  - Throw descriptive error on API failure

- [ ] **TASK-HSR-03**: Implement Ollama embedder in `src/search/embedder.ts`
  - `OllamaEmbedder` class implementing `EmbeddingProvider`
  - Constructor: `(baseUrl = 'http://localhost:11434', model = 'nomic-embed-text')`
  - `embed(text)`: POST to `${baseUrl}/api/embed`, parse `embeddings[0]`
  - `embedBatch(texts)`: POST with array input, parse `embeddings`
  - Handle connection errors with clear message ("Is Ollama running?")

- [ ] **TASK-HSR-04**: Implement `createEmbeddingProvider()` factory
  - Read env vars: `CORTEX_EMBEDDING_PROVIDER`, `CORTEX_EMBEDDING_API_KEY`, `CORTEX_EMBEDDING_MODEL`, `CORTEX_EMBEDDING_BASE_URL`
  - Return `undefined` if provider is unset or `'off'`
  - Dispatch to `OpenAIEmbedder` or `OllamaEmbedder`
  - Fall back to `OPENAI_API_KEY` env var if `CORTEX_EMBEDDING_API_KEY` not set
  - Throw clear error for unknown provider values

- [ ] **TASK-HSR-05**: Add sqlite-vec to project and create vector table
  - `npm install sqlite-vec`
  - In `src/db/database.ts`, add `initVectorTable(dimensions: number)` method
  - Load sqlite-vec extension: `sqliteVec.load(this.db)`
  - Create vec0 virtual table: `entity_embeddings(entity_id TEXT PRIMARY KEY, embedding float[N])`
  - Store dimensions in a metadata key for runtime validation
  - Handle case where sqlite-vec is not available (log warning, disable vector features)

- [ ] **TASK-HSR-06**: Add vector CRUD methods to `HiveDatabase`
  - `upsertEmbedding(entityId, embedding)`: delete existing + insert (vec0 doesn't support UPSERT)
  - `deleteEmbedding(entityId)`: DELETE FROM entity_embeddings
  - `hasEmbedding(entityId)`: SELECT 1 check
  - `countMissingEmbeddings()`: COUNT entities without embeddings
  - `vectorSearch(queryEmbedding, options)`: cosine similarity search with JOIN to entities for filtering + ACL
  - All methods are no-ops if vector table is not initialized

- [ ] **TASK-HSR-07**: Add unit tests for embedding providers (mocked fetch)
  - Mock `fetch` globally
  - Test: `OpenAIEmbedder.embed()` sends correct request, parses response
  - Test: `OpenAIEmbedder.embedBatch()` chunks requests at batchSize boundary
  - Test: `OllamaEmbedder.embed()` sends correct request to local URL
  - Test: `createEmbeddingProvider()` returns undefined when CORTEX_EMBEDDING_PROVIDER is unset
  - Test: `createEmbeddingProvider('openai')` returns OpenAIEmbedder instance

## Phase 2: Contextual Prefix + Hybrid Search (Week 2)

- [ ] **TASK-HSR-08**: Implement `buildContextualPrefix()` in `src/search/contextual.ts`
  - Construct prefix from: project, entityType, domain (if not 'code'), tags (top 5), source system, title
  - Format: `"Project: X | Type: Y | Domain: Z | Topics: a, b, c\n\nContent..."`
  - Handle missing fields gracefully (omit from prefix)
  - Max prefix length: 200 chars (truncate tags if needed)
  - Export function

- [ ] **TASK-HSR-09**: Add tests for contextual prefix
  - Test: entity with all fields -> full prefix with all parts
  - Test: entity with only project + content -> minimal prefix
  - Test: entity with domain='code' -> domain omitted from prefix
  - Test: entity with 10 tags -> only first 5 included
  - Test: entity from agent source -> source omitted from prefix

- [ ] **TASK-HSR-10**: Implement `hybridSearch()` in `src/search/hybrid.ts`
  - Accept `HiveDatabase`, `EmbeddingProvider`, `HybridSearchOptions`
  - Step 1: BM25 search via `db.searchEntities()` — top 50 candidates
  - Step 2: embed query via `embedder.embed(query)`, vector search via `db.vectorSearch()` — top 50
  - Step 3: RRF fusion with k=60 — merge scores by entity ID
  - Step 4: sort by fused score, take top-N
  - Step 5: resolve full Entity objects via `db.getEntity()`
  - Return `SearchResult[]` with score breakdown (bm25Rank, vectorRank)
  - Handle case where BM25 returns results but vector search returns empty (no embeddings yet)

- [ ] **TASK-HSR-11**: Add tests for hybrid search (with in-memory SQLite)
  - Setup: create test database with 20 entities, embed half of them
  - Test: hybrid search returns results from both BM25 and vector paths
  - Test: entity appearing in both BM25 and vector results gets higher fused score
  - Test: entity only in vector results (no keyword match) still appears
  - Test: with no embeddings, falls back to BM25-only results
  - Test: RRF scores are correctly computed (manual calculation check)

- [ ] **TASK-HSR-12**: Integrate hybrid search into `CortexStore.recall()`
  - In `src/store.ts`, initialize `embedder` from `createEmbeddingProvider()`
  - If embedder available, call `db.initVectorTable(embedder.dimensions)`
  - In `recall()`: if embedder available, use `hybridSearch()`; else use `db.searchEntities()`
  - Pass `ACLContext` through to both search paths
  - Pass `project`, `entityType`, `limit` filters through

- [ ] **TASK-HSR-13**: Embed at ingest time
  - In `CortexStore.store()` (memory_store handler): after entity insert, call `embedEntity()`
  - In connector sync path: after entity upsert, call `embedEntity()`
  - `embedEntity(entity)`: build contextual prefix, embed, upsert embedding
  - Handle embedding failures gracefully: log warning, don't fail the store operation
  - Skip embedding if `embedder` is undefined (no provider configured)

## Phase 3: Reranking + CLI + Eval (Week 3)

- [ ] **TASK-HSR-14**: Implement cross-encoder reranker in `src/search/reranker.ts`
  - `crossEncoderRerank(query, candidates, limit, llm?)`: rerank top-20 candidates
  - Build prompt: query + truncated document content (300 chars each)
  - Call `llm.extract()` to get relevance scores (0-10)
  - Merge reranker scores into SearchResult, re-sort
  - No-op if `llm` is undefined or `CORTEX_RERANK !== 'on'`
  - Handle LLM failure gracefully: return original ranking

- [ ] **TASK-HSR-15**: Add reranker integration to hybrid search
  - In `hybridSearch()`, if `options.rerank === true` and LLM provider available:
    - Expand candidate set to top-20 before reranking
    - Call `crossEncoderRerank()`
    - Trim to final `limit`
  - Pass `CORTEX_RERANK` env var through to options

- [ ] **TASK-HSR-16**: Add `embed` CLI subcommand to `src/cli.ts`
  - `hive-memory embed --backfill [--limit N] [--batch-size N]`:
    - Query entities without embeddings
    - Generate embeddings in batches
    - Print progress: `"Embedded {done}/{total} entities"`
  - `hive-memory embed --stats`:
    - Print: `"Entities: N | Embedded: M | Missing: K | Provider: X (D dims)"`
  - `hive-memory embed --entity <id>`:
    - Re-embed single entity
  - `hive-memory embed --rebuild`:
    - Drop and recreate vec0 table, re-embed all entities
    - Confirm before proceeding

- [ ] **TASK-HSR-17**: Create search eval benchmark
  - Create `src/search/eval/` directory
  - `eval-queries.json`: 50+ (query, expected_entity_ids[]) pairs covering:
    - Exact keyword matches (BM25 should find)
    - Semantic matches (vector should find, BM25 might miss)
    - Cross-domain matches (entity from different domain but same topic)
  - `eval.ts`: run BM25-only and hybrid search, compute recall@5 and recall@10
  - Print comparison table: `"BM25-only recall@10: X% | Hybrid recall@10: Y%"`
  - Add to package.json: `"eval:search": "npx tsx src/search/eval/eval.ts"`

- [ ] **TASK-HSR-18**: Update `memory_recall` tool to expose search mode
  - In `src/tools/memory-tools.ts`, add optional `searchMode` parameter to memory_recall tool schema
  - Values: `'auto'` (default — hybrid if available, else BM25), `'bm25'`, `'hybrid'`
  - Pass through to `CortexStore.recall()`
  - Include search mode used in tool response metadata

- [ ] **TASK-HSR-19**: End-to-end integration test
  - Start with empty database
  - Store 10 entities via `memory_store` with embedding provider configured
  - Verify embeddings were created (`embed --stats` shows 10 embedded)
  - Recall with semantic query (no keyword overlap) — verify entity found
  - Recall with keyword query — verify BM25 path still works
  - Disable embedding provider — verify fallback to BM25-only
