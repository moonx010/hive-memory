## 1. Phase 1: Bot Extraction (src/bot/ → jarvis)

- [x] 1.1 Add `BUMBLE_BEE_INTERNAL` feature flag to `index.ts` — when `false`, skip `/slack/events` route and bot imports
- [x] 1.2 Copy `src/bot/slack-bot.ts`, `intent-parser.ts`, `slack-formatter.ts` to jarvis repo under `src/bumble-bee/`
- [ ] 1.3 Refactor jarvis Bumble Bee to call hive-memory via MCP tools (`memory_recall`, `memory_ls`, etc.) instead of direct `CortexStore` imports
- [ ] 1.4 Move `joinMeeting()` and `getBotStatus()` from `src/connectors/recall.ts` to jarvis — implement Recall API calls directly (13 lines)
- [ ] 1.5 Deploy jarvis Bumble Bee and verify Slack bot responds correctly
- [ ] 1.6 Set `BUMBLE_BEE_INTERNAL=false` on Railway hive-memory deployment
- [x] 1.7 Delete `src/bot/` directory from hive-memory
- [x] 1.8 Remove `/slack/events` route from `index.ts`
- [x] 1.9 Remove `executeJoinMeeting()` and bot-related imports from `index.ts`
- [x] 1.10 Verify `npm run build` and `npm test` pass after deletion
- [x] 1.11 Update tests — remove or relocate `tests/slack-bot.test.ts` to jarvis

## 2. Phase 2: Meeting Output Extraction

- [x] 2.1 Remove `shareOutput()` method from `MeetingAgent` class
- [x] 2.2 Remove `slackWebhook`, `notionParentPageId` from `MeetingAgentOptions` interface
- [x] 2.3 Remove `slackPosted`, `notionPageUrl` from `MeetingAgentResult` interface
- [x] 2.4 Remove `import { postToSlack, postToNotion }` from `agent.ts`
- [x] 2.5 Update `meeting_process` MCP tool — remove `slackWebhook`, `slackChannel`, `notionParentPageId` params
- [x] 2.6 Delete `src/meeting/output.ts`
- [x] 2.7 Delete `src/meeting/stt.ts`
- [x] 2.8 Move `postToSlack`, `postToSlackChannel`, `postToNotion` functions to jarvis
- [x] 2.9 Move `transcribeToVTT` function to jarvis
- [x] 2.10 Update `tests/meeting-agent.test.ts` — remove output posting tests, keep entity creation tests
- [x] 2.11 Verify `npm run build` and `npm test` pass after changes
- [ ] 2.12 Update jarvis to post meeting notes after calling `meeting_process` tool

## 3. Phase 3: Recall Orchestration Extraction

- [x] 3.1 Remove `joinMeeting()` function from `src/connectors/recall.ts`
- [x] 3.2 Remove `scheduleBotsForUpcomingMeetings()` function from `src/connectors/recall.ts`
- [x] 3.3 Remove `getBotStatus()` function from `src/connectors/recall.ts`
- [x] 3.4 Remove auto-sync bot scheduling call from `index.ts` auto-sync loop
- [x] 3.5 Simplify `handleRecallWebhook()` — entity creation only, no `slackWebhook` in `agent.process()` call
- [ ] 3.6 Move calendar-based bot scheduling to jarvis (query hive-memory for upcoming events via MCP)
- [x] 3.7 Update `tests/recall-connector.test.ts` — remove join/schedule tests, keep transform/sync tests
- [x] 3.8 Verify `npm run build` and `npm test` pass after changes

## 4. Cleanup & Verification

- [x] 4.1 Remove `BUMBLE_BEE_INTERNAL` feature flag (no longer needed)
- [x] 4.2 Verify hive-memory has zero outbound HTTP calls to Slack/Notion/Recall (except connector inbound sync)
- [x] 4.3 Run full test suite — all tests pass
- [ ] 4.4 Update `CLAUDE.md` — remove bot/output/stt from Module Structure, update tool count
- [ ] 4.5 Deploy cleaned hive-memory to Railway
- [ ] 4.6 Verify jarvis handles all outbound posting (meeting notes → Slack, bot join, calendar auto-schedule)
