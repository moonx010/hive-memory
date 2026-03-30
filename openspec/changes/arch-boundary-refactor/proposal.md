## Why

hive-memory는 메모리/지식베이스 MCP 서버로 설계되었으나, 개발 과정에서 에이전트 레이어 코드(Slack 봇, 외부 서비스 포스팅, 미팅 봇 오케스트레이션)가 누적되어 아키텍처 경계가 무너졌다. 이로 인해 메모리 서버가 외부 부작용(side effects)을 가지게 되어 테스트가 어렵고, 소비자가 예상치 못한 동작에 놀라게 된다. 에이전트 행동(outbound)과 메모리 연산(inbound)을 분리하여 각 레이어가 독립적으로 진화할 수 있도록 한다.

## What Changes

- **`src/bot/`** (3파일, ~782줄) — jarvis로 이동. Bumble Bee Slack 봇은 hive-memory MCP 도구를 통해 통신
- **`src/meeting/output.ts`** (185줄) — jarvis로 이동. Slack/Notion 포스팅은 caller 책임
- **`src/meeting/stt.ts`** (247줄) — jarvis로 이동. 오디오 전사는 미디어 처리 파이프라인
- **`MeetingAgent.shareOutput()`** (~40줄) — 제거. `process()`는 결과만 반환
- **`recall.ts: joinMeeting()`, `scheduleBotsForUpcomingMeetings()`** (~83줄) — jarvis로 이동
- **`index.ts`** — `/slack/events` 봇 핸들링 제거, auto-sync에서 봇 스케줄링 제거
- **BREAKING**: `meeting_process` 도구가 더 이상 Slack/Notion에 자동 포스팅하지 않음. `slackWebhook`, `notionParentPageId` 파라미터 제거
- **BREAKING**: `/slack/events` 엔드포인트 제거 (jarvis가 대체)

## Capabilities

### New Capabilities
- `memory-only-meeting`: meeting_process 도구가 순수 메모리 연산만 수행 (entity 생성 + enrichment + markdown 반환). 외부 포스팅 없음
- `recall-inbound-only`: RecallConnector가 인바운드 싱크 전용으로 동작. 봇 오케스트레이션 함수 제거

### Modified Capabilities
<!-- No existing openspec specs to modify -->

## Impact

- **hive-memory**: `src/bot/`, `src/meeting/output.ts`, `src/meeting/stt.ts` 삭제. `MeetingAgent` 리팩토링 (shareOutput 제거). `index.ts` 슬랙/리콜 라우트 제거
- **jarvis**: Bumble Bee 봇 코드 수신. MCP 클라이언트를 통해 hive-memory 호출. Recall 봇 오케스트레이션 포함
- **배포**: Railway의 hive-memory 인스턴스에서 봇 기능 비활성화 → jarvis에서 봇 기능 활성화 순서로 전환
- **API 소비자**: `meeting_process` 도구의 응답에서 `slackPosted`, `notionPageUrl` 필드 제거
