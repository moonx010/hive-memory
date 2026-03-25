# Change: meeting-agent-cli

**Layer:** 3 (Agent)
**One-liner:** CLI tool that processes meeting transcripts (VTT/SRT/plain text) to extract summaries, decisions, and action items, storing structured meeting notes in Hive-Memory.
**Estimated effort:** 2 weeks
**Dependencies:**
- `calendar-connector` (optional — enriches meeting context with calendar metadata)
- `decision-action-extraction` (required — uses enrichment pipeline for decision/action extraction)

## Why

Meeting transcripts contain the richest decision and context data in any organization, but they expire from memory within days. No one re-reads raw transcripts. The Meeting Agent converts a raw transcript into:

1. A searchable `meeting` entity with summary and key themes.
2. Structured `decision` entities linked to the meeting.
3. `task` entities with owners and deadlines.
4. Person entities linked via `attended` synapses.

This makes past meetings queryable: "what did we decide about the API design in Q1?" returns results from processed transcripts, not just calendar events.

## What Changes

### In Scope

1. **New directory: `src/meeting/`** — Meeting Agent module.

2. **Transcript parser** — `src/meeting/transcript-parser.ts`:
   - Parses VTT (WebVTT), SRT (SubRip), and plain text formats.
   - Extracts speaker labels and timestamps.
   - Produces a clean plain-text representation with speaker turns for LLM processing.

3. **Meeting Agent** — `src/meeting/agent.ts`:
   - Orchestrates: parse → match calendar event → summarize → extract decisions/actions → store → generate output.
   - Uses `EnrichmentEngine` directly (in-process, not via MCP).
   - Accepts transcript file path + optional meeting metadata (title, date, attendees).

4. **New MCP tool: `meeting_process`** — `src/tools/meeting-tools.ts`:
   ```
   meeting_process
     - transcriptPath: string (absolute path to VTT/SRT/txt file)
     - title?: string (override extracted title)
     - date?: string (ISO8601, defaults to file mtime)
     - attendees?: string[] (email addresses)
     - calendarEventId?: string (to link with calendar entity)

   Returns: { meetingEntityId, summary, decisionsCreated, actionsCreated, markdownOutput }
   ```

5. **CLI command:** `hive-memory meeting <transcript-file> [options]`
   ```
   hive-memory meeting standup-2026-03-25.vtt
   hive-memory meeting design-review.srt --title "API Design Review" --date 2026-03-25
   hive-memory meeting notes.txt --attendees alice@co.com,bob@co.com
   ```

6. **Markdown output** — the agent produces a structured meeting notes Markdown file:
   ```markdown
   # Meeting: {title}
   **Date:** {date}
   **Attendees:** {names}
   **Duration:** {minutes} min

   ## Summary
   {2-3 sentence LLM summary}

   ## Key Decisions
   - {decision 1}
   - {decision 2}

   ## Action Items
   - [ ] {action 1} — {owner} (due: {deadline})
   - [ ] {action 2} — {owner}

   ## Topics Discussed
   - {topic 1}
   - {topic 2}
   ```

7. **Saved output** — Markdown is written to stdout (and optionally to a file with `--output` flag).

### Input Format Support

| Format | Extension | Detection |
|--------|-----------|-----------|
| WebVTT | `.vtt` | Extension + `WEBVTT` header |
| SubRip | `.srt` | Extension + `1\n00:00:` pattern |
| Plain text | `.txt`, others | Fallback |

### Out of Scope

- Automatic meeting detection from calendar events (no calendar event polling).
- Slack/Notion output integration — only stdout Markdown.
- Real-time transcription or audio processing.
- Meeting scheduling or calendar write-back.
- Batch processing of multiple transcripts in one command (one file per invocation).
- Automatic transcript ingestion from Zoom/Meet recording services.

## Devil's Advocate Review

**Risk: LLM summarization is required for good output — what if no LLM is configured?**
Mitigation: Without LLM (`CORTEX_ENRICHMENT=rule`), the agent produces a minimal output: speaker turn counts, extracted decision lines (rule-based), extracted action lines. Summary is skipped. User is warned: `"[meeting] LLM not configured — summary skipped, using rule-based extraction only"`.

**Risk: Speaker label extraction is unreliable for lightly-formatted transcripts.**
Mitigation: Parser falls back to unnamed turns when speaker labels are absent. LLM extraction works on raw transcript text regardless of speaker formatting. Speaker diarization is not required for decision/action extraction.

**Risk: Transcript files may be large (2+ hours = 50k+ words).**
Mitigation: Content is chunked before LLM calls. Summary prompt uses first 4000 tokens. Decision/action extraction runs on sliding 2000-token windows over the transcript, then deduplicates extracted items.

**Risk: 2 weeks is tight for parser + agent + tool + CLI + tests.**
Mitigation: Parser is ~100 lines (3 regex-based formats). Agent is a pipeline of 5 steps using existing components. CLI is a thin wrapper over the MCP tool. Tests mock the LLM. Scope is strictly CLI-only — no Slack/Notion integration.

## Acceptance Criteria

1. `hive-memory meeting standup.vtt` produces a `meeting` entity in the database and prints Markdown to stdout.
2. The Markdown output includes a summary, decisions section, and action items section.
3. `memory_recall "decisions about API design"` returns meeting-extracted decisions when a transcript containing that content has been processed.
4. Without LLM configured (`CORTEX_ENRICHMENT=rule`), the command completes with rule-based extraction and prints a warning.
5. Processing a VTT file with speaker labels produces `person` entities for each speaker.
6. Running `hive-memory meeting` on the same file twice does not create duplicate entities (idempotent by transcript file hash as `source_external_id`).

## Impact

- **New directory:** `src/meeting/` (2 new files, ~350 lines total)
- **New file:** `src/tools/meeting-tools.ts` (~80 lines)
- **Modified:** `src/tools/index.ts` — register meeting tools
- **Modified:** `src/cli.ts` — add `meeting` subcommand
- **No new npm dependencies** — VTT/SRT parsing is regex-based
- **No schema changes** — uses existing entity types
