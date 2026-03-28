/**
 * Synapse operations — standalone functions that operate on a raw BetterSqlite3 database.
 * HiveDatabase delegates to these functions.
 */
import BetterSqlite3 from "better-sqlite3";
import crypto from "node:crypto";
import type { SynapseRecord } from "./database.js";

// ── Row type ─────────────────────────────────────────────────────────────────

interface SynapseRow {
  id: string;
  source: string;
  target: string;
  axon: string;
  weight: number;
  metadata: string;
  formed_at: string;
  last_potentiated: string;
}

interface CoactivationRow {
  pair_key: string;
  count: number;
}

// ── Row converter ─────────────────────────────────────────────────────────────

export function rowToSynapse(row: SynapseRow): SynapseRecord {
  return {
    id: row.id,
    source: row.source,
    target: row.target,
    axon: row.axon,
    weight: row.weight,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    formedAt: row.formed_at,
    lastPotentiated: row.last_potentiated,
  };
}

// ── Synapse CRUD ──────────────────────────────────────────────────────────────

export function insertSynapse(db: BetterSqlite3.Database, synapse: SynapseRecord): void {
  db.prepare(`
    INSERT INTO synapses (id, source, target, axon, weight, metadata, formed_at, last_potentiated)
    VALUES (@id, @source, @target, @axon, @weight, @metadata, @formed_at, @last_potentiated)
    ON CONFLICT(source, target, axon) DO UPDATE SET
      weight = MIN(1.0, weight + 0.1),
      last_potentiated = excluded.last_potentiated
  `).run({
    id: synapse.id,
    source: synapse.source,
    target: synapse.target,
    axon: synapse.axon,
    weight: synapse.weight,
    metadata: JSON.stringify(synapse.metadata),
    formed_at: synapse.formedAt,
    last_potentiated: synapse.lastPotentiated,
  });
}

export function upsertSynapse(db: BetterSqlite3.Database, opts: {
  sourceId: string;
  targetId: string;
  axon: string;
  weight: number;
  metadata?: Record<string, string>;
}): void {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO synapses (id, source, target, axon, weight, metadata, formed_at, last_potentiated)
    VALUES (@id, @source, @target, @axon, @weight, @metadata, @formed_at, @last_potentiated)
    ON CONFLICT(source, target, axon) DO UPDATE SET
      weight = excluded.weight,
      metadata = excluded.metadata,
      last_potentiated = excluded.last_potentiated
  `).run({
    id,
    source: opts.sourceId,
    target: opts.targetId,
    axon: opts.axon,
    weight: Math.min(1.0, Math.max(0.0, opts.weight)),
    metadata: JSON.stringify(opts.metadata ?? {}),
    formed_at: now,
    last_potentiated: now,
  });
}

export function getSynapsesByEntry(
  db: BetterSqlite3.Database,
  entryId: string,
  direction: "outgoing" | "incoming" | "both" = "both",
  axonType?: string,
): SynapseRecord[] {
  const params: Record<string, unknown> = { entryId };
  const axonFilter = axonType ? "AND axon = @axonType" : "";
  if (axonType) params.axonType = axonType;

  let sql: string;
  if (direction === "outgoing") {
    sql = `SELECT * FROM synapses WHERE source = @entryId ${axonFilter}`;
  } else if (direction === "incoming") {
    sql = `SELECT * FROM synapses WHERE target = @entryId ${axonFilter}`;
  } else {
    sql = `SELECT * FROM synapses WHERE (source = @entryId OR target = @entryId) ${axonFilter}`;
  }

  const rows = db.prepare(sql).all(params) as SynapseRow[];
  return rows.map(rowToSynapse);
}

export function getSynapsesByAxon(db: BetterSqlite3.Database, axon: string): SynapseRecord[] {
  const rows = db
    .prepare("SELECT * FROM synapses WHERE axon = ?")
    .all(axon) as SynapseRow[];
  return rows.map(rowToSynapse);
}

export function getNeighborIds(
  db: BetterSqlite3.Database,
  entryId: string,
  direction: "outgoing" | "incoming" | "both" = "both",
): string[] {
  const params: Record<string, unknown> = { entryId };
  let sql: string;

  if (direction === "outgoing") {
    sql = "SELECT target AS neighbor FROM synapses WHERE source = @entryId";
  } else if (direction === "incoming") {
    sql = "SELECT source AS neighbor FROM synapses WHERE target = @entryId";
  } else {
    sql = `
      SELECT target AS neighbor FROM synapses WHERE source = @entryId
      UNION
      SELECT source AS neighbor FROM synapses WHERE target = @entryId
    `;
  }

  const rows = db.prepare(sql).all(params) as { neighbor: string }[];
  return rows.map((r) => r.neighbor);
}

export function updateSynapseWeight(db: BetterSqlite3.Database, id: string, weight: number): void {
  db
    .prepare("UPDATE synapses SET weight = ?, last_potentiated = ? WHERE id = ?")
    .run(Math.min(1.0, Math.max(0.0, weight)), new Date().toISOString(), id);
}

export function applyDecay(db: BetterSqlite3.Database, factor = 0.95, pruneThreshold = 0.05): number {
  const now = new Date().toISOString();
  db
    .prepare("UPDATE synapses SET weight = weight * ?, last_potentiated = ?")
    .run(factor, now);
  return db
    .prepare("DELETE FROM synapses WHERE weight < ?")
    .run(pruneThreshold).changes;
}

// ── Coactivation ──────────────────────────────────────────────────────────────

export function recordCoactivation(db: BetterSqlite3.Database, entryIds: string[]): void {
  const stmt = db.prepare(`
    INSERT INTO coactivations (pair_key, count)
    VALUES (?, 1)
    ON CONFLICT(pair_key) DO UPDATE SET count = count + 1
  `);

  db.transaction((ids: string[]) => {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i] < ids[j] ? ids[i] : ids[j];
        const b = ids[i] < ids[j] ? ids[j] : ids[i];
        stmt.run(`${a}:${b}`);
      }
    }
  })(entryIds);
}

export function getCoactivationAboveThreshold(db: BetterSqlite3.Database, threshold: number): { pairKey: string; count: number }[] {
  const rows = db
    .prepare(
      "SELECT pair_key, count FROM coactivations WHERE count >= ? ORDER BY count DESC",
    )
    .all(threshold) as CoactivationRow[];
  return rows.map((r) => ({ pairKey: r.pair_key, count: r.count }));
}
