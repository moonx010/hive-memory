# Design: content-hash-dedup

## Schema Migration (v2 → v3)

In `src/db/schema.ts`:

```typescript
export const SCHEMA_VERSION = 3;

// Add to createSchema() after existing table definitions:
// Migration is handled separately in migrate() function

export function migrateSchema(db: Database, fromVersion: number): void {
  if (fromVersion < 3) {
    db.exec(`
      ALTER TABLE entities ADD COLUMN content_hash TEXT;
      CREATE INDEX IF NOT EXISTS idx_entities_content_hash ON entities(content_hash);
    `);
  }
}
```

The `content_hash` column is nullable. Existing entities have `NULL` which means "not yet computed" — they will be treated as always-dirty until their first update or a backfill migration.

## Hash Computation

In `src/db/database.ts`, add a private helper:

```typescript
import { createHash } from "node:crypto";

function computeContentHash(title: string | undefined, content: string): string {
  const hasher = createHash("sha256");
  hasher.update(title ?? "");
  hasher.update("\0");  // null byte separator to prevent title/content boundary collisions
  hasher.update(content);
  return hasher.digest("hex");
}
```

### Integration into insertEntity()

```typescript
insertEntity(entity: Entity): void {
  const contentHash = computeContentHash(entity.title, entity.content);
  // Add content_hash to the INSERT statement
  const row = entityToRow(entity);
  row.content_hash = contentHash;
  this.stmts.insertEntity.run(row);
}
```

### Integration into updateEntity()

```typescript
updateEntity(id: string, updates: Partial<Entity>): { changed: boolean } {
  const existing = this.getEntity(id);
  if (!existing) throw new Error(`Entity not found: ${id}`);

  const newTitle = updates.title ?? existing.title;
  const newContent = updates.content ?? existing.content;
  const newHash = computeContentHash(newTitle, newContent);
  const oldHash = this.getContentHash(id);

  const contentChanged = oldHash === null || oldHash !== newHash;

  // Always update metadata fields (tags, attributes, status, updatedAt)
  // But track whether content actually changed
  this.stmts.updateEntity.run({
    ...updates,
    content_hash: newHash,
    updated_at: updates.updatedAt ?? new Date().toISOString(),
    id,
  });

  return { changed: contentChanged };
}
```

### New method: getContentHash()

```typescript
getContentHash(id: string): string | null {
  const row = this.db.prepare("SELECT content_hash FROM entities WHERE id = ?").get(id) as
    { content_hash: string | null } | undefined;
  return row?.content_hash ?? null;
}
```

## syncConnector() Changes

In `src/store.ts`, the sync loop (lines 510-568) currently does:

```typescript
// Current code (line 517-528):
if (existing) {
  db.updateEntity(existing.id, { ... });
  updated++;
} else {
  // insert new entity
  added++;
}
```

**New code:**

```typescript
if (existing) {
  // Compute hash of incoming content
  const incomingHash = computeContentHash(draft.title, draft.content);
  const existingHash = db.getContentHash(existing.id);

  if (existingHash !== null && existingHash === incomingHash) {
    skipped++;
    entityMap.set(draft.source.externalId, existing.id);
    continue;  // Content unchanged — skip update
  }

  db.updateEntity(existing.id, {
    title: draft.title,
    content: draft.content,
    tags: draft.tags,
    attributes: draft.attributes,
    status: draftStatus as Entity["status"],
    updatedAt: new Date().toISOString(),
  });
  entityMap.set(draft.source.externalId, existing.id);
  updated++;
} else {
  // insert new entity (hash computed inside insertEntity)
  added++;
}
```

The return type changes from `{ added, updated, errors, lastError? }` to `{ added, updated, skipped, errors, lastError? }`.

## Enrichment Hash Tracking

In `src/enrichment/engine.ts`, after successful enrichment of an entity:

```typescript
if (enrichedBy.length > 0) {
  const entity = this.db.getEntity(entityId);
  this.db.updateEntityAttributes(entityId, {
    _enrichedAt: new Date().toISOString(),
    _enrichedBy: enrichedBy,
    _enrichedContentHash: entity?.contentHash ?? null,  // Track which content version was enriched
  });
}
```

Before running providers, add a fast-path check:

```typescript
async enrichEntity(entityId: string, opts?: { force?: boolean }): Promise<EnrichmentResult[]> {
  const entity = this.db.getEntity(entityId);
  if (!entity) throw new Error(`Entity not found: ${entityId}`);

  // Skip if content hasn't changed since last enrichment (unless forced)
  if (!opts?.force) {
    const enrichedHash = entity.attributes?._enrichedContentHash as string | undefined;
    const currentHash = entity.contentHash;
    if (enrichedHash && currentHash && enrichedHash === currentHash) {
      return [];  // Content unchanged since last enrichment
    }
  }

  // ... rest of enrichEntity logic
}
```

## Backfill Strategy

For existing entities with `content_hash = NULL`, we provide a one-time backfill:

```typescript
// In HiveDatabase
backfillContentHashes(): number {
  const entities = this.db.prepare(
    "SELECT id, title, content FROM entities WHERE content_hash IS NULL"
  ).all() as Array<{ id: string; title: string | null; content: string }>;

  const stmt = this.db.prepare("UPDATE entities SET content_hash = ? WHERE id = ?");
  const tx = this.db.transaction(() => {
    for (const e of entities) {
      const hash = computeContentHash(e.title ?? undefined, e.content);
      stmt.run(hash, e.id);
    }
    return entities.length;
  });
  return tx();
}
```

This runs automatically on first `syncConnector()` call after migration, or can be triggered via CLI.

## Entity Type Extension

Add `contentHash` to the `Entity` TypeScript type in `src/types.ts`:

```typescript
export interface Entity {
  // ... existing fields ...
  contentHash?: string;  // SHA-256 of title + content
}
```

Update `rowToEntity()` in `src/db/database.ts` to include the field:

```typescript
function rowToEntity(row: EntityRow): Entity {
  return {
    // ... existing mapping ...
    contentHash: row.content_hash ?? undefined,
  };
}
```
