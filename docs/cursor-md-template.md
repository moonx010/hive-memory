## Hive Memory — Cross-Project Memory

Hive Memory MCP server is available. Use it to maintain continuity across sessions and discover knowledge across all projects.

### Session Start

When you detect which project is being worked on:

1. Call `project_status(project, detail="brief")` to load context
2. If the project is NOT registered, onboard it: `project_onboard(path, register=true)` auto-detects the project and scans for existing agent memory files (MEMORY.md, AGENTS.md, .cursor/rules)

### During Work

Store important information as it comes up:

- Key decisions → `memory_store(project, "decision", ...)`
- Debugging insights → `memory_store(project, "learning", ...)`
- Status milestones → `memory_store(project, "status", ...)`

Don't store trivial things — focus on what would help future sessions.

### Searching Knowledge

Use `memory_recall(query)` to search across all projects. Results include two types:

- **Direct entries**: Actual content stored via `memory_store` — shown as `[project/category]`
- **Reference entries**: Pointers to external files (MEMORY.md, .cursor/rules, etc.) — shown as `[project/source] (reference)` with a file path

When you see a reference result, read the file directly to get the full content.

### Browsing & Exploring

Use browse tools to explore stored knowledge without searching:

| Tool | Use Case |
|------|----------|
| `memory_ls(project)` | List all entries in a project |
| `memory_tree(project)` | Tree view of entries by type/category |
| `memory_grep(pattern)` | Regex search across all memory content |
| `memory_inspect(entityId)` | Deep-dive into a single entry with connections |
| `memory_timeline(project)` | Chronological view of recent activity |

### Entity Resolution (People)

When working across multiple tools (GitHub, Slack, Calendar), use entity resolution to unify person identities:

- `entity_resolve(action="list_candidates", entityId=...)` — Find duplicate person entities across sources
- `entity_resolve(action="merge", entityId=..., mergeIntoId=..., confirmed=true)` — Merge duplicates

### Meeting Processing

Process meeting transcripts (VTT, SRT, or plain text) to extract structured notes:

- `meeting_process(transcriptPath=..., title=..., date=...)` — Parse transcript, extract decisions and action items, create meeting entity with attendee relationships

### Enrichment

Enrich entities with metadata, classifications, and inferred relationships:

- `context_enrich(scope="entity", entityId=...)` — Enrich a single entity
- `context_enrich(scope="batch", limit=100)` — Batch-enrich unenriched entities

### Tool Quick Reference

| Situation | Tool |
|-----------|------|
| Starting work on a project | `project_status(project, detail="full")` |
| Searching for a project | `project_search(query)` |
| Need to recall past decisions | `memory_recall(query)` |
| Need knowledge from a specific project | `memory_recall(query, project=id)` |
| Found something worth remembering | `memory_store(project, category, content)` |
| Wrapping up a session | `session_save(project, summary, nextTasks, decisions, learnings)` |
| Scanning a directory for projects | `project_onboard(path, register=true)` |
| Processing a meeting transcript | `meeting_process(transcriptPath, title, date)` |
| Finding duplicate people | `entity_resolve(action="list_candidates", entityId)` |
| Enriching entities | `context_enrich(scope="batch")` |

### Don't Overdo It

- Don't call tools for quick questions unrelated to any project
- Don't store every small detail — store decisions, architecture insights, debugging breakthroughs
- One `session_save` at the end is usually enough
