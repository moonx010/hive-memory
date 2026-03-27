# Design: large-scale-pipeline

## Overview

Three infrastructure capabilities for scaling hive-memory to team/enterprise deployments: (1) Slack Enterprise Grid bulk import for historical backfill, (2) ILM-style data lifecycle management (hot/warm/cold tiers), (3) database interface extraction with PostgreSQL adapter and expand-contract migration framework.

## Directory / File Layout

```
src/
  pipeline/
    slack-import.ts       <- NEW: Slack Enterprise Export parser + bulk importer
    lifecycle.ts          <- NEW: ILM data lifecycle manager (hot/warm/cold)
  db/
    interface.ts          <- NEW: HiveDatabaseInterface (extracted from HiveDatabase)
    database.ts           <- MODIFY: implement HiveDatabaseInterface
    pg-database.ts        <- NEW (Phase 3): PostgreSQL implementation
    pg-schema.sql         <- NEW (Phase 3): PostgreSQL DDL with pgvector + RLS
    migrations/
      types.ts            <- NEW: Migration interface + MigrationResult
      runner.ts           <- NEW: MigrationRunner (up/down/status)
      registry.ts         <- NEW: migration version registry
      v005-acl.ts         <- NEW: ACL migration (if combined with Feature 1)
  store.ts                <- MODIFY: accept HiveDatabaseInterface
  cli.ts                  <- MODIFY: add import, lifecycle, migrate subcommands
  connectors/
    slack.ts              <- MODIFY: extract entity-building into reusable function
```

## Slack Enterprise Bulk Import

### Export Format

Slack Enterprise Grid export produces a directory:
```
export/
  channels.json         -- [{id, name, is_private, is_im, is_mpim, members, ...}]
  users.json            -- [{id, name, real_name, profile: {email, display_name}, ...}]
  <channel-name>/
    2024-01-01.json     -- [{ts, text, user, thread_ts, reply_count, reactions, ...}]
    2024-01-02.json
```

### Import Pipeline

```typescript
// src/pipeline/slack-import.ts

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { HiveDatabaseInterface } from '../db/interface.js';

export interface SlackImportOptions {
  exportDir: string;
  channels?: string[];       // filter by channel name
  since?: string;            // ISO date — skip messages before this
  batchSize?: number;        // entities per transaction (default: 500)
  dryRun?: boolean;
  onProgress?: (progress: ImportProgress) => void;
}

export interface ImportProgress {
  phase: 'users' | 'channels' | 'messages';
  channel?: string;
  processed: number;
  total: number;
}

export interface SlackImportResult {
  channelsProcessed: number;
  messagesRead: number;
  entitiesCreated: number;
  entitiesSkipped: number;
  usersResolved: number;
  threadsBuilt: number;
  duration: number;
  errors: Array<{ channel: string; file: string; error: string }>;
}

export async function importSlackExport(
  db: HiveDatabaseInterface,
  options: SlackImportOptions,
): Promise<SlackImportResult> {
  const { exportDir, channels, since, batchSize = 500, dryRun = false } = options;
  const startTime = Date.now();
  const result: SlackImportResult = {
    channelsProcessed: 0, messagesRead: 0, entitiesCreated: 0,
    entitiesSkipped: 0, usersResolved: 0, threadsBuilt: 0,
    duration: 0, errors: [],
  };

  // Phase 1: Parse users.json -> person entities + aliases
  const usersPath = join(exportDir, 'users.json');
  if (existsSync(usersPath)) {
    const users = JSON.parse(readFileSync(usersPath, 'utf-8')) as SlackUser[];
    for (const user of users) {
      if (dryRun) { result.usersResolved++; continue; }
      upsertSlackUser(db, user);
      result.usersResolved++;
    }
  }

  // Phase 2: Parse channels.json -> channel metadata
  const channelsPath = join(exportDir, 'channels.json');
  const channelMeta = existsSync(channelsPath)
    ? JSON.parse(readFileSync(channelsPath, 'utf-8')) as SlackChannel[]
    : [];
  const channelMap = new Map(channelMeta.map(c => [c.name, c]));

  // Phase 3: For each channel directory, import messages
  const channelDirs = readdirSync(exportDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .filter(d => !channels || channels.includes(d.name));

  for (const dir of channelDirs) {
    const channel = channelMap.get(dir.name);
    const channelDir = join(exportDir, dir.name);
    const dayFiles = readdirSync(channelDir)
      .filter(f => f.endsWith('.json'))
      .sort(); // chronological

    for (const file of dayFiles) {
      try {
        const messages = JSON.parse(
          readFileSync(join(channelDir, file), 'utf-8')
        ) as SlackMessage[];

        const filtered = since
          ? messages.filter(m => tsToDate(m.ts) >= since)
          : messages;

        result.messagesRead += filtered.length;

        if (dryRun) continue;

        // Batch insert
        const entities = filtered.map(m => buildSlackEntity(m, channel, dir.name));
        for (let i = 0; i < entities.length; i += batchSize) {
          const batch = entities.slice(i, i + batchSize);
          const { created, skipped } = db.bulkUpsertEntities(batch);
          result.entitiesCreated += created;
          result.entitiesSkipped += skipped;
        }
      } catch (err) {
        result.errors.push({
          channel: dir.name,
          file,
          error: (err as Error).message,
        });
      }
    }
    result.channelsProcessed++;
    options.onProgress?.({
      phase: 'messages',
      channel: dir.name,
      processed: result.channelsProcessed,
      total: channelDirs.length,
    });
  }

  result.duration = Date.now() - startTime;
  return result;
}
```

### Entity Building (reuse from Slack connector)

```typescript
// Extract from src/connectors/slack.ts into a shared function

export function buildSlackEntity(
  message: SlackMessage,
  channel: SlackChannel | undefined,
  channelName: string,
): EntityDraft {
  const isSignificant = isSignificantMessage(message);
  const visibility = deriveSlackVisibility(channel);

  return {
    id: `slack-${channelName}-${message.ts}`,
    entityType: message.thread_ts && message.thread_ts !== message.ts
      ? 'message' : 'conversation',
    project: undefined,  // Slack messages are cross-project
    namespace: 'local',
    title: message.text?.slice(0, 100),
    content: message.text ?? '',
    tags: isSignificant ? ['high-signal'] : [],
    keywords: extractKeywords(message.text ?? ''),
    attributes: {
      channelName,
      channelId: channel?.id,
      userId: message.user,
      threadTs: message.thread_ts,
      replyCount: message.reply_count ?? 0,
      reactions: message.reactions?.reduce((s, r) => s + r.count, 0) ?? 0,
    },
    source: {
      system: 'slack',
      externalId: message.ts,
      connector: 'slack',
    },
    visibility,
    domain: 'conversations',
    confidence: 'confirmed',
    contentHash: computeHash(message.text ?? ''),
  };
}
```

## Data Lifecycle Manager

```typescript
// src/pipeline/lifecycle.ts

export type DataTier = 'hot' | 'warm' | 'cold';

export interface LifecyclePolicy {
  hotDays: number;      // default: 30 — entities updated within this window
  warmDays: number;     // default: 365 — entities updated within this window
  // cold: everything older than warmDays
  preserveHighSignal: boolean;  // default: true — keep 'high-signal' tagged entities warm
  preserveDecisions: boolean;   // default: true — keep decision entities warm
}

export const DEFAULT_POLICY: LifecyclePolicy = {
  hotDays: 30,
  warmDays: 365,
  preserveHighSignal: true,
  preserveDecisions: true,
};

export interface LifecycleResult {
  archived: number;     // warm -> cold (status set to 'archived')
  preserved: number;    // would-archive but preserved by policy
  deleted: number;      // expired entities removed (expires_at past)
  totalActive: number;  // remaining active entities
}

export function runLifecycle(
  db: HiveDatabaseInterface,
  policy: LifecyclePolicy = DEFAULT_POLICY,
): LifecycleResult {
  const now = new Date().toISOString();
  const warmCutoff = subtractDays(now, policy.warmDays);

  // 1. Delete expired entities
  const deleted = db.deleteExpiredEntities();

  // 2. Archive old entities (warm -> cold)
  // Preserve high-signal and decision entities if policy says so
  const preserveConditions: string[] = [];
  if (policy.preserveHighSignal) {
    preserveConditions.push("tags NOT LIKE '%high-signal%'");
  }
  if (policy.preserveDecisions) {
    preserveConditions.push("entity_type != 'decision'");
  }

  const archiveResult = db.archiveOldEntities(warmCutoff, preserveConditions);

  return {
    archived: archiveResult.archived,
    preserved: archiveResult.preserved,
    deleted,
    totalActive: db.countEntities({ status: 'active' }),
  };
}

function subtractDays(isoDate: string, days: number): string {
  const d = new Date(isoDate);
  d.setDate(d.getDate() - days);
  return d.toISOString();
}
```

### Database Methods for Lifecycle

```typescript
// Added to HiveDatabaseInterface

deleteExpiredEntities(): number;
archiveOldEntities(
  cutoffDate: string,
  preserveConditions: string[],
): { archived: number; preserved: number };
```

```typescript
// SQLite implementation in src/db/database.ts

deleteExpiredEntities(): number {
  const result = this.db.prepare(
    `DELETE FROM entities WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`
  ).run();
  return result.changes;
}

archiveOldEntities(
  cutoffDate: string,
  preserveConditions: string[],
): { archived: number; preserved: number } {
  const preserveWhere = preserveConditions.length > 0
    ? `AND ${preserveConditions.join(' AND ')}`
    : '';

  // Count how many would be archived but are preserved
  const preserved = (this.db.prepare(`
    SELECT COUNT(*) as count FROM entities
    WHERE status = 'active'
      AND updated_at < @cutoff
      AND NOT (${preserveConditions.join(' AND ') || '1=0'})
  `).get({ cutoff: cutoffDate }) as { count: number }).count;

  // Archive eligible entities
  const result = this.db.prepare(`
    UPDATE entities SET status = 'archived', updated_at = datetime('now')
    WHERE status = 'active'
      AND updated_at < @cutoff
      ${preserveWhere}
  `).run({ cutoff: cutoffDate });

  return { archived: result.changes, preserved };
}
```

## Database Interface Extraction

```typescript
// src/db/interface.ts

import type { Entity, Synapse, ConnectorConfig } from '../types.js';
import type { ACLContext } from '../acl/types.js';

export interface SearchEntitiesOptions {
  project?: string;
  entityType?: string;
  domain?: string;
  namespace?: string;
  limit?: number;
  acl?: ACLContext;
}

export interface ListEntitiesOptions extends SearchEntitiesOptions {
  status?: string;
  since?: string;
  orderBy?: 'created_at' | 'updated_at';
  order?: 'asc' | 'desc';
}

export interface CountEntitiesOptions {
  project?: string;
  entityType?: string;
  domain?: string;
  namespace?: string;
  status?: string;
}

export interface VectorSearchOptions extends SearchEntitiesOptions {
  // inherits all filter options
}

export interface VectorResult {
  entityId: string;
  distance: number;
}

export interface BulkUpsertResult {
  created: number;
  skipped: number;  // content_hash duplicates
}

export interface HiveDatabaseInterface {
  // Entity CRUD
  upsertEntity(entity: Partial<Entity> & { id: string; content: string }): void;
  getEntity(id: string, acl?: ACLContext): Entity | null;
  listEntities(options: ListEntitiesOptions): Entity[];
  searchEntities(query: string, options: SearchEntitiesOptions): Entity[];
  countEntities(options: CountEntitiesOptions): number;
  deleteEntity(id: string): void;
  bulkUpsertEntities(entities: Array<Partial<Entity> & { id: string; content: string }>): BulkUpsertResult;

  // Synapse CRUD
  upsertSynapse(synapse: Partial<Synapse> & { source: string; target: string; axon: string }): void;
  getSynapses(entityId: string, direction?: 'outgoing' | 'incoming' | 'both'): Synapse[];
  deleteSynapse(id: string): void;

  // Vector operations (optional — not all backends support)
  initVectorTable?(dimensions: number): void;
  vectorSearch?(queryEmbedding: number[], options: VectorSearchOptions): VectorResult[];
  upsertEmbedding?(entityId: string, embedding: number[]): void;
  deleteEmbedding?(entityId: string): void;
  hasEmbedding?(entityId: string): boolean;
  countMissingEmbeddings?(): number;

  // Lifecycle
  deleteExpiredEntities(): number;
  archiveOldEntities(cutoffDate: string, preserveConditions: string[]): { archived: number; preserved: number };

  // Projects, Sessions, Connectors (existing)
  upsertProject(project: Record<string, unknown>): void;
  getProject(id: string): Record<string, unknown> | null;
  listProjects(): Record<string, unknown>[];

  // Connection management
  close(): void;
}
```

## Expand-Contract Migration Framework

```typescript
// src/db/migrations/types.ts

export interface Migration {
  version: number;
  name: string;
  description: string;
  up(db: HiveDatabaseInterface): void;
  down(db: HiveDatabaseInterface): void;
}

export interface MigrationRecord {
  version: number;
  name: string;
  appliedAt: string;
  direction: 'up' | 'down';
}

export interface MigrationStatus {
  currentVersion: number;
  pendingMigrations: Migration[];
  appliedMigrations: MigrationRecord[];
}

export interface MigrationResult {
  migrationsRun: number;
  currentVersion: number;
  errors: Array<{ version: number; error: string }>;
}
```

```typescript
// src/db/migrations/runner.ts

export class MigrationRunner {
  constructor(
    private db: HiveDatabaseInterface,
    private rawDb: Database,  // raw better-sqlite3 for DDL
  ) {
    // Ensure migrations table exists
    this.rawDb.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        direction  TEXT NOT NULL DEFAULT 'up'
      );
    `);
  }

  migrate(targetVersion?: number): MigrationResult {
    const current = this.currentVersion();
    const pending = this.getPendingMigrations(current, targetVersion);

    const result: MigrationResult = {
      migrationsRun: 0,
      currentVersion: current,
      errors: [],
    };

    for (const migration of pending) {
      try {
        migration.up(this.db);
        this.rawDb.prepare(
          'INSERT INTO migrations (version, name, applied_at, direction) VALUES (?, ?, ?, ?)'
        ).run(migration.version, migration.name, new Date().toISOString(), 'up');
        result.migrationsRun++;
        result.currentVersion = migration.version;
      } catch (err) {
        result.errors.push({
          version: migration.version,
          error: (err as Error).message,
        });
        break; // Stop on first failure
      }
    }

    return result;
  }

  rollback(steps = 1): MigrationResult {
    const current = this.currentVersion();
    const toRollback = this.getAppliedMigrations()
      .slice(-steps)
      .reverse();

    const result: MigrationResult = {
      migrationsRun: 0,
      currentVersion: current,
      errors: [],
    };

    for (const record of toRollback) {
      const migration = this.findMigration(record.version);
      if (!migration) continue;

      try {
        migration.down(this.db);
        this.rawDb.prepare(
          'INSERT INTO migrations (version, name, applied_at, direction) VALUES (?, ?, ?, ?)'
        ).run(record.version, `rollback-${record.name}`, new Date().toISOString(), 'down');
        result.migrationsRun++;
        result.currentVersion = record.version - 1;
      } catch (err) {
        result.errors.push({
          version: record.version,
          error: (err as Error).message,
        });
        break;
      }
    }

    return result;
  }

  status(): MigrationStatus {
    return {
      currentVersion: this.currentVersion(),
      pendingMigrations: this.getPendingMigrations(this.currentVersion()),
      appliedMigrations: this.getAppliedMigrations(),
    };
  }

  private currentVersion(): number {
    const row = this.rawDb.prepare(
      "SELECT MAX(version) as v FROM migrations WHERE direction = 'up'"
    ).get() as { v: number | null } | undefined;
    return row?.v ?? 0;
  }

  // ... helper methods
}
```

## PostgreSQL Schema (Phase 3)

```sql
-- src/db/pg-schema.sql

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Entities table (mirrors SQLite schema)
CREATE TABLE IF NOT EXISTS entities (
  id                TEXT PRIMARY KEY,
  entity_type       TEXT NOT NULL DEFAULT 'memory',
  project           TEXT,
  namespace         TEXT NOT NULL DEFAULT 'local',
  title             TEXT,
  content           TEXT NOT NULL,
  tags              JSONB NOT NULL DEFAULT '[]',
  keywords          JSONB NOT NULL DEFAULT '[]',
  attributes        JSONB NOT NULL DEFAULT '{}',
  source_system     TEXT NOT NULL DEFAULT 'agent',
  source_external_id TEXT,
  source_url        TEXT,
  source_connector  TEXT,
  author            TEXT,
  visibility        TEXT NOT NULL DEFAULT 'private',
  domain            TEXT NOT NULL DEFAULT 'code',
  confidence        TEXT NOT NULL DEFAULT 'confirmed',
  owner_id          TEXT REFERENCES users(id),
  required_labels   JSONB NOT NULL DEFAULT '[]',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'active',
  superseded_by     TEXT,
  content_hash      TEXT,
  -- Vector embedding (pgvector)
  embedding         vector(1536)
);

-- Full-text search index (GIN tsvector)
CREATE INDEX IF NOT EXISTS idx_entities_fts ON entities
  USING GIN (to_tsvector('english', coalesce(title, '') || ' ' || content));

-- pgvector index (IVF for >10K entities)
CREATE INDEX IF NOT EXISTS idx_entities_embedding ON entities
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Standard indexes
CREATE INDEX IF NOT EXISTS idx_entities_project ON entities(project);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(status);
CREATE INDEX IF NOT EXISTS idx_entities_created ON entities(created_at);
CREATE INDEX IF NOT EXISTS idx_entities_owner ON entities(owner_id);
CREATE INDEX IF NOT EXISTS idx_entities_visibility ON entities(visibility);

-- Row-Level Security (RLS)
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;

-- Policy: users see public, team, org, and own private entities
CREATE POLICY entity_read_policy ON entities FOR SELECT
  USING (
    visibility = 'public'
    OR visibility IN ('team', 'org')
    OR (visibility = 'private' AND owner_id = current_setting('app.current_user_id', TRUE))
    OR current_setting('app.current_user_role', TRUE) = 'admin'
  );

-- Synapses, projects, sessions, connectors tables mirror SQLite schema
-- (omitted for brevity — same structure with TIMESTAMPTZ instead of TEXT for dates)
```

## CLI Commands

```bash
# Slack Enterprise Export import
hive-memory import slack /path/to/export [--channels general,engineering] [--since 2024-01-01] [--dry-run]
# Output: Imported 15,432 entities from 12 channels (43 skipped as duplicates) in 3m 22s

# Data lifecycle
hive-memory lifecycle run [--hot-days 30] [--warm-days 365] [--dry-run]
# Output: Archived 2,341 entities | Preserved 156 (high-signal/decisions) | Deleted 23 (expired) | Active: 8,543

hive-memory lifecycle status
# Output:
#   Hot (0-30d):    1,234 entities
#   Warm (30d-1y):  7,309 entities
#   Cold (archived): 2,341 entities
#   Total:          10,884 entities

# Migration management
hive-memory migrate                    # Run pending migrations
hive-memory migrate --rollback         # Rollback last migration
hive-memory migrate --rollback 3       # Rollback last 3 migrations
hive-memory migrate --status           # Show migration status
hive-memory migrate --dry-run          # Show what would run
```

## Key Design Decisions

1. **Reuse Slack connector entity-building logic.** The bulk import and incremental connector share the same `buildSlackEntity` function. No divergent code paths.
2. **Lifecycle uses existing `status` field.** No new column needed. `archived` is already a valid EntityStatus. FTS5 index and vector search already filter by `status = 'active'`.
3. **Preserve high-signal and decision entities.** These are the most valuable knowledge artifacts — they should never auto-archive. Explicit archival only.
4. **Database interface is thin, not an ORM.** Methods map 1:1 to current HiveDatabase API. No query builder abstraction. Each backend writes its own SQL.
5. **PostgreSQL uses JSONB for tags/keywords/attributes.** Unlike SQLite (TEXT with JSON strings), PostgreSQL can natively index and query JSONB. This enables efficient label-based ACL queries.
6. **Expand-contract over destructive migrations.** `down()` must not lose data. Adding a column is easy to roll back (ignore it). Removing a column requires a contract step (separate migration after verifying nothing reads the old column).
