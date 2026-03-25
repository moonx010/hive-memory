# Tasks: content-hash-dedup

**Estimated effort:** 3 days
**Dependencies:** None

## Day 1: Schema + Hash Computation

- [ ] **TASK-HASH-01**: Schema migration v2 → v3
  - Add `content_hash TEXT` column to `entities` table in `src/db/schema.ts`
  - Bump `SCHEMA_VERSION` to 3
  - Add `migrateSchema(db, fromVersion)` function with v3 migration logic
  - Add `CREATE INDEX IF NOT EXISTS idx_entities_content_hash ON entities(content_hash)`
  - Add `content_hash` to `EntityRow` interface in `src/db/database.ts`

- [ ] **TASK-HASH-02**: Hash computation in HiveDatabase
  - Add `computeContentHash(title, content)` private function using `createHash("sha256")`
  - Modify `insertEntity()` to compute and store `content_hash`
  - Modify `updateEntity()` to recompute `content_hash`, return `{ changed: boolean }`
  - Modify `upsertEntity()` to compute hash on both insert and update paths
  - Add `getContentHash(id): string | null` public method
  - Update `rowToEntity()` to map `content_hash` → `contentHash`

- [ ] **TASK-HASH-03**: Add `contentHash` to Entity type
  - Add optional `contentHash?: string` field to `Entity` interface in `src/types.ts`
  - Add `content_hash` to `entityToRow()` function in `src/db/database.ts`

## Day 2: Sync + Enrichment Integration

- [ ] **TASK-HASH-04**: Content dedup in syncConnector()
  - In `src/store.ts` `syncConnector()`, before `updateEntity()` call (line ~517):
    - Compute `computeContentHash(draft.title, draft.content)`
    - Compare with `db.getContentHash(existing.id)`
    - Skip update if hashes match; increment `skipped` counter
  - Add `skipped: number` to `syncConnector()` return type
  - Log skipped entities at debug level: `[sync:${connectorId}] skipped ${skipped} unchanged`

- [ ] **TASK-HASH-05**: Enrichment content hash tracking
  - In `src/enrichment/engine.ts` `enrichEntity()`:
    - Before running providers, check `entity.attributes._enrichedContentHash === entity.contentHash`
    - If match and not `force: true`, return early with empty results
    - After successful enrichment, stamp `_enrichedContentHash` alongside `_enrichedAt`
  - Add optional `force?: boolean` parameter to `enrichEntity()` signature

- [ ] **TASK-HASH-06**: Backfill utility
  - Add `backfillContentHashes(): number` method to `HiveDatabase`
  - SELECT all entities with `content_hash IS NULL`, compute hash, UPDATE in a transaction
  - Call automatically on first `syncConnector()` if needed, or expose via CLI

## Day 3: Tests

- [ ] **TASK-HASH-07**: Unit tests for hash computation
  - Test: `insertEntity()` populates `content_hash` with 64-char hex string
  - Test: `updateEntity()` with same content returns `{ changed: false }`
  - Test: `updateEntity()` with different content returns `{ changed: true }` and new hash
  - Test: hash of `title="A" content="BC"` differs from `title="AB" content="C"` (separator test)
  - Test: entity with `content_hash = NULL` is treated as changed

- [ ] **TASK-HASH-08**: Integration tests for sync dedup
  - Test: sync same data twice → second sync returns `{ added: 0, updated: 0, skipped: N }`
  - Test: sync with modified content → returns `{ updated: 1 }`
  - Test: `skipped` count appears in sync result
  - Test: skipped entities still appear in `entityMap` for postSync synapse creation

- [ ] **TASK-HASH-09**: Integration tests for enrichment dedup
  - Test: enrich entity → change nothing → re-enrich → returns `[]` (skipped)
  - Test: enrich entity → update content → re-enrich → processes normally
  - Test: `force: true` bypasses content hash check
  - Test: `enrichBatch()` correctly skips unchanged entities
