## ADDED Requirements

### Requirement: meeting_process returns results without posting
The `meeting_process` MCP tool SHALL parse transcripts, create meeting/person/decision/task entities, run enrichment, and return structured results (markdown, speakers, decisions, actions). It SHALL NOT post to any external service.

#### Scenario: Process transcript and return markdown
- **WHEN** `meeting_process` is called with a transcript file path
- **THEN** the tool returns JSON containing `meetingEntityId`, `speakers`, `decisionsCreated`, `actionsCreated`, and `markdown` fields
- **THEN** no HTTP requests are made to Slack, Notion, or any external service

#### Scenario: slackWebhook parameter is removed
- **WHEN** `meeting_process` is called with a `slackWebhook` parameter
- **THEN** the parameter is ignored (Phase 1: deprecated) or rejected (Phase 2: removed)

#### Scenario: notionParentPageId parameter is removed
- **WHEN** `meeting_process` is called with a `notionParentPageId` parameter
- **THEN** the parameter is ignored (Phase 1: deprecated) or rejected (Phase 2: removed)

### Requirement: MeetingAgent has no outbound dependencies
The `MeetingAgent` class SHALL NOT import or call any outbound posting module. The `process()` method SHALL return `MeetingAgentResult` without `slackPosted` or `notionPageUrl` fields.

#### Scenario: MeetingAgent process creates entities only
- **WHEN** `MeetingAgent.process()` is called with transcript content
- **THEN** meeting, person, decision, and task entities are created in the database
- **THEN** the result contains `meetingEntityId`, `speakers`, `decisionsCreated`, `actionsCreated`, `markdownOutput`
- **THEN** no `shareOutput()` method exists on the class

#### Scenario: No Slack/Notion imports in meeting agent
- **WHEN** inspecting `src/meeting/agent.ts` imports
- **THEN** there are no imports from `./output.js` or any outbound posting module

### Requirement: output.ts and stt.ts are removed from hive-memory
The files `src/meeting/output.ts` and `src/meeting/stt.ts` SHALL NOT exist in the hive-memory codebase after Phase 2 completion.

#### Scenario: output.ts deleted
- **WHEN** checking the file system after Phase 2
- **THEN** `src/meeting/output.ts` does not exist

#### Scenario: stt.ts deleted
- **WHEN** checking the file system after Phase 2
- **THEN** `src/meeting/stt.ts` does not exist

#### Scenario: No broken imports
- **WHEN** running `npm run build` after deletion
- **THEN** the build succeeds with zero errors

## REMOVED Requirements

### Requirement: MeetingAgent.shareOutput()
**Reason**: Outbound posting (Slack/Notion) is agent-layer behavior, not memory-layer. Moved to jarvis.
**Migration**: Callers of `meeting_process` MCP tool receive markdown in the response and handle posting themselves.
