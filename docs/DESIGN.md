# Cortex Architecture Design

## Overview

```
User: "How's the Acme API project going?"
  ↓
Agent → MCP tool call: project_search("Acme API")
  ↓
Cortex MCP Server → searches ~/.cortex/projects/
  ↓
Returns: project status, last session, next tasks
  ↓
Agent: loads context and continues the conversation
```

## Data Model

### Directory Structure

```
~/.cortex/
├── index.json                    # Project index (always loaded)
├── config.json                   # User settings
├── global/
│   ├── patterns.md               # Cross-project patterns
│   └── preferences.md            # User preferences
└── projects/
    ├── acme-api/
    │   ├── summary.json          # Project summary (compact)
    │   ├── status.md             # Current status + next tasks
    │   ├── decisions.md          # Key decisions log
    │   ├── sessions/
    │   │   ├── 2026-02-25.md     # Per-session work log
    │   │   └── 2026-02-26.md
    │   └── knowledge/
    │       ├── architecture.md   # Architecture notes
    │       └── debugging.md      # Debugging insights
    └── dashboard/
        ├── summary.json
        ├── status.md
        └── ...
```

### index.json (Project Index)

```json
{
  "projects": [
    {
      "id": "acme-api",
      "name": "Acme API",
      "path": "/home/user/projects/acme-api",
      "description": "REST API backend for Acme platform (Go)",
      "tags": ["go", "api", "rest", "backend"],
      "lastActive": "2026-02-25T14:30:00Z",
      "status": "active"
    }
  ]
}
```

### summary.json (Project Summary — token-minimal)

```json
{
  "id": "acme-api",
  "oneLiner": "REST API backend for Acme platform built with Go",
  "techStack": ["Go", "Chi", "PostgreSQL"],
  "modules": ["auth", "handlers", "middleware", "models", "migrations"],
  "currentFocus": "Implementing rate limiting middleware",
  "lastSession": {
    "date": "2026-02-25",
    "summary": "Added JWT auth middleware, wrote integration tests",
    "nextTasks": ["Add rate limiting", "Improve error responses"]
  },
  "stats": {
    "tests": 84,
    "lastBuild": "pass"
  }
}
```

## MCP Tools

### 1. project_search
Search projects with natural language.

```typescript
{
  name: "project_search",
  description: "Search for a project by name, description, or tags",
  inputSchema: {
    query: string,      // "Acme API", "go backend", "that REST project"
    limit?: number      // default 3
  }
}
// Returns: matching projects with summaries
```

### 2. project_status
Return current status of a specific project.

```typescript
{
  name: "project_status",
  description: "Get current status and context of a project",
  inputSchema: {
    project: string,    // project id
    detail?: "brief" | "full"  // default "brief"
  }
}
// brief: summary.json only
// full: summary + status.md + recent session log
```

### 3. memory_store
Store knowledge for a project.

```typescript
{
  name: "memory_store",
  description: "Store knowledge, decision, or learning for a project",
  inputSchema: {
    project: string,
    category: "decision" | "learning" | "status" | "note",
    content: string,
    tags?: string[]
  }
}
```

### 4. memory_recall
Search and recall relevant memories.

```typescript
{
  name: "memory_recall",
  description: "Recall relevant memories across projects",
  inputSchema: {
    query: string,
    project?: string,   // limit to specific project (optional)
    limit?: number
  }
}
```

### 5. session_save
Save session progress at the end of a work session.

```typescript
{
  name: "session_save",
  description: "Save session progress — what was done and what's next",
  inputSchema: {
    project: string,
    summary: string,        // what was done this session
    nextTasks?: string[],   // what to do next
    decisions?: string[],   // decisions made
    learnings?: string[]    // things learned
  }
}
```

## Phase 1 Implementation (MVP)

### Scope
- JSON/Markdown file-based storage
- Keyword matching search (exact name, tag, description)
- 5 core MCP tools
- Claude Code hooks for auto session save (stretch goal)

### Tech Stack
- TypeScript + Node.js (ESM)
- @modelcontextprotocol/sdk
- Storage: JSON/MD files under ~/.cortex/
- Search: simple string matching (includes, fuzzy matching)

### Non-scope
- Vector embeddings / semantic search (Phase 3)
- SQLite (Phase 2)
- Web UI
- Multi-user

## Group System (Hierarchical Organization)

### Overview

Projects can belong to **groups** — logical collections that share guides, knowledge, and context.
A project can belong to multiple groups (many-to-many). Groups are optional; ungrouped projects work as before.

### Directory Structure

```
~/.cortex/
├── index.json          # ProjectEntry[] (with optional groupIds)
├── groups.json         # GroupEntry[]
├── groups/
│   ├── web-team/
│   │   ├── overview.md
│   │   ├── guides/     # Shared guides (coding-standards.md, etc.)
│   │   └── knowledge/  # Group-level decisions/learnings
│   └── ml-team/
│       ├── overview.md
│       └── guides/
└── projects/           # Unchanged
```

### Data Model

```typescript
interface GroupEntry {
  id: string;           // "web-team"
  name: string;         // "Web Team"
  description: string;
  tags: string[];
  projectIds: string[];
  createdAt: string;
  lastActive: string;
}

// ProjectEntry gets: groupIds?: string[]
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `group_create` | Create a group with optional initial projects |
| `group_list` | List all groups with member count |
| `group_update` | Update metadata + addProjects/removeProjects |
| `group_context` | brief: overview + guide list / full: + guide contents + knowledge |
| `group_guide_save` | Save shared guide documents |

Modified existing tools: `project_register` (groupIds param), `project_status` (Groups section),
`project_list` (group display), `project_search` (group-name boosting), `memory_recall` (group param).

### Progressive Disclosure

```
project_status("dashboard")
  → Level 1 (~50 tokens): group name + guide list hints

group_context("web-team", detail="full")
  → Level 2: full guide contents + member project status
```

This two-level approach saves tokens by loading shared guides only when the agent determines they're needed.

## Future Phases

### Phase 2: SQLite + Full-Text Search
- JSON/MD → SQLite migration
- FTS5 for full-text search
- More complex query support

### Phase 3: Semantic Search
- sqlite-vec or local embedding model
- Hybrid search (BM25 + vector)
- Support for vague queries like "that async debugging thing"

### Phase 4: Auto-Capture
- Claude Code hooks for auto session start/end detection
- Auto session summarization (LLM call)
- Auto project status updates
