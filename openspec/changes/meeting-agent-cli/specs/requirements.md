# Requirements: meeting-agent-cli

## Functional Requirements

### REQ-MTG-01: Transcript Parsing

- MUST parse **WebVTT** (`.vtt`) files:
  - Detect by presence of `WEBVTT` header on first line.
  - Extract cue blocks: timestamp line (`HH:MM:SS.mmm --> HH:MM:SS.mmm`) followed by text lines.
  - Extract speaker label from `<v SpeakerName>` or `SpeakerName: ` prefix within cue text.
  - Produce `TranscriptTurn[]` with `{ speaker: string | null, text: string, startTime: string }`.
- MUST parse **SubRip** (`.srt`) files:
  - Detect by pattern: integer on first line followed by `HH:MM:SS,mmm --> HH:MM:SS,mmm`.
  - Extract cue number, timestamp, and text lines.
  - Speaker labels: detect `Speaker Name: ` prefix in text.
  - Produce `TranscriptTurn[]`.
- MUST parse **plain text** (`.txt` and all other extensions) as a fallback:
  - Detect speaker turns by `Name: text` pattern at start of line.
  - If no speaker pattern, treat entire file as a single unnamed turn.
  - Produce `TranscriptTurn[]`.
- MUST produce a plain-text representation of the transcript for LLM processing:
  - Format: `[{speaker}] {text}` per turn, with empty line between turns if different speakers.
  - If no speakers: output raw text.

### REQ-MTG-02: Meeting Entity Creation

- MUST create a `meeting` entity in HiveDatabase with:
  - `entityType: "meeting"`
  - `title` from `--title` option, or first speaker turn up to 80 chars, or filename stem.
  - `content` = full plain-text transcript representation (not truncated for storage).
  - `domain: "meetings"`
  - `tags = ["transcript", "meeting", format]` where format is `"vtt"`, `"srt"`, or `"txt"`.
  - `attributes.duration` = total duration in minutes (from first to last timestamp, or 0 if not available).
  - `attributes.speakerCount` = number of unique speakers.
  - `attributes.speakers` = array of unique speaker name strings.
  - `attributes.transcriptFile` = basename of input file.
  - `attributes.processedAt` = ISO8601 timestamp.
  - `source.externalId = "meeting:transcript:{sha256(transcriptContent)[0:16]}"` — ensures idempotency.
  - `source.system = "meeting-agent"`.
  - `source.connector = "meeting-agent"`.
- MUST upsert (not duplicate) on re-processing: if entity with same `source.externalId` exists, update in place.

### REQ-MTG-03: Person Entity Creation

- MUST create `person` entities for each unique speaker found in the transcript.
- `source.externalId = "meeting:speaker:{normalizedName}"` where `normalizedName = name.toLowerCase().replace(/\s+/g, "-")`.
- `title = speaker name` as extracted.
- `content = "Meeting participant: {name}"`.
- MUST upsert — do not create duplicates.
- MUST create `"attended"` synapses from each person entity to the meeting entity.

### REQ-MTG-04: Decision and Action Extraction

- MUST run `DecisionExtractorProvider` on the meeting entity content after entity creation.
- MUST use `EnrichmentEngine.enrichEntity(meetingEntityId)` directly (not via MCP tool).
- MUST work in both modes:
  - **With LLM** (`CORTEX_ENRICHMENT=llm`): full LLM extraction on meeting content.
  - **Without LLM** (`CORTEX_ENRICHMENT=rule`): rule-based extraction only; print warning to stderr.
- Meeting content passed to extraction MUST be the full transcript (for LLM) or chunked into 8,000-char windows.

### REQ-MTG-05: LLM Summary Generation

- MUST generate a 2–4 sentence summary when LLM is configured.
- Summary prompt MUST include the full transcript (truncated to 4,000 tokens for the summary step).
- Summary MUST be stored in `attributes.summary` on the meeting entity.
- MUST skip summary silently (no error) when `CORTEX_ENRICHMENT=rule` or `CORTEX_ENRICHMENT=off`.

### REQ-MTG-06: Markdown Output

- MUST write Markdown meeting notes to stdout.
- Markdown MUST include all sections: title, date, attendees, duration, summary (if available), decisions, action items, topics discussed.
- Topics discussed MUST be extracted from tags/keywords of the meeting entity after enrichment.
- If no decisions were extracted, decisions section MUST show `"None identified"`.
- If no action items were extracted, actions section MUST show `"None identified"`.
- MUST support `--output <file>` option to write Markdown to a file instead of stdout.

### REQ-MTG-07: Calendar Event Linking (Optional)

- MUST support `--calendar-event-id <id>` option (format: `"gcal:event:{calId}:{eventId}"`).
- When provided, MUST look up the calendar entity in the database by `source_external_id`.
- If found, MUST create a `"related"` synapse from the transcript meeting entity to the calendar meeting entity.
- If not found, MUST log warning but continue processing.

### REQ-MTG-08: CLI Interface

- MUST add `meeting` subcommand to `hive-memory` CLI.
- MUST accept positional argument: transcript file path (required).
- MUST accept options:
  - `--title <string>` — override meeting title
  - `--date <ISO8601>` — meeting date (defaults to file mtime)
  - `--attendees <emails>` — comma-separated attendee emails
  - `--output <file>` — write Markdown to file
  - `--calendar-event-id <id>` — link to calendar entity
- MUST print error and exit code 1 if transcript file does not exist.
- MUST print progress to stderr: `"[meeting] Parsing transcript..."`, `"[meeting] Extracting decisions..."`, etc.

### REQ-MTG-09: MCP Tool — `meeting_process`

- MUST register `meeting_process` tool in `src/tools/meeting-tools.ts`.
- Parameters: `transcriptPath: string`, `title?: string`, `date?: string`, `attendees?: string[]`, `calendarEventId?: string`.
- MUST return `{ meetingEntityId, summary, decisionsCreated, actionsCreated, markdownOutput }`.
- MUST be registered in `src/tools/index.ts`.

### REQ-MTG-10: Idempotency

- MUST use SHA-256 hash of transcript content (first 16 hex chars) as `source_external_id`.
- Re-processing the same file MUST upsert and not create a new meeting entity.
- Decisions and action items extracted on second run MUST be idempotent via `_decisionsExtracted` flag.

## Non-Functional Requirements

- MUST NOT add npm dependencies — VTT/SRT parsing via regex, SHA-256 via `node:crypto`.
- MUST complete processing of a 60-minute transcript in under 60 seconds (including LLM calls).
- MUST handle transcript files up to 10MB.
- MUST work when LLM is not configured (graceful degradation).
- Markdown output MUST be valid Markdown (rendereable in GitHub, Notion, etc.).
