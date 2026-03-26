# Design: slack-bot-interactive

## Overview

An interactive Slack bot that handles `app_mention` events, parses user intent via regex, queries hive-memory's existing store methods, and responds with formatted Slack Block Kit messages. Runs inside the existing HTTP server — no separate process.

## Directory / File Layout

```
src/
  bot/
    slack-bot.ts         ← NEW: event handler, request verification, async processing
    intent-parser.ts     ← NEW: regex-based intent classification + query extraction
    slack-formatter.ts   ← NEW: entity results → Slack Block Kit JSON
  index.ts               ← add /slack/events route
  connectors/slack.ts    ← unchanged (read-only sync stays separate)
```

## Event Flow

```
Slack sends POST /slack/events
  → slack-bot.ts: verify signature (SLACK_SIGNING_SECRET)
  → Immediately respond 200 OK (Slack 3-sec ack requirement)
  → Async: extract mention text from event payload
  → intent-parser.ts: classify intent + extract query
  → Call appropriate CortexStore method:
      recall      → store.recallMemories(query)
      who_knows   → db.searchEntities(query) + group by author
      meeting     → db.listEntities({ entityType: "meeting", ...dateFilter })
      action_items → db.listEntities({ entityType: "task", status: "active" })
  → slack-formatter.ts: format results as Block Kit JSON
  → POST chat.postMessage to Slack (in the same channel, threaded to the mention)
```

## Request Verification

```typescript
// src/bot/slack-bot.ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  // Reject requests older than 5 minutes (replay protection)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

  const basestring = `v0:${timestamp}:${body}`;
  const hmac = createHmac("sha256", signingSecret).update(basestring).digest("hex");
  const computed = `v0=${hmac}`;

  return timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
}
```

## Intent Parser Design

```typescript
// src/bot/intent-parser.ts

interface ParsedIntent {
  intent: "recall" | "meeting_notes" | "who_knows" | "action_items";
  query: string;
  dateHint?: string; // extracted date reference like "last Tuesday", "2026-03-20"
}

const INTENT_PATTERNS: Array<{ intent: ParsedIntent["intent"]; pattern: RegExp }> = [
  { intent: "meeting_notes", pattern: /(?:meeting\s*(?:notes?|minutes)|회의\s*록|회의\s*노트)/i },
  { intent: "who_knows",     pattern: /(?:who\s*(?:knows?|is\s*(?:the\s*)?expert)|누가.*(?:알|전문))/i },
  { intent: "action_items",  pattern: /(?:action\s*items?|할\s*일|todo|tasks?|미완료)/i },
  // recall is the default — no pattern needed
];

// Date extraction: simple patterns for "last Monday", "yesterday", "2026-03-20"
const DATE_PATTERNS = [
  /(\d{4}-\d{2}-\d{2})/,                    // ISO date
  /(last\s+(?:monday|tuesday|...))/i,         // relative day
  /(yesterday|today|this\s+week|last\s+week)/i,
];
```

## Slack Block Kit Response Format

### Recall Results

```json
{
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "Memory Recall: database migration" }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*[decision]* Decided to use SQLite WAL mode for concurrent reads\n_2026-03-15 · hive-memory · score: 0.85_"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*[learning]* FTS5 BM25 scoring works better with longer content\n_2026-03-18 · hive-memory · score: 0.72_"
      }
    },
    {
      "type": "context",
      "elements": [
        { "type": "mrkdwn", "text": "Found 2 memories · Searched in 120ms" }
      ]
    }
  ]
}
```

### Who Knows Results

```json
{
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "Who knows about: authentication" }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "1. *Alice* — 12 related memories (latest: 2026-03-24)\n2. *Bob* — 5 related memories (latest: 2026-03-20)"
      }
    }
  ]
}
```

## HTTP Server Integration

In `src/index.ts`, add before the MCP transport handler:

```typescript
if (req.url === "/slack/events" && req.method === "POST") {
  // Read body
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString();

  // Verify signature
  if (!verifySlackSignature(...)) { res.writeHead(401); res.end(); return; }

  // Ack immediately (Slack 3-sec rule)
  res.writeHead(200, { "Content-Type": "application/json" });
  const parsed = JSON.parse(body);

  // URL verification challenge
  if (parsed.type === "url_verification") {
    res.end(JSON.stringify({ challenge: parsed.challenge }));
    return;
  }
  res.end("ok");

  // Process async
  handleSlackEvent(parsed, store).catch(console.error);
  return;
}
```

## Environment Variables

```bash
SLACK_SIGNING_SECRET=abc123...     # Slack app signing secret (required for bot)
SLACK_BOT_ENABLED=true             # Opt-in flag (default: false)
# SLACK_TOKEN already exists — used for both sync and bot responses (chat.postMessage)
```

## Key Design Decisions

1. **Regex, not LLM** — 4 fixed intents with clear patterns. Regex is instant, free, and deterministic. Add LLM fallback in v2 only if unmatched query rate is high.
2. **Same process as MCP server** — no separate bot process. The HTTP server handles both MCP and Slack routes.
3. **Separate from SlackConnector** — the bot (`src/bot/`) is conceptually different from the read-only connector (`src/connectors/slack.ts`). Different concerns, different files.
4. **Thread replies** — bot always responds in a thread (sets `thread_ts` to the mention's `ts`). Keeps channels clean.
5. **Korean + English** — intent patterns support both languages (matches existing `DECISION_PATTERNS` in `src/connectors/slack.ts` lines 61-68).
