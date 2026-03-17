## Why

Hive Memory is currently a **single-agent (Claude Code)** memory server. However, real workflows involve Claude (orchestrator) + Codex workers (parallel coders) + Cursor, with **multiple agents working simultaneously** on the same project. Current limitations:

1. No way to identify who stored a given memory (no agentId)
2. Codex doesn't support MCP → cannot access Hive tools
3. Concurrent writes can cause nursery flush race conditions
4. Claude Code auto-memory (`MEMORY.md`) and Hive operate independently with no sync
5. CLAUDE.md instructions reference v1 tools that no longer exist

## What Changes

- **Agent identity tracking**: Add agentId field to all memory stores (who stored it)
- **CLI write interface**: Non-MCP agents (Codex) can read/write memory via CLI
- **Concurrent write safety**: Introduce file lock on nursery flush
- **Auto-memory sync**: Detect MEMORY.md changes → auto-update Hive ReferenceEntry
- **Worker context injection**: Script to auto-inject relevant memories before worker starts
- **Worker result capture**: Script to auto-save changes after worker completes
- **Memory lifecycle**: Status memory TTL, conflict detection
- **CLAUDE.md instruction update**: Rewrite for v2.0 (7 tools)
- **SessionEnd hook activation**: Enable auto session saving

## Capabilities

### New Capabilities
- `agent-identity`: Agent identification and tracking. Add agentId field to DirectEntry and memory_store. Filter by agent on recall.
- `cli-interface`: Memory access via CLI. `hive-memory store/recall/status` subcommands. Agents can use memory without MCP.
- `write-safety`: Concurrent write safety. Lockfile-based mutex on nursery flush. Multi-process concurrent access protection.
- `memory-sync`: Bidirectional sync with external agent memory (MEMORY.md, etc.). File change detection + ReferenceEntry refresh.
- `worker-integration`: Multi-agent workflow integration scripts. Context injection (recall → PROMPT.md) + result capture (commit → store).
- `memory-lifecycle`: Memory lifetime management. Status category TTL, same-topic conflict detection, stale memory cleanup.

### Modified Capabilities
(None — no existing openspec/specs, all new)

## Impact

- **src/types.ts**: Add agentId field to DirectEntry — **BREAKING** (existing entries need to allow undefined)
- **src/tools/memory-tools.ts**: Add agentId parameter to memory_store, agent filter to memory_recall
- **src/store/hive-store.ts**: Add file lock logic to flush
- **src/index.ts**: Add CLI subcommand routing (store, recall, status)
- **src/hooks/**: New hook — file-watcher (MEMORY.md sync)
- **scripts/**: New worker-inject.sh, worker-capture.sh
- **~/.claude/CLAUDE.md**: Rewrite global instructions for v2.0
- **~/.claude/settings.json**: Add SessionEnd hook
