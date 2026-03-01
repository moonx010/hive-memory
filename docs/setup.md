# Hive Memory — Setup Guide

This guide covers full setup for **Claude Code** and **Codex**.

Two steps are needed for each:
1. **MCP server config** — tells the agent *how* to connect to Hive Memory
2. **Agent instructions** — tells the agent *when and how* to use Hive Memory

---

## Claude Code

### Step 1: MCP Server Config

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

### Step 2: Agent Instructions

Copy the template from [`claude-md-template.md`](./claude-md-template.md) and append it to your `~/.claude/CLAUDE.md`.

```bash
# If you don't have a CLAUDE.md yet:
cp docs/claude-md-template.md ~/.claude/CLAUDE.md

# If you already have one, append:
cat docs/claude-md-template.md >> ~/.claude/CLAUDE.md
```

### Verify

Restart Claude Code and say:

> "List all Hive Memory projects"

Claude should call `project_list`. If it says "no projects registered yet", Hive Memory is working.

To onboard your workspace:

> "Scan ~/Desktop/project for projects and register them"

---

## Codex (OpenAI)

### Step 1: MCP Server Config

Create `~/.codex/config.json` (or pass `--mcp-config`):

```json
{
  "mcpServers": {
    "hive-memory": {
      "command": "hive-memory"
    }
  }
}
```

> Check [Codex docs](https://github.com/openai/codex) for the latest MCP config format. The server command is the same — only the config file location may differ.

### Step 2: Agent Instructions

Copy the template from [`codex-md-template.md`](./codex-md-template.md) and save it as `AGENTS.md` in your home directory or project root.

```bash
# Global instructions (all projects):
cp docs/codex-md-template.md ~/AGENTS.md

# Or per-project:
cp docs/codex-md-template.md ./AGENTS.md
```

### Verify

Start Codex and say:

> "List all Hive Memory projects"

---

## Both at Once

If you use both Claude Code and Codex, just set up both. They share the same `~/.cortex/` data directory, so memories stored by Claude Code are visible to Codex and vice versa.

```
Claude Code ──┐
              ├── hive-memory ── ~/.cortex/ (shared)
Codex ────────┘
```
