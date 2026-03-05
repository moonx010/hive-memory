# Hive Memory — Setup Guide

This guide covers full setup for **Claude Code**, **Cursor**, and **Codex**.

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
  },
  "permissions": {
    "allow": [
      "mcp__hive-memory__*"
    ]
  }
}
```

> The `permissions.allow` entry auto-approves all Hive Memory tools so Claude won't prompt for every call.

### Step 2: Agent Instructions

Copy the template from [`claude-md-template.md`](./claude-md-template.md) and append it to your `~/.claude/CLAUDE.md`.

```bash
# If you don't have a CLAUDE.md yet:
cp docs/claude-md-template.md ~/.claude/CLAUDE.md

# If you already have one, append:
cat docs/claude-md-template.md >> ~/.claude/CLAUDE.md
```

### Step 3 (Optional): Auto Session Capture

Add to `~/.claude/settings.json` to automatically save sessions when Claude Code exits:

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

This parses the Claude Code transcript and auto-saves a session summary. It skips if `session_save` was already called during the conversation.

### Verify

Restart Claude Code and say:

> "List all Hive Memory projects"

Claude should call `project_search` with an empty query. If it says "no projects registered yet", Hive Memory is working.

To onboard your workspace:

> "Scan ~/Desktop/project for projects and register them"

This registers all detected projects AND scans for existing agent memory files (MEMORY.md, AGENTS.md, .cursor/rules/), indexing them as searchable reference entries.

---

## Cursor

### Step 1: MCP Server Config

Add to `.cursor/mcp.json` in your project (or global settings):

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

If Cursor supports custom system prompts or rule files, add the contents of [`claude-md-template.md`](./claude-md-template.md) to your `.cursor/rules/` or equivalent instruction file.

### Note on References

When you onboard a project that has `.cursor/rules/` files, Hive Memory indexes them as reference entries. This means `memory_recall` searches can surface relevant Cursor rules from other projects.

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

## All Agents Together

If you use multiple agents, just set up each one. They share the same `~/.cortex/` data directory, so memories stored by one agent are visible to all others.

```
Claude Code ──┐
              │
Cursor ───────┼── hive-memory ── ~/.cortex/ (shared)
              │
Codex ────────┘
```

Additionally, Hive Memory indexes each agent's native memory files as **reference entries**:

```
Claude's MEMORY.md ──┐
                     │
Codex's AGENTS.md ───┼── indexed as references ── searchable via memory_recall
                     │
Cursor's rules/ ─────┘
```

This means knowledge stored in Claude's MEMORY.md can be discovered when working in Cursor or Codex — without duplicating the content.

---

## Usage Workflow

Here's what a typical session looks like:

### 1. Starting a session

```
You: "Let's work on the dashboard project"
Agent: calls project_status("dashboard", detail="brief")
Agent: "Dashboard — React SPA. Last session: added auth flow. Next: implement rate limiting."
```

### 2. Finding relevant knowledge

```
You: "How did we handle auth in other projects?"
Agent: calls memory_recall("authentication")
Agent: "Found 3 results:
  - [api-server/decision] Use JWT tokens for service auth
  - [mobile-app/claude-memory] (reference) Auth token refresh strategy
    Path: /Users/.../MEMORY.md
  - [dashboard/learning] OAuth2 PKCE flow works well for SPAs"
Agent: reads the MEMORY.md file for full context
```

### 3. Storing new knowledge

```
You: "Let's use the same JWT approach"
Agent: calls memory_store("dashboard", "decision", "Use JWT tokens consistent with api-server", ["auth", "jwt"])
```

### 4. Ending a session

```
You: "Let's wrap up"
Agent: calls session_save("dashboard", summary="Implemented JWT auth...", nextTasks=["Add refresh tokens", "Write auth tests"], decisions=["Use JWT consistent with api-server"], learnings=["PKCE flow needed for SPA"])
```

### 5. Onboarding a new workspace

```
You: "Register all my projects under ~/projects"
Agent: calls project_onboard("~/projects", register=true)
Agent: "Registered 5 projects. Detected agent memory files:
  - proj-a: CLAUDE.md, MEMORY.md
  - proj-b: AGENTS.md
  - proj-c: .cursor/rules/ (3 files)"
```
