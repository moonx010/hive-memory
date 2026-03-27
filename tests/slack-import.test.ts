import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../src/db/database.js";
import { importSlackExport } from "../src/pipeline/slack-import.js";

async function createTestDb(): Promise<{ db: HiveDatabase; dbPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "slack-import-db-"));
  const dbPath = join(dir, "test.db");
  const db = new HiveDatabase(dbPath);
  return { db, dbPath };
}

async function createExportDir(
  baseDir: string,
  opts: {
    users?: object[];
    channels?: object[];
    channelMessages?: Record<string, object[]>;
  } = {},
): Promise<string> {
  const exportDir = join(baseDir, "export");
  await mkdir(exportDir, { recursive: true });

  if (opts.users) {
    await writeFile(join(exportDir, "users.json"), JSON.stringify(opts.users), "utf-8");
  }

  if (opts.channels) {
    await writeFile(
      join(exportDir, "channels.json"),
      JSON.stringify(opts.channels),
      "utf-8",
    );
  }

  if (opts.channelMessages) {
    for (const [channelName, messages] of Object.entries(opts.channelMessages)) {
      const channelDir = join(exportDir, channelName);
      await mkdir(channelDir, { recursive: true });
      await writeFile(
        join(channelDir, "2024-01-01.json"),
        JSON.stringify(messages),
        "utf-8",
      );
    }
  }

  return exportDir;
}

describe("importSlackExport", () => {
  let tempDir: string;
  let db: HiveDatabase;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "slack-import-test-"));
    const ctx = await createTestDb();
    db = ctx.db;
    dbPath = ctx.dbPath;
  });

  afterEach(async () => {
    db.close();
    try {
      await rm(tempDir, { recursive: true, force: true });
      await rm(dbPath.slice(0, dbPath.lastIndexOf("/")), { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("imports users from users.json", async () => {
    const exportDir = await createExportDir(tempDir, {
      users: [
        {
          id: "U001",
          name: "jsmith",
          real_name: "John Smith",
          profile: { title: "Engineer", email: "john@example.com" },
        },
        {
          id: "U002",
          name: "bot",
          real_name: "My Bot",
          is_bot: true,
        },
      ],
    });

    const result = await importSlackExport(db, { exportDir });

    expect(result.users).toBe(1); // bot excluded
    expect(result.errors).toBe(0);

    const entities = db.listEntities({ entityType: "person" });
    expect(entities).toHaveLength(1);
    expect(entities[0].title).toBe("John Smith");
  });

  it("imports messages from channel day files", async () => {
    const exportDir = await createExportDir(tempDir, {
      channels: [{ id: "C001", name: "general" }],
      channelMessages: {
        general: [
          {
            type: "message",
            ts: "1704067200.000001",
            user: "U001",
            text: "This is a long enough message to be imported by the pipeline",
          },
          {
            type: "message",
            ts: "1704067201.000002",
            user: "U001",
            text: "short", // too short, should be skipped
          },
          {
            type: "message",
            subtype: "channel_join",
            ts: "1704067202.000003",
            user: "U001",
            text: "joined the channel and this message is long enough to pass", // subtype filtered
          },
        ],
      },
    });

    const result = await importSlackExport(db, { exportDir });

    expect(result.channels).toBe(1);
    expect(result.messages).toBe(1); // only 1 passes filters
    expect(result.errors).toBe(0);
  });

  it("counts messages correctly across multiple channels and day files", async () => {
    const exportDir = await createExportDir(tempDir, {
      channels: [
        { id: "C001", name: "general" },
        { id: "C002", name: "engineering" },
      ],
      channelMessages: {
        general: [
          { type: "message", ts: "1704067200.000001", user: "U001", text: "General discussion message long enough" },
          { type: "message", ts: "1704067201.000002", user: "U002", text: "Another long message for general channel here" },
        ],
        engineering: [
          { type: "message", ts: "1704067202.000003", user: "U001", text: "Engineering team message that is long enough to import" },
        ],
      },
    });

    const result = await importSlackExport(db, { exportDir });

    expect(result.channels).toBe(2);
    expect(result.messages).toBe(3);
  });

  it("handles malformed JSON gracefully", async () => {
    const exportDir = join(tempDir, "bad-export");
    await mkdir(exportDir, { recursive: true });
    await writeFile(join(exportDir, "users.json"), "NOT VALID JSON", "utf-8");
    await writeFile(join(exportDir, "channels.json"), "ALSO NOT VALID JSON", "utf-8");

    const result = await importSlackExport(db, { exportDir });

    // Should not throw, just record errors
    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(result.messages).toBe(0);
  });

  it("handles missing export directory files gracefully", async () => {
    const emptyDir = join(tempDir, "empty-export");
    await mkdir(emptyDir, { recursive: true });

    const result = await importSlackExport(db, { exportDir: emptyDir });

    expect(result.channels).toBe(0);
    expect(result.messages).toBe(0);
    expect(result.users).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("skips deleted users", async () => {
    const exportDir = await createExportDir(tempDir, {
      users: [
        { id: "U001", name: "active", real_name: "Active User" },
        { id: "U002", name: "deleted", real_name: "Deleted User", deleted: true },
      ],
    });

    const result = await importSlackExport(db, { exportDir });

    expect(result.users).toBe(1);
    const persons = db.listEntities({ entityType: "person" });
    expect(persons).toHaveLength(1);
    expect(persons[0].title).toBe("Active User");
  });

  it("reports duration in result", async () => {
    const exportDir = await createExportDir(tempDir, {});

    const result = await importSlackExport(db, { exportDir });

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
