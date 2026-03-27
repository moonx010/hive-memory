<p align="center">

```
 ██╗  ██╗██╗██╗   ██╗███████╗
 ██║  ██║██║██║   ██║██╔════╝
 ███████║██║██║   ██║█████╗
 ██╔══██║██║╚██╗ ██╔╝██╔══╝
 ██║  ██║██║ ╚████╔╝ ███████╗
 ╚═╝  ╚═╝╚═╝  ╚═══╝  ╚══════╝
 ███╗   ███╗███████╗███╗   ███╗ ██████╗ ██████╗ ██╗   ██╗
 ████╗ ████║██╔════╝████╗ ████║██╔═══██╗██╔══██╗╚██╗ ██╔╝
 ██╔████╔██║█████╗  ██╔████╔██║██║   ██║██████╔╝ ╚████╔╝
 ██║╚██╔╝██║██╔══╝  ██║╚██╔╝██║██║   ██║██╔══██╗  ╚██╔╝
 ██║ ╚═╝ ██║███████╗██║ ╚═╝ ██║╚██████╔╝██║  ██║   ██║
 ╚═╝     ╚═╝╚══════╝╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝
```

**Cross-project memory layer for AI coding agents — with graph memory**

[![npm](https://img.shields.io/npm/v/hive-memory)](https://www.npmjs.com/package/hive-memory)
[![license](https://img.shields.io/npm/l/hive-memory)](LICENSE)
[![node](https://img.shields.io/node/v/hive-memory)](package.json)

</p>

---

Hive Memory is an [MCP](https://modelcontextprotocol.io) server that gives AI coding agents persistent, **graph-connected** memory across projects. It stores decisions, learnings, and session progress in a local knowledge base with brain-inspired synaptic connections — so your agent can discover related context through topology-based traversal, not just keyword search.

## Features

- **33 MCP tools** — project management, memory storage/recall, graph traversal, browsing, connectors, team sync, meetings, stewardship, and admin
- **SQLite-backed** — FTS5 full-text search, WAL mode, zero external services
- **Graph memory (synapses)** — 15 axon types, Hebbian learning, spreading activation
- **Hybrid search** — BM25 + optional vector similarity with RRF fusion
- **4 connectors** — GitHub, Slack, Notion, Google Calendar
- **Team sync** — Git-based shared cortex for teams
- **Meeting pipeline** — transcript → structured notes → enrichment
- **HTTP mode** — Deploy on Railway/Render with per-user API keys and rate limiting
- **Docker support** — Ready-to-run container with health check
- **Schema versioning** — Tracked migration history in `schema_meta` table
- **Audit logging** — In-memory audit trail for all tool calls
- **Backup CLI** — `hive-memory backup [--output path]` for database snapshots

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Hive Memory (cortex)                   │
│                                                          │
│  ┌────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │ MCP Server │  │  HTTP Server │  │   CLI Interface  │  │
│  │  (stdio)   │  │  (port 3179) │  │   (hive-memory)  │  │
│  └─────┬──────┘  └──────┬───────┘  └────────┬────────┘  │
│        └────────────────┼────────────────────┘           │
│                         │                                │
│  ┌──────────────────────▼────────────────────────────┐  │
│  │                   CortexStore                      │  │
│  │  ┌────────────┐  ┌──────────┐  ┌──────────────┐  │  │
│  │  │HiveDatabase│  │ Synapse  │  │ Enrichment   │  │  │
│  │  │ (SQLite)   │  │  Graph   │  │   Engine     │  │  │
│  │  └─────┬──────┘  └──────────┘  └──────────────┘  │  │
│  │        │                                           │  │
│  │  ┌─────▼──────────────────────────────────────┐  │  │
│  │  │         SQLite Database (cortex.db)          │  │  │
│  │  │  entities · synapses · sessions · projects  │  │  │
│  │  │  connectors · users · labels · schema_meta  │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
         ▲              ▲              ▲
   ┌─────┴─────┐  ┌─────┴─────┐  ┌───┴──────┐
   │  GitHub   │  │   Slack   │  │  Notion  │
   │ Connector │  │ Connector │  │ Connector│
   └───────────┘  └───────────┘  └──────────┘
```

## Quick Start

### Install

```bash
npm install -g hive-memory
```

### Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "hive-memory": {
      "command": "hive-memory"
    }
  },
  "permissions": {
    "allow": [
      "mcp__hive-memory__*"
    ]
  }
}
```

> The `permissions.allow` entry auto-approves all Hive Memory tools so Claude won't prompt for permission every session.

### Claude Desktop

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "hive-memory": {
      "command": "hive-memory"
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "hive-memory": {
      "command": "hive-memory"
    }
  }
}
```

### HTTP Mode (Remote Deployment)

```bash
CORTEX_HTTP=true CORTEX_AUTH_TOKEN=secret hive-memory --http
```

Or with Docker:

```bash
docker compose up
```

### Agent Instructions

Hive Memory works best when your AI agent knows *when* to call the tools. Copy the provided instruction templates into your agent's instruction file:

| Agent | Instruction file | Template |
|-------|-----------------|----------|
| Claude Code | `~/.claude/CLAUDE.md` | [`claude-md-template.md`](docs/claude-md-template.md) |
| Codex | `~/AGENTS.md` or `./AGENTS.md` | [`codex-md-template.md`](docs/codex-md-template.md) |

See the [full setup guide](docs/setup.md) for step-by-step instructions.

## Tools Reference (33 tools)

### Project Tools (4)

| Tool | Description |
|------|-------------|
| `project_register` | Register or update a project (upsert) |
| `project_search` | Search projects by name/tags, or list all (empty query) |
| `project_status` | Get project context (full mode includes cross-project insights) |
| `project_onboard` | Auto-discover projects in a directory + scan for agent memory files |

### Memory Tools (5)

| Tool | Description |
|------|-------------|
| `memory_store` | Store a decision, learning, or note. Auto-creates synapses to related memories |
| `memory_recall` | Search using keyword matching + graph traversal (spreading activation) |
| `memory_link` | Form an explicit synapse between two memory entries |
| `memory_traverse` | Deep graph traversal — find memories connected through synaptic pathways |
| `memory_connections` | View the synaptic connections of a specific memory entry |

### Session Tools (1)

| Tool | Description |
|------|-------------|
| `session_save` | Save session progress — what was done, what's next |

### Browse Tools (5)

| Tool | Description |
|------|-------------|
| `memory_ls` | List entities with filters (project, type, status, domain) |
| `memory_tree` | Tree view of entities grouped by project and type |
| `memory_grep` | Regex/substring search across entity content |
| `memory_inspect` | Detailed view of a specific entity including synapses |
| `memory_timeline` | Chronological view of entities in a time range |

### Trail Tools (3)

| Tool | Description |
|------|-------------|
| `memory_trail` | View the access trail of recently used memories |
| `memory_who` | See which agents have contributed to a project |
| `memory_decay` | Apply synapse weight decay and prune weak connections |

### Connector Tools (2)

| Tool | Description |
|------|-------------|
| `connector_sync` | Trigger a connector sync (GitHub, Slack, Notion, Calendar) |
| `connector_status` | View sync status and entry counts for all connectors |

### Team Tools (4)

| Tool | Description |
|------|-------------|
| `team_init` | Initialize a Git-based shared team cortex |
| `team_push` | Push local entries to the team cortex |
| `team_pull` | Pull team entries into local database |
| `team_status` | View pending push/pull and conflict count |

### Context Tools (2)

| Tool | Description |
|------|-------------|
| `context_enrich` | Run enrichment on an entity (classification, topics, decisions) |
| `entity_resolve` | Find and deduplicate person entities across sources |

### Meeting Tools (2)

| Tool | Description |
|------|-------------|
| `meeting_process` | Process a meeting transcript into structured notes and decisions |
| `meeting_briefing` | Generate a meeting briefing from recent meetings |

### Steward Tools (2)

| Tool | Description |
|------|-------------|
| `memory_audit` | Run data quality audit on stored memories |
| `memory_briefing` | Generate daily or weekly memory briefing |

### Advisor Tools (1)

| Tool | Description |
|------|-------------|
| `workflow_analyze` | Analyze workflow patterns and generate insights |

### User / Admin Tools (2)

| Tool | Description |
|------|-------------|
| `user_manage` | Manage users — add, list, revoke, rotate API keys |
| `memory_audit_log` | Retrieve recent MCP tool call audit log (admin only) |

## Connectors

| Connector | Env Variable | What it syncs |
|-----------|-------------|---------------|
| **GitHub** | `GITHUB_TOKEN` | PRs, Issues, ADRs, CODEOWNERS |
| **Slack** | `SLACK_TOKEN` | Signal-filtered messages, threads |
| **Notion** | `NOTION_TOKEN` | Pages, databases, block content |
| **Google Calendar** | `GOOGLE_CALENDAR_CREDENTIALS` | Events, attendees (OAuth2/service account) |
| **Outlook** | `OUTLOOK_TOKEN` | Calendar events |

## How It Works

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│ Claude   │     │ Cursor   │     │ Codex    │
│ Code     │     │          │     │          │
│ (Proj A) │     │ (Proj B) │     │ (Proj C) │
└────┬─────┘     └────┬─────┘     └────┬─────┘
     │                │                │
     └────────────────┼────────────────┘
                      │ MCP (stdio)
               ┌─────────────┐
               │ Hive Memory │
               │  MCP Server │
               └──────┬──────┘
                      │
     ┌────────────────┼────────────────┐
     ▼                ▼                ▼
┌─────────┐    ┌───────────┐    ┌───────────┐
│ Hive    │    │ Synapse   │    │ Spreading │
│ Cell    │    │ Graph     │    │ Activation│
│ Tree    │    │ (LTP/LTD) │    │           │
└─────────┘    └───────────┘    └───────────┘
```

**No cloud. No accounts. No embeddings required. Everything stays on your machine.**

### Graph Memory (Synapses)

Every memory can be connected to other memories through **synapses** — directed, weighted edges inspired by neuroscience:

```
"Use JWT for auth" ──[causal:0.8]──→ "Add token refresh logic"
        │                                      │
        │──[semantic:0.5]──→ "OAuth2 decision"  │
                                               │
"Rate limit API" ←──[dependency:0.6]───────────┘
```

**Axon Types:**

| Type | Meaning | Example |
|------|---------|---------|
| `temporal` | A occurred before B | Decision A was made before Decision B |
| `causal` | A caused/led to B | "Use PostgreSQL" → "Add pgvector extension" |
| `semantic` | Topically related | Both about authentication |
| `refinement` | B refines/updates A | "Use JWT" → "Use JWT with 15min expiry" |
| `conflict` | A contradicts B | "Use SQL" vs "Use NoSQL" |
| `dependency` | B depends on A | Feature B requires Feature A |
| `derived` | B was derived from A | Learning extracted from a decision |

### Spreading Activation

When you search with `memory_recall` or `memory_traverse`, the system propagates signal through the synapse graph:

```
Query: "auth token handling"
  │
  ▼ keyword match
  Seed: "Use JWT for auth" (activation: 1.0)
  │
  ├─[causal:0.8]──→ "Add token refresh" (activation: 0.4)
  │                        │
  │                  ├─[dependency:0.6]──→ "Rate limit API" (activation: 0.12)
  │
  └─[semantic:0.5]──→ "OAuth2 decision" (activation: 0.25)
```

### Hebbian Learning

"Neurons that fire together, wire together":

- **LTP (Long-Term Potentiation)**: When two memories are recalled together repeatedly, their synapse weight increases (+0.1 per co-activation)
- **LTD (Long-Term Depression)**: Unused synapses decay over time (×0.995 per flush cycle)
- **Pruning**: Synapses below 0.05 weight are automatically removed
- **Auto-formation**: When two memories are co-activated 5+ times, a Hebbian synapse is created automatically

## HTTP Mode & Multi-User Setup

Deploy as an HTTP server for shared team access:

```bash
# Create an admin user
hive-memory user create admin-name

# Start HTTP server
CORTEX_HTTP=true CORTEX_AUTH_TOKEN=<token> hive-memory

# Or use Docker
docker compose up
```

### API Key Rotation

```bash
hive-memory user rotate <user-id>
```

The new key is active immediately. The `graceUntil` timestamp is stored for audit purposes.

### Rate Limiting

The HTTP server enforces a limit of **100 requests per minute per user** (in-memory, per instance).

## Auto Session Capture

Hive Memory can automatically save sessions when Claude Code exits. Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionEnd": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "hive-memory hook session-end"
      }]
    }]
  }
}
```

This parses the Claude Code transcript and auto-saves a session summary. It skips if `session_save` was already called during the session.

## Backup

```bash
# Create a backup
hive-memory backup

# Specify output path
hive-memory backup --output /path/to/backup.db
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CORTEX_DATA_DIR` | `~/.cortex` | Data storage directory |
| `CORTEX_LOCAL_SYNC` | `true` | Set to `"false"` to disable writing `.cortex.md` into project directories |
| `CORTEX_LOCAL_FILENAME` | `.cortex.md` | Custom filename for local context files |
| `CORTEX_HTTP` | `false` | Set to `"true"` to enable HTTP server mode |
| `CORTEX_AUTH_TOKEN` | — | Admin API token for HTTP mode |
| `PORT` / `CORTEX_PORT` | `3179` | HTTP server port |
| `CORTEX_SYNC_INTERVAL_MIN` | `30` | Connector auto-sync interval in minutes |

Example with custom config:

```json
{
  "mcpServers": {
    "hive-memory": {
      "command": "hive-memory",
      "env": {
        "CORTEX_DATA_DIR": "/custom/path",
        "CORTEX_LOCAL_SYNC": "false"
      }
    }
  }
}
```

### Local Context File (.cortex.md)

Hive Memory writes a `.cortex.md` file in each registered project directory. This file contains a snapshot of the project's current context — summary, recent session, next tasks, and cross-project insights. It's auto-generated and should be added to `.gitignore`.

To disable this feature, set `CORTEX_LOCAL_SYNC=false`.

## Migration from v1/v2

Hive Memory v3 automatically migrates existing data:

- **Legacy `knowledge/` files** are migrated to hive direct entries on first startup, then renamed to `knowledge.bak/`
- **Existing project registrations** (`index.json`, `summary.json`, sessions) are unchanged
- **Embedding data** (`vectors.json`, embedding model cache) is no longer used and can be safely deleted
- The `@huggingface/transformers` dependency has been removed — no more model downloads
- Schema version is now tracked in the `schema_meta` table

No manual action needed — just update and restart.

## Development

```bash
npm install          # Install dependencies
npm run build        # Build TypeScript
npm run dev          # Dev mode with auto-reload
npm run lint         # Lint with ESLint
npm run typecheck    # Type check
npm test             # Run tests
npm run test:coverage # Run tests with coverage report
```

## License

[MIT](LICENSE)
