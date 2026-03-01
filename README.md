# Hive Memory

> Cross-project memory layer for AI coding agents.

Hive Memory is an [MCP](https://modelcontextprotocol.io) server that gives AI coding agents persistent memory across projects. It stores decisions, learnings, session progress, and project context in a local knowledge base — so your agent can pick up where it left off, even across different workspaces.

## Why Hive Memory?

AI coding agents have memory, but it's scoped to a single project:

| | Scope | Cross-project | Groups & shared guides | Session continuity |
|---|---|---|---|---|
| **Claude Code** (MEMORY.md) | Single project | No | No | Manual |
| **Codex** (built-in memory) | Single project | No | No | No |
| **Hive Memory** | All projects | Yes | Yes | Automatic |

Hive Memory sits **above** these tools as a meta-layer. It doesn't replace them — it connects them.

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
  }
}
```

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
               │ (local JSON │
               │  + Markdown)│
               └─────────────┘
```

**No cloud. No accounts. Everything stays on your machine.**

Hive Memory stores all data under `~/.cortex/` as plain JSON and Markdown files. Each project gets its own subdirectory with summaries, memories, and session logs.

## Tools Reference

### Project Management

| Tool | Description |
|------|-------------|
| `project_register` | Register a new project with Hive Memory |
| `project_list` | List all registered projects with status |
| `project_update` | Update project metadata or status |
| `project_search` | Search projects by name, description, or tags |
| `project_status` | Get current context: summary, focus, last session |
| `project_onboard` | Auto-discover projects in a directory |

### Memory

| Tool | Description |
|------|-------------|
| `memory_store` | Store a decision, learning, or note |
| `memory_recall` | Search and recall relevant memories |

### Sessions

| Tool | Description |
|------|-------------|
| `session_save` | Save session progress — what was done, what's next |

### Groups

| Tool | Description |
|------|-------------|
| `group_create` | Create a group to organize related projects |
| `group_list` | List all groups |
| `group_update` | Update group metadata, add/remove projects |
| `group_context` | Get shared guides and member project info |
| `group_guide_save` | Save a shared guide document for a group |

## Configuration

### Data Directory

By default, Hive Memory stores data in `~/.cortex/`. Override with:

```bash
CORTEX_DATA_DIR=/custom/path hive-memory
```

Or in your MCP config:

```json
{
  "mcpServers": {
    "hive-memory": {
      "command": "hive-memory",
      "env": {
        "CORTEX_DATA_DIR": "/custom/path"
      }
    }
  }
}
```

### Local Context File (.cortex.md)

Hive Memory writes a `.cortex.md` file in each registered project directory. This file contains a snapshot of the project's current context — summary, recent session, and next tasks. It's auto-generated and can be added to `.gitignore`.

## Semantic Search

Hive Memory includes an optional native module (Rust + NAPI) for embedding-based semantic search. Without it, Hive Memory uses keyword matching which works well for most use cases.

To enable semantic search:

```bash
cd native && npm install && npm run build
```

This requires a Rust toolchain. The native module is **not included in the npm package** — build it locally if needed.

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Dev mode with auto-reload
npm run dev

# Type check
npm run typecheck

# Run tests
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed contribution guidelines.

## License

[MIT](LICENSE)
