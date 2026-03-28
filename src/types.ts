export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  status: string;
}

export interface Workspace {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  createdAt: string;
  status: string;
}

export interface User {
  id: string;
  name: string;
  email?: string;
  role: string;
  createdAt: string;
  status: string;
  orgId?: string;
  workspaceId?: string;
}

export interface ProjectEntry {
  id: string;
  name: string;
  path: string;
  description: string;
  tags: string[];
  lastActive: string; // ISO 8601
  status: "active" | "paused" | "archived";
}

export interface ProjectIndex {
  projects: ProjectEntry[];
}

export interface SessionSummary {
  date: string;
  summary: string;
  nextTasks: string[];
  decisions: string[];
  learnings: string[];
}

export interface ProjectSummary {
  id: string;
  oneLiner: string;
  techStack: string[];
  modules: string[];
  currentFocus: string;
  lastSession: {
    date: string;
    summary: string;
    nextTasks: string[];
  } | null;
  stats: Record<string, unknown>;
}

export type MemoryCategory = "decision" | "learning" | "status" | "note";

export interface MemoryEntry {
  id: string;
  project: string;
  category: MemoryCategory;
  content: string;
  tags: string[];
  createdAt: string;
}

export interface OnboardCandidate {
  path: string;
  suggestedId: string;
  suggestedName: string;
  description: string;
  techStack: string[];
  modules: string[];
  tags: string[];
  alreadyRegistered: boolean;
}

export interface LocalContextConfig {
  /** Filename written into each project directory */
  filename: string;
  /** Whether to sync .cortex.md into project directories (default: true) */
  enabled?: boolean;
}

export interface CortexConfig {
  dataDir: string;
  localContext: LocalContextConfig;
}

// ── Hive Cell Types ──

export interface CellEntryBase {
  id: string;
  project: string;
  tags: string[];
  createdAt: string;
  /** @deprecated Vector embeddings removed — kept for migration compatibility */
  embedding?: number[];
}

export interface DirectEntry extends CellEntryBase {
  type: "direct";
  category: MemoryCategory;
  content: string;
  agentId?: string;
}

export interface ReferenceEntry extends CellEntryBase {
  type: "reference";
  path: string;
  source: string;
  description: string;
  lastSynced: string;
}

export type CellEntry = DirectEntry | ReferenceEntry;

export interface HiveLeafCell {
  id: string;
  type: "leaf";
  summary: string;
  keywords: string[];
  count: number;
  /** @deprecated Removed — clustering is keyword-based now */
  centroid?: number[];
}

export interface HiveBranchCell {
  id: string;
  type: "branch";
  summary: string;
  keywords: string[];
  count: number;
  children: string[];
  /** @deprecated Removed — clustering is keyword-based now */
  centroid?: number[];
}

export type HiveCell = HiveLeafCell | HiveBranchCell;

export interface HiveIndex {
  version: 1;
  cells: Record<string, HiveCell>;
  nursery: CellEntry[];
  totalEntries: number;
}

export interface HiveCellData {
  cellId: string;
  entries: CellEntry[];
}

// ── Synapse Types (Brain-Inspired Graph) ──

/**
 * Axon type — the kind of connection between two engrams (entries).
 * Named after neural axon pathways that carry specific signal types.
 */
export type AxonType =
  | "temporal"      // A occurred before B (time sequence)
  | "causal"        // A caused/led to B
  | "semantic"      // A and B are topically related
  | "refinement"    // B refines/updates A
  | "conflict"      // A and B contradict each other
  | "dependency"    // B depends on A
  | "derived";      // B was derived from A

/**
 * Synapse — a weighted, directed edge between two engrams (entries).
 * Models the biological synapse: source → target with signal strength.
 */
export interface Synapse {
  id: string;
  /** Pre-synaptic entry (source) */
  source: string;
  /** Post-synaptic entry (target) */
  target: string;
  /** Type of neural pathway */
  axon: AxonType;
  /** Synaptic strength: 0.0 (pruned) to 1.0 (strongly potentiated) */
  weight: number;
  /** Optional context about this connection */
  metadata?: Record<string, string>;
  /** When this synapse was first formed */
  formedAt: string;
  /** Last time this synapse was potentiated (LTP) */
  lastPotentiated: string;
}

/**
 * SynapseIndex — the connectome. Stores all synapses with adjacency indexes.
 */
export interface SynapseIndex {
  version: 1;
  synapses: Synapse[];
  /** Adjacency list for O(1) neighbor lookup */
  adjacency: {
    /** entryId → synapseIds where entry is source */
    outgoing: Record<string, string[]>;
    /** entryId → synapseIds where entry is target */
    incoming: Record<string, string[]>;
  };
}

/**
 * Co-activation tracking for Hebbian learning.
 * "Neurons that fire together, wire together."
 */
export interface CoactivationIndex {
  version: 1;
  /** "entryA:entryB" → co-activation count (sorted key pair) */
  counts: Record<string, number>;
}

// ── v3 Entity Types ───────────────────────────────────────────────────────────

/**
 * Entity type for v3.
 * Phase 1: memory / reference / decision
 * Phase 2: person / document
 * Phase 3: conversation / message / meeting / task / event / snippet
 */
export type EntityType =
  | "memory"
  | "reference"
  | "decision" // Phase 1
  | "person"
  | "document" // Phase 2
  | "conversation"
  | "message"
  | "meeting"
  | "task"
  | "event"
  | "snippet"; // Phase 3

/**
 * Extended axon type for v3 (adds relationship types for rich entity graph).
 * Supersedes the v2 AxonType — kept for backward compatibility.
 */
export type AxonTypeV3 =
  // v2 existing
  | "temporal"
  | "causal"
  | "semantic"
  | "refinement"
  | "conflict"
  | "dependency"
  | "derived"
  // v3 new
  | "authored"
  | "attended"
  | "mentioned"
  | "contains"
  | "supersedes"
  | "implements"
  | "belongs_to"
  | "related";

export type DomainType =
  | "code"
  | "documents"
  | "conversations"
  | "meetings"
  | "incidents"
  | "product"
  | "operations";

/** Phase 1: always 'local'. Phase 2: 'local'|'team:{id}'. Phase 3: + 'org:{id}' */
export type NamespaceType = "local" | `team:${string}` | `org:${string}`;

export type VisibilityType = "personal" | "team";

export type ConfidenceType = "confirmed" | "inferred";

export type EntityStatus = "active" | "superseded" | "archived";

export interface EntitySource {
  system: string;
  externalId?: string;
  url?: string;
  connector?: string;
}

/**
 * Entity — the core v3 unit of knowledge.
 * Replaces DirectEntry + ReferenceEntry from v2.
 */
export interface Entity {
  id: string;
  entityType: EntityType;
  project?: string;
  namespace: string;
  orgId?: string;
  title?: string;
  content: string;
  tags: string[];
  keywords: string[];
  attributes: Record<string, unknown>;
  source: EntitySource;
  author?: string;
  visibility: VisibilityType;
  domain: DomainType;
  confidence: ConfidenceType;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  status: EntityStatus;
  supersededBy?: string;
  contentHash?: string;
  /** ISO8601 — when this fact became valid (defaults to createdAt) */
  validFrom?: string;
  /** ISO8601 — when this fact was superseded/expired (null = currently valid) */
  validTo?: string;
}

export interface ConnectorConfig {
  id: string;
  connectorType: string;
  config: Record<string, unknown>;
  lastSync?: string;
  status: "idle" | "syncing" | "error";
  syncCursor?: string;
  syncPhase?: string;
  syncHistory?: string;
}
