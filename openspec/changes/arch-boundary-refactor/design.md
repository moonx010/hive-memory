## Context

hive-memory는 MCP 프로토콜을 통해 AI 에이전트에게 영구 메모리를 제공하는 서버다. 현재 단일 프로세스에서 메모리 연산(저장/검색/분석)과 에이전트 행동(Slack 봇, 외부 포스팅, 미팅 봇 오케스트레이션)을 모두 수행한다.

**현재 상태:**
- `src/bot/` — Bumble Bee Slack 봇 (intent parsing + Slack API)
- `src/meeting/output.ts` — Slack/Notion 포스팅
- `src/meeting/stt.ts` — 오디오 전사 (Whisper/Deepgram)
- `src/connectors/recall.ts` — 인바운드 싱크 + 아웃바운드 봇 오케스트레이션 혼재
- `src/index.ts` — MCP 서버 + Slack 이벤트 라우터 + 미팅 봇 스케줄러

**제약:**
- Railway에 배포 중 — 무중단 전환 필요
- jarvis 레포가 이미 존재 — Bumble Bee 코드의 수신처
- 30개 MCP 도구가 이미 안정화 — 인터페이스 유지

## Goals / Non-Goals

**Goals:**
- hive-memory를 순수 메모리 레이어로 만든다 (inbound only)
- 에이전트 행동을 jarvis/bumble-bee로 이동한다
- `meeting_process` 도구가 결과만 반환하고 포스팅하지 않도록 한다
- RecallConnector를 인바운드 전용으로 정리한다
- 무중단 점진적 마이그레이션

**Non-Goals:**
- jarvis 내부 아키텍처 설계 (별도 스코프)
- 기존 MCP 도구 인터페이스 대규모 변경
- 커넥터 프레임워크를 별도 서비스로 분리
- enrichment 파이프라인 변경 (메모리 레이어로 확정)

## Decisions

### D1: 아키텍처 경계 = 데이터 흐름 방향

**결정:** inbound (외부→DB) = hive-memory, outbound (DB→외부) = jarvis

- **대안 A:** "LLM 사용 여부"로 구분 → 기각. enrichment도 LLM 쓰지만 내부 데이터 변환이므로 메모리 레이어
- **대안 B:** "사용자 상호작용 여부"로 구분 → 불완전. 미팅 봇 스케줄링은 사용자 상호작용 없이도 아웃바운드

### D2: 통신 프로토콜 = MCP 도구

**결정:** jarvis의 Bumble Bee가 hive-memory MCP 도구를 통해 통신

- **대안 A:** 직접 DB 접근 → 기각. 배포 결합도 높음
- **대안 B:** 전용 HTTP API → 기각. MCP가 이미 존재하고 도구가 안정화

### D3: 3단계 점진적 마이그레이션

**결정:** Phase 1 (봇 추출) → Phase 2 (미팅 출력 추출) → Phase 3 (Recall 오케스트레이션 추출)

- 각 페이즈는 독립적으로 배포/롤백 가능
- feature flag (`BUMBLE_BEE_INTERNAL=true/false`)로 전환 기간 관리

### D4: MeetingAgent 리팩토링 방식

**결정:** `shareOutput()` 메서드를 제거하고, `process()`가 `MeetingAgentResult`만 반환

- `slackWebhook`, `notionParentPageId` 파라미터를 `MeetingAgentOptions`에서 제거
- `MeetingAgentResult`에서 `slackPosted`, `notionPageUrl` 필드 제거
- jarvis가 `meeting_process` 도구 응답의 `markdown`을 받아서 직접 포스팅

### D5: RecallClient 위치

**결정:** `RecallClient` 클래스는 hive-memory에 유지 (RecallConnector가 사용). jarvis에서 필요한 `joinMeeting()`은 별도 구현 (13줄)

- 공유 패키지로 추출하는 것은 과도한 추상화

## Risks / Trade-offs

| Risk | Severity | Mitigation |
|------|----------|------------|
| Railway 배포 중 봇 다운타임 | HIGH | Phase 1에서 feature flag로 전환. jarvis 봇 확인 후 hive-memory에서 제거 |
| MCP 레이턴시로 봇 응답 느려짐 | MEDIUM | 현재 직접 함수 호출 → MCP 왕복. 프로파일 후 필요시 HTTP search 엔드포인트 추가 |
| `meeting_process` 도구 Breaking Change | MEDIUM | 1 릴리스 동안 deprecated 파라미터 유지 (무시). 다음 릴리스에서 제거 |
| Phase 간 불완전한 상태 | LOW | 각 Phase가 독립적으로 동작하도록 설계. Phase 1만 완료해도 시스템은 정상 |

## Migration Plan

### Phase 1: 봇 추출
1. jarvis에 `src/bot/` 코드 복사 + MCP 클라이언트로 전환
2. hive-memory에 `BUMBLE_BEE_INTERNAL=false` flag 추가
3. jarvis Bumble Bee 배포 및 검증
4. hive-memory에서 `src/bot/`, `/slack/events` 라우트 제거

### Phase 2: 미팅 출력 추출
1. `MeetingAgent.shareOutput()` 제거, `process()` 순수화
2. `meeting_process` 도구에서 포스팅 파라미터 deprecated → 제거
3. `src/meeting/output.ts`, `src/meeting/stt.ts` 삭제
4. jarvis에서 `meeting_process` 결과 받아 포스팅

### Phase 3: Recall 오케스트레이션 추출
1. `joinMeeting()`, `scheduleBotsForUpcomingMeetings()` 제거
2. `index.ts` auto-sync에서 봇 스케줄링 코드 제거
3. `handleRecallWebhook()`에서 포스팅 로직 제거 (entity 생성만)
4. jarvis에서 캘린더 기반 봇 스케줄링 구현

### Rollback
- 각 Phase의 feature flag를 켜면 이전 동작 복원
- git revert로 각 Phase 커밋 독립적으로 롤백 가능

## Open Questions

1. jarvis의 Bumble Bee가 hive-memory MCP 서버에 연결하는 방식 — stdio vs HTTP? (HTTP가 유력, Railway 환경)
2. Recall webhook을 jarvis가 직접 받을지, hive-memory가 받아서 entity만 생성하고 jarvis가 폴링할지
3. jarvis에 별도 operational state DB가 필요한지 (봇 상태, 스케줄링 이력)
