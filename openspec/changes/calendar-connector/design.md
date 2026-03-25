# Design: calendar-connector

## Overview

A single file, `src/connectors/calendar.ts`, implements the `ConnectorPlugin` interface. It uses two internal helper classes — `GoogleAuth` and `CalendarAPI` — to isolate authentication and HTTP concerns from entity mapping logic. All HTTP is Node.js built-in `fetch`. JWT signing for service account auth uses `node:crypto`.

## Directory / File Layout

```
src/connectors/
  calendar.ts          ← new file (all logic)
  types.ts             ← unchanged
  github.ts            ← reference pattern
src/store.ts           ← add CalendarConnector registration
```

## Authentication Design

### Mode 1: Service Account (Preferred)

1. Read service account JSON from `GOOGLE_CALENDAR_CREDENTIALS` path:
   ```json
   { "type": "service_account", "client_email": "...", "private_key": "-----BEGIN RSA..." }
   ```
2. Build JWT header + payload:
   ```typescript
   const header = { alg: "RS256", typ: "JWT" };
   const now = Math.floor(Date.now() / 1000);
   const payload = {
     iss: serviceAccount.client_email,
     scope: "https://www.googleapis.com/auth/calendar.readonly",
     aud: "https://oauth2.googleapis.com/token",
     iat: now,
     exp: now + 3600,
   };
   ```
3. Sign using `node:crypto` `createSign("RSA-SHA256")`.
4. POST to `https://oauth2.googleapis.com/token` with `grant_type=urn:ietf:params:oauth2:grant_type:jwt-bearer`.
5. Cache access token with `expiresAt = Date.now() + (expires_in - 60) * 1000`.

### Mode 2: OAuth2 Token JSON

1. Read token JSON from `GOOGLE_CALENDAR_TOKEN` path:
   ```json
   { "access_token": "ya29...", "refresh_token": "1//...", "expires_in": 3599, "token_type": "Bearer" }
   ```
2. If `expires_at` < now, refresh: POST to `https://oauth2.googleapis.com/token` with `grant_type=refresh_token`.
3. Write updated token back to file (overwrite) to persist refreshed token.

### Auth Helper Class

```typescript
class GoogleAuth {
  private accessToken: string | null = null;
  private expiresAt = 0;

  constructor(
    private credentialsPath: string,
    private tokenPath?: string
  ) {}

  async getAccessToken(): Promise<string>;
  private async refreshServiceAccountToken(): Promise<void>;
  private async refreshOAuth2Token(): Promise<void>;
}
```

## Google Calendar API v3 Endpoints

| Operation | Endpoint | Key Parameters |
|-----------|----------|----------------|
| List events | `GET https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events` | `timeMin`, `updatedMin`, `pageToken`, `maxResults=250`, `singleEvents=true`, `orderBy=updated` |
| List calendars | `GET https://www.googleapis.com/calendar/v3/users/me/calendarList` | `pageToken` |

All requests include `Authorization: Bearer {accessToken}` header.

## Retry / Rate-Limit Helper

Identical to `github.ts` pattern:

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 5
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt === maxAttempts - 1) throw err;
      const delay = Math.min(1000 * 2 ** attempt, 32000);
      const jitter = delay * 0.2 * (Math.random() - 0.5);
      await sleep(delay + jitter);
    }
  }
  throw new Error("unreachable");
}

function isRetryable(err: unknown): boolean {
  return err instanceof CalendarApiError && (err.status === 429 || err.status === 403);
}
```

## CalendarConnector Class

```typescript
export class CalendarConnector implements ConnectorPlugin {
  readonly id = "google-calendar";
  readonly name = "Google Calendar";
  readonly description = "Syncs calendar events as meeting and event entities";
  readonly entityTypes = ["event", "meeting", "person"];
  readonly domains = ["meetings"];

  private auth: GoogleAuth;

  constructor() {
    const credPath = process.env.GOOGLE_CALENDAR_CREDENTIALS ?? "";
    const tokenPath = process.env.GOOGLE_CALENDAR_TOKEN;
    this.auth = new GoogleAuth(credPath, tokenPath);
  }

  isConfigured(): boolean {
    const credPath = process.env.GOOGLE_CALENDAR_CREDENTIALS;
    if (!credPath) return false;
    try {
      accessSync(credPath, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async *fullSync(): AsyncGenerator<RawDocument> {
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    yield* this.fetchEvents({ timeMin: since });
  }

  async *incrementalSync(cursor?: string): AsyncGenerator<RawDocument> {
    yield* this.fetchEvents({ updatedMin: cursor });
  }

  private async *fetchEvents(params: EventListParams): AsyncGenerator<RawDocument> { ... }

  transform(doc: RawDocument): EntityDraft[] { ... }

  getCursor(): string | undefined { ... }
}
```

## Entity Mapping Table

| Google Calendar Field | Hive Entity Field | Notes |
|----------------------|-------------------|-------|
| `event.id` | `source.externalId` = `"gcal:event:{calId}:{eventId}"` | |
| `event.summary` | `title` | Fallback: `"(No title)"` |
| `event.description` | Included in `content` | Stripped HTML tags |
| `event.start.dateTime` | `attributes.startTime` | ISO8601 |
| `event.end.dateTime` | `attributes.endTime` | ISO8601 |
| `event.location` | `attributes.location` | |
| `event.recurringEventId` | `attributes.recurringEventId` | |
| `event.status` | `attributes.status` + entity `status` | `"cancelled"` → `status: "archived"` |
| `event.organizer` | `author` + `attributes.organizer` | |
| `event.attendees` | `attributes.attendees` + separate `person` entities | |
| `event.conferenceData.entryPoints[0].uri` | `attributes.conferenceUrl` | |
| `event.attachments` | `attributes.attachments` | |

## Promotion Logic

```typescript
function shouldPromoteToMeeting(event: CalendarEvent): boolean {
  const attendeeCount = (event.attendees ?? []).length;
  const hasConference = event.conferenceData != null;
  return attendeeCount >= 3 || hasConference;
}

function getMeetingType(attendeeCount: number): "one-on-one" | "small-group" | "large-meeting" {
  if (attendeeCount <= 2) return "one-on-one";
  if (attendeeCount <= 8) return "small-group";
  return "large-meeting";
}
```

## Synapse Creation

After `transform()` returns all `EntityDraft[]`, the connector emits both entity drafts and synapse drafts. Synapse creation happens in `CortexStore` after entity upsert resolves entity IDs.

Two synapse types:

**1. attended (person → meeting)**
```typescript
// After upserting entities, look up person and meeting IDs by source_external_id
for (const attendee of meetingEntity.attributes.attendees) {
  if (attendee.responseStatus === "declined") continue;
  const personId = db.getByExternalId(`gcal:person:${attendee.email}`)?.id;
  const meetingId = meetingEntity.id;
  if (personId) db.upsertSynapse({ sourceId: personId, targetId: meetingId, axon: "attended", weight: 1.0 });
}
```

**2. temporal (meeting → meeting for recurring series)**
```typescript
// Group meeting entities by recurringEventId, sort by startTime, link in order
for (let i = 0; i < seriesInstances.length - 1; i++) {
  db.upsertSynapse({
    sourceId: seriesInstances[i].id,
    targetId: seriesInstances[i + 1].id,
    axon: "temporal",
    weight: 0.8,
  });
}
```

## Registration in store.ts

```typescript
// In CortexStore constructor, after existing connector registrations:
import { CalendarConnector } from "./connectors/calendar.js";

if (process.env.GOOGLE_CALENDAR_CREDENTIALS) {
  this.connectorRegistry.register(new CalendarConnector());
}
```

## Error Handling Strategy

| Error Condition | Behavior |
|-----------------|----------|
| Missing credentials file | `isConfigured()` returns `false`; sync never starts |
| Auth failure (401 on token exchange) | Throw `Error("CalendarConnector: auth failed — {statusText}")` |
| Rate limit (429/403) | Exponential backoff, up to 5 retries |
| Individual event parse error | Log warning, continue to next event |
| Cancelled event | Set `status: "archived"` on existing entity, no new entity |
| Network timeout | Bubble up as-is (caller handles) |

## Test Strategy

**Unit tests** (mock `fetch` globally):
- `isConfigured()` returns `false` when env var missing.
- `fullSync()` paginates correctly (mock two pages of events).
- `transform()` correctly produces `event` vs `meeting` entity based on attendee count.
- `transform()` produces correct `person` entities and deduplicates by email.
- Cancelled event produces entity with `status: "archived"`.
- Service account JWT signing produces valid JWT structure.
- Auth helper caches token and does not re-request before expiry.

**Integration test** (manual, requires real credentials):
- `hive-memory sync google-calendar` produces entities in SQLite for a real calendar.
- Second sync (incremental) does not duplicate entities.
