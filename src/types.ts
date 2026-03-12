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
  embedding: number[];
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
  centroid: number[];
  count: number;
}

export interface HiveBranchCell {
  id: string;
  type: "branch";
  summary: string;
  keywords: string[];
  centroid: number[];
  count: number;
  children: string[];
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
