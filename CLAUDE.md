# Hive Memory — Unified Memory System for AI Agents

## Project Overview
MCP server that gives AI agents persistent, browsable memory across projects and domains.
Evolving from single-developer coding memory (v2) toward company-wide context layer (v3).
Stores entities (decisions, learnings, documents, conversations, people) in a SQLite-backed graph with FTS5 search, synapse connections, and Hebbian learning.

## Tech Stack
- TypeScript, Node.js (ES modules)
- MCP SDK (`@modelcontextprotocol/sdk`)
- SQLite via `better-sqlite3` (FTS5 full-text search, WAL mode)
- Storage: `~/.cortex/cortex.db` (SQLite) + legacy JSON fallback
- No external services — everything runs locally

## Architecture

### v3 (Current) — SQLite + Entity Model
- **Database**: Single SQLite file with FTS5 virtual table for full-text search
  - `entities` table: unified entity model (memory, reference, decision, person, document, conversation, message, meeting, task, event, snippet)
  - `synapses` table: weighted directed graph (14 axon types)
  - `coactivations` table: Hebbian learning pairs
  - `projects`, `sessions`, `connectors` tables
- **Search**: FTS5 BM25 + spreading activation + RRF fusion
- **24 MCP tools**: 10 v2-compatible + 14 new (browse, trail, connectors, team)

### v2 (Legacy, auto-migrated) — JSON Cell Tree
- Hive cell tree (`hive.json` + `cells/*.json`) with keyword-based clustering
- Beam search (width=3, Jaccard similarity)
- Auto-migrated to SQLite on first v3 run

### Tool Categories
**Project** (4): `project_register`, `project_search`, `project_status`, `project_onboard`
**Memory** (5): `memory_store`, `memory_recall`, `memory_link`, `memory_traverse`, `memory_connections`
**Session** (1): `session_save`
**Browse** (5): `memory_ls`, `memory_tree`, `memory_grep`, `memory_inspect`, `memory_timeline`
**Trail** (3): `memory_trail`, `memory_who`, `memory_decay`
**Connector** (2): `connector_sync`, `connector_status`
**Team** (4): `team_init`, `team_push`, `team_pull`, `team_status`

## Module Structure

### Core
- `src/store.ts` — CortexStore facade: integrates DB, hive, team, connectors
- `src/db/database.ts` — HiveDatabase: SQLite operations (sync API, better-sqlite3)
- `src/db/schema.ts` — SQLite schema definition (7 tables, FTS5, triggers)
- `src/db/migrate-v2.ts` — JSON → SQLite migration
- `src/db/adapter.ts` — AsyncHiveDb: async wrapper with extended helpers
- `src/types.ts` — All TypeScript types (v2 + v3)

### Search & Graph
- `src/store/hive-search.ts` — HiveSearch: beam search + spreading activation
- `src/store/hive-index.ts` — Keyword extraction, Jaccard similarity, cell splitting
- `src/store/synapse-store.ts` — SynapseStore: graph + LTP/LTD + Hebbian learning
- `src/store/activation.ts` — Spreading activation algorithm

### Storage (v2 legacy, kept for backward compat)
- `src/store/hive-store.ts` — HiveStore: nursery + cell tree + JSON I/O
- `src/store/memory-store.ts`, `project-store.ts`, `session-store.ts`
- `src/store/context-sync.ts` — Cross-project insights + `.cortex.md` sync
- `src/store/io.ts` — Atomic file I/O, `src/store/lock.ts` — File-based lock

### Connectors (Phase 2-3)
- `src/connectors/types.ts` — ConnectorPlugin interface + registry
- `src/connectors/github.ts` — GitHub: PRs, Issues, ADRs, CODEOWNERS
- `src/connectors/slack.ts` — Slack: signal-filtered messages + threads
- `src/connectors/notion.ts` — Notion: pages, databases, block content

### Team (Phase 2)
- `src/team/git-sync.ts` — Git-based team cortex (per-entry JSON files)

### Tools
- `src/tools/index.ts` — Tool registration (all 24 tools)
- `src/tools/browse-tools.ts` — ls, tree, grep, inspect, timeline
- `src/tools/trail-tools.ts` — trail, who, decay
- `src/tools/connector-tools.ts` — sync, status
- `src/tools/team-tools.ts` — init, push, pull, status
- `src/tools/memory-tools.ts`, `project-tools.ts`, `session-tools.ts` (v2)

### Hooks
- `src/hooks/session-end.ts` — SessionEnd auto-capture
- `src/hooks/transcript-parser.ts` — JSONL transcript parsing

## CLI Commands
```bash
hive-memory                    # MCP server mode (default)
hive-memory store ...          # Store memory
hive-memory recall ...         # Search memories
hive-memory status ...         # Project status
hive-memory stats              # Database statistics
hive-memory sync <connector>   # Run connector sync
hive-memory team init <path>   # Initialize team cortex
hive-memory team push/pull     # Team sync
hive-memory hook session-end   # Auto session capture
hive-memory cleanup            # Remove expired entries
```

## Conventions
- `src/` — TypeScript source
- `tests/` — vitest tests (125 tests across 11 files)
- Build: `npm run build`, Dev: `npm run dev`, Test: `npm test`
- All new code uses SQLite; legacy JSON path kept for backward compat
