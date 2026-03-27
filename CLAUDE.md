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
  - `synapses` table: weighted directed graph (15 axon types)
  - `coactivations` table: Hebbian learning pairs
  - `entity_aliases` table: cross-source identity mapping (schema v3: content_hash + sync_phase + sync_history)
  - `projects`, `sessions`, `connectors` tables
- **Search**: FTS5 BM25 + spreading activation + RRF fusion
- **33 MCP tools**: 10 v2-compatible + 23 new (browse, trail, connectors, team, context, meeting, steward, advisor, user)

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

### Connectors (Phase 2-3)
- `src/connectors/types.ts` — ConnectorPlugin interface + registry
- `src/connectors/github.ts` — GitHub: PRs, Issues, ADRs, CODEOWNERS
- `src/connectors/slack.ts` — Slack: signal-filtered messages + threads
- `src/connectors/notion.ts` — Notion: pages, databases, block content
- `src/connectors/calendar.ts` — Google Calendar: events, attendees (OAuth2/service account)

### Team (Phase 2)
- `src/team/git-sync.ts` — Git-based team cortex (per-entry JSON files)

### Enrichment
- `src/enrichment/engine.ts` — EnrichmentEngine: orchestrates providers, batch processing
- `src/enrichment/entity-resolver.ts` — EntityResolver: cross-source person deduplication
- `src/enrichment/types.ts` — EnrichmentProvider interface, BatchFilter, BatchResult
- `src/enrichment/providers/` — classify.ts, decision-extractor.ts, llm-enrich.ts, topic-stitch.ts
- `src/enrichment/llm/` — anthropic.ts, openai.ts, ollama.ts, budget.ts, index.ts
- `src/enrichment/eval/` — decision-eval.ts, eval.ts (provider evaluation harness)

### Meeting
- `src/meeting/agent.ts` — MeetingAgent: transcript processing + pre-briefing generation
- `src/meeting/transcript-parser.ts` — Speaker-turn transcript parser (plain text + SRT)

### Steward
- `src/steward/index.ts` — MemorySteward: data quality audit + daily/weekly briefings

### Advisor
- `src/advisor/index.ts` — WorkflowAdvisor: workflow pattern analysis + improvement suggestions
- `src/advisor/patterns.ts` — PatternAnalyzer: activity heatmap + collaboration graph

### Auth
- `src/auth.ts` — User management (create/list/revoke API keys, CORTEX_AUTH_TOKEN)

### Tools
- `src/tools/index.ts` — Tool registration (all 33 tools)
- `src/tools/browse-tools.ts` — ls, tree, grep, inspect, timeline
- `src/tools/trail-tools.ts` — trail, who, decay
- `src/tools/connector-tools.ts` — sync, status
- `src/tools/team-tools.ts` — init, push, pull, status
- `src/tools/context-tools.ts` — context_enrich, entity_resolve
- `src/tools/meeting-tools.ts` — meeting_process, meeting_briefing
- `src/tools/steward-tools.ts` — memory_audit, memory_briefing
- `src/tools/advisor-tools.ts` — workflow_analyze, pattern_analyze
- `src/tools/user-tools.ts` — user_manage
- `src/tools/memory-tools.ts`, `project-tools.ts`, `session-tools.ts` (v2)

### Hooks
- `src/hooks/session-end.ts` — SessionEnd auto-capture
- `src/hooks/transcript-parser.ts` — JSONL transcript parsing

## CLI Commands (17 total)
```bash
hive-memory                      # MCP server mode (default, auto-sync scheduler enabled)
hive-memory store ...            # Store memory
hive-memory recall ...           # Search memories
hive-memory status ...           # Project status
hive-memory inject ...           # Recall + append to file
hive-memory sync <connector>     # Run connector sync
hive-memory cleanup              # Remove expired entries
hive-memory stats                # Database statistics
hive-memory team init <path>     # Initialize team cortex
hive-memory team push/pull       # Team sync
hive-memory enrich               # Run enrichment batch (--since, --type, --limit)
hive-memory meeting <file>       # Process meeting transcript (--title, --output)
hive-memory transcribe <file>    # Full pipeline: audio/video → STT → meeting notes
hive-memory audit                # Run memory data quality audit
hive-memory briefing             # Generate daily/weekly briefing (--type daily|weekly)
hive-memory analyze              # Analyze workflow patterns and generate insights
hive-memory patterns             # Analyze aggregated working patterns (--since, --project)
hive-memory connect              # Generate MCP config for Claude Code or Cursor
hive-memory user <action>        # Manage users (create, list, revoke) — requires CORTEX_AUTH_TOKEN
hive-memory label <action>       # Manage ACL labels (create, list, assign, revoke)
hive-memory entity reassign      # Reassign entity ownership (--from <user-id> --to <user-id>)
hive-memory hook session-end     # Auto session capture (Claude Code hook)
```

## Access Control (CORTEX_ACL)

Set `CORTEX_ACL=on` to enable per-entity access control enforcement. Default is off.

```bash
CORTEX_ACL=on   # Enable ACL enforcement on all queries
CORTEX_ACL=off  # (default) All entities visible — backward-compatible single-user mode
```

**Visibility levels** (most to least restrictive): `dm > private > team > org > public`
- `dm`: accessible only by participants listed in `acl_members` (admins excluded)
- `private`: accessible by owner + admins (not DM participants)
- `team`: accessible by all authenticated users
- `org`, `public`: broadest access

**Label management workflow:**
```bash
hive-memory label create hr --description "HR team access"
hive-memory label assign <user-id> hr
hive-memory label list
hive-memory label revoke <user-id> hr
```

**Label gate logic:** OR — user satisfies access if they have all `required_labels`, OR are listed in `acl_members`.

**Orphan cleanup:** `db.cleanupOrphanedEntities(90)` — archives private/DM entities owned by users revoked >90 days ago; clears `owner_id` on team/org/public entities.

**Backward compat:** `CORTEX_ACL=off` (default) passes all existing tests unchanged. Entities without `owner_id` are treated as `team` visibility.

## Deployment
- **Railway**: `railway.json` configures Nixpacks build + `node dist/index.js` start command
- **HTTP mode**: `CORTEX_HTTP=true` enables HTTP transport (auth via `CORTEX_AUTH_TOKEN`)
- **Auto-sync scheduler**: runs connector sync + enrichment periodically when in server mode (interval via `CORTEX_SYNC_INTERVAL_MS`)

## Conventions
- `src/` — TypeScript source
- `tests/` — vitest tests (125 tests across 11 files)
- Build: `npm run build`, Dev: `npm run dev`, Test: `npm test`
- All new code uses SQLite; legacy JSON path kept for backward compat
