import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CalendarConnector } from "../src/connectors/calendar.js";
import { HiveDatabase } from "../src/db/database.js";
import type { RawDocument } from "../src/connectors/types.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    summary: "Team Standup",
    description: "<p>Daily sync</p>",
    start: { dateTime: "2026-03-20T09:00:00Z" },
    end: { dateTime: "2026-03-20T09:30:00Z" },
    status: "confirmed",
    organizer: { email: "alice@example.com", displayName: "Alice" },
    attendees: [
      { email: "alice@example.com", displayName: "Alice", responseStatus: "accepted" },
      { email: "bob@example.com", displayName: "Bob", responseStatus: "accepted" },
      { email: "charlie@example.com", displayName: "Charlie", responseStatus: "accepted" },
    ],
    conferenceData: null,
    updated: "2026-03-20T10:00:00Z",
    ...overrides,
  };
}

function makeRawDoc(event: Record<string, unknown>, calendarId = "primary"): RawDocument {
  return {
    externalId: `gcal:event:${calendarId}:${event.id as string}`,
    source: "google-calendar",
    content: typeof event.description === "string" ? event.description.replace(/<[^>]+>/g, "").trim() : "",
    title: (event.summary as string) ?? "(No title)",
    timestamp: (event.updated as string) ?? "",
    metadata: { calendarId, rawEvent: event },
  };
}

describe("CalendarConnector", () => {
  let connector: CalendarConnector;

  beforeEach(() => {
    connector = new CalendarConnector();
  });

  describe("isConfigured", () => {
    it("returns false when env var is not set", () => {
      delete process.env.GOOGLE_CALENDAR_CREDENTIALS;
      const c = new CalendarConnector();
      expect(c.isConfigured()).toBe(false);
    });

    it("returns false when file does not exist", () => {
      process.env.GOOGLE_CALENDAR_CREDENTIALS = "/nonexistent/path.json";
      const c = new CalendarConnector();
      expect(c.isConfigured()).toBe(false);
      delete process.env.GOOGLE_CALENDAR_CREDENTIALS;
    });

    it("returns true when env var points to an existing file (CAL-16)", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "hive-cal-creds-test-"));
      const credFile = join(tmpDir, "credentials.json");
      writeFileSync(credFile, JSON.stringify({ type: "service_account" }));
      process.env.GOOGLE_CALENDAR_CREDENTIALS = credFile;
      const c = new CalendarConnector();
      const configured = c.isConfigured();
      delete process.env.GOOGLE_CALENDAR_CREDENTIALS;
      rmSync(tmpDir, { recursive: true, force: true });
      expect(configured).toBe(true);
    });
  });

  describe("transform", () => {
    it("produces meeting entity for 3+ attendees", () => {
      const event = makeEvent();
      const doc = makeRawDoc(event);
      const drafts = connector.transform(doc);

      const meetingDraft = drafts.find((d) => d.entityType === "meeting");
      expect(meetingDraft).toBeDefined();
      expect(meetingDraft!.attributes.meetingType).toBe("small-group");
    });

    it("produces event entity for 2 attendees without conference", () => {
      const event = makeEvent({
        attendees: [
          { email: "alice@example.com", displayName: "Alice", responseStatus: "accepted" },
          { email: "bob@example.com", displayName: "Bob", responseStatus: "accepted" },
        ],
      });
      const doc = makeRawDoc(event);
      const drafts = connector.transform(doc);

      const eventDraft = drafts.find(
        (d) => d.entityType === "event" || d.entityType === "meeting",
      );
      expect(eventDraft!.entityType).toBe("event");
    });

    it("promotes to meeting when conferenceData is present", () => {
      const event = makeEvent({
        attendees: [
          { email: "alice@example.com", displayName: "Alice", responseStatus: "accepted" },
        ],
        conferenceData: {
          entryPoints: [{ uri: "https://meet.google.com/abc-defg-hij", entryPointType: "video" }],
        },
      });
      const doc = makeRawDoc(event);
      const drafts = connector.transform(doc);

      const meetingDraft = drafts.find((d) => d.entityType === "meeting");
      expect(meetingDraft).toBeDefined();
      expect(meetingDraft!.attributes.conferenceUrl).toBe(
        "https://meet.google.com/abc-defg-hij",
      );
    });

    it("produces person entities for attendees, deduplicated", () => {
      const event = makeEvent();
      const doc = makeRawDoc(event);
      const drafts = connector.transform(doc);

      const personDrafts = drafts.filter((d) => d.entityType === "person");
      expect(personDrafts).toHaveLength(3);

      const emails = personDrafts.map(
        (d) => d.attributes.email as string,
      );
      expect(new Set(emails).size).toBe(3);
    });

    it("handles cancelled events with archived status", () => {
      const event = makeEvent({ status: "cancelled" });
      const doc = makeRawDoc(event);
      const drafts = connector.transform(doc);

      const meetingDraft = drafts.find(
        (d) => d.entityType === "meeting" || d.entityType === "event",
      );
      expect(meetingDraft!.status).toBe("archived");
    });

    it("uses email as title when displayName is missing", () => {
      const event = makeEvent({
        attendees: [
          { email: "no-name@example.com", responseStatus: "accepted" },
          { email: "alice@example.com", displayName: "Alice", responseStatus: "accepted" },
          { email: "bob@example.com", displayName: "Bob", responseStatus: "accepted" },
        ],
      });
      const doc = makeRawDoc(event);
      const drafts = connector.transform(doc);

      const noNamePerson = drafts.find(
        (d) =>
          d.entityType === "person" &&
          (d.attributes.email as string) === "no-name@example.com",
      );
      expect(noNamePerson!.title).toBe("no-name@example.com");
    });

    it("sets correct source external IDs", () => {
      const event = makeEvent();
      const doc = makeRawDoc(event);
      const drafts = connector.transform(doc);

      const meetingDraft = drafts.find((d) => d.entityType === "meeting");
      expect(meetingDraft!.source.externalId).toBe(
        "gcal:event:primary:evt-1",
      );

      const personDraft = drafts.find((d) => d.entityType === "person");
      expect(personDraft!.source.externalId).toMatch(
        /^gcal:person:/,
      );
    });

    it("strips HTML from description", () => {
      const event = makeEvent({
        description: "<p>Hello <b>world</b></p><br/>Next line",
      });
      const doc = makeRawDoc(event);
      // The raw doc content already strips HTML in makeRawDoc
      // But the connector should produce clean content
      const drafts = connector.transform(doc);
      const meeting = drafts.find((d) => d.entityType === "meeting");
      expect(meeting!.content).not.toContain("<p>");
      expect(meeting!.content).not.toContain("<b>");
    });

    it("classifies large meeting correctly", () => {
      const attendees = Array.from({ length: 12 }, (_, i) => ({
        email: `user${i}@example.com`,
        displayName: `User ${i}`,
        responseStatus: "accepted",
      }));
      const event = makeEvent({ attendees });
      const doc = makeRawDoc(event);
      const drafts = connector.transform(doc);

      const meeting = drafts.find((d) => d.entityType === "meeting");
      expect(meeting!.attributes.meetingType).toBe("large-meeting");
    });

    it("produces correct entity counts for 5 events (CAL-15 pagination)", () => {
      const events = Array.from({ length: 5 }, (_, i) =>
        makeEvent({
          id: `evt-multi-${i}`,
          summary: `Event ${i}`,
          attendees: [
            { email: `host${i}@example.com`, displayName: `Host ${i}`, responseStatus: "accepted" },
            { email: `guest${i}@example.com`, displayName: `Guest ${i}`, responseStatus: "accepted" },
            { email: `extra${i}@example.com`, displayName: `Extra ${i}`, responseStatus: "accepted" },
          ],
        }),
      );

      const allDrafts = events.flatMap((event) =>
        connector.transform(makeRawDoc(event, "primary")),
      );

      // Each event produces 1 meeting + 3 person entities = 4 drafts × 5 events = 20 total
      // But persons are deduplicated per-transform call, so each call yields 1 meeting + 3 persons
      const meetings = allDrafts.filter((d) => d.entityType === "meeting");
      const persons = allDrafts.filter((d) => d.entityType === "person");

      expect(meetings).toHaveLength(5);
      expect(persons).toHaveLength(15); // 3 unique persons per event, 5 events
    });
  });

  describe("postSync", () => {
    let db: HiveDatabase;
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "hive-cal-test-"));
      db = new HiveDatabase(join(tmpDir, "test.db"));
    });

    afterEach(() => {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("creates attended synapses for meeting attendees", () => {
      const event = makeEvent();
      const doc = makeRawDoc(event);
      connector.transform(doc);

      // Simulate entityMap that syncConnector would build
      const entityMap = new Map([
        ["gcal:event:primary:evt-1", "meeting-id"],
        ["gcal:person:alice@example.com", "alice-id"],
        ["gcal:person:bob@example.com", "bob-id"],
        ["gcal:person:charlie@example.com", "charlie-id"],
      ]);

      // Create the entities in DB first (upsertSynapse checks for existence)
      for (const [extId, id] of entityMap) {
        db.insertEntity({
          id,
          entityType: extId.startsWith("gcal:person") ? "person" : "meeting",
          namespace: "local",
          content: "test",
          tags: [],
          keywords: [],
          attributes: {},
          source: { system: "google-calendar", externalId: extId },
          visibility: "personal",
          domain: "meetings",
          confidence: "confirmed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: "active",
        });
      }

      connector.postSync(db, entityMap);

      // Check synapses
      const aliceSynapses = db.getSynapsesByEntry("alice-id", "outgoing", "attended");
      expect(aliceSynapses).toHaveLength(1);
      expect(aliceSynapses[0].target).toBe("meeting-id");
    });

    it("skips declined attendees for synapses", () => {
      const event = makeEvent({
        attendees: [
          { email: "alice@example.com", displayName: "Alice", responseStatus: "accepted" },
          { email: "bob@example.com", displayName: "Bob", responseStatus: "declined" },
          { email: "charlie@example.com", displayName: "Charlie", responseStatus: "accepted" },
        ],
      });
      const doc = makeRawDoc(event);
      connector.transform(doc);

      const entityMap = new Map([
        ["gcal:event:primary:evt-1", "meeting-id"],
        ["gcal:person:alice@example.com", "alice-id"],
        ["gcal:person:bob@example.com", "bob-id"],
        ["gcal:person:charlie@example.com", "charlie-id"],
      ]);

      for (const [extId, id] of entityMap) {
        db.insertEntity({
          id,
          entityType: extId.startsWith("gcal:person") ? "person" : "meeting",
          namespace: "local",
          content: "test",
          tags: [],
          keywords: [],
          attributes: {},
          source: { system: "google-calendar", externalId: extId },
          visibility: "personal",
          domain: "meetings",
          confidence: "confirmed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: "active",
        });
      }

      connector.postSync(db, entityMap);

      // Bob declined — no synapse
      const bobSynapses = db.getSynapsesByEntry("bob-id", "outgoing", "attended");
      expect(bobSynapses).toHaveLength(0);
    });

    it("creates temporal synapses for recurring events", () => {
      const event1 = makeEvent({
        id: "evt-r1",
        recurringEventId: "series-1",
        start: { dateTime: "2026-03-20T09:00:00Z" },
      });
      const event2 = makeEvent({
        id: "evt-r2",
        recurringEventId: "series-1",
        start: { dateTime: "2026-03-27T09:00:00Z" },
      });

      connector.transform(makeRawDoc(event1));
      connector.transform(makeRawDoc(event2));

      const entityMap = new Map([
        ["gcal:event:primary:evt-r1", "r1-id"],
        ["gcal:event:primary:evt-r2", "r2-id"],
        ["gcal:person:alice@example.com", "alice-id"],
        ["gcal:person:bob@example.com", "bob-id"],
        ["gcal:person:charlie@example.com", "charlie-id"],
      ]);

      for (const [extId, id] of entityMap) {
        db.insertEntity({
          id,
          entityType: extId.startsWith("gcal:person") ? "person" : "meeting",
          namespace: "local",
          content: "test",
          tags: [],
          keywords: [],
          attributes: {},
          source: { system: "google-calendar", externalId: extId },
          visibility: "personal",
          domain: "meetings",
          confidence: "confirmed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: "active",
        });
      }

      connector.postSync(db, entityMap);

      // Check temporal synapse
      const synapses = db.getSynapsesByEntry("r1-id", "outgoing", "temporal");
      expect(synapses).toHaveLength(1);
      expect(synapses[0].target).toBe("r2-id");
      expect(synapses[0].weight).toBe(0.8);
    });
  });

  describe("getByExternalId (HiveDatabase)", () => {
    let db: HiveDatabase;
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "hive-extid-test-"));
      db = new HiveDatabase(join(tmpDir, "test.db"));
    });

    afterEach(() => {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("finds entity by system + external ID", () => {
      db.insertEntity({
        id: "test-id",
        entityType: "person",
        namespace: "local",
        content: "Test person",
        tags: [],
        keywords: [],
        attributes: {},
        source: { system: "google-calendar", externalId: "gcal:person:test@example.com" },
        visibility: "personal",
        domain: "meetings",
        confidence: "confirmed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "active",
      });

      const found = db.getByExternalId("google-calendar", "gcal:person:test@example.com");
      expect(found).not.toBeNull();
      expect(found!.id).toBe("test-id");
    });

    it("returns null for non-existent external ID", () => {
      const found = db.getByExternalId("google-calendar", "gcal:person:nobody@example.com");
      expect(found).toBeNull();
    });
  });
});
