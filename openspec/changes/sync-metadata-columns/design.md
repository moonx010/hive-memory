# Design: sync-metadata-columns

## Metadata Stamping in syncConnector()

In `src/store.ts`, within the sync loop, stamp metadata on every entity encounter:

```typescript
// Sync metadata to stamp on all entities (inserted, updated, or skipped)
const syncMeta = {
  _lastSyncedAt: new Date().toISOString(),
  _syncCursor: cursor ?? null,
  _syncPhase: phase,
  _syncConnector: connectorId,
  _sourceDeleted: false,
};

for await (const doc of gen) {
  try {
    // Handle deletions
    if (doc._deleted) {
      const existing = db.getByExternalId(doc.source, doc.externalId);
      if (existing) {
        db.updateEntityAttributes(existing.id, {
          ...syncMeta,
          _sourceDeleted: true,
        });
        if (existing.status !== "archived") {
          db.updateEntity(existing.id, { status: "archived" });
          archived++;
        }
      }
      continue;
    }

    const drafts = connector.transform(doc);

    for (const draft of drafts) {
      try {
        const existing = db.getByExternalId(draft.source.system, draft.source.externalId);

        if (existing) {
          const incomingHash = computeContentHash(draft.title, draft.content);
          const existingHash = db.getContentHash(existing.id);

          if (existingHash !== null && existingHash === incomingHash) {
            // Content unchanged — still stamp sync metadata
            db.updateEntityAttributes(existing.id, syncMeta);
            entityMap.set(draft.source.externalId, existing.id);
            skipped++;
            continue;
          }

          db.updateEntity(existing.id, {
            title: draft.title,
            content: draft.content,
            tags: draft.tags,
            attributes: { ...draft.attributes, ...syncMeta },
            status: draftStatus,
            updatedAt: new Date().toISOString(),
          });
          entityMap.set(draft.source.externalId, existing.id);
          updated++;
        } else {
          // Insert new entity with sync metadata
          const entity: Entity = {
            // ... existing entity construction ...
            attributes: { ...draft.attributes, ...syncMeta },
          };
          db.insertEntity(entity);
          entityMap.set(draft.source.externalId, entity.id);
          added++;
        }
      } catch (err) {
        errors++;
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
  } catch (err) {
    errors++;
    lastError = err instanceof Error ? err.message : String(err);
  }
}
```

## memory_inspect Enhancement

In `src/tools/browse-tools.ts`, add a sync provenance section to the inspect output:

```typescript
// Inside memory_inspect handler, after the main entity display
if (entity.source?.connector) {
  const syncProvenance = [
    `## Sync Provenance`,
    `| Field | Value |`,
    `|-------|-------|`,
    `| Last Synced | ${entity.attributes?._lastSyncedAt ?? "never"} |`,
    `| Sync Cursor | ${entity.attributes?._syncCursor ?? "N/A"} |`,
    `| Sync Phase | ${entity.attributes?._syncPhase ?? "N/A"} |`,
    `| Connector | ${entity.attributes?._syncConnector ?? entity.source.connector} |`,
    `| Source Deleted | ${entity.attributes?._sourceDeleted ? "Yes" : "No"} |`,
    `| Content Hash | ${entity.contentHash?.slice(0, 12) ?? "N/A"}... |`,
  ].join("\n");

  sections.push(syncProvenance);
}
```

## Staleness Detection in memory_audit

In `src/steward/index.ts`, add staleness check:

```typescript
// In the audit function
async function checkStaleness(db: HiveDatabase): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const staleDays = 7;
  const staleThreshold = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000).toISOString();

  // Find connector-sourced entities not synced recently
  const entities = db.listEntities({
    status: "active",
    limit: 1000,
  });

  const staleEntities = entities.filter(e => {
    if (!e.source?.connector) return false;  // Skip non-connector entities
    const lastSynced = e.attributes?._lastSyncedAt as string | undefined;
    if (!lastSynced) return true;  // Never-synced connector entities are stale
    return lastSynced < staleThreshold;
  });

  if (staleEntities.length > 0) {
    findings.push({
      severity: "warning",
      category: "staleness",
      message: `${staleEntities.length} connector-sourced entities not synced in ${staleDays}+ days`,
      entities: staleEntities.slice(0, 10).map(e => ({
        id: e.id,
        title: e.title,
        lastSynced: e.attributes?._lastSyncedAt as string ?? "never",
        connector: e.source?.connector,
      })),
    });
  }

  return findings;
}
```

## Attribute Key Conventions

All sync metadata uses underscore prefix (`_lastSyncedAt`, `_syncCursor`, etc.) consistent with the enrichment framework's conventions (`_enrichedAt`, `_enrichedBy`, `_batchId`).

Namespace summary:
| Prefix | Owner | Examples |
|--------|-------|---------|
| `_enriched*` | EnrichmentEngine | `_enrichedAt`, `_enrichedBy`, `_enrichedContentHash` |
| `_sync*` | syncConnector | `_syncCursor`, `_syncPhase`, `_syncConnector` |
| `_lastSynced*` | syncConnector | `_lastSyncedAt` |
| `_source*` | syncConnector | `_sourceDeleted` |
| `_batch*` | EnrichmentEngine | `_batchId` |
| (no prefix) | Connector/User | `repo`, `channelId`, `startTime`, etc. |
