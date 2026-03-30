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
- No outbound side effects — pure memory layer (inbound storage/search/enrichment only)
- Agent behavior (Slack posting, meeting bot orchestration) lives in jarvis

## Architecture

### v3 (Current) — SQLite + Entity Model
- **Database**: Single SQLite file with FTS5 virtual table for full-text search
  - `entities` table: unified entity model (memory, reference, decision, person, document, conversation, message, meeting, task, event, snippet)
  - `synapses` table: weighted directed graph (15 axon types)
  - `coactivations` table: Hebbian learning pairs
  - `entity_aliases` table: cross-source identity mapping (schema v5)
  - `projects`, `sessions`, `connectors` tables
- **Search**: FTS5 BM25 + spreading activation + RRF fusion
- **33 MCP tools**: 10 v2-compatible + 23 new (browse, trail, connectors, team, context, meeting, steward, advisor, user, audit)

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
**Context** (2): `context_enrich`, `entity_resolve`
**Meeting** (2): `meeting_process`, `meeting_briefing`
**Steward** (2): `memory_audit`, `memory_briefing`
**Advisor** (2): `workflow_analyze`, `pattern_analyze`
**User** (1): `user_manage`
**Audit** (1): `memory_audit_log`

### ACL
Enable with `CORTEX_ACL=on`. When active, every query path (search, list, inspect) filters results per the `defaultACLPolicy`:
- `private`: only owner
- `dm`: only listed `aclMembers`
- `team`/`org`: all authenticated users (label or member gate if configured)
- `public`: always readable
- `admin` role bypasses all restrictions except DM

### Search
- FTS5 full-text search on `title`, `content`, `tags`
- Hybrid search: BM25 + vector similarity (RRF fusion) when `CORTEX_EMBEDDING_PROVIDER` set
- Spreading activation graph traversal for cross-project recall
- ACL filtering injected at SQL level for all search paths

## Module Structure

### Core
- `src/store.ts` — CortexStore facade: integrates DB, hive, team, connectors, enrichment
- `src/db/database.ts` — HiveDatabase: SQLite operations (sync API, better-sqlite3)
- `src/db/schema.ts` — SQLite schema definition (8 tables incl. entity_aliases, FTS5, triggers)
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

### Connectors (inbound-only data ingestion)
- `src/connectors/types.ts` — ConnectorPlugin interface + registry
- `src/connectors/github.ts` — GitHub: PRs, Issues, ADRs, CODEOWNERS
- `src/connectors/slack.ts` — Slack: signal-filtered messages + threads
- `src/connectors/notion.ts` — Notion: pages, databases, block content
- `src/connectors/calendar.ts` — Google Calendar: events, attendees (OAuth2/service account)
- `src/connectors/recall.ts` — Recall.ai: completed meeting transcripts (inbound sync only)

### Team (Phase 2)
- `src/team/git-sync.ts` — Git-based team cortex (per-entry JSON files)

### Enrichment
- `src/enrichment/engine.ts` — EnrichmentEngine: orchestrates providers, batch processing
- `src/enrichment/entity-resolver.ts` — EntityResolver: cross-source person deduplication
- `src/enrichment/types.ts` — EnrichmentProvider interface, BatchFilter, BatchResult
- `src/enrichment/providers/` — classify.ts, decision-extractor.ts, llm-enrich.ts, topic-stitch.ts
- `src/enrichment/llm/` — anthropic.ts, openai.ts, ollama.ts, budget.ts, index.ts
- `src/enrichment/eval/` — decision-eval.ts, eval.ts (provider evaluation harness)

### Meeting (memory-layer only — no outbound posting)
- `src/meeting/agent.ts` — MeetingAgent: transcript → entities + enrichment + markdown (returns result, caller handles posting)
- `src/meeting/transcript-parser.ts` — Speaker-turn transcript parser (plain text + SRT + VTT)

### Steward
- `src/steward/index.ts` — MemorySteward: data quality audit + daily/weekly briefings

### Tools
- `src/tools/index.ts` — Tool registration
- `src/tools/browse-tools.ts` — ls, tree, grep, inspect, timeline
- `src/tools/trail-tools.ts` — trail, who, decay
- `src/tools/connector-tools.ts` — sync, status
- `src/tools/team-tools.ts` — init, push, pull, status
- `src/tools/context-tools.ts` — context_enrich, entity_resolve
- `src/tools/meeting-tools.ts` — meeting_process (returns markdown only), meeting_briefing
- `src/tools/steward-tools.ts` — memory_audit, memory_briefing
- `src/tools/memory-tools.ts`, `project-tools.ts`, `session-tools.ts` (v2)

### Extracted to jarvis (agent layer — not in this repo)
- Bumble Bee Slack bot (intent parsing, Slack posting, conversation)
- Meeting output posting (Slack/Notion)
- STT audio transcription (Whisper/Deepgram)
- Recall.ai bot orchestration (join meetings, schedule bots)

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
hive-memory enrich             # Run enrichment batch (--since, --type, --limit)
hive-memory meeting <file>     # Process meeting transcript (--title, --output) — returns markdown only
hive-memory audit              # Run memory data quality audit
hive-memory briefing           # Generate daily/weekly briefing (--type daily|weekly)
hive-memory user create <name> # Create a user + API key
hive-memory user list          # List all users
hive-memory user revoke <id>   # Revoke a user
hive-memory lifecycle          # Data lifecycle operations (--dry-run)
hive-memory import-slack       # Import Slack export archive
hive-memory backup <path>      # Backup SQLite database
```

## Conventions
- `src/` — TypeScript source
- `tests/` — vitest tests
- Build: `npm run build`, Dev: `npm run dev`, Test: `npm test`
- All new code uses SQLite; legacy JSON path kept for backward compat
