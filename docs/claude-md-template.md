## Cortex — Cross-Project Memory

Cortex MCP server (`cortex`) is available. Use it to maintain continuity across sessions and projects.

### Session Start

When you detect which project is being worked on:

1. Call `project_status(project, detail="brief")` to load context
2. If the project is NOT registered, onboard it: `project_onboard(path)` or `project_register(...)`
3. If the project belongs to a group, mention it — the user may want shared guides via `group_context()`

### During Work

Store important information as it comes up:

- Key decisions → `memory_store(project, "decision", ...)`
- Debugging insights → `memory_store(project, "learning", ...)`
- Status milestones → `memory_store(project, "status", ...)`

Don't store trivial things — focus on what would help future sessions.

### Session End

When the user says they're done or wrapping up:

1. Call `session_save(project, summary, nextTasks, decisions, learnings)`

### Tool Reference

| Situation | Tool |
|-----------|------|
| Starting work on a project | `project_status` |
| Searching for a project | `project_search` |
| Need to recall past decisions | `memory_recall` |
| Found something worth remembering | `memory_store` |
| Wrapping up a session | `session_save` |
| Need shared guides for a group | `group_context(group, detail="full")` |
| Scanning a directory for projects | `project_onboard(path)` |

### Don't Overdo It

- Don't call Cortex tools for quick questions unrelated to any project
- Don't store every small detail — store decisions, architecture insights, debugging breakthroughs
- One `session_save` at the end is usually enough
