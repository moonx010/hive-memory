/**
 * Connector Framework — types and registry for external data source connectors.
 * Each connector fetches raw documents from an external system and transforms
 * them into EntityDraft objects ready for ingestion into the Hive store.
 */

export type SyncPhase = "initial" | "incremental" | "rollback";

export interface SyncHistoryEntry {
  phase: SyncPhase;
  startedAt: string;
  completedAt?: string;
  added: number;
  updated: number;
  skipped: number;
  errors: number;
  lastError?: string;
}

export interface ConnectorPlugin {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Entity types this connector produces */
  readonly entityTypes: string[];
  /** Domains this connector populates */
  readonly domains: string[];

  /** Check if connector is configured (has required credentials) */
  isConfigured(): boolean;

  /** Full sync — yield everything available */
  fullSync(): AsyncGenerator<RawDocument>;

  /** Incremental sync — yield documents changed since cursor */
  incrementalSync(cursor?: string): AsyncGenerator<RawDocument>;

  /** Transform a raw document into zero or more entity drafts */
  transform(doc: RawDocument): EntityDraft[];

  /** Get the current sync cursor (ISO date or opaque string) */
  getCursor(): string | undefined;

  /** Optional: re-sync entities from the past N hours to catch retroactive edits/deletes.
   *  Only called during ROLLBACK phase. Falls back to incrementalSync if not implemented. */
  rollbackSync?(window: { since: string; until: string }): AsyncGenerator<RawDocument>;

  /** Optional post-sync hook for creating synapses after all entities are upserted.
   *  entityMap maps source.externalId → entity.id for all entities processed in this sync. */
  postSync?(db: import("../db/database.js").HiveDatabase, entityMap: Map<string, string>): void;
}

export interface RawDocument {
  externalId: string;
  source: string;
  content: string;
  title?: string;
  url?: string;
  author?: string;
  timestamp: string;
  metadata: Record<string, unknown>;
  /** Set to true when the source system reports this entity as deleted/archived.
   *  syncConnector() will mark the corresponding entity as status: "archived". */
  _deleted?: boolean;
}

export interface EntityDraft {
  entityType: string;
  project?: string;
  title?: string;
  content: string;
  tags: string[];
  attributes: Record<string, unknown>;
  source: { system: string; externalId: string; url?: string; connector: string };
  author?: string;
  domain: string;
  confidence: "confirmed" | "inferred";
  /** Optional status override (e.g., "archived" for cancelled events) */
  status?: "active" | "superseded" | "archived";
  /** ACL fields derived from source system */
  visibility?: "private" | "dm" | "team" | "org" | "public" | "personal";
  aclMembers?: string[];
  ownerId?: string;
}

export interface ConnectorRegistry {
  register(connector: ConnectorPlugin): void;
  get(id: string): ConnectorPlugin | undefined;
  list(): ConnectorPlugin[];
}

/**
 * Create a new in-memory ConnectorRegistry.
 */
export function createConnectorRegistry(): ConnectorRegistry {
  const store = new Map<string, ConnectorPlugin>();

  return {
    register(connector: ConnectorPlugin): void {
      store.set(connector.id, connector);
    },

    get(id: string): ConnectorPlugin | undefined {
      return store.get(id);
    },

    list(): ConnectorPlugin[] {
      return Array.from(store.values());
    },
  };
}
