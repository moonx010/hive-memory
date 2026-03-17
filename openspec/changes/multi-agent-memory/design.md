## Context

Hive Memory v2.0 is a single MCP server called from Claude Code. Data is stored as JSON files in `~/.cortex/`, with a Hive Cell tree supporting O(log N) semantic search.

Current limitations:
- **Single-agent assumption**: Only accessible via MCP protocol → excludes agents like Codex and Cursor that don't support MCP
- **No identity**: No author information in memories → impossible to track in multi-agent environments
- **No concurrency control**: Direct JSON file writes → potential data loss on concurrent access
- **Disconnected from auto-memory**: Operates independently from Claude Code's built-in memory

## Goals / Non-Goals

**Goals:**
- Multiple agents (Claude, Codex workers, Cursor) simultaneously read/write to the same Hive
- Identify and track each agent's contributions
- CLI access for agents without MCP support
- Minimize duplication between Claude Code auto-memory and Hive
- Maintain backward compatibility with existing v2.0 data and APIs

**Non-Goals:**
- Network/cloud sync (stay local-only)
- Real-time pub/sub notifications (polling/hook-based is sufficient)
- GUI/dashboard (P3 scope, outside this change)
- Direct integration with other LLM providers (CLI provides universal access)

## Decisions

### D1: agentId is an optional string (backward compatible)

**Choice**: `DirectEntry.agentId?: string` — allows undefined
**Alt A**: Required field + migration script → requires modifying all 36 existing entries
**Alt B**: Separate AgentEntry type → unnecessary complexity
**Reason**: Existing entries must work without agentId. Making it optional avoids migration.

### D2: CLI extends the existing bin entry (`hive-memory`)

**Choice**: Add `hive-memory store/recall/status` subcommands
**Alt**: Separate CLI binary (`hive-cli`) → complicates installation/distribution
**Reason**: `bin: "hive-memory"` already exists, and `hive-memory hook session-end` follows the same pattern. Extend it.

```
hive-memory store --project <id> --category decision --agent codex-w1 "content"
hive-memory recall --project <id> --query "search terms" [--agent <id>] [--limit 5]
hive-memory status --project <id>
hive-memory inject --project <id> --query "task context" --output PROMPT.md
```

### D3: File lock uses lockfile (mkdir-based)

**Choice**: `~/.cortex/.lock/hive.lock` directory-based atomic lock
**Alt A**: `flock()` syscall → macOS/Linux compatibility issues, complex in Node.js
**Alt B**: SQLite WAL mode → requires full storage migration (future consideration)
**Alt C**: No lock, last-write-wins → risk of data loss
**Reason**: `mkdir` is an atomic operation on POSIX. Simple to implement and cross-platform.

```typescript
// Lock acquisition
const lockDir = join(dataDir, '.lock', 'hive.lock');
await mkdir(lockDir, { recursive: false }); // throws if exists
try {
  await flushNursery();
} finally {
  await rmdir(lockDir);
}
```

Stale lock protection: PID file included at lock creation, 30-second timeout.

### D4: Auto-memory sync at onboard time + CLI trigger

**Choice**: Runs during `project_onboard` + `hive-memory sync --project <id>` CLI command
**Alt**: File watcher (fsevents) → requires always-on process, battery drain
**Reason**: MCP server only runs during Claude Code sessions. Always-on watch is unsuitable. CLI trigger for on-demand sync.

### D5: Worker integration via shell script wrappers

**Choice**: `scripts/worker-inject.sh`, `scripts/worker-capture.sh`
**Alt**: Instruct Codex via AGENTS.md to call hive-memory CLI → Codex may arbitrarily ignore
**Reason**: Shell scripts provide deterministic execution. Integrated as pre/post hooks in codex-worker.sh.

```bash
# worker-inject.sh: runs before worker starts
hive-memory recall --project $PROJECT --query "$TASK_DESC" --limit 3 >> PROMPT.md

# worker-capture.sh: runs after worker completes
SUMMARY=$(git log -1 --format=%B)
hive-memory store --project $PROJECT --category learning --agent "codex-w$WORKER_ID" "$SUMMARY"
```

### D6: Memory lifecycle uses category-based TTL

**Choice**: Only `status` category has 30-day TTL; others (`decision`, `learning`, `note`) are permanent
**Alt**: TTL on all categories → decisions disappearing causes context loss
**Reason**: Status entries represent "current state" and are time-sensitive. Decisions/learnings have long-term value.

## Risks / Trade-offs

**[mkdir lock contention]** → Multiple workers storing simultaneously will queue on lock. Mitigation: nursery append is lock-free, only flush acquires lock. Most stores end at nursery append (flush threshold = 10).

**[CLI overhead]** → Each CLI invocation loads the embedding model (transformers.js init ~2-3s). Mitigation: `--no-embed` flag for keyword-only mode. Worker integration prioritizes speed.

**[Breaking change: agentId]** → Existing code with strict type checking on DirectEntry may break. Mitigation: optional field has no runtime impact. Only TypeScript rebuild needed.

**[Auto-memory drift]** → Same information may exist in different versions in MEMORY.md and Hive. Mitigation: Hive uses ReferenceEntry (pointers only), avoiding duplicate storage. Principle: "MEMORY.md is source of truth, Hive is the search index."

## Open Questions

1. ~~Will CLI interface become unnecessary if Codex CLI supports MCP in the future?~~ → CLI has universal value beyond Codex — also usable from cron, CI/CD.
2. Conflict detection accuracy — how to set the threshold for "same topic"? → Start with cosine similarity > 0.85 + same category, adjust after experimentation.
