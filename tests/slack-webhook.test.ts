import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HiveDatabase } from "../src/db/database.js";
import { processSlackMessageEvent, type SlackMessageEvent } from "../src/connectors/slack-webhook.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
  return {
    type: "message",
    text: "This is a meaningful Slack message that is long enough to store.",
    user: "U12345",
    channel: "C99999",
    channel_type: "channel",
    ts: "1711600000.000000",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("processSlackMessageEvent", () => {
  let db: HiveDatabase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "slack-webhook-test-"));
    db = new HiveDatabase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores a valid message entity and returns stored=true with entityId", () => {
    const result = processSlackMessageEvent(db, makeEvent());

    expect(result.stored).toBe(true);
    expect(result.entityId).toBeDefined();
    expect(typeof result.entityId).toBe("string");

    const entity = db.getEntity(result.entityId!);
    expect(entity).not.toBeNull();
    expect(entity!.entityType).toBe("message");
    expect(entity!.content).toBe("This is a meaningful Slack message that is long enough to store.");
    expect(entity!.tags).toContain("slack");
    expect(entity!.tags).toContain("real-time");
    expect(entity!.source.system).toBe("slack");
    expect(entity!.source.connector).toBe("slack-webhook");
  });

  it("skips bot messages (subtype present)", () => {
    const result = processSlackMessageEvent(db, makeEvent({ subtype: "bot_message" }));
    expect(result.stored).toBe(false);
    expect(result.entityId).toBeUndefined();
  });

  it("skips messages without text", () => {
    const result = processSlackMessageEvent(db, makeEvent({ text: undefined }));
    expect(result.stored).toBe(false);
  });

  it("skips messages without user (e.g. system messages)", () => {
    const result = processSlackMessageEvent(db, makeEvent({ user: undefined }));
    expect(result.stored).toBe(false);
  });

  it("skips short messages (< 20 characters)", () => {
    const result = processSlackMessageEvent(db, makeEvent({ text: "ok" }));
    expect(result.stored).toBe(false);
  });

  it("skips messages exactly at the 20-char boundary (length = 19)", () => {
    const result = processSlackMessageEvent(db, makeEvent({ text: "nineteen chars long" })); // 19 chars
    expect(result.stored).toBe(false);
  });

  it("stores a message that is exactly 20 characters", () => {
    const result = processSlackMessageEvent(db, makeEvent({ text: "twenty characters ok" })); // 20 chars
    expect(result.stored).toBe(true);
  });

  it("dedup — same channel+ts not stored twice", () => {
    const event = makeEvent();
    const first = processSlackMessageEvent(db, event);
    const second = processSlackMessageEvent(db, event);

    expect(first.stored).toBe(true);
    expect(second.stored).toBe(false);
  });

  it("dedup — different ts is stored as separate entity", () => {
    const first = processSlackMessageEvent(db, makeEvent({ ts: "1711600000.000001" }));
    const second = processSlackMessageEvent(db, makeEvent({ ts: "1711600000.000002" }));

    expect(first.stored).toBe(true);
    expect(second.stored).toBe(true);
    expect(first.entityId).not.toBe(second.entityId);
  });

  it("DM channel type (im) sets visibility to dm", () => {
    const result = processSlackMessageEvent(db, makeEvent({ channel_type: "im" }));
    expect(result.stored).toBe(true);

    const entity = db.getEntity(result.entityId!);
    expect(entity!.visibility).toBe("dm");
  });

  it("MPIM channel type sets visibility to dm", () => {
    const result = processSlackMessageEvent(db, makeEvent({ channel_type: "mpim" }));
    expect(result.stored).toBe(true);

    const entity = db.getEntity(result.entityId!);
    expect(entity!.visibility).toBe("dm");
  });

  it("public channel type (channel) sets visibility to team", () => {
    const result = processSlackMessageEvent(db, makeEvent({ channel_type: "channel" }));
    expect(result.stored).toBe(true);

    const entity = db.getEntity(result.entityId!);
    expect(entity!.visibility).toBe("team");
  });

  it("private channel type (group) sets visibility to private", () => {
    const result = processSlackMessageEvent(db, makeEvent({ channel_type: "group" }));
    expect(result.stored).toBe(true);

    const entity = db.getEntity(result.entityId!);
    expect(entity!.visibility).toBe("private");
  });

  it("stores thread_ts in attributes when present", () => {
    const result = processSlackMessageEvent(
      db,
      makeEvent({ thread_ts: "1711500000.000000" }),
    );
    expect(result.stored).toBe(true);

    const entity = db.getEntity(result.entityId!);
    expect(entity!.attributes.threadTs).toBe("1711500000.000000");
  });

  it("stores channelId and slackUserId in attributes", () => {
    const result = processSlackMessageEvent(
      db,
      makeEvent({ channel: "C99999", user: "U12345" }),
    );
    const entity = db.getEntity(result.entityId!);
    expect(entity!.attributes.channelId).toBe("C99999");
    expect(entity!.attributes.slackUserId).toBe("U12345");
  });

  it("externalId format is slack:msg:<channel>:<ts>", () => {
    const result = processSlackMessageEvent(
      db,
      makeEvent({ channel: "CABC", ts: "1711600000.000000" }),
    );
    expect(result.stored).toBe(true);

    const entity = db.getEntity(result.entityId!);
    expect(entity!.source.externalId).toBe("slack:msg:CABC:1711600000.000000");
  });
});
