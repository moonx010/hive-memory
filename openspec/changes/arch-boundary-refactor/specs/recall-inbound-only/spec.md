## ADDED Requirements

### Requirement: RecallConnector is inbound-only
The `RecallConnector` class SHALL only pull completed meeting transcripts from Recall.ai API and yield them as `RawDocument` entities. It SHALL NOT create bots, join meetings, or schedule bots.

#### Scenario: Sync pulls completed transcripts
- **WHEN** `RecallConnector.fullSync()` or `incrementalSync()` is called
- **THEN** it lists bots with status "done" or "analysis_done"
- **THEN** it downloads transcripts and yields them as `RawDocument`
- **THEN** no `POST /api/v1/bot` calls are made (no bot creation)

#### Scenario: No joinMeeting export
- **WHEN** inspecting `src/connectors/recall.ts` exports
- **THEN** `joinMeeting` function does not exist
- **THEN** `scheduleBotsForUpcomingMeetings` function does not exist
- **THEN** `getBotStatus` function does not exist

### Requirement: handleRecallWebhook creates entities without posting
The `handleRecallWebhook()` function SHALL download the transcript, create meeting entities via `MeetingAgent.process()`, and return. It SHALL NOT post to Slack, Notion, or any external service.

#### Scenario: Webhook creates meeting entity
- **WHEN** a `recording.done` webhook is received
- **THEN** the transcript is downloaded from Recall.ai
- **THEN** `MeetingAgent.process()` is called with transcript content
- **THEN** a meeting entity is created in the database
- **THEN** no outbound HTTP requests are made to Slack or Notion

### Requirement: Auto-sync does not schedule meeting bots
The auto-sync loop in `index.ts` SHALL NOT call `scheduleBotsForUpcomingMeetings()` or any bot creation logic.

#### Scenario: Auto-sync runs without bot scheduling
- **WHEN** the auto-sync timer fires
- **THEN** it syncs all configured connectors (including Recall inbound sync)
- **THEN** it runs enrichment batch
- **THEN** it does NOT call any function that creates Recall bots

### Requirement: Bot code is removed from hive-memory
The `src/bot/` directory SHALL NOT exist in hive-memory after Phase 1 completion. The `/slack/events` HTTP endpoint SHALL be removed from `index.ts`.

#### Scenario: src/bot/ deleted
- **WHEN** checking the file system after Phase 1
- **THEN** `src/bot/` directory does not exist

#### Scenario: No /slack/events route
- **WHEN** sending POST to `/slack/events` on the hive-memory HTTP server
- **THEN** the server returns 404 or routes to MCP handler (not Slack event processing)

#### Scenario: Build succeeds without bot
- **WHEN** running `npm run build` after bot removal
- **THEN** the build succeeds with zero errors

## REMOVED Requirements

### Requirement: joinMeeting()
**Reason**: Creating Recall bots to join live meetings is agent-layer orchestration, not memory storage.
**Migration**: jarvis/bumble-bee implements its own Recall API client for bot creation.

### Requirement: scheduleBotsForUpcomingMeetings()
**Reason**: Autonomous bot scheduling based on calendar events is agent-layer orchestration.
**Migration**: jarvis implements calendar-based bot scheduling using hive-memory MCP tools for event queries.

### Requirement: Slack bot event handling in index.ts
**Reason**: Conversational agent behavior (intent parsing, response formatting, Slack posting) belongs in the agent layer.
**Migration**: jarvis runs its own HTTP server or Slack app that handles `/slack/events` and calls hive-memory via MCP.
