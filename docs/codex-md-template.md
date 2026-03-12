## Hive Memory — Cross-Project Memory

Hive Memory MCP server is available via MCP. Use it to maintain continuity across sessions and discover knowledge across all projects.

### Session Start

When you detect which project is being worked on:

1. Call `project_status` with the project ID and `detail="full"` to load context (includes cross-project insights via semantic search)
2. If the project is NOT registered, use `project_onboard` with the directory path and `register=true` to discover and register it. This also scans for existing agent memory files (MEMORY.md, AGENTS.md, .cursor/rules)

### During Work

Store important information as it comes up using the `memory_store` tool:

- Key decisions: category "decision"
- Debugging insights: category "learning"
- Status milestones: category "status"

Don't store trivial things — focus on what would help future sessions.

### Searching Knowledge

Use `memory_recall` with a query to search across all projects. Results include two types:

- **Direct entries**: Actual content stored via `memory_store` — shown with `[project/category]`
- **Reference entries**: Pointers to external files (MEMORY.md, CLAUDE.md, AGENTS.md, etc.) — shown with `[project/source] (reference)` and include a file path

When you see a reference result with a file path, read that file to get full content.

### Session End

When the user says they're done or wrapping up:

1. Call `session_save` with a summary of what was done, next tasks, decisions made, and learnings

### Available Tools

- `project_register` — Register or update a project (upsert)
- `project_search` — Search projects by name/tags, or list all (empty query)
- `project_status` — Get project context with cross-project insights
- `project_onboard` — Auto-discover projects in a directory and scan for agent memory files
- `memory_store` — Store a decision, learning, or note
- `memory_recall` — Search memories across all projects (returns direct entries + reference pointers)
- `session_save` — Save session progress

### Don't Overdo It

- Don't call tools for quick questions unrelated to any project
- Don't store every small detail — store decisions, architecture insights, debugging breakthroughs
- One `session_save` at the end is usually enough
