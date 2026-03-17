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

## What's New in v2

- **Graph Memory (Synapses)**: Brain-inspired connections between memories — temporal, causal, semantic, refinement, conflict, dependency, derived
- **Spreading Activation**: Discover related memories through synaptic pathways that keyword search alone wouldn't find
- **Hebbian Learning**: Connections strengthen (LTP) or weaken (LTD) over time based on co-activation
- **No embeddings required**: Replaced vector-based search with keyword + topology-based graph traversal. Zero external dependencies, instant startup
- **3 new tools**: `memory_link`, `memory_traverse`, `memory_connections`

## Why Hive Memory?

AI coding agents have memory, but it's scoped to a single project:

| | Scope | Cross-project | Graph search | Coexists with agent memory |
|---|---|---|---|---|
| **Claude Code** (MEMORY.md) | Single project | No | No | — |
| **Codex** (AGENTS.md) | Single project | No | No | — |
| **Cursor** (.cursor/rules/) | Single project | No | No | — |
| **Hive Memory** | All projects | Yes (automatic) | Yes (synapses) | Yes (references) |

Hive Memory sits **above** these tools as a meta-layer. It doesn't replace them — it connects them.

### Two types of knowledge

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
                        │ keyword + graph search
                 "JWT 관련 지식이 어디 있지?"
                        │
         ┌──────────────┼──────────────┐
         ▼              ▼              ▼
    [direct]       [reference]    [reference]
    proj-a의       proj-b의        proj-c의
    JWT 결정       MEMORY.md에     CLAUDE.md에
                   JWT 관련 메모   JWT 가이드
```

- **Direct entries**: Knowledge your agent stores via `memory_store` — decisions, learnings, notes
- **Reference entries**: Pointers to existing agent memory files (MEMORY.md, AGENTS.md, .cursor/rules/) — Hive knows *what's in them* without copying content

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

### Agent Instructions

Hive Memory works best when your AI agent knows *when* to call the tools. Copy the provided instruction templates into your agent's instruction file:

| Agent | Instruction file | Template |
|-------|-----------------|----------|
| Claude Code | `~/.claude/CLAUDE.md` | [`claude-md-template.md`](docs/claude-md-template.md) |
| Codex | `~/AGENTS.md` or `./AGENTS.md` | [`codex-md-template.md`](docs/codex-md-template.md) |

See the [full setup guide](docs/setup.md) for step-by-step instructions.

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

**No cloud. No accounts. No embeddings. Everything stays on your machine.**

### Hive Cell Architecture

All knowledge lives in a single **global cell tree** — a hierarchical index that organizes entries by keyword similarity:

```
~/.cortex/
  index.json            ← Project registry
  hive.json             ← Global tree index (cells + nursery)
  synapses.json         ← Connectome (synapse graph)
  coactivation.json     ← Hebbian co-activation counts
  cells/                ← Leaf cell data files
    auth-jwt-a1b2.json
    db-perf-c3d4.json
  projects/
    proj-a/
      summary.json      ← Project summary
      sessions/         ← Session logs
```

New entries go into a **nursery** buffer. When the nursery reaches 10 entries, they're flushed into the best-matching leaf cell. Cells that grow beyond 20 entries are split via keyword clustering into two children.

### Graph Memory (Synapses)

Every memory can be connected to other memories through **synapses** — directed, weighted edges inspired by neuroscience:

```
"Use JWT for auth" ──[causal:0.8]──→ "Add token refresh logic"
        │                                      │
        │──[semantic:0.5]──→ "OAuth2 decision"  │
                                               │
"Rate limit API" ←──[dependency:0.6]───────────┘
```

**7 Axon Types:**

| Type | Meaning | Example |
|------|---------|---------|
| `temporal` | A occurred before B | Decision A was made before Decision B |
| `causal` | A caused/led to B | "Use PostgreSQL" → "Add pgvector extension" |
| `semantic` | Topically related | Both about authentication |
| `refinement` | B refines/updates A | "Use JWT" → "Use JWT with 15min expiry" |
| `conflict` | A contradicts B | "Use SQL" vs "Use NoSQL" |
| `dependency` | B depends on A | Feature B requires Feature A |
| `derived` | B was derived from A | Learning extracted from a decision |

**Synapses are created automatically** when you store memories (temporal + semantic), and can be created explicitly with `memory_link`.

### Spreading Activation

When you search with `memory_recall` or `memory_traverse`, the system doesn't just match keywords — it propagates signal through the synapse graph:

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

Signal decays with each hop (default: 0.5× per hop). This surfaces **contextually related** memories that keyword search alone would miss.

### Hebbian Learning

"Neurons that fire together, wire together":

- **LTP (Long-Term Potentiation)**: When two memories are recalled together repeatedly, their synapse weight increases (+0.1 per co-activation)
- **LTD (Long-Term Depression)**: Unused synapses decay over time (×0.995 per flush cycle)
- **Pruning**: Synapses below 0.05 weight are automatically removed
- **Auto-formation**: When two memories are co-activated 5+ times, a Hebbian synapse is created automatically

## Tools Reference (10 tools)

### Project Tools

| Tool | Description |
|------|-------------|
| `project_register` | Register or update a project (upsert) |
| `project_search` | Search projects by name/tags, or list all (empty query) |
| `project_status` | Get project context (full mode includes cross-project insights) |
| `project_onboard` | Auto-discover projects in a directory + scan for agent memory files |

### Memory Tools

| Tool | Description |
|------|-------------|
| `memory_store` | Store a decision, learning, or note. Auto-creates synapses to related memories |
| `memory_recall` | Search using keyword matching + graph traversal (spreading activation) |
| `memory_link` | Form an explicit synapse between two memory entries |
| `memory_traverse` | Deep graph traversal — find memories connected through synaptic pathways |
| `memory_connections` | View the synaptic connections of a specific memory entry |

### Session Tools

| Tool | Description |
|------|-------------|
| `session_save` | Save session progress — what was done, what's next |

### memory_recall result format

```
memory_recall("JWT auth")

  → Direct:    **[proj-a/decision]**
               "Use JWT tokens for service-to-service auth"

  → Direct:    **[proj-a/learning]** 🔗depth:1
               "Token refresh needs retry logic"

  → Reference: **[proj-b/claude-memory]** (reference)
               "JWT token expiration handling notes"
               Path: /Users/.../MEMORY.md
```

Results include `🔗depth:N` markers showing how many synaptic hops away the memory was found.

### memory_traverse example

```
memory_traverse("database architecture", depth=3)

  → **[proj-a/decision]** [depth:0]
    "Use PostgreSQL for main database"

  → **[proj-a/decision]** [depth:1]
    "Add pgvector extension for embeddings"

  → **[proj-b/learning]** [depth:2]
    "Connection pooling critical for serverless"

  → **[proj-c/decision]** [depth:3]
    "Use Supabase (PostgreSQL) for BaaS"
```

### project_onboard with reference scanning

When you onboard projects, Hive Memory automatically scans for existing agent memory files:

| Source | File pattern | What it detects |
|--------|-------------|-----------------|
| `claude-memory` | `~/.claude/projects/*/memory/MEMORY.md` | Claude Code auto-memory |
| `claude-project` | `{project}/CLAUDE.md` | Project instructions |
| `codex-agents` | `{project}/AGENTS.md` | Codex agent instructions |
| `cursor-rules` | `{project}/.cursor/rules/*` | Cursor rule files |

These are indexed as reference entries — searchable via `memory_recall` without duplicating content.

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

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CORTEX_DATA_DIR` | `~/.cortex` | Data storage directory |
| `CORTEX_LOCAL_SYNC` | `true` | Set to `"false"` to disable writing `.cortex.md` into project directories |
| `CORTEX_LOCAL_FILENAME` | `.cortex.md` | Custom filename for local context files |

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

## Migration from v1

Hive Memory v2 automatically migrates existing data:

- **Legacy `knowledge/` files** are migrated to hive direct entries on first startup, then renamed to `knowledge.bak/`
- **Existing project registrations** (`index.json`, `summary.json`, sessions) are unchanged
- **Embedding data** (`vectors.json`, embedding model cache) is no longer used and can be safely deleted
- The `@huggingface/transformers` dependency has been removed — no more model downloads

No manual action needed — just update and restart.

## Development

```bash
npm install          # Install dependencies
npm run build        # Build TypeScript
npm run dev          # Dev mode with auto-reload
npm run lint         # Lint with ESLint
npm run typecheck    # Type check
npm test             # Run tests (125 tests)
```

## License

[MIT](LICENSE)
