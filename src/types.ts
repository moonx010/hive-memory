export interface ProjectEntry {
  id: string;
  name: string;
  path: string;
  description: string;
  tags: string[];
  lastActive: string; // ISO 8601
  status: "active" | "paused" | "archived";
  groupIds?: string[]; // optional, backwards-compatible
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

export interface GroupEntry {
  id: string;           // e.g. "web-team"
  name: string;         // e.g. "Web Team"
  description: string;
  tags: string[];
  projectIds: string[];
  createdAt: string;
  lastActive: string;
}

export interface GroupIndex {
  groups: GroupEntry[];
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
  filename: ".cortex.md";
}

export interface CortexConfig {
  dataDir: string;
  localContext: LocalContextConfig;
}
