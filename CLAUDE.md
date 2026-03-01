# Hive Memory — Cross-Project Memory for AI Agents

## Project Overview
MCP server that solves fragmented information across multiple AI agent workspaces.
Agents store/retrieve project context through this server, enabling cross-project memory.

## Tech Stack
- TypeScript, Node.js (ES modules)
- MCP SDK (`@modelcontextprotocol/sdk`)
- Storage: local JSON/Markdown files (phase 1), SQLite + FTS5 (phase 2)
- No external services — everything runs locally

## Architecture
- Hub-and-spoke: central store at `~/.cortex/` with per-project subdirectories
- Progressive disclosure: always-loaded summaries + on-demand detail files
- MCP tools: `project_search`, `project_status`, `memory_store`, `memory_recall`, `session_save`

## Conventions
- `src/` — TypeScript source
- `docs/` — design docs, research
- `tests/` — vitest tests
- Build: `npm run build`, Dev: `npm run dev`, Test: `npm test`
