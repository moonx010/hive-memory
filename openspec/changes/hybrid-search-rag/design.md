# Design: hybrid-search-rag

## Overview

Extends hive-memory's search from FTS5 BM25-only to a hybrid search pipeline: BM25 lexical + sqlite-vec cosine similarity, fused via Reciprocal Rank Fusion (RRF). Entities are embedded at ingest time with a rule-based contextual prefix. Optional cross-encoder reranking on the top-N fused results.

## Directory / File Layout

```
src/
  search/
    types.ts              <- NEW: EmbeddingProvider, SearchResult, HybridSearchOptions
    embedder.ts           <- NEW: OpenAI + Ollama embedding providers
    contextual.ts         <- NEW: buildContextualPrefix (rule-based)
    hybrid.ts             <- NEW: hybridSearch with RRF fusion
    reranker.ts           <- NEW: LLM-based cross-encoder reranking (optional)
  db/
    schema.ts             <- MODIFY: add entity_embeddings vec0 table
    database.ts           <- MODIFY: add vectorSearch, upsertEmbedding, deleteEmbedding methods
  store.ts                <- MODIFY: initialize embedder, use hybrid search in recall
  tools/
    memory-tools.ts       <- MODIFY: memory_recall routes through hybrid search
  cli.ts                  <- MODIFY: add "embed" subcommand (backfill, stats)
```

## Schema: Vector Storage

```sql
-- sqlite-vec virtual table for vector embeddings
-- Loaded via: sqliteVec.load(db) at database init
CREATE VIRTUAL TABLE IF NOT EXISTS entity_embeddings USING vec0(
  entity_id TEXT PRIMARY KEY,
  embedding float[1536]
);
```

The dimension (1536 vs 768) is determined by the configured embedding provider. sqlite-vec requires the dimension to be fixed at table creation. Strategy:
- Default: 1536 (OpenAI text-embedding-3-small).
- If `CORTEX_EMBEDDING_PROVIDER=ollama` with `nomic-embed-text`: 768 dims.
- Dimension is stored in `connectors` table metadata for runtime validation.
- Changing dimension requires dropping and recreating the vec0 table (+ re-embedding all entities).

```typescript
// In src/db/database.ts — init
import * as sqliteVec from 'sqlite-vec';

initVectorTable(dimensions: number): void {
  sqliteVec.load(this.db);
  this.db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS entity_embeddings USING vec0(
      entity_id TEXT PRIMARY KEY,
      embedding float[${dimensions}]
    );
  `);
}
```

## Embedding Provider Abstraction

```typescript
// src/search/types.ts

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[], batchSize?: number): Promise<number[][]>;
}

export interface SearchResult {
  id: string;
  entity: Entity;
  score: number;
  sources: {
    bm25Rank?: number;
    vectorRank?: number;
    rerankerScore?: number;
  };
}

export interface HybridSearchOptions {
  query: string;
  project?: string;
  entityType?: EntityType;
  domain?: DomainType;
  namespace?: string;
  limit?: number;
  acl?: ACLContext;
  rerank?: boolean;          // default: false
  rrf?: { k?: number };     // RRF constant, default 60
}
```

```typescript
// src/search/embedder.ts

export class OpenAIEmbedder implements EmbeddingProvider {
  readonly name = 'openai';
  readonly dimensions = 1536;

  constructor(
    private apiKey: string,
    private model = 'text-embedding-3-small',
  ) {}

  async embed(text: string): Promise<number[]> {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
        encoding_format: 'float',
      }),
    });
    if (!res.ok) throw new Error(`OpenAI embedding error: ${res.status}`);
    const json = await res.json() as { data: Array<{ embedding: number[] }> };
    return json.data[0].embedding;
  }

  async embedBatch(texts: string[], batchSize = 100): Promise<number[][]> {
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input: batch,
          encoding_format: 'float',
        }),
      });
      if (!res.ok) throw new Error(`OpenAI embedding error: ${res.status}`);
      const json = await res.json() as { data: Array<{ embedding: number[] }> };
      results.push(...json.data.map(d => d.embedding));
    }
    return results;
  }
}

export class OllamaEmbedder implements EmbeddingProvider {
  readonly name = 'ollama';
  readonly dimensions = 768;

  constructor(
    private baseUrl = 'http://localhost:11434',
    private model = 'nomic-embed-text',
  ) {}

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!res.ok) throw new Error(`Ollama embedding error: ${res.status}`);
    const json = await res.json() as { embeddings: number[][] };
    return json.embeddings[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Ollama /api/embed supports array input natively
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`Ollama embedding error: ${res.status}`);
    const json = await res.json() as { embeddings: number[][] };
    return json.embeddings;
  }
}

export function createEmbeddingProvider(): EmbeddingProvider | undefined {
  const provider = process.env.CORTEX_EMBEDDING_PROVIDER;
  if (!provider || provider === 'off') return undefined;

  switch (provider) {
    case 'openai': {
      const apiKey = process.env.CORTEX_EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('CORTEX_EMBEDDING_API_KEY or OPENAI_API_KEY required');
      const model = process.env.CORTEX_EMBEDDING_MODEL ?? 'text-embedding-3-small';
      return new OpenAIEmbedder(apiKey, model);
    }
    case 'ollama': {
      const baseUrl = process.env.CORTEX_EMBEDDING_BASE_URL ?? 'http://localhost:11434';
      const model = process.env.CORTEX_EMBEDDING_MODEL ?? 'nomic-embed-text';
      return new OllamaEmbedder(baseUrl, model);
    }
    default:
      throw new Error(`Unknown embedding provider: ${provider}`);
  }
}
```

## Contextual Prefix

```typescript
// src/search/contextual.ts

/**
 * Build a structured prefix that grounds the embedding in organizational context.
 * This is the "contextual RAG" approach — but rule-based instead of LLM-generated.
 * Prepended to entity content before embedding.
 */
export function buildContextualPrefix(entity: Entity): string {
  const parts: string[] = [];

  if (entity.project) parts.push(`Project: ${entity.project}`);
  parts.push(`Type: ${entity.entityType}`);
  if (entity.domain && entity.domain !== 'code') {
    parts.push(`Domain: ${entity.domain}`);
  }
  if (entity.tags.length > 0) {
    parts.push(`Topics: ${entity.tags.slice(0, 5).join(', ')}`);
  }
  if (entity.source.system !== 'agent') {
    parts.push(`Source: ${entity.source.system}`);
  }
  if (entity.title) {
    parts.push(`Title: ${entity.title}`);
  }

  const prefix = parts.join(' | ');
  return `${prefix}\n\n${entity.content}`;
}
```

## Hybrid Search with RRF Fusion

```typescript
// src/search/hybrid.ts

const DEFAULT_RRF_K = 60;

export async function hybridSearch(
  db: HiveDatabase,
  embedder: EmbeddingProvider,
  options: HybridSearchOptions,
): Promise<SearchResult[]> {
  const {
    query,
    project,
    entityType,
    domain,
    namespace,
    limit = 10,
    acl,
    rerank = false,
    rrf = {},
  } = options;

  const k = rrf.k ?? DEFAULT_RRF_K;
  const candidateLimit = Math.max(limit * 5, 50);

  // 1. BM25 lexical search
  const bm25Results = db.searchEntities(query, {
    project,
    entityType,
    domain,
    namespace,
    limit: candidateLimit,
    acl,
  });

  // 2. Vector similarity search
  const queryEmbedding = await embedder.embed(query);
  const vectorResults = db.vectorSearch(queryEmbedding, {
    limit: candidateLimit,
    project,
    entityType,
    domain,
    namespace,
    acl,
  });

  // 3. RRF fusion
  const scores = new Map<string, { score: number; bm25Rank?: number; vectorRank?: number }>();

  bm25Results.forEach((entity, rank) => {
    const entry = scores.get(entity.id) ?? { score: 0 };
    entry.score += 1 / (k + rank + 1);
    entry.bm25Rank = rank + 1;
    scores.set(entity.id, entry);
  });

  vectorResults.forEach(({ entityId, distance }, rank) => {
    const entry = scores.get(entityId) ?? { score: 0 };
    entry.score += 1 / (k + rank + 1);
    entry.vectorRank = rank + 1;
    scores.set(entityId, entry);
  });

  // 4. Sort by fused score
  let results = [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, rerank ? Math.max(limit, 20) : limit)
    .map(([id, { score, bm25Rank, vectorRank }]) => ({
      id,
      entity: db.getEntity(id)!,
      score,
      sources: { bm25Rank, vectorRank },
    }))
    .filter(r => r.entity !== null);

  // 5. Optional cross-encoder reranking
  if (rerank && results.length > 0) {
    results = await crossEncoderRerank(query, results, limit);
  }

  return results.slice(0, limit);
}
```

## Database: Vector Operations

```typescript
// Added to src/db/database.ts

upsertEmbedding(entityId: string, embedding: number[]): void {
  // Delete existing if present
  this.db.prepare('DELETE FROM entity_embeddings WHERE entity_id = ?').run(entityId);
  // Insert new
  this.db.prepare(
    'INSERT INTO entity_embeddings (entity_id, embedding) VALUES (?, ?)'
  ).run(entityId, new Float32Array(embedding));
}

deleteEmbedding(entityId: string): void {
  this.db.prepare('DELETE FROM entity_embeddings WHERE entity_id = ?').run(entityId);
}

vectorSearch(
  queryEmbedding: number[],
  options: VectorSearchOptions = {},
): Array<{ entityId: string; distance: number }> {
  const { limit = 20, project, entityType, domain, namespace, acl } = options;

  // Build filter conditions for the JOIN
  const conditions: string[] = ['e.status = \'active\''];
  const params: Record<string, unknown> = { limit };

  if (project) { conditions.push('e.project = @project'); params.project = project; }
  if (entityType) { conditions.push('e.entity_type = @entityType'); params.entityType = entityType; }
  if (domain) { conditions.push('e.domain = @domain'); params.domain = domain; }
  if (namespace) { conditions.push('e.namespace = @namespace'); params.namespace = namespace; }

  if (acl) {
    const { clause, params: aclParams } = defaultACLPolicy.sqlWhereClause(acl);
    conditions.push(clause);
    Object.assign(params, aclParams);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = this.db.prepare(`
    SELECT v.entity_id, v.distance
    FROM entity_embeddings v
    JOIN entities e ON e.id = v.entity_id
    ${whereClause}
    WHERE v.embedding MATCH @queryEmbedding
    ORDER BY v.distance
    LIMIT @limit
  `).all({ ...params, queryEmbedding: new Float32Array(queryEmbedding) }) as Array<{
    entity_id: string;
    distance: number;
  }>;

  return rows.map(r => ({ entityId: r.entity_id, distance: r.distance }));
}

hasEmbedding(entityId: string): boolean {
  const row = this.db.prepare(
    'SELECT 1 FROM entity_embeddings WHERE entity_id = ? LIMIT 1'
  ).get(entityId);
  return row !== undefined;
}

countMissingEmbeddings(): number {
  const row = this.db.prepare(`
    SELECT COUNT(*) as count FROM entities e
    WHERE e.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM entity_embeddings v WHERE v.entity_id = e.id)
  `).get() as { count: number };
  return row.count;
}
```

## Cross-Encoder Reranker

```typescript
// src/search/reranker.ts

import type { LLMProvider } from '../enrichment/types.js';
import type { SearchResult } from './types.js';

/**
 * Rerank search results using an LLM as a cross-encoder.
 * Sends (query, document) pairs and asks the LLM to score relevance 0-10.
 * Only runs on top-N candidates (default 20) for cost control.
 */
export async function crossEncoderRerank(
  query: string,
  candidates: SearchResult[],
  limit: number,
  llm?: LLMProvider,
): Promise<SearchResult[]> {
  if (!llm || candidates.length === 0) return candidates;

  const prompt = buildRerankPrompt(query, candidates.slice(0, 20));
  const response = await llm.extract<{ scores: Array<{ id: string; score: number }> }>(
    prompt,
    {
      type: 'object',
      properties: {
        scores: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, score: { type: 'number' } },
          },
        },
      },
    },
  );

  // Merge reranker scores
  const scoreMap = new Map(response.scores.map(s => [s.id, s.score]));
  return candidates
    .map(c => ({
      ...c,
      score: scoreMap.get(c.id) ?? c.score,
      sources: { ...c.sources, rerankerScore: scoreMap.get(c.id) },
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function buildRerankPrompt(query: string, candidates: SearchResult[]): string {
  const docs = candidates.map((c, i) =>
    `[${i + 1}] ID: ${c.id}\nContent: ${c.entity.content.slice(0, 300)}`
  ).join('\n\n');

  return `Rate the relevance of each document to the query on a scale of 0-10.
Query: "${query}"

Documents:
${docs}

Return JSON: { "scores": [{ "id": "...", "score": N }, ...] }`;
}
```

## Store Integration

```typescript
// In src/store.ts

class CortexStore {
  private embedder?: EmbeddingProvider;

  constructor(/* ... */) {
    // ... existing init ...
    this.embedder = createEmbeddingProvider();
    if (this.embedder) {
      this.db.initVectorTable(this.embedder.dimensions);
    }
  }

  async recall(query: string, options: RecallOptions = {}): Promise<Entity[]> {
    if (this.embedder) {
      const results = await hybridSearch(this.db, this.embedder, {
        query,
        project: options.project,
        limit: options.limit,
        acl: options.acl,
      });
      return results.map(r => r.entity);
    }
    // Fallback: BM25-only (current behavior)
    return this.db.searchEntities(query, options);
  }

  async embedEntity(entity: Entity): Promise<void> {
    if (!this.embedder) return;
    const text = buildContextualPrefix(entity);
    const embedding = await this.embedder.embed(text);
    this.db.upsertEmbedding(entity.id, embedding);
  }
}
```

## Environment Variables

```bash
# Embedding provider: 'openai' | 'ollama' | 'off' (default: off)
CORTEX_EMBEDDING_PROVIDER=openai

# API key (falls back to OPENAI_API_KEY)
CORTEX_EMBEDDING_API_KEY=sk-...

# Model name (default: text-embedding-3-small for OpenAI, nomic-embed-text for Ollama)
CORTEX_EMBEDDING_MODEL=text-embedding-3-small

# Ollama base URL (default: http://localhost:11434)
CORTEX_EMBEDDING_BASE_URL=http://localhost:11434

# Enable cross-encoder reranking (default: off)
CORTEX_RERANK=on
```

## CLI: Embed Subcommand

```bash
# Backfill embeddings for all entities without embeddings
hive-memory embed --backfill [--limit 1000] [--batch-size 100]

# Show embedding stats
hive-memory embed --stats
# Output: Entities: 5,432 | Embedded: 4,891 | Missing: 541 | Provider: openai (1536 dims)

# Re-embed specific entity
hive-memory embed --entity <entity-id>

# Re-embed all entities (regenerate with updated contextual prefix)
hive-memory embed --rebuild
```

## Key Design Decisions

1. **sqlite-vec over external vector DB.** Keeps the single-file, zero-ops architecture. Performance is acceptable under 100K entities. Migration path to pgvector exists in Feature 3.
2. **Rule-based contextual prefix, not LLM.** Zero cost, zero latency. Grounds embeddings in project/domain/source context. LLM-generated prefixes deferred to v2.
3. **RRF over weighted linear combination.** RRF is parameter-free (only k constant, default 60). No need to tune BM25/vector weights. Proven effective in MS MARCO benchmarks.
4. **Graceful degradation.** No embedding provider = BM25-only. This is critical for backward compatibility and for users who don't want API costs.
5. **Embed at ingest, not at query time.** Query-time embedding is only for the query itself (~100ms). Entity embeddings are pre-computed. This keeps search latency low.
6. **Cross-encoder reranking is opt-in.** Adds 200-500ms latency and LLM cost. Only for users who need precision over speed.
