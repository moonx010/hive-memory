/**
 * IHiveDatabase — database abstraction interface.
 *
 * Extracted from HiveDatabase to support future PostgreSQL migration.
 * HiveDatabase structurally satisfies this interface.
 */
import type { Entity } from "../types.js";

// ── Minimal option types (mirrors src/db/database.ts without importing it) ───

export interface IListEntitiesOptions {
  project?: string;
  entityType?: string | string[];
  domain?: string;
  namespace?: string;
  status?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface ISearchEntitiesOptions {
  project?: string;
  entityType?: string;
  domain?: string;
  namespace?: string;
  limit?: number;
}

export interface ICountEntitiesOptions {
  project?: string;
  entityType?: string;
  domain?: string;
  namespace?: string;
  status?: string;
}

export interface ISynapseRecord {
  id: string;
  source: string;
  target: string;
  axon: string;
  weight: number;
  metadata: Record<string, unknown>;
  formedAt: string;
  lastPotentiated: string;
}

// ── Interface ─────────────────────────────────────────────────────────────────

export interface IHiveDatabase {
  // Entity CRUD
  insertEntity(entity: Entity): void;
  updateEntity(id: string, updates: Partial<Omit<Entity, "id">>): { changed: boolean };
  getEntity(id: string): Entity | null;
  deleteEntity(id: string): void;

  // Search
  searchEntities(query: string, options?: ISearchEntitiesOptions): Entity[];
  listEntities(options?: IListEntitiesOptions): Entity[];
  countEntities(options?: ICountEntitiesOptions): number;

  // Synapse
  upsertSynapse(opts: {
    sourceId: string;
    targetId: string;
    axon: string;
    weight: number;
    metadata?: Record<string, string>;
  }): void;
  getSynapsesByEntry(
    entryId: string,
    direction?: "outgoing" | "incoming" | "both",
    axonType?: string,
  ): ISynapseRecord[];

  // Convenience
  upsertEntity(draft: {
    entityType: string;
    project?: string;
    title?: string;
    content: string;
    tags: string[];
    attributes: Record<string, unknown>;
    source: { system: string; externalId?: string; connector?: string };
    domain: string;
    confidence: string;
  }): string;

  // Lifecycle
  close(): void;
}
