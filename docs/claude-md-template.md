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
- **Reference entries**: Pointers to external files (MEMORY.md, CLAUDE.md, AGENTS.md, etc.) — shown as `[project/source] (reference)` with a file path

When you see a reference result, you can read the file directly with the `Read` tool to get the full content.

Example result:
```
**[proj-a/decision]**
Use JWT tokens for service-to-service auth

---

**[proj-b/claude-memory]** (reference)
JWT token expiration handling notes
Path: /Users/.../MEMORY.md
```

### Tool Reference

| Situation | Tool |
|-----------|------|
| Starting work on a project | `project_status(project, detail="full")` |
| Searching for a project | `project_search(query)` |
| Listing all projects | `project_search("")` (empty query) |
| Need to recall past decisions | `memory_recall(query)` |
| Need knowledge from a specific project | `memory_recall(query, project=id)` |
| Found something worth remembering | `memory_store(project, category, content)` |
| Wrapping up a session | `session_save(project, summary, nextTasks, decisions, learnings)` |
| Scanning a directory for projects | `project_onboard(path, register=true)` |

### Don't Overdo It

- Don't call tools for quick questions unrelated to any project
- Don't store every small detail — store decisions, architecture insights, debugging breakthroughs
- One `session_save` at the end is usually enough
