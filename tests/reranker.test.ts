import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rerankResults } from '../src/search/reranker.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeResults(items: Array<{ id: string; content: string; title?: string }>) {
  return items;
}

// ── No reranker (default) ──────────────────────────────────────────────────────

describe('rerankResults — no reranker (default)', () => {
  beforeEach(() => {
    delete process.env.CORTEX_RERANKER;
  });

  it('returns original order with normalized scores', async () => {
    const results = makeResults([
      { id: 'a', content: 'first result' },
      { id: 'b', content: 'second result' },
      { id: 'c', content: 'third result' },
    ]);
    const reranked = await rerankResults('query', results);
    expect(reranked).toHaveLength(3);
    expect(reranked[0].entityId).toBe('a');
    expect(reranked[1].entityId).toBe('b');
    expect(reranked[2].entityId).toBe('c');
  });

  it('scores decrease with rank', async () => {
    const results = makeResults([
      { id: 'a', content: 'first' },
      { id: 'b', content: 'second' },
    ]);
    const reranked = await rerankResults('query', results);
    expect(reranked[0].score).toBeGreaterThan(reranked[1].score);
  });

  it('returns empty array for empty input', async () => {
    const reranked = await rerankResults('query', []);
    expect(reranked).toHaveLength(0);
  });

  it('also returns original order when CORTEX_RERANKER=none', async () => {
    process.env.CORTEX_RERANKER = 'none';
    const results = makeResults([
      { id: 'x', content: 'first' },
      { id: 'y', content: 'second' },
    ]);
    const reranked = await rerankResults('query', results);
    expect(reranked[0].entityId).toBe('x');
    expect(reranked[1].entityId).toBe('y');
    delete process.env.CORTEX_RERANKER;
  });
});

// ── Local reranker ─────────────────────────────────────────────────────────────

describe('rerankResults — local reranker', () => {
  beforeEach(() => {
    process.env.CORTEX_RERANKER = 'local';
  });
  afterEach(() => {
    delete process.env.CORTEX_RERANKER;
  });

  it('scores higher for more query-term matches', async () => {
    const query = 'database migration performance';
    const results = makeResults([
      { id: 'low', content: 'unrelated content about cats' },
      { id: 'high', content: 'database migration improves performance significantly' },
    ]);
    const reranked = await rerankResults(query, results);
    const highIdx = reranked.findIndex((r) => r.entityId === 'high');
    const lowIdx = reranked.findIndex((r) => r.entityId === 'low');
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it('uses title in scoring when provided', async () => {
    const query = 'postgres migration';
    const results = makeResults([
      { id: 'with-title', content: 'some content', title: 'postgres migration guide' },
      { id: 'no-title', content: 'unrelated content about nothing' },
    ]);
    const reranked = await rerankResults(query, results);
    expect(reranked[0].entityId).toBe('with-title');
  });

  it('respects topK limit', async () => {
    const results = makeResults([
      { id: 'a', content: 'alpha' },
      { id: 'b', content: 'beta' },
      { id: 'c', content: 'gamma' },
      { id: 'd', content: 'delta' },
    ]);
    const reranked = await rerankResults('query', results, 2);
    expect(reranked).toHaveLength(2);
  });

  it('preserves originalRank field', async () => {
    const results = makeResults([
      { id: 'first', content: 'first item' },
      { id: 'second', content: 'second item' },
    ]);
    const reranked = await rerankResults('query', results);
    const firstItem = reranked.find((r) => r.entityId === 'first');
    const secondItem = reranked.find((r) => r.entityId === 'second');
    expect(firstItem?.originalRank).toBe(0);
    expect(secondItem?.originalRank).toBe(1);
  });
});

// ── Cohere reranker fallback ───────────────────────────────────────────────────

describe('rerankResults — cohere reranker (missing API key)', () => {
  beforeEach(() => {
    process.env.CORTEX_RERANKER = 'cohere';
    delete process.env.COHERE_API_KEY;
  });
  afterEach(() => {
    delete process.env.CORTEX_RERANKER;
  });

  it('gracefully falls back to original order when no API key', async () => {
    const results = makeResults([
      { id: 'a', content: 'first' },
      { id: 'b', content: 'second' },
    ]);
    const reranked = await rerankResults('query', results);
    expect(reranked).toHaveLength(2);
    // Falls back to original order
    expect(reranked[0].entityId).toBe('a');
    expect(reranked[1].entityId).toBe('b');
  });
});
