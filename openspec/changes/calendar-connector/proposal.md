# Change: calendar-connector

**Layer:** 1 (Hive-Memory)
**One-liner:** Google Calendar connector that syncs events into the entity graph as `event` and `meeting` entities.
**Estimated effort:** 2 weeks
**Dependencies:** None (uses existing ConnectorPlugin interface)

## Why

Calendar is the single most reliable source of "who met whom, when, about what." Without it:
- Meeting Agent (Layer 3) has no scheduling context — it cannot correlate a transcript with the actual calendar event.
- Person entities from Slack/GitHub lack temporal interaction data — we know people exist but not when they collaborate.
- The `event` and `meeting` EntityTypes defined in `src/types.ts` are declared but no connector produces them.

Calendar data is the backbone for the Context Engine's topic stitching and the Meeting Agent's pre-brief generation.

## What Changes

### In Scope

1. **New file: `src/connectors/calendar.ts`** — implements `ConnectorPlugin` interface.
   - `fullSync()`: fetches events from last 90 days across configured calendars.
   - `incrementalSync(cursor)`: fetches events updated since cursor (uses `updatedMin` parameter).
   - `transform(doc)`: produces `event` entities for all events, promotes to `meeting` entity when `conferenceData` or 3+ attendees present.
   - Rate-limit handling matching the pattern in `github.ts` (exponential backoff on 429).

2. **Environment variables:**
   - `GOOGLE_CALENDAR_CREDENTIALS` — path to service account JSON or OAuth2 credentials JSON file.
   - `GOOGLE_CALENDAR_TOKEN` — path to OAuth2 token JSON file (for OAuth2 flow, optional if service account).
   - `GOOGLE_CALENDAR_IDS` — comma-separated calendar IDs (default: `"primary"`).

3. **Entity production:**

   **`event` entity:**
   ```
   entityType: "event"
   title: event.summary
   content: "{summary}\n\nDescription: {description}\nLocation: {location}"
   domain: "meetings"
   tags: ["calendar", "event", calendar-id]
   attributes: {
     calendarId: string,
     eventId: string,
     startTime: ISO8601,
     endTime: ISO8601,
     duration: minutes (number),
     location: string | null,
     isRecurring: boolean,
     recurringEventId: string | null,
     status: "confirmed" | "tentative" | "cancelled",
     organizer: { email, displayName },
     attendees: [{ email, displayName, responseStatus }],
     conferenceUrl: string | null,
     attachments: [{ title, url }]
   }
   source: { system: "google-calendar", externalId: "gcal:event:{calendarId}:{eventId}", connector: "google-calendar" }
   author: organizer.email
   confidence: "confirmed"
   ```

   **`meeting` entity (promoted from event):**
   ```
   entityType: "meeting"
   title: event.summary
   content: "{summary}\n\nAttendees: {attendee list}\nAgenda: {description}"
   domain: "meetings"
   tags: ["calendar", "meeting", calendar-id]
   attributes: {
     ...all event attributes,
     attendeeCount: number,
     hasConference: boolean,
     meetingType: "one-on-one" | "small-group" | "large-meeting" (based on attendee count)
   }
   ```

   **`person` entity (per unique attendee):**
   ```
   entityType: "person"
   title: attendee.displayName || attendee.email
   content: "Calendar attendee {displayName} ({email})"
   source: { system: "google-calendar", externalId: "gcal:person:{email}", connector: "google-calendar" }
   attributes: { email, displayName, lastSeenAt }
   confidence: "inferred"
   ```

4. **Synapse auto-creation:** After entity insertion, create synapses:
   - `person --attended--> meeting` (axon: `"attended"`)
   - `meeting --temporal--> meeting` (for recurring events in the same series)

5. **Registration in `src/store.ts`:** Add `CalendarConnector` to the connector registry alongside GitHub/Slack/Notion in the `CortexStore` constructor.

6. **CLI support:** `hive-memory sync google-calendar` works via existing `connector_sync` tool and CLI route.

### Out of Scope

- **OAuth2 browser flow deferred** — manual token input is Plan A. User must generate and provide token JSON file out-of-band. OAuth2 refresh flow may be added in a follow-up if token expiry becomes a friction point.
- Calendar write-back (creating/updating events).
- Real-time push notifications (Google Calendar webhooks) — sync is pull-based only.
- iCal/CalDAV support — Google Calendar API only.
- `googleapis` npm SDK — all HTTP via Node.js built-in `fetch`.

## Devil's Advocate Review

**Risk: Token expiry breaks incremental sync silently.**
Mitigation: Auth helper detects expired access token from 401 response and retries with refresh flow (for OAuth2) or re-signs JWT (for service account). Auth errors surface as connector errors, not silent failures.

**Risk: 2-week budget is tight for auth + pagination + entity mapping.**
Mitigation: Service account auth is the happy path (no browser flow needed). OAuth2 refresh is a 20-line helper. Pagination is a while loop. Entity mapping can be written and tested incrementally. Week 1: auth + fullSync + tests. Week 2: incrementalSync + synapse creation + integration test.

**Risk: Attendee dedup conflicts with entity-resolution change.**
Mitigation: Layer 1 dedup is purely by `source_external_id` (`gcal:person:{email}`). Cross-source dedup (matching gcal:person:alice@co.com with github:user:alice) is handled by entity-resolution (Layer 1+2) as a separate concern.

## Acceptance Criteria

1. `hive-memory sync google-calendar` successfully syncs events from a configured Google Calendar and produces `event`, `meeting`, and `person` entities in the SQLite database.
2. `connector_status` MCP tool shows `google-calendar` with correct last-sync time and entity count.
3. Incremental sync (second run) only fetches events updated since the last cursor, and upserts (not duplicates) existing entities by `source_external_id`.
4. Events with 3+ attendees or `conferenceData` are stored as `meeting` entityType; solo/two-person events without conferenceData are stored as `event` entityType.
5. `person` entities are created for each unique attendee email, with `externalId: "gcal:person:{email}"` enabling future cross-source dedup.
6. Cancelled events update the entity `status` to `"archived"` rather than creating a duplicate.

## Impact

- **New file:** `src/connectors/calendar.ts` (~350 lines, following `github.ts` pattern)
- **Modified:** `src/store.ts` — add `CalendarConnector` to registry (2 lines)
- **No new npm dependencies** — uses Node.js built-in `fetch` + `node:crypto` for JWT signing
- **No schema changes** — uses existing `entities`, `synapses`, `connectors` tables
- **No new MCP tools** — uses existing `connector_sync` and `connector_status`
