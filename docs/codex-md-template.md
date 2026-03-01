## Cortex — Cross-Project Memory

Cortex MCP server (`cortex`) is available via MCP. Use it to maintain continuity across sessions and projects.

### Session Start

When you detect which project is being worked on:

1. Call the `project_status` tool with the project ID to load context
2. If the project is NOT registered, use `project_onboard` with the directory path to discover and register it
3. If the project belongs to a group, let the user know — they may want shared guides via `group_context`

### During Work

Store important information as it comes up using the `memory_store` tool:

- Key decisions: category "decision"
- Debugging insights: category "learning"
- Status milestones: category "status"

Don't store trivial things — focus on what would help future sessions.

### Session End

When the user says they're done or wrapping up:

1. Call `session_save` with a summary of what was done, next tasks, decisions made, and learnings

### Available Tools

**Project management:**
- `project_register` — Register a new project
- `project_list` — List all registered projects
- `project_update` — Update project metadata or status
- `project_search` — Search projects by name or tags
- `project_status` — Get current context and last session info
- `project_onboard` — Auto-discover projects in a directory

**Memory:**
- `memory_store` — Store a decision, learning, or note
- `memory_recall` — Search and recall relevant memories

**Sessions:**
- `session_save` — Save session progress

**Groups:**
- `group_create` — Create a group of related projects
- `group_list` — List all groups
- `group_update` — Add/remove projects from a group
- `group_context` — Get shared guides and group info
- `group_guide_save` — Save a shared guide for the group

### Don't Overdo It

- Don't call Cortex tools for quick questions unrelated to any project
- Don't store every small detail — store decisions, architecture insights, debugging breakthroughs
- One `session_save` at the end is usually enough
