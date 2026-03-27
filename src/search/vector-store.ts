import * as sqliteVec from "sqlite-vec";
import type BetterSqlite3 from "better-sqlite3";

export interface VectorSearchResult {
  entityId: string;
  distance: number;
}

/**
 * Thin wrapper around sqlite-vec's vec0 virtual table.
 * Gracefully degrades if sqlite-vec fails to load (extension unavailable).
 */
export class VectorStore {
  private available = false;

  constructor(private db: BetterSqlite3.Database) {
    try {
      sqliteVec.load(db);
      this.ensureTable();
      this.available = true;
    } catch {
      // sqlite-vec not available — VectorStore operates as no-op
    }
  }

  get isAvailable(): boolean {
    return this.available;
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS entity_vectors USING vec0(
        entity_id TEXT PRIMARY KEY,
        embedding float[384]
      );
    `);
  }

  upsertVector(entityId: string, embedding: Float32Array): void {
    if (!this.available) return;
    try {
      // vec0 virtual tables don't support UPSERT syntax — use DELETE + INSERT
      this.db
        .prepare("DELETE FROM entity_vectors WHERE entity_id = ?")
        .run(entityId);
      this.db
        .prepare(
          "INSERT INTO entity_vectors (entity_id, embedding) VALUES (?, ?)",
        )
        .run(entityId, embedding);
    } catch {
      // Silently fail — never break the main flow
    }
  }

  searchSimilar(
    queryEmbedding: Float32Array,
    limit = 50,
  ): VectorSearchResult[] {
    if (!this.available) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT entity_id, distance
           FROM entity_vectors
           WHERE embedding MATCH ?
           ORDER BY distance
           LIMIT ?`,
        )
        .all(queryEmbedding, limit) as Array<{
        entity_id: string;
        distance: number;
      }>;
      return rows.map((r) => ({ entityId: r.entity_id, distance: r.distance }));
    } catch {
      return [];
    }
  }

  deleteVector(entityId: string): void {
    if (!this.available) return;
    try {
      this.db
        .prepare("DELETE FROM entity_vectors WHERE entity_id = ?")
        .run(entityId);
    } catch {
      // Silently fail
    }
  }

  hasVector(entityId: string): boolean {
    if (!this.available) return false;
    try {
      const row = this.db
        .prepare(
          "SELECT 1 FROM entity_vectors WHERE entity_id = ? LIMIT 1",
        )
        .get(entityId);
      return row !== undefined;
    } catch {
      return false;
    }
  }
}
