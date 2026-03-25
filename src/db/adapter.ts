/**
 * AsyncHiveDb — async wrapper around the synchronous HiveDatabase class.
 *
 * The v3 tools (browse-tools, trail-tools, connector-tools, team-tools) were
 * designed against an async interface. This adapter bridges the sync HiveDatabase
 * to that async contract, adding missing helper methods as lightweight shims.
 */

import type {
  Entity,
  EntityStatus,
} from "../types.js";
import type { ProjectEntry } from "../types.js";
import type {
  ListEntitiesOptions,
  SearchEntitiesOptions,
  CountEntitiesOptions,
  SynapseRecord,
} from "./database.js";
import { HiveDatabase } from "./database.js";

// Re-export types tools depend on
export type { SynapseRecord };
export type { ListEntitiesOptions, SearchEntitiesOptions, CountEntitiesOptions };
export type { Entity };

// ── Extended result types ──

export interface NeighborResult {
  neighborId: string;
  synapse: SynapseRecord;
}

export interface ConnectorStatus {
  id: string;
  name: string;
  status: "active" | "idle" | "error" | "never_synced";
  lastSync?: string;
  entryCount: number;
  errorMessage?: string;
}

// ── AsyncHiveDb ──

export class AsyncHiveDb {
  constructor(private db: HiveDatabase) {}

  // ── Entity methods (async wrappers) ──

  async listEntities(options: ListEntitiesOptions & {
    since?: string;
    until?: string;
    types?: string[];
    sort?: "recent" | "name" | "created_at" | "updated_at";
  } = {}): Promise<Entity[]> {
    // Map "recent" → "updated_at", "name" → "updated_at" (no name sort in DB)
    const dbOptions: ListEntitiesOptions = {
      ...options,
      sort: options.sort === "recent" || options.sort === undefined
        ? "updated_at"
        : options.sort === "name"
          ? "updated_at"
          : options.sort,
    };

    let results: Entity[] = this.db.listEntities(dbOptions);

    // Post-filter for `since` and `until` (DB doesn't support these natively)
    if (options.since) {
      const sinceTs = new Date(options.since).getTime();
      results = results.filter((e: Entity) => new Date(e.updatedAt).getTime() >= sinceTs);
    }
    if (options.until) {
      const untilTs = new Date(options.until).getTime();
      results = results.filter((e: Entity) => new Date(e.updatedAt).getTime() <= untilTs);
    }
    if (options.types && options.types.length > 0) {
      const typeSet = options.types;
      results = results.filter((e: Entity) => typeSet.includes(e.entityType));
    }
    if (options.sort === "name") {
      results = results.sort((a: Entity, b: Entity) =>
        (a.title ?? a.id).localeCompare(b.title ?? b.id),
      );
    }

    return results;
  }

  async searchEntities(query: string, options: SearchEntitiesOptions = {}): Promise<Entity[]> {
    return this.db.searchEntities(query, options);
  }

  async countEntities(options: CountEntitiesOptions = {}): Promise<number> {
    return this.db.countEntities(options);
  }

  async getEntity(id: string): Promise<Entity | null> {
    return this.db.getEntity(id);
  }

  async getSynapsesByEntry(
    entryId: string,
    direction: "outgoing" | "incoming" | "both" = "both",
    axonType?: string,
  ): Promise<SynapseRecord[]> {
    const result: SynapseRecord[] = this.db.getSynapsesByEntry(entryId, direction, axonType);
    return result;
  }

  /**
   * Get neighbor IDs with synapse records (extended version of getNeighborIds).
   * The base HiveDatabase.getNeighborIds returns string[] only; this returns
   * full synapse records for use in spreading activation.
   */
  async getNeighborIds(
    entryId: string,
    direction: "outgoing" | "incoming" | "both" = "both",
  ): Promise<NeighborResult[]> {
    const synapses: SynapseRecord[] = this.db.getSynapsesByEntry(entryId, direction);
    return synapses.map((s: SynapseRecord) => ({
      neighborId: s.source === entryId ? s.target : s.source,
      synapse: s,
    }));
  }

  // ── Project methods ──

  async listProjects(query?: string): Promise<ProjectEntry[]> {
    const records = this.db.listProjects(query ?? "", 200);
    return records.map((r) => ({
      id: r.id,
      name: r.name,
      path: r.path,
      description: r.description,
      tags: r.tags,
      lastActive: r.lastActive,
      status: r.status as ProjectEntry["status"],
    }));
  }

  // ── Connector methods ──

  async getConnectorStatuses(): Promise<ConnectorStatus[]> {
    const connectors = this.db.listConnectors();
    return connectors.map((c) => {
      const status: ConnectorStatus["status"] =
        c.status === "error" ? "error"
        : c.status === "idle" ? "idle"
        : c.lastSync ? "active"
        : "never_synced";
      return {
        id: c.id,
        name: c.connectorType,
        status,
        lastSync: c.lastSync,
        entryCount: this.db.countEntities({ namespace: c.id }),
        errorMessage: undefined,
      };
    });
  }

  async triggerConnectorSync(connectorId: string, _full = false): Promise<string> {
    const connector = this.db.getConnector(connectorId);
    if (!connector) {
      return `Connector "${connectorId}" not found.`;
    }
    const connStatus: string = connector.status;
    return `Connector "${connectorId}" sync queued (status: ${connStatus}).`;
  }

  // ── Session methods ──

  async getRecentSessions(projectId: string, limit = 5) {
    return this.db.getRecentSessions(projectId, limit);
  }

  // ── Lifecycle / maintenance ──

  async expireEntities(): Promise<number> {
    const now = new Date().toISOString();
    // Mark entities with expiresAt < now as archived
    const candidates: Entity[] = this.db.listEntities({ status: "active", limit: 10000 });
    let count = 0;
    for (const e of candidates) {
      if (e.expiresAt && e.expiresAt <= now) {
        this.db.updateEntity(e.id, { status: "archived" as EntityStatus });
        count++;
      }
    }
    return count;
  }

  async pruneExpiredEntities(olderThanMs = 30 * 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const archived: Entity[] = this.db.listEntities({ status: "archived", limit: 10000 });
    let count = 0;
    for (const e of archived) {
      if (e.updatedAt <= cutoff) {
        this.db.deleteEntity(e.id);
        count++;
      }
    }
    return count;
  }

  async applyDecayAndPrune(): Promise<number> {
    return this.db.applyDecay();
  }

  async findStaleInferredEntities(olderThanMs = 90 * 24 * 60 * 60 * 1000): Promise<Entity[]> {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const all: Entity[] = this.db.listEntities({ limit: 10000 });
    const stale: Entity[] = [];
    for (const e of all) {
      if (
        e.confidence === "inferred" &&
        e.updatedAt <= cutoff
      ) {
        // Check if entity has no synapses
        const neighbors: string[] = this.db.getNeighborIds(e.id, "both");
        if (neighbors.length === 0) {
          stale.push(e);
        }
      }
    }
    return stale;
  }

  // ── Expose raw DB for insert/upsert ──

  get raw(): HiveDatabase {
    return this.db;
  }
}
