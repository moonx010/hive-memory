## Why

Hive Memory는 현재 **단일 에이전트(Claude Code)** 전용 메모리 서버다. 하지만 실제 워크플로우에서는 Claude(orchestrator) + Codex workers(parallel coders) + Cursor 등 **여러 에이전트가 동시에** 같은 프로젝트에서 작업한다. 현재 구조에서는:

1. 누가 어떤 메모리를 저장했는지 식별 불가 (agentId 없음)
2. Codex는 MCP 미지원 → Hive 도구에 접근 불가
3. 동시 write 시 nursery flush race condition 발생 가능
4. Claude Code auto-memory(`MEMORY.md`)와 Hive가 독립적으로 동작, 동기화 없음
5. CLAUDE.md 지시문이 v1 기준이라 존재하지 않는 도구 참조

## What Changes

- **Agent identity tracking**: 모든 메모리 저장에 agentId 필드 추가 (누가 저장했는지)
- **CLI write interface**: MCP 미지원 에이전트(Codex)가 CLI로 메모리 읽기/쓰기 가능
- **Concurrent write safety**: nursery flush에 file lock 도입
- **Auto-memory sync**: Claude Code MEMORY.md 변경 감지 → Hive ReferenceEntry 자동 업데이트
- **Worker context injection**: worker 시작 시 관련 메모리를 자동 주입하는 스크립트
- **Worker result capture**: worker 완료 후 변경사항을 자동 저장하는 스크립트
- **Memory lifecycle**: status 메모리 TTL, conflict detection
- **CLAUDE.md instruction update**: v2.0 (7 도구) 기준으로 재작성
- **SessionEnd hook activation**: 자동 세션 저장 활성화

## Capabilities

### New Capabilities
- `agent-identity`: 에이전트 식별 및 추적. agentId 필드를 DirectEntry와 memory_store에 추가. recall 시 agent별 필터링.
- `cli-interface`: CLI를 통한 메모리 접근. `hive-memory store/recall/status` 서브커맨드. MCP 없이도 에이전트가 메모리 사용 가능.
- `write-safety`: 동시 쓰기 안전성. nursery flush에 lockfile 기반 mutex. 다중 프로세스 동시 접근 보호.
- `memory-sync`: 외부 에이전트 메모리(MEMORY.md 등)와 양방향 동기화. 파일 변경 감지 + ReferenceEntry 갱신.
- `worker-integration`: multi-agent 워크플로우 통합 스크립트. context injection (recall → PROMPT.md) + result capture (commit → store).
- `memory-lifecycle`: 메모리 수명 관리. status 카테고리 TTL, 동일 토픽 상충 감지, 오래된 메모리 정리.

### Modified Capabilities
(없음 — 기존 openspec/specs 없음, 모두 신규)

## Impact

- **src/types.ts**: DirectEntry에 agentId 필드 추가 — **BREAKING** (기존 entry에 undefined 허용 필요)
- **src/tools/memory-tools.ts**: memory_store에 agentId 파라미터, memory_recall에 agent 필터
- **src/store/hive-store.ts**: flush에 file lock 로직 추가
- **src/index.ts**: CLI 서브커맨드 라우팅 추가 (store, recall, status)
- **src/hooks/**: 새 hook — file-watcher (MEMORY.md sync)
- **scripts/**: worker-inject.sh, worker-capture.sh 신규
- **~/.claude/CLAUDE.md**: 전역 지시문 v2.0 재작성
- **~/.claude/settings.json**: SessionEnd hook 추가
