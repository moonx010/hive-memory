# Change: content-hash-dedup

**Layer:** 1 (Data Ingestion)
**One-liner:** Add content_hash column to entities table; skip re-enrichment and avoid unnecessary updates when content is unchanged across syncs.
**Estimated effort:** 3 days
**Dependencies:** None
**Priority:** P1

## Design Review

### PM Perspective

**User problem:** Every connector sync re-processes and re-enriches entities even when the upstream content has not changed. For a GitHub connector syncing 500 PRs, this means 500 unnecessary `updateEntity` calls plus 500 wasted enrichment cycles. Users running `connector_sync` on a schedule (e.g., every 30 minutes) see wasted compute, slower syncs, and misleading `updated` counts.

**Success metrics:**
- Incremental sync of unchanged content completes in <10% of full sync time
- `syncConnector()` returns `updated: 0` when no content has actually changed
- Enrichment `enrichBatch({ unenrichedOnly: true })` correctly skips entities whose content_hash is unchanged since last enrichment

**Priority justification:** This is the single highest-ROI optimization for the sync pipeline. Without it, every other feature (rollback sync, metadata columns) amplifies wasted work. LlamaIndex's docstore uses this exact pattern to achieve 100x speedup on re-indexing.

### Tech Lead Perspective

**Implementation approach:**
1. Add `content_hash TEXT` column to `entities` table in `src/db/schema.ts` (schema v3 migration)
2. Compute SHA-256 hash of `content + title` at insert/update time in `HiveDatabase.insertEntity()` and `HiveDatabase.updateEntity()` (lines ~260-320 in `src/db/database.ts`)
3. In `syncConnector()` (line 517-528 of `src/store.ts`), before calling `db.updateEntity()`, compare incoming content_hash with existing entity's content_hash. Skip update if identical.
4. Add `_contentHashAt` attribute alongside `_enrichedAt` so enrichment can check if content changed since last enrichment.

**File changes:**
- `src/db/schema.ts` — Add `content_hash TEXT` column, bump to `SCHEMA_VERSION = 3`, add migration
- `src/db/database.ts` — Compute hash in `insertEntity()`, `updateEntity()`, `upsertEntity()`. Add `getContentHash(id)` method.
- `src/store.ts` — Add hash comparison in `syncConnector()` loop (line ~517)
- `src/enrichment/engine.ts` — Check content_hash vs `_enrichedContentHash` before running providers

**Risk assessment:** LOW. This is an additive column with no breaking changes. Existing entities get `content_hash = NULL` which means they'll always be processed on first encounter (safe default). SHA-256 is fast (~100ns per hash for typical entity content).

### Architect Perspective

**System design impact:** Minimal. The content_hash column sits alongside existing columns. No new tables, no schema relationship changes.

**Data model changes:**
```sql
ALTER TABLE entities ADD COLUMN content_hash TEXT;
CREATE INDEX idx_entities_content_hash ON entities(content_hash);
```

The hash is computed as `SHA-256(title + '\0' + content)` — using a null byte separator to avoid collisions between `title="ab" content="c"` and `title="a" content="bc"`.

**Integration points:**
- `HiveDatabase.insertEntity()` — compute hash on insert
- `HiveDatabase.updateEntity()` — compute hash on update, return boolean `changed`
- `syncConnector()` — skip update when hash matches
- `EnrichmentEngine.enrichEntity()` — skip re-enrichment when `_enrichedContentHash === content_hash`

### Devil's Advocate

**What could go wrong?**
- Hash collisions: SHA-256 collision probability is astronomically low (2^-128). Not a practical concern.
- Metadata-only changes: If a connector updates `tags` or `attributes` without changing `content`, the hash stays the same. This is actually desired behavior — content-based dedup should ignore metadata.
- NULL hash for existing entities: All pre-existing entities will have `content_hash = NULL`, so they'll be processed on first sync after migration. This is a one-time cost.

**Over-engineering concerns:**
- Could we just compare `updatedAt` timestamps? No — `updatedAt` is set by hive-memory, not by the source system. A re-sync sets a new `updatedAt` even if content is identical.
- Could we skip the column and do in-memory comparison? Yes, but that requires loading full content from DB for every entity during sync, which is expensive for large datasets.

**Alternative simpler approaches:**
- Store hash in `attributes._contentHash` instead of a dedicated column. Simpler migration (no schema change), but no index support and JSON parsing overhead for every comparison. REJECTED — the performance benefit of a native column + index outweighs migration simplicity.

### Consensus Decision

**Go** — Unanimous.

**Scope adjustments:**
- Include enrichment-side hash checking (compare content_hash vs `_enrichedContentHash` attribute) since this is the primary consumer of the dedup signal.
- Index on `content_hash` is optional for P1 — add it but don't block on it.

**Implementation order:** First among P1 features. Connector state machine (Feature 2) builds on this.

## Acceptance Criteria

1. New entities inserted via `insertEntity()` have `content_hash` populated with SHA-256 hex string.
2. `updateEntity()` recomputes `content_hash`; returns indicator of whether content actually changed.
3. `syncConnector()` skips `updateEntity()` call when incoming content hash matches existing entity's hash. Logs `[sync:${id}] skipped (unchanged)` at debug level.
4. After sync of unchanged content, `syncConnector()` returns `{ added: 0, updated: 0, skipped: N }`.
5. `enrichEntity()` skips providers when `entity.attributes._enrichedContentHash === entity.contentHash` (unless `force: true`).
6. Schema migration from v2 to v3 runs without error; existing entities have `content_hash = NULL`.
7. Re-running `enrichBatch()` on already-enriched, unchanged entities processes 0 entities.

## Impact

- **Modified:** `src/db/schema.ts` — add column, bump version, add migration (~15 lines)
- **Modified:** `src/db/database.ts` — compute hash in insert/update/upsert, add return type change (~30 lines)
- **Modified:** `src/store.ts` — add hash comparison in syncConnector loop (~15 lines), add `skipped` to return type
- **Modified:** `src/enrichment/engine.ts` — add content hash check in enrichEntity (~10 lines)
- **No new dependencies** — uses built-in `node:crypto` for SHA-256
