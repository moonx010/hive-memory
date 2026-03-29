import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HiveDatabase } from "../src/db/database.js";
import { EnrichmentEngine } from "../src/enrichment/engine.js";
import { ClassifyProvider } from "../src/enrichment/providers/classify.js";
import { DecisionExtractorProvider } from "../src/enrichment/providers/decision-extractor.js";
import {
  parseTranscriptContent,
  parseTranscript,
} from "../src/meeting/transcript-parser.js";
import { MeetingAgent } from "../src/meeting/agent.js";
// output.ts extracted to jarvis — posting tests moved there
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("TranscriptParser", () => {
  it("parses VTT format with speaker tags", () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:10.000
<v Alice>Hello everyone, welcome to the meeting.

00:00:10.000 --> 00:00:20.000
<v Bob>Thanks Alice, let me share my update.`;

    const result = parseTranscriptContent(vtt);
    expect(result.format).toBe("vtt");
    expect(result.turns).toHaveLength(2);
    expect(result.speakers).toContain("Alice");
    expect(result.speakers).toContain("Bob");
    expect(result.durationMinutes).toBe(0); // 20 seconds
    expect(result.plaintext).toContain("Alice:");
  });

  it("parses SRT format with speaker labels", () => {
    const srt = `1
00:00:00,000 --> 00:00:10,000
Alice: Good morning team.

2
00:00:10,000 --> 00:01:30,000
Bob: Let me share the update on the project progress.`;

    const result = parseTranscriptContent(srt);
    expect(result.format).toBe("srt");
    expect(result.turns).toHaveLength(2);
    expect(result.speakers).toContain("Alice");
    expect(result.durationMinutes).toBe(2); // ~90 seconds
  });

  it("parses plain text with speaker prefixes", () => {
    const text = `Alice: Let's discuss the roadmap.
Bob: I think we should prioritize the API.
Charlie: Agreed, the API is most important.`;

    const result = parseTranscriptContent(text);
    expect(result.format).toBe("plaintext");
    expect(result.turns).toHaveLength(3);
    expect(result.speakers).toEqual(["Alice", "Bob", "Charlie"]);
  });

  it("handles plain text without speaker labels", () => {
    const text = `The meeting started at 9am.
We discussed project timelines.
Everyone agreed on the plan.`;

    const result = parseTranscriptContent(text);
    expect(result.turns).toHaveLength(3);
    expect(result.speakers).toHaveLength(0);
    expect(result.turns[0].speaker).toBe("Unknown");
  });

  it("parses VTT file from disk", () => {
    const result = parseTranscript(
      join(__dirname, "fixtures", "sample-meeting.vtt"),
    );
    expect(result.format).toBe("vtt");
    expect(result.turns.length).toBeGreaterThanOrEqual(4);
    expect(result.speakers).toContain("Alice");
    expect(result.speakers).toContain("Bob");
    expect(result.speakers).toContain("Charlie");
  });
});

describe("MeetingAgent", () => {
  let db: HiveDatabase;
  let tmpDir: string;
  let engine: EnrichmentEngine;
  let agent: MeetingAgent;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hive-meeting-test-"));
    db = new HiveDatabase(join(tmpDir, "test.db"));
    engine = new EnrichmentEngine(db);
    engine.register(new DecisionExtractorProvider());
    engine.register(new ClassifyProvider());
    agent = new MeetingAgent(db, engine);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("processes a transcript and creates meeting entity", async () => {
    const result = await agent.process({
      transcriptContent: [
        "Alice: We decided to use PostgreSQL for the new database service.",
        "Bob: Action item: @alice will set up the schema by Friday.",
        "Charlie: Sounds good, I agreed to handle the API layer.",
      ].join("\n"),
      title: "Architecture Planning",
      date: "2026-03-25",
    });

    expect(result.meetingEntityId).toBeDefined();
    expect(result.speakers).toContain("Alice");
    expect(result.speakers).toContain("Bob");
    expect(result.speakers).toContain("Charlie");

    // Check meeting entity in DB
    const meeting = db.getEntity(result.meetingEntityId);
    expect(meeting).not.toBeNull();
    expect(meeting!.entityType).toBe("meeting");
    expect(meeting!.title).toBe("Architecture Planning");
  });

  it("creates person entities and attended synapses", async () => {
    const result = await agent.process({
      transcriptContent:
        "Alice: Hello\nBob: Hi there, let's get started with the agenda.",
      title: "Quick Sync",
    });

    // Check person entities exist
    const persons = db.listEntities({ entityType: "person" });
    expect(persons.length).toBeGreaterThanOrEqual(2);

    // Check attended synapses
    const synapses = db.getSynapsesByEntry(
      result.meetingEntityId,
      "incoming",
      "attended",
    );
    expect(synapses.length).toBeGreaterThanOrEqual(2);
  });

  it("extracts decisions and actions via enrichment", async () => {
    const result = await agent.process({
      transcriptContent: [
        "Alice: We decided to use Redis for caching all user sessions",
        "Bob: Action item: @charlie will deploy the cache layer by next Monday",
        "Alice: Also, let's go with Docker for containerization of all microservices",
      ].join("\n"),
      title: "Architecture Meeting",
    });

    expect(result.decisionsCreated).toBeGreaterThanOrEqual(1);
    expect(result.actionsCreated).toBeGreaterThanOrEqual(1);
  });

  it("is idempotent — reprocessing same content returns same entity", async () => {
    const content =
      "Alice: Good morning\nBob: Let's discuss the project roadmap for next quarter.";

    const result1 = await agent.process({
      transcriptContent: content,
      title: "Standup",
    });
    const result2 = await agent.process({
      transcriptContent: content,
      title: "Standup",
    });

    expect(result1.meetingEntityId).toBe(result2.meetingEntityId);

    // Should not create duplicate meeting entities
    const meetings = db.listEntities({ entityType: "meeting" });
    expect(meetings).toHaveLength(1);
  });

  it("renders markdown with decisions and action items", async () => {
    const result = await agent.process({
      transcriptContent: [
        "Alice: We decided to migrate from MySQL to PostgreSQL for better JSON support",
        "Bob: Action item: @dave will update the connection strings by Friday for all services",
      ].join("\n"),
      title: "DB Migration Planning",
      date: "2026-03-25",
    });

    expect(result.markdownOutput).toContain("# DB Migration Planning");
    expect(result.markdownOutput).toContain("**Date:** 2026-03-25");
    expect(result.markdownOutput).toContain("## Decisions");
    expect(result.markdownOutput).toContain("## Action Items");
  });

  it("does not fail when slackWebhook and notionParentPageId are not set", async () => {
    const result = await agent.process({
      transcriptContent: "Alice: Let's keep it simple.",
      title: "Simple Meeting",
    });

    expect(result.markdownOutput).toContain("# Simple Meeting");
  });
});

// postToSlack and postToNotion tests moved to jarvis/tests/ — output.ts extracted
