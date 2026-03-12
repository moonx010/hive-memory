## 1. P0 — Immediate Fixes (No Code Changes)

- [x] 1.1 Update `~/.claude/CLAUDE.md` global instructions to match hive-memory v2.0 (7 tools, correct names, usage examples)
- [x] 1.2 Add `SessionEnd` hook to `~/.claude/settings.json` pointing to `hive-memory hook session-end`
- [x] 1.3 Register `agent-enterprise-research` project via `project_register`

## 2. P1-A — Agent Identity (types + memory_store + memory_recall)

- [x] 2.1 Add `agentId?: string` field to `DirectEntry` in `src/types.ts`
- [x] 2.2 Add `agentId?: string` field to `HiveSearchResult` in `src/store/hive-search.ts`
- [x] 2.3 Update `memory_store` tool to accept optional `agent` parameter and pass it through to `storeMemory()`
- [x] 2.4 Update `MemoryStore.storeMemory()` to set `agentId` on created DirectEntry
- [x] 2.5 Update `memory_recall` tool to accept optional `agent` parameter for filtering
- [x] 2.6 Update `HiveSearch` to filter results by agentId when provided
- [x] 2.7 Include `agent` field in search result output formatting (memory-tools.ts)
- [x] 2.8 Add vitest tests for agent identity (store with/without agentId, recall with filter)

## 3. P1-B — CLI Interface (store, recall, status, inject)

- [x] 3.1 Add CLI argument parser in `src/index.ts` for subcommands: `store`, `recall`, `status`, `inject`, `sync`, `cleanup`
- [x] 3.2 Implement `hive-memory store` CLI handler (parse --project, --category, --agent, content)
- [x] 3.3 Implement `hive-memory recall` CLI handler (parse --project, --query, --agent, --limit, --json)
- [x] 3.4 Implement `hive-memory status` CLI handler (parse --project, output summary)
- [x] 3.5 Implement `hive-memory inject` CLI handler (recall + append to --output file)
- [x] 3.6 Add `--no-embed` flag support: skip embedding init, use keyword-only search
- [x] 3.7 Add vitest tests for CLI argument parsing and handler routing

## 4. P1-C — Write Safety (file lock for nursery flush)

- [x] 4.1 Create `src/store/lock.ts` with mkdir-based lock (acquire, release, stale detection)
- [x] 4.2 Integrate lock into `HiveStore.flushNursery()` — acquire before flush, release after
- [x] 4.3 Add PID file inside lock dir for stale detection (30s timeout)
- [x] 4.4 Add vitest tests for lock (acquire, concurrent block, stale recovery)

## 5. P2-A — Memory Sync (CLI sync command)

- [x] 5.1 Implement `hive-memory sync` CLI handler that calls `scanProjectReferences` for one or all projects
- [x] 5.2 Update `scanProjectReferences` to compare lastSynced timestamps and skip unchanged files
- [ ] 5.3 Add vitest test for sync detecting new and updated files

## 6. P2-B — Worker Integration Scripts

- [x] 6.1 Create `scripts/worker-inject.sh` — calls `hive-memory inject` for a task, outputs to PROMPT.md
- [x] 6.2 Create `scripts/worker-capture.sh` — extracts commit message, calls `hive-memory store` with agentId
- [x] 6.3 Update `~/.claude/scripts/codex-worker.sh` to call inject before worker start and capture after completion
- [ ] 6.4 Test end-to-end: 1 worker with inject → codex exec → capture

## 7. P3 — Memory Lifecycle

- [x] 7.1 Add TTL check in `HiveSearch.searchEntries()` — exclude `status` entries older than 30 days
- [x] 7.2 Implement conflict detection: cosine similarity > 0.85 + same project + different agentId + same category=decision → flag
- [x] 7.3 Implement `hive-memory cleanup` CLI handler — remove expired entries, report stats
- [x] 7.4 Add vitest tests for TTL filtering and cleanup
