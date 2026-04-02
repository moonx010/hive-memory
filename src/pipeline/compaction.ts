/**
 * Memory Compaction — periodic maintenance to keep the knowledge graph healthy.
 *
 * 1. Semantic auto-linking: create synapses between entities with keyword overlap
 * 2. Duplicate merging: consolidate near-duplicate entities
 * 3. Weak edge pruning: remove synapses with decayed weight below threshold
 * 4. Stale entity archival: archive old, unconnected, low-value entities
 * 5. Orphan cleanup: remove entities with no content value and no connections
 */

import type { HiveDatabase } from "../db/database.js";
import crypto from "node:crypto";

export interface CompactionResult {
  linksCreated: number;
  duplicatesMerged: number;
  edgesPruned: number;
  entitiesArchived: number;
  orphansRemoved: number;
  duration: number;
}

export interface CompactionOptions {
  /** Minimum keyword Jaccard similarity to create a semantic link (default 0.4) */
  linkThreshold?: number;
  /** Minimum content similarity ratio to consider entities duplicates (default 0.85) */
  dupThreshold?: number;
  /** Prune synapses with weight below this (default 0.05) */
  edgePruneWeight?: number;
  /** Archive entities not updated in this many days and with 0-1 connections (default 180) */
  staleDays?: number;
  /** Max entities to process per run (default 1000) */
  batchSize?: number;
  /** Dry run — report what would happen without making changes */
  dryRun?: boolean;
}

const DEFAULT_OPTIONS: Required<CompactionOptions> = {
  linkThreshold: 0.4,
  dupThreshold: 0.85,
  edgePruneWeight: 0.05,
  staleDays: 180,
  batchSize: 1000,
  dryRun: false,
};

export function runCompaction(
  db: HiveDatabase,
  opts: CompactionOptions = {},
): CompactionResult {
  const start = Date.now();
  const o = { ...DEFAULT_OPTIONS, ...opts };

  let linksCreated = 0;
  let duplicatesMerged = 0;
  let edgesPruned = 0;
  let entitiesArchived = 0;
  let orphansRemoved = 0;

  try { linksCreated = semanticAutoLink(db, o); } catch (e) { console.error("[compact] auto-link failed:", e); }
  try { duplicatesMerged = mergeDuplicates(db, o); } catch (e) { console.error("[compact] merge failed:", e); }
  try { edgesPruned = pruneWeakEdges(db, o); } catch (e) { console.error("[compact] prune failed:", e); }
  try { entitiesArchived = archiveStale(db, o); } catch (e) { console.error("[compact] archive failed:", e); }
  try { orphansRemoved = removeOrphans(db, o); } catch (e) { console.error("[compact] orphan cleanup failed:", e); }

  return {
    linksCreated,
    duplicatesMerged,
    edgesPruned,
    entitiesArchived,
    orphansRemoved,
    duration: Date.now() - start,
  };
}

// ── 1. Semantic Auto-Linking ─────────────────────────────────────────────────

function semanticAutoLink(db: HiveDatabase, o: Required<CompactionOptions>): number {
  // Load entities with keywords
  const entities = db.rawDb
    .prepare(
      `SELECT id, keywords, project FROM entities
       WHERE status = 'active' AND valid_to IS NULL AND keywords != '[]'
       ORDER BY updated_at DESC LIMIT @limit`,
    )
    .all({ limit: o.batchSize }) as Array<{ id: string; keywords: string; project: string | null }>;

  // Parse keywords
  const parsed = entities.map((e) => ({
    id: e.id,
    project: e.project,
    keywords: new Set<string>(JSON.parse(e.keywords) as string[]),
  }));

  // Load existing synapse pairs to avoid duplicates
  const existingPairs = new Set<string>();
  const synapses = db.rawDb
    .prepare("SELECT source, target FROM synapses")
    .all() as Array<{ source: string; target: string }>;
  for (const s of synapses) {
    existingPairs.add(`${s.source}:${s.target}`);
    existingPairs.add(`${s.target}:${s.source}`);
  }

  let created = 0;
  const now = new Date().toISOString();

  // Compare pairs (skip same-entity, skip existing links)
  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      const a = parsed[i];
      const b = parsed[j];

      // Skip if already linked
      if (existingPairs.has(`${a.id}:${b.id}`)) continue;

      // Jaccard similarity
      const intersection = [...a.keywords].filter((k) => b.keywords.has(k)).length;
      const union = new Set([...a.keywords, ...b.keywords]).size;
      if (union === 0) continue;
      const jaccard = intersection / union;

      if (jaccard >= o.linkThreshold) {
        if (!o.dryRun) {
          const weight = Math.min(0.3 + jaccard * 0.4, 0.7); // 0.3-0.7 based on similarity
          try {
            db.rawDb
              .prepare(
                `INSERT OR IGNORE INTO synapses (id, source, target, axon, weight, metadata, formed_at, last_potentiated)
                 VALUES (@id, @source, @target, 'semantic', @weight, '{}', @now, @now)`,
              )
              .run({
                id: crypto.randomUUID(),
                source: a.id,
                target: b.id,
                weight,
                now,
              });
            existingPairs.add(`${a.id}:${b.id}`);
          } catch {
            // UNIQUE constraint — already exists
          }
        }
        created++;
      }
    }
    // Limit work: stop after creating many links in one batch
    if (created >= 200) break;
  }

  return created;
}

// ── 2. Duplicate Merging ─────────────────────────────────────────────────────

function mergeDuplicates(db: HiveDatabase, o: Required<CompactionOptions>): number {
  // Find entities with same content_hash (exact content duplicates)
  const dupes = db.rawDb
    .prepare(
      `SELECT content_hash, GROUP_CONCAT(id) as ids, COUNT(*) as cnt
       FROM entities
       WHERE status = 'active' AND content_hash IS NOT NULL AND valid_to IS NULL
       GROUP BY content_hash
       HAVING cnt > 1
       LIMIT 100`,
    )
    .all() as Array<{ content_hash: string; ids: string; cnt: number }>;

  let merged = 0;

  for (const group of dupes) {
    const ids = group.ids.split(",");
    if (ids.length < 2) continue;

    // Keep the oldest (first created), supersede the rest
    const ordered = db.rawDb
      .prepare(
        `SELECT id, created_at FROM entities WHERE id IN (${ids.map(() => "?").join(",")})
         ORDER BY created_at ASC`,
      )
      .all(...ids) as Array<{ id: string; created_at: string }>;

    const canonical = ordered[0];
    const dupeIds = ordered.slice(1);

    if (!o.dryRun) {
      for (const dupe of dupeIds) {
        try {
          db.supersede(dupe.id, canonical.id);
          merged++;
        } catch {
          // Entity may have been already superseded
        }
      }
    } else {
      merged += dupeIds.length;
    }
  }

  return merged;
}

// ── 3. Weak Edge Pruning ─────────────────────────────────────────────────────

function pruneWeakEdges(db: HiveDatabase, o: Required<CompactionOptions>): number {
  if (o.dryRun) {
    const count = db.rawDb
      .prepare("SELECT COUNT(*) as cnt FROM synapses WHERE weight < @threshold")
      .get({ threshold: o.edgePruneWeight }) as { cnt: number };
    return count.cnt;
  }

  const result = db.rawDb
    .prepare("DELETE FROM synapses WHERE weight < @threshold")
    .run({ threshold: o.edgePruneWeight });

  return result.changes;
}

// ── 4. Stale Entity Archival ─────────────────────────────────────────────────

function archiveStale(db: HiveDatabase, o: Required<CompactionOptions>): number {
  const cutoff = new Date(Date.now() - o.staleDays * 24 * 60 * 60 * 1000).toISOString();

  // Find stale entities with 0 or 1 synapse connections
  const stale = db.rawDb
    .prepare(
      `SELECT e.id FROM entities e
       LEFT JOIN synapses s ON (s.source = e.id OR s.target = e.id)
       WHERE e.status = 'active'
         AND e.updated_at < @cutoff
         AND e.valid_to IS NULL
         AND e.entity_type NOT IN ('person', 'project')
       GROUP BY e.id
       HAVING COUNT(s.id) <= 1
       LIMIT @limit`,
    )
    .all({ cutoff, limit: o.batchSize }) as Array<{ id: string }>;

  if (o.dryRun) return stale.length;

  const now = new Date().toISOString();
  let archived = 0;
  for (const { id } of stale) {
    db.rawDb
      .prepare("UPDATE entities SET status = 'archived', updated_at = @now WHERE id = @id")
      .run({ id, now });
    archived++;
  }

  return archived;
}

// ── 5. Orphan Cleanup ────────────────────────────────────────────────────────

function removeOrphans(db: HiveDatabase, o: Required<CompactionOptions>): number {
  // Orphans: archived entities with no synapses and content < 50 chars
  const orphans = db.rawDb
    .prepare(
      `SELECT e.id FROM entities e
       LEFT JOIN synapses s ON (s.source = e.id OR s.target = e.id)
       WHERE e.status = 'archived'
         AND LENGTH(e.content) < 50
       GROUP BY e.id
       HAVING COUNT(s.id) = 0
       LIMIT @limit`,
    )
    .all({ limit: o.batchSize }) as Array<{ id: string }>;

  if (o.dryRun) return orphans.length;

  let removed = 0;
  for (const { id } of orphans) {
    db.rawDb.prepare("DELETE FROM entities WHERE id = @id").run({ id });
    removed++;
  }

  return removed;
}
