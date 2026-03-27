# Plan: Team Features v1 (Multi-User + Slack Bot + MCP Gateway)

**Created:** 2026-03-26
**Status:** Ready for review

## Context

Hive-Memory v3 is feature-complete as a single-user memory system. Three features are needed to make it a team tool: per-user auth, interactive Slack bot, and MCP gateway for personal agents.

## Work Objectives

1. Enable multiple team members to connect to a single hive-memory instance with per-user API keys.
2. Make hive-memory queryable from Slack via `@bumble bee` mentions.
3. Provide one-command onboarding for Claude Code and Cursor users.

## Guardrails

### Must Have
- Per-user API keys with SHA-256 hashing at rest
- Backward compatibility with existing `CORTEX_AUTH_TOKEN`
- Slack request signature verification
- Config file merge (never overwrite existing MCP servers)

### Must NOT Have
- OAuth / JWT / external identity providers (keep it lightweight)
- LLM dependency for Slack bot intent parsing (regex-first)
- Role-based permissions (all users are equal in v1)
- Interactive TUI wizards

## Task Flow

```
Phase A: multi-user-access (3-4 days)
  └─ users table + auth module + CLI + HTTP middleware
       │
       ├── Phase B: slack-bot-interactive (1 week)
       │     └─ /slack/events route + intent parser + formatter + response posting
       │
       └── Phase C: mcp-gateway (2-3 days)
             └─ connect CLI command + config templates + config writer
```

## Success Criteria

- [ ] 3+ users can connect to a single hive-memory instance with unique API keys
- [ ] `@bumble bee what did we decide about X?` returns relevant memories in Slack
- [ ] `hive-memory connect --tool claude --write` generates working MCP config
- [ ] All existing tests still pass
- [ ] New tests cover auth, bot intents, config merge

## OpenSpec Files

- `openspec/changes/multi-user-access/` — proposal.md, design.md, tasks.md
- `openspec/changes/slack-bot-interactive/` — proposal.md, design.md, tasks.md
- `openspec/changes/mcp-gateway/` — proposal.md, design.md, tasks.md
