# Hive Memory — Cross-Project Memory for AI Agents

## Project Overview
MCP server that gives AI coding agents persistent memory across projects.
Agents store/retrieve project context through this server, enabling cross-project discovery via semantic search.
Two entry types: direct (agent-stored knowledge) and reference (pointers to existing agent memory files like MEMORY.md, AGENTS.md, .cursor/rules).

## Tech Stack
- TypeScript, Node.js (ES modules)
- MCP SDK (`@modelcontextprotocol/sdk`)
- Embeddings: `@huggingface/transformers` (built-in, 384-dim)
- Storage: Hive Cell tree (`~/.cortex/hive.json` + `cells/`) + project JSON/Markdown
- No external services — everything runs locally

## Architecture
- **Hive Cell**: Global cell tree organizing all knowledge by semantic similarity
  - Nursery buffer (flush at 10 entries) → leaf cells (split at 20 via k-means)
  - O(log N) beam search (width=3, score = 0.7 × vector + 0.3 × keyword)
  - Two entry types: DirectEntry (content in hive) + ReferenceEntry (path to external file)
- 7 MCP tools: `project_register`, `project_search`, `project_status`, `project_onboard`, `memory_store`, `memory_recall`, `session_save`
- Cross-project discovery via beam search (no manual grouping)
- Reference scanning on `project_onboard`: detects MEMORY.md, CLAUDE.md, AGENTS.md, .cursor/rules
- Auto session capture via Claude Code `SessionEnd` hook
- Legacy compatibility: dual-write to knowledge/ markdown + hive; auto-migration on first run

## Module Structure
- `src/store.ts` — Facade: initializes hive, auto-migrates legacy data
- `src/store/hive-index.ts` — Pure functions: centroid, cosine sim, keywords, kMeans2
- `src/store/hive-store.ts` — HiveStore: nursery, cells, flush, split, direct/reference entries
- `src/store/hive-search.ts` — HiveSearch: beam search through cell tree
- `src/store/hive-migrate.ts` — Legacy migration + external memory reference scanning
- `src/store/` — project-store, memory-store, session-store, context-sync, onboard, io
- `src/tools/` — project-tools, memory-tools, session-tools
- `src/hooks/` — session-end handler, transcript parser
- `src/embed.ts` — Embedding service (native/JS/none fallback), includes `getEmbedding()`
- `tests/` — vitest tests (95 tests across 7 files)

## Conventions
- `src/` — TypeScript source
- `docs/` — design docs, setup guide, instruction templates
- `tests/` — vitest tests
- Build: `npm run build`, Dev: `npm run dev`, Test: `npm test`
