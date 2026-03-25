# Design: meeting-agent-cli

## Overview

The Meeting Agent is a thin pipeline: parse → store → enrich → render. It reuses the `EnrichmentEngine` from `enrichment-framework` and `DecisionExtractorProvider` from `decision-action-extraction` directly. No new LLM integration code is needed — all LLM calls go through the existing `LLMProvider` abstraction.

## Directory / File Layout

```
src/meeting/
  transcript-parser.ts      ← VTT/SRT/plaintext parser (new file)
  agent.ts                  ← MeetingAgent orchestrator class (new file)

src/tools/
  meeting-tools.ts          ← meeting_process MCP tool (new file)
  index.ts                  ← register meeting tools (modified)

src/cli.ts                  ← add `meeting` subcommand (modified)
```

## Transcript Parser (`src/meeting/transcript-parser.ts`)

```typescript
export interface TranscriptTurn {
  speaker: string | null;
  text: string;
  startTime: string | null;   // "HH:MM:SS" or null
}

export interface ParsedTranscript {
  format: "vtt" | "srt" | "txt";
  turns: TranscriptTurn[];
  duration: number;           // minutes, 0 if not computable
  speakers: string[];         // unique speaker names (normalized)
  plainText: string;          // "[Speaker] text\n..." or raw text
}

export function parseTranscript(filePath: string): ParsedTranscript {
  const content = readFileSync(filePath, "utf-8");
  if (content.trimStart().startsWith("WEBVTT")) return parseVTT(content);
  if (/^\d+\r?\n\d{2}:\d{2}:\d{2},\d{3}/.test(content.trimStart())) return parseSRT(content);
  return parsePlainText(content);
}
```

### VTT Parser

```typescript
function parseVTT(content: string): ParsedTranscript {
  const turns: TranscriptTurn[] = [];
  // Split on blank lines to get cue blocks
  const blocks = content.split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    // Find timestamp line: "HH:MM:SS.mmm --> HH:MM:SS.mmm"
    const tsLineIdx = lines.findIndex(l => /\d{2}:\d{2}:\d{2}[.,]\d{3}\s+-->\s+/.test(l));
    if (tsLineIdx === -1) continue;

    const tsLine = lines[tsLineIdx];
    const startTime = tsLine.split("-->")[0].trim().split(".")[0];  // "HH:MM:SS"
    const textLines = lines.slice(tsLineIdx + 1).join(" ");

    // Extract <v Speaker> tag or "Speaker: " prefix
    const vTagMatch = textLines.match(/<v\s+([^>]+)>/);
    const prefixMatch = textLines.match(/^([A-Z][^:]{1,30}):\s/);
    const speaker = vTagMatch?.[1] ?? prefixMatch?.[1] ?? null;
    const text = textLines
      .replace(/<[^>]+>/g, "")         // strip HTML/VTT tags
      .replace(/^[^:]+:\s/, "")         // strip speaker prefix
      .trim();

    if (text) turns.push({ speaker, text, startTime });
  }

  return buildParsedTranscript("vtt", turns);
}
```

### SRT Parser

```typescript
function parseSRT(content: string): ParsedTranscript {
  const turns: TranscriptTurn[] = [];
  // SRT cue blocks: index \n timestamp \n text... \n blank
  const blocks = content.split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 2) continue;
    const tsLineIdx = lines.findIndex(l => /\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+/.test(l));
    if (tsLineIdx === -1) continue;

    const tsLine = lines[tsLineIdx];
    const startTime = tsLine.split("-->")[0].trim().replace(",", ".").split(".")[0];
    const textLines = lines.slice(tsLineIdx + 1).join(" ");

    const prefixMatch = textLines.match(/^([A-Z][^:]{1,30}):\s/);
    const speaker = prefixMatch?.[1] ?? null;
    const text = textLines.replace(/^[^:]+:\s/, "").trim();

    if (text) turns.push({ speaker, text, startTime });
  }

  return buildParsedTranscript("srt", turns);
}
```

### Plain Text Parser

```typescript
function parsePlainText(content: string): ParsedTranscript {
  const turns: TranscriptTurn[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const match = line.match(/^([A-Z][^:]{1,30}):\s+(.+)/);
    if (match) {
      turns.push({ speaker: match[1].trim(), text: match[2].trim(), startTime: null });
    } else if (line.trim()) {
      // Append to last turn or create unnamed turn
      if (turns.length > 0 && turns[turns.length - 1].speaker === null) {
        turns[turns.length - 1].text += " " + line.trim();
      } else {
        turns.push({ speaker: null, text: line.trim(), startTime: null });
      }
    }
  }

  return buildParsedTranscript("txt", turns);
}
```

### Helper: buildParsedTranscript

```typescript
function buildParsedTranscript(format: "vtt" | "srt" | "txt", turns: TranscriptTurn[]): ParsedTranscript {
  const speakers = [...new Set(turns.map(t => t.speaker).filter(Boolean) as string[])];

  // Compute duration from first and last timestamps
  const timestamps = turns.map(t => t.startTime).filter(Boolean) as string[];
  let duration = 0;
  if (timestamps.length >= 2) {
    const toSeconds = (ts: string) => {
      const [h, m, s] = ts.split(":").map(Number);
      return h * 3600 + m * 60 + s;
    };
    duration = Math.round((toSeconds(timestamps[timestamps.length - 1]) - toSeconds(timestamps[0])) / 60);
  }

  // Build plain text representation
  const plainText = turns
    .map(t => t.speaker ? `[${t.speaker}] ${t.text}` : t.text)
    .join("\n");

  return { format, turns, duration, speakers, plainText };
}
```

## MeetingAgent Class (`src/meeting/agent.ts`)

```typescript
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { HiveDatabase } from "../db/database.js";
import type { EnrichmentEngine } from "../enrichment/engine.js";
import { parseTranscript } from "./transcript-parser.js";

export interface MeetingAgentOptions {
  transcriptPath: string;
  title?: string;
  date?: string;
  attendees?: string[];
  calendarEventId?: string;
  outputPath?: string;
}

export interface MeetingAgentResult {
  meetingEntityId: string;
  summary: string | null;
  decisionsCreated: number;
  actionsCreated: number;
  markdownOutput: string;
}

export class MeetingAgent {
  constructor(
    private db: HiveDatabase,
    private enrichmentEngine: EnrichmentEngine
  ) {}

  async process(opts: MeetingAgentOptions): Promise<MeetingAgentResult> {
    // Step 1: Parse transcript
    console.error("[meeting] Parsing transcript...");
    const transcript = parseTranscript(opts.transcriptPath);

    // Step 2: Compute idempotency key (SHA-256 of transcript plain text)
    const hash = createHash("sha256").update(transcript.plainText).digest("hex").slice(0, 16);
    const externalId = `meeting:transcript:${hash}`;

    // Step 3: Determine title and date
    const date = opts.date ?? statSync(opts.transcriptPath).mtime.toISOString();
    const title = opts.title
      ?? transcript.turns[0]?.text.slice(0, 80)
      ?? basename(opts.transcriptPath, extname(opts.transcriptPath));

    // Step 4: Create/upsert meeting entity
    console.error("[meeting] Storing meeting entity...");
    const meetingEntityId = this.db.upsertEntity({
      entityType: "meeting",
      title,
      content: transcript.plainText,
      domain: "meetings",
      tags: ["transcript", "meeting", transcript.format],
      attributes: {
        duration: transcript.duration,
        speakerCount: transcript.speakers.length,
        speakers: transcript.speakers,
        transcriptFile: basename(opts.transcriptPath),
        processedAt: new Date().toISOString(),
        meetingDate: date,
      },
      source: { system: "meeting-agent", externalId, connector: "meeting-agent" },
      confidence: "confirmed",
    });

    // Step 5: Create person entities for speakers
    for (const speaker of transcript.speakers) {
      const normalizedName = speaker.toLowerCase().replace(/\s+/g, "-");
      const personId = this.db.upsertEntity({
        entityType: "person",
        title: speaker,
        content: `Meeting participant: ${speaker}`,
        domain: "meetings",
        tags: ["person", "speaker"],
        attributes: { speakerName: speaker },
        source: { system: "meeting-agent", externalId: `meeting:speaker:${normalizedName}`, connector: "meeting-agent" },
        confidence: "inferred",
      });
      this.db.upsertSynapse({ sourceId: personId, targetId: meetingEntityId, axon: "attended", weight: 1.0 });
    }

    // Step 6: Add additional attendees from --attendees option
    for (const email of (opts.attendees ?? [])) {
      const personId = this.db.upsertEntity({
        entityType: "person",
        title: email,
        content: `Meeting attendee: ${email}`,
        domain: "meetings",
        tags: ["person"],
        attributes: { email },
        source: { system: "meeting-agent", externalId: `meeting:attendee:${email}`, connector: "meeting-agent" },
        confidence: "inferred",
      });
      this.db.upsertSynapse({ sourceId: personId, targetId: meetingEntityId, axon: "attended", weight: 1.0 });
    }

    // Step 7: Run enrichment (decision/action extraction)
    console.error("[meeting] Extracting decisions and actions...");
    const enrichResults = await this.enrichmentEngine.enrichEntity(meetingEntityId);
    const decisionsCreated = enrichResults.flatMap(r => r.derivedEntities ?? []).filter(e => e.entityType === "decision").length;
    const actionsCreated = enrichResults.flatMap(r => r.derivedEntities ?? []).filter(e => e.entityType === "task").length;

    // Step 8: Get summary (set by LLMEnrichProvider or missing)
    const updatedEntity = this.db.getEntity(meetingEntityId);
    const summary = updatedEntity?.attributes?.summary as string | null ?? null;

    // Step 9: Link to calendar event if provided
    if (opts.calendarEventId) {
      const calEntity = this.db.getEntityByExternalId(opts.calendarEventId);
      if (calEntity) {
        this.db.upsertSynapse({ sourceId: meetingEntityId, targetId: calEntity.id, axon: "related", weight: 1.0 });
      } else {
        console.error(`[meeting] Warning: calendar event ${opts.calendarEventId} not found in database`);
      }
    }

    // Step 10: Generate Markdown output
    const markdownOutput = this.renderMarkdown({
      title, date, transcript, summary,
      decisionsCreated, actionsCreated,
      meetingEntityId,
    });

    return { meetingEntityId, summary, decisionsCreated, actionsCreated, markdownOutput };
  }

  private renderMarkdown(ctx: RenderContext): string {
    const { title, date, transcript, summary, decisionsCreated, actionsCreated } = ctx;

    // Fetch extracted decisions and tasks from DB
    const decisions = this.db.getEntitiesByConnector("decision-extractor", ctx.meetingEntityId);
    const tasks = decisions.filter(e => e.entityType === "task");
    const decisionEntities = decisions.filter(e => e.entityType === "decision");

    const lines: string[] = [
      `# Meeting: ${title}`,
      `**Date:** ${date.split("T")[0]}`,
      `**Attendees:** ${transcript.speakers.join(", ") || "Unknown"}`,
      `**Duration:** ${transcript.duration > 0 ? `${transcript.duration} min` : "Unknown"}`,
      `**Format:** ${transcript.format.toUpperCase()}`,
      ``,
      `## Summary`,
      summary ?? "_LLM not configured — run with CORTEX_ENRICHMENT=llm for automated summary._",
      ``,
      `## Key Decisions`,
    ];

    if (decisionEntities.length > 0) {
      for (const d of decisionEntities) lines.push(`- ${d.title}`);
    } else {
      lines.push("None identified.");
    }

    lines.push(``, `## Action Items`);
    if (tasks.length > 0) {
      for (const t of tasks) {
        const owner = t.attributes?.owner as string ?? "unassigned";
        const deadline = t.attributes?.deadline as string ?? "";
        lines.push(`- [ ] ${t.title} — **${owner}**${deadline ? ` (due: ${deadline})` : ""}`);
      }
    } else {
      lines.push("None identified.");
    }

    lines.push(``, `## Topics Discussed`);
    const keywords = this.db.getEntity(ctx.meetingEntityId)?.keywords ?? [];
    if (keywords.length > 0) {
      for (const kw of keywords.slice(0, 10)) lines.push(`- ${kw}`);
    } else {
      lines.push("_No topics extracted._");
    }

    lines.push(``, `---`, `_Processed by hive-memory meeting agent_`);
    return lines.join("\n");
  }
}
```

## MCP Tool (`src/tools/meeting-tools.ts`)

```typescript
export function registerMeetingTools(server: McpServer, store: CortexStore): void {
  server.tool(
    "meeting_process",
    "Process a meeting transcript file to extract summary, decisions, and action items",
    {
      transcriptPath: z.string(),
      title: z.string().optional(),
      date: z.string().optional(),
      attendees: z.array(z.string()).optional(),
      calendarEventId: z.string().optional(),
    },
    async ({ transcriptPath, title, date, attendees, calendarEventId }) => {
      if (!existsSync(transcriptPath)) {
        throw new Error(`Transcript file not found: ${transcriptPath}`);
      }

      const agent = new MeetingAgent(store.db, store.enrichmentEngine);
      const result = await agent.process({ transcriptPath, title, date, attendees, calendarEventId });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            meetingEntityId: result.meetingEntityId,
            summary: result.summary,
            decisionsCreated: result.decisionsCreated,
            actionsCreated: result.actionsCreated,
            markdownOutput: result.markdownOutput,
          }),
        }],
      };
    }
  );
}
```

## CLI Integration (`src/cli.ts`)

```typescript
// In the switch/case for subcommands:
case "meeting": {
  const [, transcriptFile, ...flags] = args;
  if (!transcriptFile) {
    console.error("Usage: hive-memory meeting <transcript-file> [options]");
    process.exit(1);
  }

  if (!existsSync(transcriptFile)) {
    console.error(`Error: File not found: ${transcriptFile}`);
    process.exit(1);
  }

  const parsedFlags = parseFlags(flags);
  const agent = new MeetingAgent(store.db, store.enrichmentEngine);
  const result = await agent.process({
    transcriptPath: transcriptFile,
    title: parsedFlags.title,
    date: parsedFlags.date,
    attendees: parsedFlags.attendees?.split(","),
    calendarEventId: parsedFlags["calendar-event-id"],
    outputPath: parsedFlags.output,
  });

  if (parsedFlags.output) {
    writeFileSync(parsedFlags.output, result.markdownOutput, "utf-8");
    console.error(`[meeting] Notes written to ${parsedFlags.output}`);
  } else {
    process.stdout.write(result.markdownOutput + "\n");
  }
  break;
}
```

## Pipeline Flow Diagram

```
transcript file
       │
       ▼
TranscriptParser.parse()
  → ParsedTranscript { turns, speakers, duration, plainText }
       │
       ▼
MeetingAgent.process()
  → db.upsertEntity(meeting)          ← meetingEntityId
  → db.upsertEntity(person) × N       ← speaker entities
  → db.upsertSynapse(attended) × N
       │
       ▼
EnrichmentEngine.enrichEntity(meetingEntityId)
  → ClassifyProvider  (priority 100)
  → DecisionExtractorProvider (priority 50)
    → rule signals? → LLM or rule extraction
    → db.upsertEntity(decision) × M
    → db.upsertEntity(task) × K
    → db.upsertSynapse(derived) × (M+K)
  → LLMEnrichProvider (priority 200)
    → attributes.summary = "..."
       │
       ▼
MeetingAgent.renderMarkdown()
  → stdout (or file)
```
