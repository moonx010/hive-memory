/**
 * Connector Framework — types and registry for external data source connectors.
 * Each connector fetches raw documents from an external system and transforms
 * them into EntityDraft objects ready for ingestion into the Hive store.
 */

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
