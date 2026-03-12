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

**Cross-project memory layer for AI coding agents**

[![npm](https://img.shields.io/npm/v/hive-memory)](https://www.npmjs.com/package/hive-memory)
[![license](https://img.shields.io/npm/l/hive-memory)](LICENSE)
[![node](https://img.shields.io/node/v/hive-memory)](package.json)

</p>

---

Hive Memory is an [MCP](https://modelcontextprotocol.io) server that gives AI coding agents persistent memory across projects. It stores decisions, learnings, session progress, and project context in a local knowledge base — so your agent can pick up where it left off, even across different workspaces.

## Why Hive Memory?

AI coding agents have memory, but it's scoped to a single project:

| | Scope | Cross-project | Semantic search | Coexists with agent memory |
|---|---|---|---|---|
| **Claude Code** (MEMORY.md) | Single project | No | No | — |
| **Codex** (AGENTS.md) | Single project | No | No | — |
| **Cursor** (.cursor/rules/) | Single project | No | No | — |
| **Hive Memory** | All projects | Yes (automatic) | Yes (O(log N)) | Yes (references) |

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
                        │ beam search
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

When you search with `memory_recall`, you get both: actual content from direct entries, and "this file has relevant info" pointers from reference entries. Your agent can then read the referenced files directly.

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
               ┌──────▼──────┐
               │  ~/.cortex/ │
               │  Hive Cell  │
               │  (O(log N)  │
               │   search)   │
               └─────────────┘
```

**No cloud. No accounts. Everything stays on your machine.**

### Hive Cell Architecture

All knowledge lives in a single **global cell tree** — a hierarchical index that organizes entries by semantic similarity:

```
~/.cortex/
  index.json        ← Project registry (unchanged)
  hive.json         ← Global tree index (cells + nursery)
  cells/            ← Leaf cell data files
    auth-jwt-a1b2.json
    db-perf-c3d4.json
  projects/
    proj-a/
      summary.json  ← Project summary
      sessions/     ← Session logs
      knowledge/    ← Legacy (auto-migrated to hive)
```

New entries go into a **nursery** buffer. When the nursery reaches 10 entries, they're flushed into the best-matching leaf cell. Cells that grow beyond 20 entries are split via k-means clustering into two children.

Search uses **beam search** (width=3) through the tree: score = 0.7 × vector similarity + 0.3 × keyword overlap. This gives O(log N) search instead of brute-force scanning.

## Tools Reference (7 tools)

| Tool | Description |
|------|-------------|
| `project_register` | Register or update a project (upsert) |
| `project_search` | Search projects by name/tags, or list all (empty query) |
| `project_status` | Get project context (full mode includes cross-project insights) |
| `project_onboard` | Auto-discover projects in a directory + scan for agent memory files |
| `memory_store` | Store a decision, learning, or note (→ direct entry in hive) |
| `memory_recall` | Search memories across all projects (returns direct + reference results) |
| `session_save` | Save session progress — what was done, what's next |

### memory_recall result format

```
memory_recall("JWT auth")

  → Direct:    **[proj-a/decision]**
               "Use JWT tokens for service-to-service auth"

  → Reference: **[proj-b/claude-memory]** (reference)
               "JWT token expiration handling notes"
               Path: /Users/.../MEMORY.md
```

Your agent sees reference results and can read the file directly with its `Read` tool.

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

## Semantic Search

Hive Memory includes embedding-based semantic search — **fully local, no API calls, no external servers**. The `@huggingface/transformers` package is included as a dependency and works out of the box.

### How It Works

```
"refactored auth module"
         │
         ▼
┌─────────────────────┐
│  Embedding Model    │   Runs inside your Node.js process
│  (ONNX Runtime)     │   Model auto-downloaded on first use (~23MB)
└────────┬────────────┘
         │
         ▼
  [0.12, -0.34, ...]     384-dimensional vector
         │
         ▼
┌─────────────────────┐
│  Hive Cell Tree     │   Entries organized by semantic similarity
│  O(log N) beam      │   No brute-force scanning
│  search             │
└─────────────────────┘
```

### Backends

| Priority | Backend | Storage | How to enable |
|----------|---------|---------|---------------|
| 1 (best) | **Native** (Rust + FastEmbed) | SQLite | `cd native && npm install && npm run build` |
| 2 | **JS** (transformers.js) | Hive Cell tree | Included by default |
| 3 | **Keyword-only** | — | Fallback if model fails to load |

## Migration from v2

Hive Memory v3 automatically migrates existing data:

- **Legacy `knowledge/` files** are migrated to hive direct entries on first startup, then renamed to `knowledge.bak/`
- **Existing project registrations** (`index.json`, `summary.json`, sessions) are unchanged
- The legacy `vectors.json` file continues to work for the old embed index

No manual action needed — just update and restart.

## Development

```bash
npm install          # Install dependencies
npm run build        # Build TypeScript
npm run dev          # Dev mode with auto-reload
npm run lint         # Lint with ESLint
npm run typecheck    # Type check
npm test             # Run tests (95 tests)
```

## License

[MIT](LICENSE)
