# Change: large-scale-pipeline

**Layer:** 0 (Core Infrastructure)
**One-liner:** Slack Enterprise bulk import, ILM-style data lifecycle (hot/warm/cold), PostgreSQL migration path with expand-contract schema tooling, and time-based partitioning.
**Estimated effort:** 4 weeks
**Dependencies:** None (but designed to work with `access-control-layer` and `hybrid-search-rag`)

## Why

Current hive-memory handles individual developer memory well (100s to low 1000s of entities). But for a company-wide deployment:
- **Slack Enterprise Export** generates 100K+ messages. The current incremental connector can't backfill historical data efficiently.
- **Data growth is unbounded.** Without lifecycle management, the SQLite database grows indefinitely. A 1-year-old Slack message has low retrieval value but costs the same storage and query overhead.
- **SQLite has limits.** Single-writer lock, no concurrent reads during writes, no row-level security, no horizontal scaling. PostgreSQL with pgvector is the natural migration target.
- **Schema migrations are risky.** SQLite ALTER TABLE is limited. The current try/catch approach for column additions doesn't support column removals, type changes, or rollbacks.

Research findings support a phased approach: keep SQLite for local/small deployments, offer PostgreSQL for team/enterprise. ILM (Information Lifecycle Management) patterns from search engines (Elasticsearch hot/warm/cold) map well to memory systems where recency correlates with retrieval value.

## 5-Role Design Review

### PM — User Stories & Scope

**Target users:** Team/Enterprise (50+ person org, multi-year data)

**User stories:**
1. As an admin, I want to bulk-import our Slack Enterprise Grid export (JSON files) into hive-memory so the team has historical context from day one.
2. As an admin, I want old entities (>1 year) to be automatically archived (searchable but not in default results) to keep search fast.
3. As an admin, I want a clear migration path from SQLite to PostgreSQL when my team outgrows single-file storage.
4. As an admin, I want schema migrations that can be tested, rolled back, and run without downtime.

**Success metrics:**
- Slack Enterprise Export (100K messages) imports in < 30 minutes.
- Query latency p50 stays under 50ms even with 500K total entities (hot + warm).
- PostgreSQL migration preserves all data and entity relationships.
- Schema migrations have rollback capability.

**MVP scope:**
- Slack bulk import from Enterprise Grid export JSON format.
- Data lifecycle: hot (0-30d), warm (30d-1y), cold (>1y archive).
- PostgreSQL adapter with pgvector support.
- Expand-contract migration framework.

**Deferred to v2:**
- Automatic hot/warm/cold tier movement (cron-based).
- PostgreSQL read replicas / horizontal scaling.
- Partitioned tables in PostgreSQL.
- S3/GCS cold storage for archived entities.

### Tech Lead — Implementation Approach

**Slack Enterprise Bulk Import:**

Slack Enterprise Grid exports produce a directory structure:
```
export/
  channels.json          -- channel metadata
  users.json             -- user profiles
  integration_logs.json  -- app activity
  <channel-name>/
    2024-01-01.json      -- messages for that day
    2024-01-02.json
    ...
```

Each message JSON matches the Slack Web API format. We reuse existing Slack connector entity-building logic.

```typescript
// src/pipeline/slack-import.ts

export interface SlackImportOptions {
  exportDir: string;           // path to extracted export
  channels?: string[];         // filter to specific channels (default: all)
  since?: string;              // ISO date — skip messages before this
  batchSize?: number;          // entities per transaction (default: 500)
  dryRun?: boolean;            // count without inserting
}

export interface SlackImportResult {
  channelsProcessed: number;
  messagesRead: number;
  entitiesCreated: number;
  entitiesSkipped: number;     // duplicates (content_hash match)
  usersResolved: number;
  duration: number;            // ms
  errors: Array<{ channel: string; file: string; error: string }>;
}

export async function importSlackExport(
  db: HiveDatabase,
  options: SlackImportOptions,
): Promise<SlackImportResult> {
  // 1. Parse channels.json → build channel metadata map
  // 2. Parse users.json → upsert person entities + entity_aliases
  // 3. For each channel directory:
  //    a. Sort day files chronologically
  //    b. For each day file:
  //       - Parse messages, filter by options.since
  //       - Build EntityDraft using existing Slack connector logic
  //       - Set content_hash for dedup
  //       - Batch insert in transaction (options.batchSize)
  //    c. Build thread entities from threaded messages
  // 4. Return import stats
}
```

**Data Lifecycle (ILM):**

```typescript
// src/pipeline/lifecycle.ts

export type DataTier = 'hot' | 'warm' | 'cold';

export interface LifecyclePolicy {
  hotDays: number;     // default: 30
  warmDays: number;    // default: 365
  // cold = everything older than warmDays
}

export interface LifecycleResult {
  promoted: number;    // cold -> warm (if updated recently)
  demoted: number;     // hot -> warm, warm -> cold
  archived: number;    // moved to cold
  deleted: number;     // expired entities removed
}
```

Tier implementation uses the existing `status` field:
- `hot` = `status: 'active'` AND `updated_at > now - hotDays`
- `warm` = `status: 'active'` AND `updated_at <= now - hotDays` AND `updated_at > now - warmDays`
- `cold` = `status: 'archived'` (entities older than warmDays get archived)

Search behavior by tier:
- Default search (`memory_recall`) queries hot + warm (active status).
- Explicit `memory_recall --include-archived` queries all tiers.
- `memory_decay` already handles TTL-based expiry — lifecycle extends this with tier transitions.

**PostgreSQL Adapter:**

```typescript
// src/db/pg-database.ts

import pg from 'pg';

export class PgHiveDatabase implements HiveDatabaseInterface {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async searchEntities(query: string, options: SearchEntitiesOptions): Promise<Entity[]> {
    // Uses PostgreSQL full-text search (tsvector/tsquery) instead of FTS5
    // Uses pgvector for vector search instead of sqlite-vec
    const result = await this.pool.query(`
      SELECT e.*,
        ts_rank(to_tsvector('english', e.content), plainto_tsquery('english', $1)) as rank
      FROM entities e
      WHERE to_tsvector('english', e.content) @@ plainto_tsquery('english', $1)
        AND e.status = 'active'
      ORDER BY rank DESC
      LIMIT $2
    `, [query, options.limit ?? 20]);
    return result.rows.map(rowToEntity);
  }

  // ... all other HiveDatabaseInterface methods
}
```

**Database Interface Extraction:**

The key refactor: extract `HiveDatabaseInterface` from the current `HiveDatabase` class, then implement both SQLite and PostgreSQL backends.

```typescript
// src/db/interface.ts

export interface HiveDatabaseInterface {
  // Entity CRUD
  upsertEntity(entity: Entity): void;
  getEntity(id: string, acl?: ACLContext): Entity | null;
  listEntities(options: ListEntitiesOptions): Entity[];
  searchEntities(query: string, options: SearchEntitiesOptions): Entity[];
  countEntities(options: CountEntitiesOptions): number;
  deleteEntity(id: string): void;

  // Synapse CRUD
  upsertSynapse(synapse: Synapse): void;
  getSynapses(entityId: string): Synapse[];
  deleteSynapse(id: string): void;

  // Vector operations (optional)
  vectorSearch?(queryEmbedding: number[], options: VectorSearchOptions): VectorResult[];
  upsertEmbedding?(entityId: string, embedding: number[]): void;

  // Lifecycle
  close(): void;
}
```

**Expand-Contract Migration Framework:**

```typescript
// src/db/migrations/types.ts

export interface Migration {
  version: number;
  name: string;
  up(db: HiveDatabaseInterface): Promise<void>;    // expand
  down(db: HiveDatabaseInterface): Promise<void>;   // contract (rollback)
}

// src/db/migrations/runner.ts
export class MigrationRunner {
  constructor(private db: HiveDatabaseInterface) {}

  async migrate(targetVersion?: number): Promise<MigrationResult>;
  async rollback(steps?: number): Promise<MigrationResult>;
  async status(): Promise<MigrationStatus>;
}
```

**File changes:**
- `src/pipeline/slack-import.ts` — NEW: Slack Enterprise Export importer
- `src/pipeline/lifecycle.ts` — NEW: ILM data lifecycle manager
- `src/db/interface.ts` — NEW: HiveDatabaseInterface extraction
- `src/db/pg-database.ts` — NEW: PostgreSQL implementation
- `src/db/pg-schema.sql` — NEW: PostgreSQL schema with pgvector + RLS
- `src/db/migrations/types.ts` — NEW: Migration interface
- `src/db/migrations/runner.ts` — NEW: MigrationRunner
- `src/db/migrations/v5-acl.ts` — NEW: ACL migration (if combined with Feature 1)
- `src/db/database.ts` — MODIFY: implement HiveDatabaseInterface
- `src/store.ts` — MODIFY: accept HiveDatabaseInterface instead of HiveDatabase
- `src/cli.ts` — MODIFY: add `import`, `lifecycle`, `migrate` subcommands

### SRE Engineer — Performance & Operations

**Bulk import performance:**
- 100K Slack messages at 500/transaction = 200 transactions. SQLite WAL mode handles this well.
- Estimated time: 5-10 minutes (bottleneck: content_hash computation + dedup check).
- Memory: streaming JSON parsing (read one day-file at a time), not loading entire export into memory.
- Disk: 100K entities with avg 500 bytes content = ~50 MB in SQLite. With embeddings: +600 MB.

**Lifecycle impact on query performance:**
- Archiving old entities reduces the active dataset size. FTS5 index only includes active entities (existing `status = 'active'` filter).
- 500K entities total, 50K hot, 100K warm, 350K cold: search queries scan ~150K entities (hot + warm). BM25 on 150K is ~10ms.
- sqlite-vec brute-force on 150K vectors: ~75ms. Acceptable.

**PostgreSQL resource requirements:**
- PostgreSQL 15+ with pgvector extension.
- Minimum: 2 CPU, 4 GB RAM, 10 GB disk (for 500K entities).
- Connection pooling: pg.Pool with max 10 connections.
- pgvector IVF index for >100K vectors: `CREATE INDEX ON entity_embeddings USING ivfflat (embedding vector_cosine_ops)`.

**Monitoring:**
- Track lifecycle transitions (entities promoted/demoted/archived per day).
- Track import progress (entities/sec, errors).
- Track migration status (current version, pending migrations).
- For PostgreSQL: connection pool utilization, query latency p50/p95/p99.

### Security Engineer — Threat Analysis

**Slack Export security:**
- Enterprise Grid exports may contain PII, credentials in messages, file URLs. Hive-memory stores content as-is — no PII scrubbing in v1.
- Import should log which channels are processed but NOT log message content.
- Export files should be deleted after import (user responsibility — document in CLI output).

**PostgreSQL security:**
- Row-level security (RLS) for ACL enforcement at the database level (defense in depth beyond application-level ACL).
- Connection string contains credentials — store in env var, not config file.
- TLS required for non-localhost connections.
- pgvector embeddings are stored in the database — same security posture as entity content.

**Migration security:**
- Rollback must not lose data — expand-contract pattern ensures old columns/tables remain until explicitly contracted.
- Migration history table records who ran what migration and when (audit trail).

### Devil's Advocate — Sanity Check

**Is PostgreSQL migration over-engineering?**
For current scale (single developer, <10K entities): absolutely yes. For the stated vision (company-wide context layer, 50+ users, 500K+ entities): it's necessary. BUT — we should not build a full ORM or database abstraction layer. The interface extraction is the right approach: thin interface, two concrete implementations.

**Recommendation: PostgreSQL is Week 3-4, and can be deferred entirely.**
The SQLite implementation with lifecycle management covers 90% of use cases. PostgreSQL only becomes necessary when:
- Concurrent write contention is a real problem (multiple connectors syncing simultaneously).
- Data exceeds 1M entities (sqlite-vec brute-force becomes slow).
- Enterprise security requires RLS.

**Simplest 80% version:**
1. Slack bulk import (Week 1-2): huge immediate value for teams adopting hive-memory.
2. Data lifecycle (Week 2): keeps SQLite fast as data grows.
3. Database interface extraction (Week 3): prepares for PostgreSQL without implementing it.
4. PostgreSQL adapter (Week 4 or deferred): implement only when a real user needs it.

**Can we keep SQLite longer?**
Yes. SQLite WAL mode supports concurrent readers. Single-writer is acceptable when writes are batched (connector syncs run sequentially). The lifecycle manager keeps the active dataset small. SQLite is viable up to ~500K active entities.

## Consensus Decision

**Approved scope (adjusted per Devil's Advocate):**
- Phase 1 (Weeks 1-2): Slack Enterprise bulk import + data lifecycle manager.
- Phase 2 (Week 3): Database interface extraction (`HiveDatabaseInterface`), expand-contract migration framework.
- Phase 3 (Week 4, deferrable): PostgreSQL adapter with pgvector. Only build if there's a concrete deployment need.
- Deferred: automatic lifecycle cron, PostgreSQL partitioning, S3 cold storage.

**Key design decisions:**
1. Slack import reuses existing connector entity-building logic — not a separate code path.
2. Lifecycle uses existing `status` field (no new column). `archived` status = cold tier.
3. Database interface is a thin extraction, not an ORM. Both SQLite and PostgreSQL implement the same interface.
4. Expand-contract migrations replace the current try/catch ALTER TABLE pattern. Migrations are versioned, reversible, and recorded.
5. PostgreSQL adapter is explicitly optional. Single-file SQLite remains the default and recommended deployment.

## Acceptance Criteria

1. `hive-memory import slack /path/to/export` imports 10K+ messages from Slack Enterprise Grid export in under 5 minutes.
2. Duplicate messages (same content_hash) are skipped, not duplicated.
3. Users from `users.json` are resolved to person entities with entity_aliases.
4. `hive-memory lifecycle run` archives entities older than `warmDays` (default 365), setting status to 'archived'.
5. `memory_recall` by default excludes archived entities; `--include-archived` includes them.
6. `HiveDatabaseInterface` extracted and both `HiveDatabase` (SQLite) and `PgHiveDatabase` (PostgreSQL) implement it.
7. `hive-memory migrate` runs pending migrations; `hive-memory migrate --rollback` reverts the last migration.
8. Migration history is stored in `migrations` table with version, name, applied_at.

## Impact

- **New directory:** `src/pipeline/` (~2 files, ~400 lines)
- **New directory:** `src/db/migrations/` (~3 files, ~300 lines)
- **New file:** `src/db/interface.ts` (~80 lines)
- **New file:** `src/db/pg-database.ts` (~500 lines, Phase 3)
- **New file:** `src/db/pg-schema.sql` (~100 lines, Phase 3)
- **Modified:** `src/db/database.ts` — implements HiveDatabaseInterface
- **Modified:** `src/store.ts` — accepts HiveDatabaseInterface, lifecycle integration
- **Modified:** `src/cli.ts` — add `import`, `lifecycle`, `migrate` subcommands
- **New npm dependency (Phase 3 only):** `pg` (PostgreSQL client)
- **No new dependencies for Phase 1-2** (Slack import uses filesystem + existing Slack connector types)
