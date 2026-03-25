import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OutlookConnector } from "../src/connectors/outlook.js";
import { HiveDatabase } from "../src/db/database.js";
import type { RawDocument } from "../src/connectors/types.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "AAMkAGFhYjFhYT",
    subject: "Team Standup",
    bodyPreview: "Daily sync meeting",
    start: { dateTime: "2026-03-20T09:00:00Z", timeZone: "UTC" },
    end: { dateTime: "2026-03-20T09:30:00Z", timeZone: "UTC" },
    location: { displayName: "Conference Room A" },
    isCancelled: false,
    isOnlineMeeting: false,
    organizer: { emailAddress: { name: "Alice", address: "alice@example.com" } },
    attendees: [
      { emailAddress: { name: "Alice", address: "alice@example.com" }, status: { response: "accepted" } },
      { emailAddress: { name: "Bob", address: "bob@example.com" }, status: { response: "accepted" } },
      { emailAddress: { name: "Charlie", address: "charlie@example.com" }, status: { response: "accepted" } },
    ],
    onlineMeeting: null,
    lastModifiedDateTime: "2026-03-20T10:00:00Z",
    ...overrides,
  };
}

function makeRawDoc(event: Record<string, unknown>, calendarId = "primary"): RawDocument {
  return {
    externalId: `outlook:event:${event.id as string}`,
    source: "outlook-calendar",
    content: (event.bodyPreview as string) ?? "",
    title: (event.subject as string) ?? "(No title)",
    timestamp: (event.lastModifiedDateTime as string) ?? "",
    metadata: { calendarId, rawEvent: event },
  };
}

describe("OutlookConnector", () => {
  let connector: OutlookConnector;

  beforeEach(() => {
    connector = new OutlookConnector();
  });

  describe("isConfigured", () => {
    it("returns false when OUTLOOK_TOKEN env var is not set", () => {
      delete process.env["OUTLOOK_TOKEN"];
      const c = new OutlookConnector();
      expect(c.isConfigured()).toBe(false);
    });

    it("returns false when token file does not exist", () => {
      process.env["OUTLOOK_TOKEN"] = "/nonexistent/path.json";
      const c = new OutlookConnector();
      expect(c.isConfigured()).toBe(false);
      delete process.env["OUTLOOK_TOKEN"];
    });

    it("returns true when OUTLOOK_TOKEN points to an existing file", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "hive-outlook-token-test-"));
      const tokenFile = join(tmpDir, "token.json");
      writeFileSync(
        tokenFile,
        JSON.stringify({
          access_token: "test-token",
          client_id: "client-id",
          client_secret: "secret",
          tenant_id: "tenant",
        }),
      );
      process.env["OUTLOOK_TOKEN"] = tokenFile;
      const c = new OutlookConnector();
      const configured = c.isConfigured();
      delete process.env["OUTLOOK_TOKEN"];
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

    it("produces event entity for 2 attendees without isOnlineMeeting", () => {
      const event = makeEvent({
        attendees: [
          { emailAddress: { name: "Alice", address: "alice@example.com" }, status: { response: "accepted" } },
          { emailAddress: { name: "Bob", address: "bob@example.com" }, status: { response: "accepted" } },
        ],
      });
      const doc = makeRawDoc(event);
      const drafts = connector.transform(doc);

      const mainDraft = drafts.find(
        (d) => d.entityType === "event" || d.entityType === "meeting",
      );
      expect(mainDraft!.entityType).toBe("event");
    });

    it("promotes to meeting when isOnlineMeeting is true", () => {
      const event = makeEvent({
        attendees: [
          { emailAddress: { name: "Alice", address: "alice@example.com" }, status: { response: "accepted" } },
        ],
        isOnlineMeeting: true,
        onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/abc" },
      });
      const doc = makeRawDoc(event);
      const drafts = connector.transform(doc);

      const meetingDraft = drafts.find((d) => d.entityType === "meeting");
      expect(meetingDraft).toBeDefined();
      expect(meetingDraft!.attributes.conferenceUrl).toBe(
        "https://teams.microsoft.com/l/meetup-join/abc",
      );
    });

    it("produces person entities for attendees, deduplicated", () => {
      const event = makeEvent();
      const doc = makeRawDoc(event);
      const drafts = connector.transform(doc);

      const personDrafts = drafts.filter((d) => d.entityType === "person");
      expect(personDrafts).toHaveLength(3);

      const emails = personDrafts.map((d) => d.attributes.email as string);
      expect(new Set(emails).size).toBe(3);
    });

    it("sets archived status for cancelled events", () => {
      const event = makeEvent({ isCancelled: true });
      const doc = makeRawDoc(event);
      const drafts = connector.transform(doc);

      const mainDraft = drafts.find(
        (d) => d.entityType === "meeting" || d.entityType === "event",
      );
      expect(mainDraft!.status).toBe("archived");
    });

    it("uses email as title when displayName is missing", () => {
      const event = makeEvent({
        attendees: [
          { emailAddress: { address: "no-name@example.com" }, status: { response: "accepted" } },
          { emailAddress: { name: "Alice", address: "alice@example.com" }, status: { response: "accepted" } },
          { emailAddress: { name: "Bob", address: "bob@example.com" }, status: { response: "accepted" } },
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

    it("sets correct external ID format outlook:event:{id}", () => {
      const event = makeEvent();
      const doc = makeRawDoc(event);
      const drafts = connector.transform(doc);

      const meetingDraft = drafts.find((d) => d.entityType === "meeting");
      expect(meetingDraft!.source.externalId).toBe(
        `outlook:event:${event.id as string}`,
      );

      const personDraft = drafts.find((d) => d.entityType === "person");
      expect(personDraft!.source.externalId).toMatch(/^outlook:person:/);
    });

    it("sets location from location.displayName", () => {
      const event = makeEvent();
      const doc = makeRawDoc(event);
      const drafts = connector.transform(doc);

      const meetingDraft = drafts.find((d) => d.entityType === "meeting");
      expect(meetingDraft!.attributes.location).toBe("Conference Room A");
    });

    it("classifies large meeting correctly (9+ attendees)", () => {
      const attendees = Array.from({ length: 10 }, (_, i) => ({
        emailAddress: { name: `User ${i}`, address: `user${i}@example.com` },
        status: { response: "accepted" },
      }));
      const event = makeEvent({ attendees });
      const doc = makeRawDoc(event);
      const drafts = connector.transform(doc);

      const meeting = drafts.find((d) => d.entityType === "meeting");
      expect(meeting!.attributes.meetingType).toBe("large-meeting");
    });

    it("classifies one-on-one meeting correctly (2 attendees with isOnlineMeeting)", () => {
      const event = makeEvent({
        attendees: [
          { emailAddress: { name: "Alice", address: "alice@example.com" }, status: { response: "accepted" } },
          { emailAddress: { name: "Bob", address: "bob@example.com" }, status: { response: "accepted" } },
        ],
        isOnlineMeeting: true,
      });
      const doc = makeRawDoc(event);
      const drafts = connector.transform(doc);

      const meeting = drafts.find((d) => d.entityType === "meeting");
      expect(meeting!.attributes.meetingType).toBe("one-on-one");
    });

    it("sets startTime and endTime from start/end dateTime", () => {
      const event = makeEvent();
      const doc = makeRawDoc(event);
      const drafts = connector.transform(doc);

      const meeting = drafts.find((d) => d.entityType === "meeting");
      expect(meeting!.attributes.startTime).toBe("2026-03-20T09:00:00Z");
      expect(meeting!.attributes.endTime).toBe("2026-03-20T09:30:00Z");
    });

    it("sets correct system and connector in source", () => {
      const event = makeEvent();
      const doc = makeRawDoc(event);
      const drafts = connector.transform(doc);

      const meetingDraft = drafts.find((d) => d.entityType === "meeting");
      expect(meetingDraft!.source.system).toBe("outlook-calendar");
      expect(meetingDraft!.source.connector).toBe("outlook-calendar");
    });
  });

  describe("postSync", () => {
    let db: HiveDatabase;
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "hive-outlook-test-"));
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

      const entityMap = new Map([
        [`outlook:event:${event.id as string}`, "meeting-id"],
        ["outlook:person:alice@example.com", "alice-id"],
        ["outlook:person:bob@example.com", "bob-id"],
        ["outlook:person:charlie@example.com", "charlie-id"],
      ]);

      for (const [extId, id] of entityMap) {
        db.insertEntity({
          id,
          entityType: extId.startsWith("outlook:person") ? "person" : "meeting",
          namespace: "local",
          content: "test",
          tags: [],
          keywords: [],
          attributes: {},
          source: { system: "outlook-calendar", externalId: extId },
          visibility: "personal",
          domain: "meetings",
          confidence: "confirmed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: "active",
        });
      }

      connector.postSync(db, entityMap);

      const aliceSynapses = db.getSynapsesByEntry("alice-id", "outgoing", "attended");
      expect(aliceSynapses).toHaveLength(1);
      expect(aliceSynapses[0].target).toBe("meeting-id");
    });

    it("skips declined attendees for synapses", () => {
      const event = makeEvent({
        attendees: [
          { emailAddress: { name: "Alice", address: "alice@example.com" }, status: { response: "accepted" } },
          { emailAddress: { name: "Bob", address: "bob@example.com" }, status: { response: "declined" } },
          { emailAddress: { name: "Charlie", address: "charlie@example.com" }, status: { response: "accepted" } },
        ],
      });
      const doc = makeRawDoc(event);
      connector.transform(doc);

      const entityMap = new Map([
        [`outlook:event:${event.id as string}`, "meeting-id"],
        ["outlook:person:alice@example.com", "alice-id"],
        ["outlook:person:bob@example.com", "bob-id"],
        ["outlook:person:charlie@example.com", "charlie-id"],
      ]);

      for (const [extId, id] of entityMap) {
        db.insertEntity({
          id,
          entityType: extId.startsWith("outlook:person") ? "person" : "meeting",
          namespace: "local",
          content: "test",
          tags: [],
          keywords: [],
          attributes: {},
          source: { system: "outlook-calendar", externalId: extId },
          visibility: "personal",
          domain: "meetings",
          confidence: "confirmed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: "active",
        });
      }

      connector.postSync(db, entityMap);

      const bobSynapses = db.getSynapsesByEntry("bob-id", "outgoing", "attended");
      expect(bobSynapses).toHaveLength(0);

      const aliceSynapses = db.getSynapsesByEntry("alice-id", "outgoing", "attended");
      expect(aliceSynapses).toHaveLength(1);
    });

    it("creates temporal synapses for recurring events", () => {
      const event1 = makeEvent({
        id: "evt-r1",
        seriesMasterId: "series-master-1",
        start: { dateTime: "2026-03-20T09:00:00Z", timeZone: "UTC" },
      });
      const event2 = makeEvent({
        id: "evt-r2",
        seriesMasterId: "series-master-1",
        start: { dateTime: "2026-03-27T09:00:00Z", timeZone: "UTC" },
      });

      connector.transform(makeRawDoc(event1));
      connector.transform(makeRawDoc(event2));

      const entityMap = new Map([
        ["outlook:event:evt-r1", "r1-id"],
        ["outlook:event:evt-r2", "r2-id"],
        ["outlook:person:alice@example.com", "alice-id"],
        ["outlook:person:bob@example.com", "bob-id"],
        ["outlook:person:charlie@example.com", "charlie-id"],
      ]);

      for (const [extId, id] of entityMap) {
        db.insertEntity({
          id,
          entityType: extId.startsWith("outlook:person") ? "person" : "meeting",
          namespace: "local",
          content: "test",
          tags: [],
          keywords: [],
          attributes: {},
          source: { system: "outlook-calendar", externalId: extId },
          visibility: "personal",
          domain: "meetings",
          confidence: "confirmed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: "active",
        });
      }

      connector.postSync(db, entityMap);

      const synapses = db.getSynapsesByEntry("r1-id", "outgoing", "temporal");
      expect(synapses).toHaveLength(1);
      expect(synapses[0].target).toBe("r2-id");
      expect(synapses[0].weight).toBe(0.8);
    });

    it("does not create synapse for event entityType (only meeting)", () => {
      // 2 attendees, no isOnlineMeeting → event, not meeting → no attended synapse
      const event = makeEvent({
        attendees: [
          { emailAddress: { name: "Alice", address: "alice@example.com" }, status: { response: "accepted" } },
          { emailAddress: { name: "Bob", address: "bob@example.com" }, status: { response: "accepted" } },
        ],
        isOnlineMeeting: false,
      });
      const doc = makeRawDoc(event);
      connector.transform(doc);

      const entityMap = new Map([
        [`outlook:event:${event.id as string}`, "event-id"],
        ["outlook:person:alice@example.com", "alice-id"],
        ["outlook:person:bob@example.com", "bob-id"],
      ]);

      for (const [extId, id] of entityMap) {
        db.insertEntity({
          id,
          entityType: extId.startsWith("outlook:person") ? "person" : "event",
          namespace: "local",
          content: "test",
          tags: [],
          keywords: [],
          attributes: {},
          source: { system: "outlook-calendar", externalId: extId },
          visibility: "personal",
          domain: "meetings",
          confidence: "confirmed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: "active",
        });
      }

      connector.postSync(db, entityMap);

      // No attended synapses — event is not a meeting
      const aliceSynapses = db.getSynapsesByEntry("alice-id", "outgoing", "attended");
      expect(aliceSynapses).toHaveLength(0);
    });
  });
});
