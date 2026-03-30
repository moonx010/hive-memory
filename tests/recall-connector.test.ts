import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RecallClient, RecallConnector } from "../src/connectors/recall.js";
import type { RecallTranscriptEntry } from "../src/connectors/recall.js";

describe("RecallClient", () => {
  describe("transcriptToPlaintext", () => {
    it("converts Recall transcript entries to plaintext", () => {
      const entries: RecallTranscriptEntry[] = [
        {
          speaker: "Alice",
          speaker_id: 1,
          words: [
            { text: "Hello", start_time: 0, end_time: 0.5 },
            { text: "everyone.", start_time: 0.5, end_time: 1.0 },
          ],
        },
        {
          speaker: "Bob",
          speaker_id: 2,
          words: [
            { text: "Hi", start_time: 1.5, end_time: 2.0 },
            { text: "Alice!", start_time: 2.0, end_time: 2.5 },
          ],
        },
      ];

      const result = RecallClient.transcriptToPlaintext(entries);
      expect(result).toBe("Alice: Hello everyone.\nBob: Hi Alice!");
    });

    it("uses Speaker N for null speaker names", () => {
      const entries: RecallTranscriptEntry[] = [
        {
          speaker: null,
          speaker_id: 0,
          words: [{ text: "Testing", start_time: 0, end_time: 1 }],
        },
      ];

      const result = RecallClient.transcriptToPlaintext(entries);
      expect(result).toBe("Speaker 0: Testing");
    });

    it("skips entries with no words", () => {
      const entries: RecallTranscriptEntry[] = [
        { speaker: "Alice", speaker_id: 1, words: [] },
        {
          speaker: "Bob",
          speaker_id: 2,
          words: [{ text: "Hi", start_time: 0, end_time: 1 }],
        },
      ];

      const result = RecallClient.transcriptToPlaintext(entries);
      expect(result).toBe("Bob: Hi");
    });
  });

  describe("transcriptToVTT", () => {
    it("converts Recall transcript to WebVTT format", () => {
      const entries: RecallTranscriptEntry[] = [
        {
          speaker: "Alice",
          speaker_id: 1,
          words: [
            { text: "Hello", start_time: 0, end_time: 0.5 },
            { text: "everyone.", start_time: 0.5, end_time: 1.2 },
          ],
        },
      ];

      const result = RecallClient.transcriptToVTT(entries);
      expect(result).toContain("WEBVTT");
      expect(result).toContain("00:00:00.000 --> 00:00:01.200");
      expect(result).toContain("<v Alice>Hello everyone.");
    });
  });
});

describe("RecallConnector", () => {
  it("has correct metadata", () => {
    const connector = new RecallConnector();
    expect(connector.id).toBe("recall");
    expect(connector.entityTypes).toContain("meeting");
    expect(connector.entityTypes).toContain("person");
    expect(connector.domains).toContain("meetings");
  });

  it("isConfigured returns false without API key", () => {
    const orig = process.env["RECALL_API_KEY"];
    delete process.env["RECALL_API_KEY"];
    const connector = new RecallConnector();
    expect(connector.isConfigured()).toBe(false);
    if (orig) process.env["RECALL_API_KEY"] = orig;
  });

  it("transform produces meeting and person entities", () => {
    const connector = new RecallConnector();
    const drafts = connector.transform({
      externalId: "recall:bot:test-123",
      source: "recall",
      content: "Alice: We should use Redis.\nBob: Agreed.",
      title: "Architecture Meeting",
      url: "https://meet.google.com/abc-defg",
      timestamp: "2026-03-29T10:00:00Z",
      metadata: {
        speakers: ["Alice", "Bob"],
        durationMinutes: 30,
        meetingUrl: "https://meet.google.com/abc-defg",
        botId: "test-123",
      },
    });

    // Should have 1 meeting + 2 person entities
    expect(drafts).toHaveLength(3);

    const meeting = drafts.find((d) => d.entityType === "meeting")!;
    expect(meeting.title).toBe("Architecture Meeting");
    expect(meeting.attributes.recallBotId).toBe("test-123");
    expect(meeting.attributes.speakers).toEqual(["Alice", "Bob"]);
    expect(meeting.source.connector).toBe("recall");

    const persons = drafts.filter((d) => d.entityType === "person");
    expect(persons).toHaveLength(2);
    expect(persons.map((p) => p.title)).toEqual(["Alice", "Bob"]);
  });
});

// parseIntentRegex tests moved to jarvis/tests/bumble-bee.test.ts
