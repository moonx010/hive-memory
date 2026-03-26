# Change: slack-bot-interactive

**Layer:** 1 (Hive-Memory)
**One-liner:** Interactive Slack bot that responds to `@bumble bee` mentions by querying hive-memory and returning formatted results.
**Estimated effort:** 1 week
**Dependencies:** multi-user-access (recommended, not blocking)

## Why

The current `SlackConnector` in `src/connectors/slack.ts` is read-only — it ingests messages from Slack into hive-memory but provides no way to query from Slack. Team members must use Claude Code or the CLI to search memories.

Slack is where teams live. An interactive bot that answers "@bumble bee what did we decide about X?" makes hive-memory accessible to everyone, including non-engineers who don't use AI coding tools.

## What Changes

### In Scope

1. **New file: `src/bot/slack-bot.ts`** — Slack Events API handler.
   - Receives `app_mention` events via HTTP POST to `/slack/events`.
   - Verifies request signature using `SLACK_SIGNING_SECRET`.
   - Handles Slack URL verification challenge (initial setup).
   - Parses mention text, determines intent, calls the appropriate store method, formats and posts response.

2. **New file: `src/bot/intent-parser.ts`** — regex-based intent classification.
   - 4 intents: `recall` (default), `meeting_notes`, `who_knows`, `action_items`.
   - Pattern matching:
     - `meeting_notes`: `/meeting\s*(notes?|minutes)|회의\s*록/i`
     - `who_knows`: `/who\s*(knows?|is\s*expert)|누가.*알/i`
     - `action_items`: `/action\s*items?|할\s*일|todo/i`
     - `recall`: everything else (default fallback)
   - Extracts query text by stripping the bot mention and intent keywords.

3. **New file: `src/bot/slack-formatter.ts`** — Slack Block Kit response formatter.
   - Converts entity search results into Slack blocks (section + context blocks).
   - Truncates content to fit Slack's 3000-char block limit.
   - Adds metadata footer (source, date, entity type).

4. **HTTP server integration in `src/index.ts`:**
   - Add `/slack/events` route to the existing HTTP server.
   - Immediately respond with 200 (Slack requires ack within 3 seconds).
   - Process the event asynchronously after acknowledgement.

5. **New environment variables:**
   - `SLACK_SIGNING_SECRET` — for request verification.
   - `SLACK_BOT_ENABLED=true` — opt-in flag to enable the bot routes.

### Out of Scope

- LLM-based intent parsing (regex handles 4 fixed intents; add LLM in v2 if needed)
- Slash commands (`/bumble recall X`)
- Threaded follow-up conversations
- Proactive notifications
- Home tab or DM support
- Storing bot interactions back into memory

## How to Verify

1. Set up a Slack app with `app_mentions:read`, `chat:write` scopes and Events API subscription.
2. `@bumble bee what did we decide about database migration?` → bot responds with relevant decision entities.
3. `@bumble bee who knows about authentication?` → bot responds with ranked authors from `memory_who`.
4. `@bumble bee meeting notes from 2026-03-20` → bot responds with meeting entities from that date range.
5. `@bumble bee action items` → bot lists entities with `entity_type: task` and `status: active`.
6. Invalid/empty queries return a helpful "I didn't find anything" message, not an error.
7. Request signature verification rejects tampered requests with 401.

## Risks

| Risk | Mitigation |
|------|------------|
| Slack 3-second ack timeout | Immediately respond 200, process async, post result via `chat.postMessage` |
| Regex misses natural language variations | Log unmatched queries; add LLM fallback in v2 |
| Response too long for Slack blocks | Truncate to top 5 results, add "X more results" footer |
| Public URL required for Events API | Document ngrok setup for dev; production uses deployed server |
| Bot token scopes differ from read-only connector | Document required scopes; may need a separate Slack app |
