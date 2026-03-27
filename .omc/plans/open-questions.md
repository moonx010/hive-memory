# Open Questions

## enrichment-framework - 2026-03-25
- [ ] Should `enrichBatch` run enrichment on entities from ALL projects or only a specific project? — The design's `BatchFilter` has no `project` field, which means it enriches across all projects. Confirm this is intentional.
- [ ] Should `upsertEntity` (for derived entities) check for duplicates by `source.externalId`? — The `EntityDraft` includes source info; without dedup, running enrichment twice could create duplicate derived entities.
- [ ] TopicStitcher `CORTEX_TOPIC_STITCH=on` env var — is this separate from `CORTEX_ENRICHMENT`? The design mentions it as a separate guard but it's unclear if `CORTEX_ENRICHMENT=off` should also disable topic stitching.
- [ ] LLM retry backoff (2s) — should this be configurable via env var (e.g., `CORTEX_LLM_RETRY_DELAY_MS`)? Current design hardcodes it.
- [ ] Eval dataset — who creates the 50+ labeled samples? This is manual labeling work. Consider generating a starter set from existing test fixtures and hand-labeling.

## team-features-v1 - 2026-03-26
- [ ] Should the Slack bot use the same `SLACK_TOKEN` as the read-only connector, or a separate bot token? — Using the same token is simpler but may need additional scopes (`chat:write`, `app_mentions:read`) that could require re-installing the Slack app.
- [ ] Should `hive-memory connect` create a user automatically if none exists, or require `hive-memory user create` first? — Auto-create is smoother UX but conflates two operations.
- [ ] For the Slack bot, should `visibility: personal` entities be completely hidden, or shown with a "(personal)" tag? — Security favors complete hiding; usability favors tagged display.
- [ ] Should the MCP gateway support stdio mode (local process) in addition to HTTP mode? — Some users may prefer running hive-memory locally per-user rather than connecting to a shared server. This changes the config template significantly.
- [ ] What happens when the Slack bot query returns zero results? — Should it suggest alternative queries, say "nothing found", or silently not respond?
- [ ] Should the `users` table track last-used timestamp for API keys? — Useful for admin audit but adds a write on every request.

## loom-as-agent-tool - 2026-03-26
- [ ] SDK custom tools API: Verify the exact `@anthropic-ai/claude-agent-sdk` API for registering custom tools and returning tool_results. The `tools` option and `streamInput()` pattern need SDK docs confirmation. — Blocks Task 2 implementation details.
- [ ] Auto-load policy: Should `loom-orchestrator` skill be auto-loaded for ALL tasks, or only when no explicit workflow/skills are specified? Auto-loading adds ~100 tokens overhead per task but gives the agent workflow awareness universally. — Affects Task 4 scope.
- [ ] Workflow catalog refresh: Should the catalog be refreshed on every `loom_list` call, or cached with file watcher? File watcher is cleaner but adds complexity. Mtime-based cache invalidation is simpler. — Implementation detail for Task 1.
- [ ] Cost attribution: When the agent invokes `loom_run`, the workflow's cost is tracked separately by loom.ts but not attributed to the parent task's `costUsd`. Should we aggregate? — Affects metrics accuracy.
- [ ] Loom v2 syntax: CLAUDE.md references v2 syntax (`step`/`engine` instead of `agent`/`phase`), but existing .loom files use both styles. The catalog parser needs to handle both. — Affects Task 1 parser.
