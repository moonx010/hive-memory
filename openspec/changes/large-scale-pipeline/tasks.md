# Tasks: large-scale-pipeline

**Estimated effort:** 4 weeks
**Dependencies:** None (works alongside access-control-layer and hybrid-search-rag)

## Phase 1: Slack Enterprise Bulk Import (Week 1-2)

- [ ] **TASK-LSP-01**: Extract shared entity builder from Slack connector
  - In `src/connectors/slack.ts`, refactor entity-building logic into exported function `buildSlackEntity(message, channel, channelName)`
  - Extract `isSignificantMessage(message)` as exported function
  - Extract `deriveSlackVisibility(channel)` as exported function (reuses ACL source-inherit if available)
  - Ensure existing Slack connector still works (calls the extracted functions)
  - Add tests for extracted functions

- [ ] **TASK-LSP-02**: Create `src/pipeline/slack-import.ts` — parser
  - Implement `parseSlackExportDir(exportDir)` — validate directory structure
  - Parse `channels.json` -> `Map<string, SlackChannel>` with channel metadata
  - Parse `users.json` -> `SlackUser[]` with profile data
  - Implement `parseDayFile(filePath)` -> `SlackMessage[]` (single day's messages)
  - Handle malformed JSON gracefully (skip file, log error)
  - Implement `tsToDate(ts)` — Slack timestamp to ISO date conversion

- [ ] **TASK-LSP-03**: Implement user resolution in bulk import
  - `upsertSlackUser(db, slackUser)`: create/update person entity for each Slack user
  - Set entity_aliases: `alias_system='slack'`, `alias_value=user.id`, `alias_type='external_id'`
  - Set additional alias for email if present: `alias_system='email'`, `alias_value=user.profile.email`
  - Deduplicate: check existing entity_aliases before creating new person entity
  - Return mapping: `Map<slackUserId, hivememoryEntityId>`

- [ ] **TASK-LSP-04**: Add `bulkUpsertEntities()` to `HiveDatabase`
  - Accept array of entity drafts
  - Wrap in single transaction for performance
  - Skip entities where `content_hash` already exists (dedup)
  - Return `{ created: number, skipped: number }`
  - Use prepared statement (reuse across batch for performance)

- [ ] **TASK-LSP-05**: Implement `importSlackExport()` main function
  - Orchestrate: parse users -> resolve users -> iterate channel dirs -> parse day files -> batch insert
  - Filter by `options.channels` (channel name filter)
  - Filter by `options.since` (date filter)
  - Batch inserts with `options.batchSize` (default 500)
  - Emit progress via `options.onProgress` callback
  - Track and return `SlackImportResult` stats
  - Handle thread messages: group by `thread_ts`, build conversation entities

- [ ] **TASK-LSP-06**: Add `import slack` CLI subcommand
  - `hive-memory import slack <export-dir> [--channels c1,c2] [--since DATE] [--batch-size N] [--dry-run]`
  - Validate export directory exists and has expected structure
  - Print progress: `"Channel [name]: {n} messages imported"`
  - Print summary: `"Imported {created} entities from {channels} channels ({skipped} duplicates) in {duration}"`
  - Dry run: parse and count without inserting
  - Add to CLI help text

- [ ] **TASK-LSP-07**: Add tests for Slack bulk import
  - Create fixture: minimal Slack export directory with 3 channels, 2 users, 50 messages
  - Test: import creates correct number of entities
  - Test: duplicate import (same content_hash) skips already-imported messages
  - Test: `--channels` filter imports only specified channels
  - Test: `--since` filter skips old messages
  - Test: user resolution creates person entities with correct aliases
  - Test: thread messages grouped into conversation entities
  - Test: import handles malformed day file (skips, reports error)
  - Test: dry run returns counts without inserting

## Phase 2: Data Lifecycle Manager (Week 2)

- [ ] **TASK-LSP-08**: Implement `src/pipeline/lifecycle.ts`
  - Define `LifecyclePolicy` interface with `hotDays`, `warmDays`, `preserveHighSignal`, `preserveDecisions`
  - Define `DEFAULT_POLICY` constant (hot=30, warm=365, preserve both)
  - Implement `runLifecycle(db, policy)`:
    - Step 1: `db.deleteExpiredEntities()` — remove entities past expires_at
    - Step 2: `db.archiveOldEntities(cutoff, preserveConditions)` — set status='archived' for old entities
    - Return `LifecycleResult` with counts
  - Implement `getLifecycleStatus(db, policy)` — count entities in each tier

- [ ] **TASK-LSP-09**: Add lifecycle database methods to `HiveDatabase`
  - `deleteExpiredEntities()`: DELETE WHERE expires_at < now, return changes count
  - `archiveOldEntities(cutoffDate, preserveConditions)`:
    - Build WHERE clause: `status = 'active' AND updated_at < cutoff AND [preserveConditions]`
    - UPDATE SET status = 'archived'
    - Return `{ archived: changes, preserved: count of preserved }`
  - `getEntityCountByTier(hotCutoff, warmCutoff)`:
    - Return `{ hot: count, warm: count, cold: count, total: count }`

- [ ] **TASK-LSP-10**: Add `lifecycle` CLI subcommand
  - `hive-memory lifecycle run [--hot-days N] [--warm-days N] [--dry-run]`
  - `hive-memory lifecycle status`
  - Print formatted output with tier counts
  - Dry run: show what would be archived without doing it
  - Add to CLI help text

- [ ] **TASK-LSP-11**: Add `--include-archived` flag to search tools
  - In `memory_recall`: add optional `includeArchived` parameter
  - When true, remove `status = 'active'` filter (or change to `status IN ('active', 'archived')`)
  - Default: false (existing behavior unchanged)
  - Apply to `memory_ls`, `memory_grep`, `memory_timeline` as well
  - Document in tool descriptions

- [ ] **TASK-LSP-12**: Add tests for lifecycle manager
  - Setup: create entities with various updated_at dates (1 week, 3 months, 2 years ago)
  - Test: `runLifecycle` archives entities older than warmDays
  - Test: entities with 'high-signal' tag are preserved when preserveHighSignal=true
  - Test: decision entities are preserved when preserveDecisions=true
  - Test: expired entities (expires_at past) are deleted
  - Test: `getLifecycleStatus` returns correct tier counts
  - Test: default policy preserves decisions and high-signal

## Phase 3: Database Interface + Migration Framework (Week 3)

- [ ] **TASK-LSP-13**: Create `src/db/interface.ts` — HiveDatabaseInterface
  - Extract interface from current `HiveDatabase` public methods
  - Include: entity CRUD, synapse CRUD, search, count, list
  - Include: optional vector methods (vectorSearch, upsertEmbedding)
  - Include: lifecycle methods (deleteExpiredEntities, archiveOldEntities)
  - Include: bulk operations (bulkUpsertEntities)
  - Include: project, session, connector methods
  - Export interface and all related option types

- [ ] **TASK-LSP-14**: Refactor `HiveDatabase` to implement `HiveDatabaseInterface`
  - Add `implements HiveDatabaseInterface` to class declaration
  - Verify all interface methods are implemented (TypeScript will enforce)
  - No logic changes — purely a type-level refactor
  - Update `src/store.ts` to accept `HiveDatabaseInterface` instead of `HiveDatabase`
  - Verify all existing tests still pass

- [ ] **TASK-LSP-15**: Create migration framework in `src/db/migrations/`
  - `types.ts`: `Migration` interface (version, name, description, up, down)
  - `types.ts`: `MigrationRecord`, `MigrationStatus`, `MigrationResult` types
  - `runner.ts`: `MigrationRunner` class
    - Constructor: create `migrations` table if not exists
    - `migrate(targetVersion?)`: run pending migrations in order
    - `rollback(steps?)`: run down() for last N migrations
    - `status()`: return current version + pending + applied
    - `currentVersion()`: MAX(version) from migrations table where direction='up'
  - `registry.ts`: array of all migrations, sorted by version

- [ ] **TASK-LSP-16**: Add `migrate` CLI subcommand
  - `hive-memory migrate`: run all pending migrations
  - `hive-memory migrate --rollback [N]`: rollback last N migrations (default 1)
  - `hive-memory migrate --status`: show current version, pending, applied
  - `hive-memory migrate --dry-run`: show what would run without executing
  - Print migration names and versions as they run
  - Exit with error code on migration failure

- [ ] **TASK-LSP-17**: Add tests for migration framework
  - Test: `migrate()` runs pending migrations in version order
  - Test: `migrate()` skips already-applied migrations
  - Test: `rollback(1)` calls `down()` on last applied migration
  - Test: `status()` returns correct pending count
  - Test: migration failure stops execution (doesn't run subsequent migrations)
  - Test: rollback records `direction: 'down'` in migrations table
  - Test: re-migrate after rollback applies the migration again

## Phase 4: PostgreSQL Adapter (Week 4, deferrable)

- [ ] **TASK-LSP-18**: Create PostgreSQL schema in `src/db/pg-schema.sql`
  - Mirror SQLite schema with PostgreSQL types (TIMESTAMPTZ, JSONB, TEXT)
  - Add pgvector extension and `embedding vector(1536)` column on entities
  - Add GIN index for full-text search: `to_tsvector('english', content)`
  - Add IVF index for pgvector: `USING ivfflat (embedding vector_cosine_ops)`
  - Add Row-Level Security (RLS) policies for ACL enforcement
  - Include all indexes from SQLite schema

- [ ] **TASK-LSP-19**: Implement `PgHiveDatabase` in `src/db/pg-database.ts`
  - Implement `HiveDatabaseInterface` using `pg` (node-postgres) Pool
  - `searchEntities`: use `to_tsvector/plainto_tsquery` instead of FTS5
  - `vectorSearch`: use pgvector `<=>` operator for cosine distance
  - `upsertEntity`: use `INSERT ... ON CONFLICT DO UPDATE`
  - `bulkUpsertEntities`: use `COPY` or multi-row INSERT for performance
  - JSONB columns (tags, keywords, attributes) use native PostgreSQL JSON ops
  - Set `app.current_user_id` session variable for RLS enforcement
  - Connection pooling via `pg.Pool`

- [ ] **TASK-LSP-20**: Add PostgreSQL-specific tests
  - Skip tests if `CORTEX_PG_URL` env var is not set (CI-friendly)
  - Test: entity CRUD (upsert, get, list, search, delete)
  - Test: full-text search returns correct results
  - Test: vector search returns results ordered by distance
  - Test: RLS enforcement (set different user IDs, verify visibility)
  - Test: bulkUpsertEntities with 1000 entities completes in <5 seconds

- [ ] **TASK-LSP-21**: Add database factory and env var routing
  - `createDatabase(config)` factory function:
    - If `CORTEX_DB=postgres` and `CORTEX_PG_URL` set -> return `PgHiveDatabase`
    - Default -> return `HiveDatabase` (SQLite)
  - Update `src/store.ts` to use factory
  - Document env vars: `CORTEX_DB`, `CORTEX_PG_URL`

- [ ] **TASK-LSP-22**: SQLite to PostgreSQL data migration script
  - `hive-memory migrate --to-postgres --pg-url <URL>`
  - Read all entities from SQLite, write to PostgreSQL in batches
  - Migrate: entities, synapses, entity_aliases, projects, sessions, connectors
  - Verify row counts match after migration
  - Print progress and summary
  - Does NOT delete SQLite data (user can verify before switching)
