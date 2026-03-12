# Hive Memory Architecture Design (v3)

## Overview

```
User: "How did we handle JWT in other projects?"
  ↓
Agent → MCP tool call: memory_recall("JWT auth")
  ↓
Hive Memory MCP Server → beam search through hive cell tree
  ↓
Returns:
  - Direct: "Use JWT tokens for service auth" (proj-a, decision)
  - Reference: "proj-b's MEMORY.md has JWT expiration notes" (path included)
  ↓
Agent: reads reference file if needed, applies context
```

## Core Concept: Hive Cell

All knowledge lives in a **single global cell tree** organized by semantic similarity. Two entry types coexist:

- **Direct entries**: Content stored via `memory_store` — the actual text lives in hive
- **Reference entries**: Pointers to external agent memory files — hive stores a description of what's in the file, not the file itself

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ Claude Code │  │   Cursor    │  │   Codex     │
│ MEMORY.md   │  │ .cursor/    │  │ AGENTS.md   │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │
       └────────────────┼────────────────┘
                        │ reference entries
                 ┌──────▼──────┐
                 │  Hive Cell  │ ← direct entries too
                 │  (global)   │
                 └──────┬──────┘
                        │ beam search
                 "JWT 관련 지식이 어디 있지?"
                        │
         ┌──────────────┼──────────────┐
         ▼              ▼              ▼
    [direct]       [reference]    [reference]
    proj-a의       proj-b의        proj-c의
    JWT 결정       MEMORY.md      CLAUDE.md
```

## Data Model

### Directory Structure

```
~/.cortex/
├── index.json                    # Project index (always loaded)
├── hive.json                     # Global cell tree index
├── vectors.json                  # Legacy embedding vectors (JS backend)
├── cells/                        # Leaf cell data files
│   ├── auth-jwt-a1b2.json        # Direct + reference entries mixed
│   └── db-perf-c3d4.json
├── global/
│   ├── patterns.md               # Cross-project patterns
│   └── preferences.md            # User preferences
└── projects/
    ├── acme-api/
    │   ├── summary.json          # Project summary (compact)
    │   ├── sessions/
    │   │   ├── 2026-02-25.md     # Per-session work log
    │   │   └── 2026-02-26.md
    │   └── knowledge/            # Legacy (auto-migrated → knowledge.bak/)
    └── dashboard/
        ├── summary.json
        └── ...
```

### hive.json (Global Cell Tree Index)

```json
{
  "version": 1,
  "cells": {
    "auth-jwt-a1b2": {
      "id": "auth-jwt-a1b2",
      "type": "leaf",
      "summary": "JWT authentication tokens...",
      "keywords": ["jwt", "auth", "tokens"],
      "centroid": [0.12, -0.34, ...],
      "count": 8
    },
    "root-xy12": {
      "id": "root-xy12",
      "type": "branch",
      "summary": "...",
      "keywords": [...],
      "centroid": [...],
      "count": 25,
      "children": ["auth-jwt-a1b2", "db-perf-c3d4"]
    }
  },
  "nursery": [],
  "totalEntries": 42
}
```

### Cell Data File (cells/auth-jwt-a1b2.json)

```json
{
  "cellId": "auth-jwt-a1b2",
  "entries": [
    {
      "type": "direct",
      "id": "uuid-1",
      "project": "proj-a",
      "category": "decision",
      "content": "Use JWT tokens for service-to-service auth",
      "tags": ["auth", "jwt"],
      "createdAt": "2026-03-05T10:30:00Z",
      "embedding": [0.12, -0.34, ...]
    },
    {
      "type": "reference",
      "id": "uuid-2",
      "project": "proj-b",
      "path": "/Users/user/proj-b/.claude/memory/MEMORY.md",
      "source": "claude-memory",
      "description": "JWT token expiration handling and refresh strategy",
      "tags": ["auth", "jwt"],
      "createdAt": "2026-03-05T11:00:00Z",
      "lastSynced": "2026-03-05T11:00:00Z",
      "embedding": [0.11, -0.33, ...]
    }
  ]
}
```

### Recognized External Memory Sources

| Source | File pattern | Description |
|--------|-------------|-------------|
| `claude-memory` | `~/.claude/projects/*/memory/MEMORY.md` | Claude Code auto-memory |
| `claude-project` | `{project}/CLAUDE.md` | Project-level Claude instructions |
| `codex-agents` | `{project}/AGENTS.md` | Codex agent instructions |
| `cursor-rules` | `{project}/.cursor/rules/*` | Cursor rule files |
| `custom` | User-specified | Manually registered documents |

## MCP Tools (7)

| Tool | Description |
|------|-------------|
| `project_register` | Register or update a project (upsert) |
| `project_search` | Search projects, or list all with empty query |
| `project_status` | Get context (full mode includes cross-project insights) |
| `project_onboard` | Auto-discover projects + scan for agent memory files |
| `memory_store` | Store decision/learning/note (→ direct entry) |
| `memory_recall` | Cross-project search (→ direct + reference results) |
| `session_save` | Save session progress |

## Search Algorithm

### Beam Search (O(log N))

```
search(query, options?)
  1. Embed query → 384-dim vector
  2. Extract query keywords
  3. Search nursery (brute force, small buffer)
  4. Beam search through cell tree:
     - Score = 0.7 × cosineSim(query, centroid) + 0.3 × keywordOverlap
     - Beam width = 3
     - At each level, keep top 3 candidates
     - Follow branches, collect leaves
  5. Load matching leaf cell files
  6. Score individual entries (vector + keyword + tag match)
  7. Filter by project/category if specified
  8. Return sorted results:
     - Direct → { project, category, snippet, score }
     - Reference → { project, source, path, snippet, score }
```

### Write Path

```
storeDirectEntry(project, category, content, tags)
  1. Embed content → 384-dim vector
  2. Create DirectEntry { type: "direct", content, embedding, ... }
  3. Push to nursery
  4. If nursery >= 10 → flushNursery():
     - Assign each entry to best-matching leaf (cosine similarity)
     - If no cells exist → create first leaf
     - If leaf > 20 entries → splitCell() via k-means(k=2)
```

## Cross-Project Discovery

Cross-project insights are powered by beam search — no manual grouping required.

```
project_status("dashboard", detail="full")
  → dashboard's currentFocus = "authentication"
  → memory_recall("authentication") across all projects
  → filter: exclude self, keep decision/learning + references
  → return top 3 relevant insights from other projects
```

This means registering two projects with related work automatically surfaces cross-project connections — including references to other agents' memory files.

## Auto Session Capture

Claude Code's `SessionEnd` hook triggers `hive-memory hook session-end`:

```
Claude Code session ends
  → SessionEnd hook fires
  → hive-memory hook session-end --transcript <path> --cwd <path>
  → parse JSONL transcript
  → match project by working directory
  → skip if session_save already called
  → skip if last save < 5 minutes ago
  → auto-save session summary
```

## Module Structure

```
src/
  index.ts              ← Entry point (MCP server + CLI routing)
  store.ts              ← Facade (initializes hive, auto-migrates)
  store/
    io.ts               ← readJson, writeJson, atomicWriteFile, validateId
    project-store.ts    ← Project CRUD, search, index
    memory-store.ts     ← Delegates to hive, dual-writes legacy markdown
    session-store.ts    ← saveSession, formatSessionMarkdown
    context-sync.ts     ← syncLocalContext, getCrossProjectContext
    onboard.ts          ← scanForProjects, detectProject
    hive-index.ts       ← Pure functions: centroid, cosine, keywords, kMeans2
    hive-store.ts       ← HiveStore: nursery, cells, flush, split
    hive-search.ts      ← HiveSearch: beam search through cell tree
    hive-migrate.ts     ← Legacy migration + reference scanning
  tools.ts              ← Re-export from tools/
  tools/
    index.ts            ← registerTools orchestrator
    project-tools.ts    ← project_register, search, status, onboard
    memory-tools.ts     ← memory_store, memory_recall
    session-tools.ts    ← session_save
  hooks/
    session-end.ts      ← Auto session capture handler
    transcript-parser.ts ← Claude Code JSONL parser
  embed.ts              ← Embedding service (native/JS/none)
  js-embed.ts           ← JS embedding backend
  types.ts              ← Type definitions (including Hive types)
```

## Migration

### Legacy → Hive (automatic)

On first startup, if `hive.json` has no entries:
1. Scan all projects' `knowledge/` directories
2. Parse markdown sections → direct entries
3. Embed and store in hive
4. Rename `knowledge/` → `knowledge.bak/`

### Reference Scanning (on onboard)

When `project_onboard(path, register=true)` is called:
1. Detect and register projects
2. For each project, scan for agent memory files
3. Extract description (heading summary or first 500 chars)
4. Store as reference entries in hive
