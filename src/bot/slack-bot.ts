/**
 * Bumble Bee — Slack bot event handler for hive-memory.
 *
 * Handles app_mention events from the Slack Events API.
 * Verifies request signatures, parses intent, queries the store,
 * and posts threaded replies using Block Kit.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { CortexStore } from "../store.js";
import { parseIntent, stripMention } from "./intent-parser.js";
import {
  formatRecallResults,
  formatWhoKnows,
  formatMeetingNotes,
  formatActionItems,
  formatHelp,
  type SlackBlock,
} from "./slack-formatter.js";
import type { Entity } from "../types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SlackEventPayload {
  type: string;
  challenge?: string;
  event?: {
    type: string;
    text?: string;
    user?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    bot_id?: string;
    subtype?: string;
  };
}

interface PostMessageOptions {
  channel: string;
  blocks: SlackBlock[];
  threadTs?: string;
}

// ── Signature verification ────────────────────────────────────────────────────

/**
 * Verify an incoming Slack request signature.
 * Rejects requests with a timestamp older than 5 minutes (replay protection).
 */
export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

  const basestring = `v0:${timestamp}:${body}`;
  const hmac = createHmac("sha256", signingSecret).update(basestring).digest("hex");
  const computed = `v0=${hmac}`;

  try {
    return timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ── Post message ──────────────────────────────────────────────────────────────

async function postMessage(token: string, options: PostMessageOptions): Promise<void> {
  const { channel, blocks, threadTs } = options;

  const body: Record<string, unknown> = { channel, blocks };
  if (threadTs) body.thread_ts = threadTs;

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After") ?? "10";
    await new Promise((resolve) => setTimeout(resolve, parseInt(retryAfter, 10) * 1000));
    return postMessage(token, options);
  }

  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(`[bumble-bee] chat.postMessage error: ${data.error ?? "unknown"}`);
  }
}

// ── Query execution ───────────────────────────────────────────────────────────

async function executeRecall(store: CortexStore, query: string): Promise<SlackBlock[]> {
  const results = await store.recallMemories(query, undefined, 5);
  return formatRecallResults(query, results);
}

function executeWhoKnows(store: CortexStore, topic: string): SlackBlock[] {
  const db = store.database;
  const entities = db.searchEntities(topic, { limit: 50 });

  // Group by author, count, track latest
  const byAuthor = new Map<string, { count: number; latest: string }>();
  for (const entity of entities) {
    if (entity.visibility === "personal") continue;
    if (!entity.author) continue;
    const existing = byAuthor.get(entity.author);
    if (existing) {
      existing.count += 1;
      if (entity.updatedAt > existing.latest) existing.latest = entity.updatedAt;
    } else {
      byAuthor.set(entity.author, { count: 1, latest: entity.updatedAt });
    }
  }

  const authors = [...byAuthor.entries()]
    .map(([name, { count, latest }]) => ({ name, count, latest }))
    .sort((a, b) => b.count - a.count);

  return formatWhoKnows(topic, authors);
}

function executeMeetingNotes(store: CortexStore, dateHint?: string): SlackBlock[] {
  const db = store.database;
  const options: Parameters<typeof db.listEntities>[0] = {
    entityType: "meeting",
    status: "active",
    limit: 10,
  };

  if (dateHint) {
    // If it's an ISO date, use it as the date filter range (full day)
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateHint)) {
      options.since = `${dateHint}T00:00:00.000Z`;
      options.until = `${dateHint}T23:59:59.999Z`;
    }
    // Relative hints (yesterday, today, last week) — best effort approximation
    else if (/yesterday/i.test(dateHint)) {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      const iso = d.toISOString().slice(0, 10);
      options.since = `${iso}T00:00:00.000Z`;
      options.until = `${iso}T23:59:59.999Z`;
    } else if (/today/i.test(dateHint)) {
      const iso = new Date().toISOString().slice(0, 10);
      options.since = `${iso}T00:00:00.000Z`;
    } else if (/last\s+week/i.test(dateHint)) {
      const d = new Date();
      d.setDate(d.getDate() - 7);
      options.since = d.toISOString();
    } else if (/this\s+week/i.test(dateHint)) {
      const d = new Date();
      const day = d.getDay();
      d.setDate(d.getDate() - day);
      options.since = `${d.toISOString().slice(0, 10)}T00:00:00.000Z`;
    }
  }

  const meetings: Entity[] = db.listEntities(options).filter(
    (e) => e.visibility !== "personal",
  );

  return formatMeetingNotes(dateHint, meetings);
}

function executeActionItems(store: CortexStore): SlackBlock[] {
  const db = store.database;
  const items: Entity[] = db
    .listEntities({ entityType: "task", status: "active", limit: 20 })
    .filter((e) => e.visibility !== "personal");

  return formatActionItems(items);
}

async function executeBriefing(store: CortexStore, query: string, person?: string): Promise<SlackBlock[]> {
  const db = store.database;
  const blocks: SlackBlock[] = [];

  if (person) {
    // Search for a specific person's activity
    const results = await store.recallMemories(person, undefined, 10);
    if (results.length > 0) {
      blocks.push({ type: "header", text: { type: "plain_text", text: `Activity: ${person}` } });
      for (const r of results.slice(0, 5)) {
        const label = r.source ? `[${r.project}/${r.source}]` : `[${r.project}/${r.category ?? ""}]`;
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: `*${label}*\n${r.snippet.slice(0, 200)}` },
        });
      }
    } else {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: `No activity found for "${person}"` } });
    }
  } else {
    // General briefing
    const { MemorySteward } = await import("../steward/index.js");
    const steward = new MemorySteward(db);
    const report = steward.briefing("daily");

    blocks.push({ type: "header", text: { type: "plain_text", text: "Daily Briefing" } });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*New entities:* ${report.newEntities}`,
          `*Decisions:* ${report.newDecisions.length}`,
          `*Pending actions:* ${report.pendingActions.length}`,
        ].join("  |  "),
      },
    });

    if (report.newDecisions.length > 0) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: "*Recent Decisions:*" } });
      for (const d of report.newDecisions.slice(0, 5)) {
        blocks.push({ type: "section", text: { type: "mrkdwn", text: `• ${d.title.slice(0, 150)}` } });
      }
    }

    if (report.pendingActions.length > 0) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: "*Pending Actions:*" } });
      for (const a of report.pendingActions.slice(0, 5)) {
        blocks.push({ type: "section", text: { type: "mrkdwn", text: `☐ ${a.title.slice(0, 120)} — _${a.owner}_` } });
      }
    }
  }

  if (blocks.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "No recent activity found." } });
  }

  return blocks;
}

// ── Event handler ─────────────────────────────────────────────────────────────

/**
 * Process a Slack event payload asynchronously.
 * Only handles app_mention events. Ignores bots and edits.
 */
export async function handleSlackEvent(
  payload: SlackEventPayload,
  store: CortexStore,
  token: string,
): Promise<void> {
  const event = payload.event;

  // Only handle app_mention events
  if (!event || event.type !== "app_mention") return;

  // Ignore bot messages and edits
  if (event.bot_id || event.subtype) return;

  const text = event.text ?? "";
  const channel = event.channel;
  const ts = event.ts;

  if (!channel || !ts) return;

  // Reply in thread: if the mention was itself in a thread, use that thread's ts;
  // otherwise start a new thread anchored to the mention's ts.
  const threadTs = event.thread_ts ?? ts;

  let blocks: SlackBlock[];

  try {
    const cleanText = stripMention(text);

    // Help shortcut
    if (/^\s*help\s*$/i.test(cleanText) || /^\s*도움\s*$/i.test(cleanText)) {
      blocks = formatHelp();
    } else {
      const intent = await parseIntent(text);

      switch (intent.intent) {
        case "recall":
          blocks = await executeRecall(store, intent.query || cleanText);
          break;
        case "meeting_notes":
          blocks = executeMeetingNotes(store, intent.dateHint);
          break;
        case "who_knows":
          blocks = executeWhoKnows(store, intent.query || cleanText);
          break;
        case "action_items":
          blocks = executeActionItems(store);
          break;
        case "briefing":
        case "summarize":
          blocks = await executeBriefing(store, intent.query, intent.person);
          break;
        default:
          blocks = formatHelp();
      }
    }
  } catch (err) {
    console.error("[bumble-bee] Error processing event:", err);
    blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Sorry, I encountered an error. Please try again.",
        },
      },
    ];
  }

  try {
    await postMessage(token, { channel, blocks, threadTs });
  } catch (err) {
    console.error("[bumble-bee] Error posting message:", err);
  }
}
