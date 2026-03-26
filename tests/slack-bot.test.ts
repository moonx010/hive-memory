import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseIntentRegex as parseIntent, stripMention } from "../src/bot/intent-parser.js";
import {
  formatRecallResults,
  formatHelp,
  formatWhoKnows,
  formatMeetingNotes,
  formatActionItems,
  type SlackBlock,
} from "../src/bot/slack-formatter.js";
import { verifySlackSignature } from "../src/bot/slack-bot.js";
import { createHmac } from "node:crypto";
import type { HiveSearchResult } from "../src/store/hive-search.js";
import type { Entity } from "../src/types.js";

// ── Intent parser ─────────────────────────────────────────────────────────────

describe("stripMention", () => {
  it("strips single bot mention", () => {
    expect(stripMention("<@U12345> hello")).toBe("hello");
  });
  it("strips mention anywhere in text", () => {
    expect(stripMention("find <@UABC123> sqlite")).toBe("find  sqlite");
  });
  it("is a no-op when no mention present", () => {
    expect(stripMention("action items")).toBe("action items");
  });
});

describe("parseIntent", () => {
  it("defaults to recall for generic queries", () => {
    const result = parseIntent("<@U1> what did we decide about auth?");
    expect(result.intent).toBe("recall");
    expect(result.query).toContain("auth");
  });

  it("recall intent — find keyword", () => {
    const result = parseIntent("<@U1> find database migrations");
    expect(result.intent).toBe("recall");
    expect(result.query).toContain("database");
  });

  it("recall intent — search keyword", () => {
    const result = parseIntent("<@U1> search redis caching strategy");
    expect(result.intent).toBe("recall");
  });

  it("recall intent — Korean 찾아", () => {
    const result = parseIntent("<@U1> SQLite 찾아");
    expect(result.intent).toBe("recall");
  });

  it("recall intent — Korean 알려줘", () => {
    const result = parseIntent("<@U1> API 설계 알려줘");
    expect(result.intent).toBe("recall");
  });

  it("meeting_notes intent — English", () => {
    const result = parseIntent("<@U1> meeting notes");
    expect(result.intent).toBe("meeting_notes");
  });

  it("meeting_notes intent — with ISO date", () => {
    const result = parseIntent("<@U1> meeting notes from 2026-03-20");
    expect(result.intent).toBe("meeting_notes");
    expect(result.dateHint).toBe("2026-03-20");
  });

  it("meeting_notes intent — minutes keyword", () => {
    const result = parseIntent("<@U1> meeting minutes");
    expect(result.intent).toBe("meeting_notes");
  });

  it("meeting_notes intent — Korean 회의록", () => {
    const result = parseIntent("<@U1> 회의록 보여줘");
    expect(result.intent).toBe("meeting_notes");
  });

  it("who_knows intent — English", () => {
    const result = parseIntent("<@U1> who knows about sqlite?");
    expect(result.intent).toBe("who_knows");
    expect(result.query).toContain("sqlite");
  });

  it("who_knows intent — expert", () => {
    const result = parseIntent("<@U1> who is the expert on authentication?");
    expect(result.intent).toBe("who_knows");
  });

  it("who_knows intent — Korean 누가", () => {
    const result = parseIntent("<@U1> 누가 데이터베이스 잘 알아?");
    expect(result.intent).toBe("who_knows");
  });

  it("action_items intent — English", () => {
    const result = parseIntent("<@U1> action items");
    expect(result.intent).toBe("action_items");
    expect(result.query).toBe("");
  });

  it("action_items intent — todo", () => {
    const result = parseIntent("<@U1> todo");
    expect(result.intent).toBe("action_items");
  });

  it("action_items intent — Korean 할 일", () => {
    const result = parseIntent("<@U1> 할 일 알려줘");
    expect(result.intent).toBe("action_items");
  });

  it("action_items intent — 미완료", () => {
    const result = parseIntent("<@U1> 미완료 작업");
    expect(result.intent).toBe("action_items");
  });

  it("extracts dateHint — yesterday", () => {
    const result = parseIntent("<@U1> meeting notes yesterday");
    expect(result.intent).toBe("meeting_notes");
    expect(result.dateHint).toMatch(/yesterday/i);
  });

  it("extracts dateHint — last week", () => {
    const result = parseIntent("<@U1> meeting notes last week");
    expect(result.intent).toBe("meeting_notes");
    expect(result.dateHint).toMatch(/last\s+week/i);
  });
});

// ── Signature verification ────────────────────────────────────────────────────

function makeSignature(secret: string, timestamp: string, body: string): string {
  const basestring = `v0:${timestamp}:${body}`;
  const hmac = createHmac("sha256", secret).update(basestring).digest("hex");
  return `v0=${hmac}`;
}

describe("verifySlackSignature", () => {
  const secret = "test-signing-secret";
  const body = '{"type":"event_callback"}';
  const timestamp = Math.floor(Date.now() / 1000).toString();

  it("accepts a valid signature", () => {
    const sig = makeSignature(secret, timestamp, body);
    expect(verifySlackSignature(secret, timestamp, body, sig)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = makeSignature(secret, timestamp, body);
    expect(verifySlackSignature(secret, timestamp, '{"type":"tampered"}', sig)).toBe(false);
  });

  it("rejects an expired timestamp (> 5 min old)", () => {
    const oldTimestamp = (Math.floor(Date.now() / 1000) - 400).toString();
    const sig = makeSignature(secret, oldTimestamp, body);
    expect(verifySlackSignature(secret, oldTimestamp, body, sig)).toBe(false);
  });

  it("rejects a future timestamp (> 5 min ahead)", () => {
    const futureTimestamp = (Math.floor(Date.now() / 1000) + 400).toString();
    const sig = makeSignature(secret, futureTimestamp, body);
    expect(verifySlackSignature(secret, futureTimestamp, body, sig)).toBe(false);
  });

  it("rejects wrong secret", () => {
    const sig = makeSignature("wrong-secret", timestamp, body);
    expect(verifySlackSignature(secret, timestamp, body, sig)).toBe(false);
  });
});

// ── Formatters ────────────────────────────────────────────────────────────────

function makeSearchResult(overrides: Partial<HiveSearchResult> = {}): HiveSearchResult {
  return {
    project: "test-project",
    category: "decision",
    snippet: "We decided to use SQLite WAL mode for concurrent reads",
    score: 0.85,
    ...overrides,
  };
}

function makeEntity(overrides: Partial<Entity> = {}): Entity {
  return {
    id: "ent-1",
    entityType: "task",
    namespace: "local",
    content: "Implement the new authentication flow",
    tags: [],
    keywords: [],
    attributes: {},
    source: { system: "local" },
    visibility: "team",
    domain: "code",
    confidence: "confirmed",
    createdAt: "2026-03-20T10:00:00.000Z",
    updatedAt: "2026-03-20T10:00:00.000Z",
    status: "active",
    ...overrides,
  };
}

function isValidBlockKit(blocks: SlackBlock[]): boolean {
  if (!Array.isArray(blocks) || blocks.length === 0) return false;
  return blocks.every((b) => typeof b.type === "string");
}

describe("formatRecallResults", () => {
  it("produces valid Block Kit JSON for 3 results", () => {
    const results = [makeSearchResult(), makeSearchResult({ score: 0.7 }), makeSearchResult({ score: 0.6 })];
    const blocks = formatRecallResults("database migration", results);
    expect(isValidBlockKit(blocks)).toBe(true);
    // header + 3 sections + context
    expect(blocks).toHaveLength(5);
  });

  it("header contains the query", () => {
    const blocks = formatRecallResults("authentication", [makeSearchResult()]);
    const header = blocks[0];
    expect(header.type).toBe("header");
    expect(header.text?.text).toContain("authentication");
  });

  it("context footer shows count", () => {
    const blocks = formatRecallResults("auth", [makeSearchResult()]);
    const last = blocks[blocks.length - 1];
    expect(last.type).toBe("context");
    expect(last.elements?.[0]?.text).toContain("1 memory");
  });

  it("handles empty results gracefully", () => {
    const blocks = formatRecallResults("nothing", []);
    expect(isValidBlockKit(blocks)).toBe(true);
    expect(blocks.some((b) => b.text?.text?.includes("No memories"))).toBe(true);
  });

  it("truncates content exceeding 200 chars", () => {
    const longContent = "A".repeat(300);
    const blocks = formatRecallResults("test", [makeSearchResult({ snippet: longContent })]);
    const section = blocks.find((b) => b.type === "section" && b.text?.text?.includes("A"));
    expect(section).toBeDefined();
    // The visible text block should not exceed some reasonable bound
    expect((section!.text?.text?.length ?? 0)).toBeLessThan(400);
  });

  it("caps at 5 results with footer", () => {
    const results = Array.from({ length: 7 }, (_, i) => makeSearchResult({ score: 1 - i * 0.1 }));
    const blocks = formatRecallResults("test", results);
    const sections = blocks.filter((b) => b.type === "section");
    expect(sections.length).toBeLessThanOrEqual(5);
    const context = blocks.find((b) => b.type === "context");
    expect(context?.elements?.[0]?.text).toContain("7");
  });
});

describe("formatHelp", () => {
  it("includes all available commands", () => {
    const blocks = formatHelp();
    expect(isValidBlockKit(blocks)).toBe(true);
    const text = blocks.map((b) => b.text?.text ?? b.elements?.map((e) => e.text).join("")).join("\n");
    expect(text).toContain("meeting notes");
    expect(text).toContain("who knows");
    expect(text).toContain("action items");
    expect(text).toContain("find");
    expect(text).toContain("help");
  });

  it("mentions Korean support", () => {
    const blocks = formatHelp();
    const text = blocks.map((b) => b.text?.text ?? "").join("\n");
    expect(text).toContain("회의록");
  });
});

describe("formatWhoKnows", () => {
  it("produces valid blocks with author list", () => {
    const authors = [
      { name: "Alice", count: 12, latest: "2026-03-24T00:00:00Z" },
      { name: "Bob", count: 5, latest: "2026-03-20T00:00:00Z" },
    ];
    const blocks = formatWhoKnows("authentication", authors);
    expect(isValidBlockKit(blocks)).toBe(true);
    const section = blocks.find((b) => b.type === "section");
    expect(section?.text?.text).toContain("Alice");
    expect(section?.text?.text).toContain("12");
  });

  it("handles empty author list", () => {
    const blocks = formatWhoKnows("obscure topic", []);
    expect(isValidBlockKit(blocks)).toBe(true);
    expect(blocks.some((b) => b.text?.text?.includes("No contributors"))).toBe(true);
  });
});

describe("formatMeetingNotes", () => {
  it("produces valid blocks for meeting entities", () => {
    const meetings = [
      makeEntity({ entityType: "meeting", title: "Sprint Planning", content: "We planned sprint 42" }),
    ];
    const blocks = formatMeetingNotes("2026-03-20", meetings);
    expect(isValidBlockKit(blocks)).toBe(true);
    const section = blocks.find((b) => b.type === "section" && b.text?.text?.includes("Sprint"));
    expect(section).toBeDefined();
  });

  it("handles no meetings", () => {
    const blocks = formatMeetingNotes("2026-01-01", []);
    expect(isValidBlockKit(blocks)).toBe(true);
    expect(blocks.some((b) => b.text?.text?.includes("No meeting notes"))).toBe(true);
  });
});

describe("formatActionItems", () => {
  it("produces valid blocks for task entities", () => {
    const tasks = [
      makeEntity({ entityType: "task", title: "Fix auth bug", content: "Fix the login flow" }),
      makeEntity({ entityType: "task", title: "Write tests", content: "Add unit tests" }),
    ];
    const blocks = formatActionItems(tasks);
    expect(isValidBlockKit(blocks)).toBe(true);
    const section = blocks.find((b) => b.type === "section");
    expect(section?.text?.text).toContain("Fix auth bug");
  });

  it("handles empty task list", () => {
    const blocks = formatActionItems([]);
    expect(isValidBlockKit(blocks)).toBe(true);
    expect(blocks.some((b) => b.text?.text?.includes("No active action items"))).toBe(true);
  });
});
