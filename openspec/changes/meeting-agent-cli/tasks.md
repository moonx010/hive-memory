# Tasks: meeting-agent-cli

**Phase:** C (starts after calendar-connector and decision-action-extraction are complete)
**Estimated effort:** 2 weeks
**Dependencies:**
- `decision-action-extraction` (required — `DecisionExtractorProvider` must be registered)
- `calendar-connector` (optional — calendar event linking)

## Week 1: Transcript Parser + Meeting Agent Core

- [ ] **TASK-MTG-01**: Create `src/meeting/transcript-parser.ts`
  - Define `TranscriptTurn` interface: `{ speaker: string | null, text: string, startTime: string | null }`
  - Define `ParsedTranscript` interface: `{ format, turns, duration, speakers, plainText }`
  - Implement `parseTranscript(filePath: string): ParsedTranscript` dispatch function
  - Implement `parseVTT(content)`:
    - Split on blank lines to get cue blocks
    - Find timestamp line via regex: `/\d{2}:\d{2}:\d{2}[.,]\d{3}\s+-->\s+/`
    - Extract speaker from `<v Speaker>` tag or `Speaker: ` prefix
    - Strip HTML/VTT tags from text
  - Implement `parseSRT(content)`:
    - Split on blank lines, find timestamp line via SRT pattern
    - Extract speaker from `Speaker: ` prefix
  - Implement `parsePlainText(content)`:
    - Detect `Name: text` pattern per line
    - Fall back to single unnamed turn if no speaker pattern
  - Implement `buildParsedTranscript(format, turns)`:
    - Deduplicate speakers (unique, non-null)
    - Compute duration from first/last timestamps (minutes, 0 if unavailable)
    - Build `plainText` from turns: `[Speaker] text` or raw text

- [ ] **TASK-MTG-02**: Add tests for transcript parser
  - Test: VTT with `<v SpeakerName>` tags → correct speaker labels
  - Test: VTT with `SpeakerName: ` prefix → correct speaker labels
  - Test: SRT with speaker prefixes → correct speaker labels
  - Test: SRT without speakers → `speaker: null` on all turns
  - Test: plain text with `Name: text` → speaker extracted
  - Test: plain text without pattern → single unnamed turn
  - Test: duration computed correctly from VTT timestamps
  - Test: `speakers` array contains unique names only
  - Test: empty file → `ParsedTranscript` with empty turns, zero duration

- [ ] **TASK-MTG-03**: Create `src/meeting/agent.ts` skeleton
  - Define `MeetingAgentOptions` interface
  - Define `MeetingAgentResult` interface
  - Implement `MeetingAgent` class constructor: `(db: HiveDatabase, enrichmentEngine: EnrichmentEngine)`
  - Stub `process(opts): Promise<MeetingAgentResult>` returning `throw new Error("not implemented")`
  - Export class and interfaces

- [ ] **TASK-MTG-04**: Implement meeting entity creation in `MeetingAgent.process()`
  - Step 1: Call `parseTranscript(opts.transcriptPath)`
  - Step 2: Compute SHA-256 hash of `transcript.plainText` via `node:crypto` → first 16 hex chars → `externalId`
  - Step 3: Determine `date` (opts.date or file mtime via `statSync`)
  - Step 4: Determine `title` (opts.title or first turn text sliced to 80 chars or filename stem)
  - Step 5: Call `this.db.upsertEntity(meetingDraft)` with all required fields
  - Return `meetingEntityId` from upsert

- [ ] **TASK-MTG-05**: Implement speaker entity creation
  - For each speaker in `transcript.speakers`:
    - Compute `normalizedName = speaker.toLowerCase().replace(/\s+/g, "-")`
    - Call `db.upsertEntity(personDraft)` with `externalId: "meeting:speaker:{normalizedName}"`
    - Call `db.upsertSynapse({ sourceId: personId, targetId: meetingEntityId, axon: "attended", weight: 1.0 })`
  - For each email in `opts.attendees ?? []`:
    - Create person entity with `externalId: "meeting:attendee:{email}"`
    - Create `attended` synapse
  - Add test: 3-speaker transcript produces 3 person entities + 3 attended synapses

- [ ] **TASK-MTG-06**: Implement enrichment call in `process()`
  - Call `await this.enrichmentEngine.enrichEntity(meetingEntityId)`
  - Count `decisionsCreated` from derived entities with `entityType: "decision"` in results
  - Count `actionsCreated` from derived entities with `entityType: "task"` in results
  - Load updated entity from DB to get `attributes.summary` (set by LLMEnrichProvider)
  - Add test: mock enrichment engine, assert `enrichEntity()` is called with correct ID

- [ ] **TASK-MTG-07**: Implement calendar event linking
  - If `opts.calendarEventId` is defined:
    - Call `this.db.getEntityByExternalId(opts.calendarEventId)`
    - If found: call `db.upsertSynapse({ sourceId: meetingEntityId, targetId: calEntity.id, axon: "related", weight: 1.0 })`
    - If not found: `console.error("[meeting] Warning: calendar event not found: {id}")`
  - Add test: calendar event not found → warning logged, no error thrown

## Week 2: Markdown Rendering + MCP Tool + CLI Integration

- [ ] **TASK-MTG-08**: Implement `renderMarkdown()` in `MeetingAgent`
  - Fetch decision entities from DB by `source_connector = "decision-extractor"` filtered by `extractedFrom = meetingEntityId`
  - Build Markdown string with sections: title header, metadata, summary, decisions, action items, topics
  - Format action items as `- [ ] {title} — **{owner}** (due: {deadline})`, skip deadline if null
  - Format topics from entity's `keywords` array (top 10)
  - Show `"None identified."` when sections are empty
  - Add footer: `_Processed by hive-memory meeting agent_`

- [ ] **TASK-MTG-09**: Add tests for `renderMarkdown()`
  - Test: meeting with decisions → decisions section populated
  - Test: meeting with no decisions → `"None identified."` in decisions section
  - Test: meeting with action items and owners → correct `- [ ]` format
  - Test: meeting with no LLM summary → summary section shows graceful message
  - Test: Markdown output contains all required sections

- [ ] **TASK-MTG-10**: Create `src/tools/meeting-tools.ts`
  - Implement `registerMeetingTools(server, store)` function
  - Register `meeting_process` tool with Zod schema
  - Validate: `transcriptPath` must be an existing file (check with `existsSync`)
  - Instantiate `MeetingAgent(store.db, store.enrichmentEngine)` and call `agent.process()`
  - Return JSON response with `meetingEntityId`, `summary`, `decisionsCreated`, `actionsCreated`, `markdownOutput`

- [ ] **TASK-MTG-11**: Register meeting tools in `src/tools/index.ts`
  - Import `registerMeetingTools` from `./meeting-tools.js`
  - Call `registerMeetingTools(server, store)` in the registration function
  - Verify `store.enrichmentEngine` is accessible (requires enrichment-framework to be integrated into store)

- [ ] **TASK-MTG-12**: Add `meeting` subcommand to `src/cli.ts`
  - Add `case "meeting":` to the CLI subcommand switch
  - Parse positional argument: transcript file path (required, exit 1 if missing)
  - Check file exists: `existsSync(transcriptFile)`, exit 1 with error message if not
  - Parse flags: `--title`, `--date`, `--attendees` (comma-separated), `--output`, `--calendar-event-id`
  - Instantiate `MeetingAgent` and call `process()`
  - Write Markdown to stdout or `--output` file
  - Print summary to stderr: `"[meeting] Stored meeting: {title} ({decisionsCreated} decisions, {actionsCreated} actions)"`

- [ ] **TASK-MTG-13**: Add `meeting` to CLI help text in `src/cli.ts`
  - Document usage: `hive-memory meeting <transcript-file> [--title STR] [--date ISO] [--attendees EMAILS] [--output FILE]`
  - Include in the help output block

- [ ] **TASK-MTG-14**: End-to-end integration test
  - Create a sample VTT transcript file in `tests/fixtures/sample-meeting.vtt` with:
    - 2 speakers, 10+ cue blocks
    - At least one decision signal ("We decided to...")
    - At least one action signal ("@alice will...")
  - Run `MeetingAgent.process({ transcriptPath })` in a test with an in-memory DB
  - Assert: `meeting` entity created with correct title
  - Assert: 2 person entities created, 2 attended synapses
  - Assert: `decision` entity derived from meeting (rule-based, no LLM needed)
  - Assert: Markdown output contains "## Key Decisions" section
  - Assert: re-processing same file produces same `meetingEntityId` (idempotent)

- [ ] **TASK-MTG-15**: Create test fixture files
  - `tests/fixtures/sample-meeting.vtt` — WebVTT with 2 speakers, timestamps, decision + action content
  - `tests/fixtures/sample-standup.srt` — SubRip format standup transcript
  - `tests/fixtures/plain-notes.txt` — Plain text meeting notes with `Speaker: text` format
