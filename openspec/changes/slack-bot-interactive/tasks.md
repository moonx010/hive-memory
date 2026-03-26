# Tasks: slack-bot-interactive

**Phase:** B (after multi-user-access)
**Estimated effort:** 1 week
**Dependencies:** multi-user-access (recommended, not blocking)

## Day 1-2: Event Handler + Signature Verification

- [ ] **TASK-BOT-01**: Create `src/bot/slack-bot.ts` — core event handler
  - Export `handleSlackEvent(event, store)` async function
  - Parse `app_mention` events from Slack Events API payload
  - Extract mention text (strip `<@BOT_ID>` prefix)
  - Handle `url_verification` challenge type (return `challenge` value)
  - Ignore non-`app_mention` events, bot messages, and message edits
  - Skeleton: parse event → call intent parser → call store → call formatter → post response

- [ ] **TASK-BOT-02**: Implement request signature verification
  - In `src/bot/slack-bot.ts`: `verifySlackSignature(signingSecret, timestamp, body, signature)`
  - Use `node:crypto` `createHmac("sha256", signingSecret)` on `v0:${timestamp}:${body}`
  - Compare with `timingSafeEqual` against the `X-Slack-Signature` header
  - Reject requests with timestamp older than 5 minutes (replay protection)
  - Test: valid signature → pass; tampered body → fail; old timestamp → fail

- [ ] **TASK-BOT-03**: Add `/slack/events` route to `src/index.ts`
  - Add route before the MCP transport handler (after auth check, around line 131)
  - Gate behind `SLACK_BOT_ENABLED=true` env var — skip route registration if not set
  - Immediately respond 200 OK (Slack 3-sec ack requirement)
  - Process event asynchronously via `handleSlackEvent(parsed, store).catch(console.error)`
  - URL verification: respond with `{ challenge }` synchronously
  - Test: POST to `/slack/events` with valid signature → 200; invalid → 401

## Day 3: Intent Parser

- [ ] **TASK-BOT-04**: Create `src/bot/intent-parser.ts`
  - Export `parseIntent(text: string): ParsedIntent`
  - `ParsedIntent = { intent: "recall" | "meeting_notes" | "who_knows" | "action_items"; query: string; dateHint?: string }`
  - Intent patterns (checked in order, first match wins):
    - `meeting_notes`: `/meeting\s*(?:notes?|minutes|록)|회의\s*(?:록|노트)/i`
    - `who_knows`: `/who\s*(?:knows?|is\s*(?:the\s*)?expert)|누가.*(?:알|전문)/i`
    - `action_items`: `/action\s*items?|할\s*일|todo|tasks?|미완료/i`
    - `recall`: default (everything else)
  - Query extraction: strip bot mention, strip matched intent keywords, trim
  - Date extraction: match `(\d{4}-\d{2}-\d{2})`, `yesterday`, `today`, `last\s+week` etc.
  - Test: "what did we decide about auth?" → `{ intent: "recall", query: "auth" }`
  - Test: "meeting notes from 2026-03-20" → `{ intent: "meeting_notes", dateHint: "2026-03-20" }`
  - Test: "who knows about sqlite?" → `{ intent: "who_knows", query: "sqlite" }`
  - Test: "action items" → `{ intent: "action_items", query: "" }`

## Day 4: Store Queries + Response Formatting

- [ ] **TASK-BOT-05**: Implement query execution in `src/bot/slack-bot.ts`
  - Map intents to store/db calls:
    - `recall` → `store.recallMemories(query, undefined, 5)` (reuse existing `memory_recall` logic)
    - `who_knows` → `db.searchEntities(query)` + group results by `author`, count, sort desc
    - `meeting_notes` → `db.listEntities({ entityType: "meeting" })` filtered by dateHint
    - `action_items` → `db.listEntities({ entityType: "task", status: "active" })`
  - Filter out entities with `visibility: "personal"` (safety: don't expose private memories in Slack)
  - Return structured results for the formatter

- [ ] **TASK-BOT-06**: Create `src/bot/slack-formatter.ts`
  - Export `formatRecallResults(query, results): SlackBlocks`
  - Export `formatWhoKnows(topic, authors): SlackBlocks`
  - Export `formatMeetingNotes(date, meetings): SlackBlocks`
  - Export `formatActionItems(items): SlackBlocks`
  - Export `formatNoResults(query): SlackBlocks`
  - Each formatter returns Slack Block Kit JSON (header + sections + context)
  - Truncate entity content to 200 chars per result
  - Max 5 results per response (add "N more results" footer if truncated)
  - Use `mrkdwn` text type for formatting (bold, italic, links)
  - Test: format 3 recall results → valid Block Kit JSON with 3 sections + 1 context

## Day 5: Response Posting + Error Handling

- [ ] **TASK-BOT-07**: Implement Slack response posting
  - Use `fetch` to POST to `https://slack.com/api/chat.postMessage`
  - Set `channel` to the event's channel, `thread_ts` to the event's `ts` (always reply in thread)
  - Use existing `SLACK_TOKEN` (must have `chat:write` scope)
  - Handle rate limiting (429 + Retry-After), same pattern as `slackFetch` in `src/connectors/slack.ts` line 117
  - On error: post a simple text message "Sorry, I encountered an error. Please try again."
  - Log all errors to stderr with `[bumble-bee]` prefix

- [ ] **TASK-BOT-08**: End-to-end testing
  - Create `tests/slack-bot.test.ts`
  - Test intent parser with 10+ input variations (English + Korean)
  - Test formatter output is valid Block Kit JSON
  - Test signature verification (valid, invalid, expired)
  - Mock Slack API calls for response posting
  - Test visibility filter: personal entities never appear in bot responses

- [ ] **TASK-BOT-09**: Update `deploy/.env.example`
  - Add `SLACK_SIGNING_SECRET=...` with comment
  - Add `SLACK_BOT_ENABLED=true` with comment
  - Add note about required Slack app scopes: `app_mentions:read`, `chat:write`
  - Document Slack Events API subscription URL: `https://<host>/slack/events`
