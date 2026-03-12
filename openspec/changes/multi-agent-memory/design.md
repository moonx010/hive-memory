## Context

Hive Memory v2.0은 단일 MCP 서버로 Claude Code에서 호출되는 구조. 데이터는 `~/.cortex/`에 JSON 파일로 저장되며, Hive Cell tree로 O(log N) semantic search를 지원한다.

현재 한계:
- **Single-agent assumption**: MCP 프로토콜로만 접근 가능 → Codex, Cursor 등 MCP 미지원 에이전트 배제
- **No identity**: 메모리에 저자 정보 없음 → 멀티에이전트 환경에서 추적 불가
- **No concurrency control**: JSON 파일 직접 쓰기 → 동시 접근 시 데이터 손실 가능
- **Disconnected from auto-memory**: Claude Code의 내장 메모리와 별개 시스템

## Goals / Non-Goals

**Goals:**
- 여러 에이전트(Claude, Codex worker, Cursor)가 동시에 같은 Hive에 메모리 읽기/쓰기
- 각 에이전트의 기여를 식별 및 추적
- MCP 없는 에이전트도 CLI로 동일한 기능 접근
- Claude Code auto-memory와 Hive 간 중복 최소화
- 기존 v2.0 데이터 및 API 하위 호환성 유지

**Non-Goals:**
- 네트워크/클라우드 동기화 (로컬 전용 유지)
- 실시간 pub/sub 알림 (polling/hook 기반으로 충분)
- GUI/대시보드 (P3이지만 이번 change 범위 밖)
- 다른 LLM 프로바이더 직접 통합 (CLI로 범용 접근)

## Decisions

### D1: agentId는 optional string (기존 데이터 호환)

**선택**: `DirectEntry.agentId?: string` — undefined 허용
**대안 A**: required field + migration script → 기존 36개 entry 모두 수정 필요
**대안 B**: 별도 AgentEntry 타입 → 불필요한 복잡성
**이유**: 기존 entry는 agentId 없이도 정상 동작해야 함. optional로 하면 migration 불필요.

### D2: CLI는 기존 bin entry (`hive-memory`) 확장

**선택**: `hive-memory store/recall/status` 서브커맨드 추가
**대안**: 별도 CLI 바이너리 (`hive-cli`) → 설치/배포 복잡
**이유**: 이미 `bin: "hive-memory"`이 있고, hook용 `hive-memory hook session-end`도 있음. 같은 패턴으로 확장.

```
hive-memory store --project <id> --category decision --agent codex-w1 "content"
hive-memory recall --project <id> --query "search terms" [--agent <id>] [--limit 5]
hive-memory status --project <id>
hive-memory inject --project <id> --query "task context" --output PROMPT.md
```

### D3: File lock은 lockfile (mkdir-based)

**선택**: `~/.cortex/.lock/hive.lock` 디렉토리 기반 atomic lock
**대안 A**: `flock()` syscall → macOS/Linux 호환 이슈, Node.js에서 복잡
**대안 B**: SQLite WAL mode → 전체 스토리지 마이그레이션 필요 (미래 고려)
**대안 C**: No lock, last-write-wins → 데이터 손실 위험
**이유**: `mkdir`는 POSIX에서 atomic operation. 구현 간단하고 cross-platform.

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

Stale lock 보호: lock 생성 시 PID 파일 포함, 30초 timeout.

### D4: Auto-memory sync는 onboard 시점 + CLI trigger

**선택**: `project_onboard` 실행 시 + `hive-memory sync --project <id>` CLI 커맨드
**대안**: File watcher (fsevents) → 상시 프로세스 필요, 배터리 소모
**이유**: MCP 서버는 Claude Code 세션 중에만 실행됨. 상시 watch 부적합. 필요 시 CLI로 수동 트리거.

### D5: Worker integration은 shell script wrapper

**선택**: `scripts/worker-inject.sh`, `scripts/worker-capture.sh`
**대안**: Codex의 AGENTS.md에 hive-memory CLI 호출 지시 → Codex가 임의로 무시 가능
**이유**: Shell script로 확정적 실행. codex-worker.sh의 pre/post hook으로 통합.

```bash
# worker-inject.sh: worker 시작 전 실행
hive-memory recall --project $PROJECT --query "$TASK_DESC" --limit 3 >> PROMPT.md

# worker-capture.sh: worker 완료 후 실행
SUMMARY=$(git log -1 --format=%B)
hive-memory store --project $PROJECT --category learning --agent "codex-w$WORKER_ID" "$SUMMARY"
```

### D6: Memory lifecycle은 category-based TTL

**선택**: `status` 카테고리만 30일 TTL, 나머지(`decision`, `learning`, `note`)는 영구
**대안**: 모든 카테고리에 TTL → decision이 사라지면 context 손실
**이유**: status는 "현재 진행 상태"로 시간에 민감. decision/learning은 장기 가치.

## Risks / Trade-offs

**[mkdir lock contention]** → 여러 worker가 동시에 store하면 lock 대기. Mitigation: nursery append는 lock-free, flush만 lock. 대부분의 store는 nursery append로 끝남 (flush threshold = 10).

**[CLI overhead]** → 매 CLI 호출마다 embedding model 로드 (transformers.js 초기화 ~2-3초). Mitigation: `--no-embed` 플래그로 keyword-only 모드 지원. Worker integration에서는 속도 우선.

**[Breaking change: agentId]** → 기존 코드가 DirectEntry를 strict type check하면 깨질 수 있음. Mitigation: optional field이므로 런타임 영향 없음. TypeScript만 재빌드.

**[Auto-memory drift]** → MEMORY.md와 Hive에 같은 정보가 다른 버전으로 존재. Mitigation: Hive는 ReferenceEntry(포인터만)로 중복 저장 안 함. "Source of truth는 MEMORY.md, Hive는 검색 인덱스" 원칙.

## Open Questions

1. ~~Codex CLI가 향후 MCP 지원하면 CLI interface가 불필요해지나?~~ → CLI는 범용이므로 유지 가치 있음. Codex뿐 아니라 cron, CI/CD에서도 사용 가능.
2. conflict detection의 정확도 — 같은 토픽인지 판단하는 임계값은 어떻게 설정? → cosine similarity > 0.85 + 같은 category로 시작, 실험 후 조정.
