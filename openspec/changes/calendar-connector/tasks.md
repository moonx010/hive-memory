# Tasks: calendar-connector

**Phase:** A (parallel with enrichment-framework)
**Estimated effort:** 2 weeks
**Dependencies:** None

## Week 1: Auth + Full Sync + Core Entity Mapping

- [ ] **TASK-CAL-01**: Create `src/connectors/calendar.ts` skeleton
  - Define `CalendarConnector` class implementing `ConnectorPlugin` from `src/connectors/types.ts`
  - Stub all interface methods with `throw new Error("not implemented")`
  - Add `readonly id = "google-calendar"`, `name`, `description`, `entityTypes`, `domains` fields
  - Export the class

- [ ] **TASK-CAL-02**: Implement `GoogleAuth` helper class (service account path)
  - Read service account JSON from file path (use `readFileSync`)
  - Build JWT header/payload (iss, scope, aud, iat, exp)
  - Sign JWT using `node:crypto` `createSign("RSA-SHA256")` with service account `private_key`
  - POST to `https://oauth2.googleapis.com/token` using `fetch` to exchange JWT for access token
  - Cache token in memory with `expiresAt` timestamp (expire 60s early)
  - Expose `getAccessToken(): Promise<string>` that returns cached or refreshes

- [ ] **TASK-CAL-03**: Implement `GoogleAuth` OAuth2 token path
  - Read token JSON from `GOOGLE_CALENDAR_TOKEN` file path
  - Check `expires_at` field (or compute from `expires_in` + file mtime)
  - If expired, POST refresh to `https://oauth2.googleapis.com/token` with `grant_type=refresh_token`
  - Write updated token back to file (overwrite)
  - `getAccessToken()` dispatches to service account or OAuth2 based on `credentials.type` field

- [ ] **TASK-CAL-04**: Implement `isConfigured()` method
  - Check `GOOGLE_CALENDAR_CREDENTIALS` env var is set
  - Check file at path is readable via `fs.accessSync(path, fs.constants.R_OK)`
  - Return `false` if either check fails, `true` otherwise
  - Add test: `isConfigured()` returns `false` when env var is unset

- [ ] **TASK-CAL-05**: Implement `CalendarAPI` helper (fetch wrapper)
  - `listEvents(calendarId, params)`: GET `https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events`
  - Params: `timeMin`, `updatedMin`, `pageToken`, `maxResults=250`, `singleEvents=true`, `orderBy=updated`
  - Include `Authorization: Bearer {token}` header
  - Throw `CalendarApiError` (with `.status` field) on non-200 responses
  - Implement `withRetry` helper: exponential backoff on 429/403, max 5 attempts, initial 1s, max 32s, jitter ±20%

- [ ] **TASK-CAL-06**: Implement `fullSync()` async generator
  - Resolve calendar IDs from `GOOGLE_CALENDAR_IDS` env var (split on `,`, trim, default `["primary"]`)
  - For each calendar ID, call `fetchEvents({ timeMin: now - 90 days })` with pagination loop
  - Pagination: loop while `nextPageToken` is returned, pass as `pageToken` on next request
  - Yield each `RawDocument` with `metadata: { calendarId, rawEvent: event }`

- [ ] **TASK-CAL-07**: Implement `transform()` entity mapping
  - Map `event.summary` → `title` (fallback: `"(No title)"`)
  - Strip HTML from `event.description` (simple regex-based stripper, no DOM dependency)
  - Compute `duration` in minutes from `startTime` / `endTime`
  - Apply promotion logic: if `attendees.length >= 3` OR `conferenceData != null` → `entityType: "meeting"`, else `"event"`
  - Set `meetingType` on meeting entities: 2→`"one-on-one"`, 3-8→`"small-group"`, 9+→`"large-meeting"`
  - Produce `person` EntityDraft for each attendee (deduplicate by email within the batch)
  - Map `event.status === "cancelled"` → mark entity draft with `attributes._cancelled: true`

- [ ] **TASK-CAL-08**: Add tests for `transform()`
  - Test: 2-attendee event without conferenceData → `entityType: "event"`
  - Test: 3-attendee event → `entityType: "meeting"`, `meetingType: "small-group"`
  - Test: event with `conferenceData` (1 attendee) → `entityType: "meeting"`
  - Test: cancelled event → `attributes._cancelled: true`
  - Test: 3 attendees with 1 duplicate email → 2 unique person entities
  - Test: attendee with no `displayName` → `title = email`

## Week 2: Incremental Sync + Synapses + Integration

- [ ] **TASK-CAL-09**: Implement `incrementalSync(cursor?)` async generator
  - If `cursor` is provided, pass as `updatedMin` parameter to `CalendarAPI.listEvents`
  - If no `cursor`, fall back to `fullSync()` behavior
  - Upsert logic: `CortexStore` handles dedup by `source_external_id` — connector yields all docs, store handles idempotency

- [ ] **TASK-CAL-10**: Implement `getCursor()` method
  - Return `new Date().toISOString()` captured at the start of each sync run
  - Store cursor in `this._lastSyncStart` field (set in `fullSync`/`incrementalSync` preamble)

- [ ] **TASK-CAL-11**: Implement synapse creation for `attended` relationships
  - After entity upsert in `CortexStore.syncConnector()`, look up person and meeting entities by `source_external_id`
  - For each attendee with `responseStatus !== "declined"`, upsert synapse `(personId → meetingId, axon: "attended", weight: 1.0)`
  - Use existing `db.upsertSynapse()` method (check signature in `src/db/database.ts`)
  - Skip synapse if either entity is not found (person may not have been created yet)

- [ ] **TASK-CAL-12**: Implement synapse creation for `temporal` relationships (recurring events)
  - Group event entities produced in the same sync by `attributes.recurringEventId` (non-null)
  - Sort each group by `attributes.startTime` ascending
  - Upsert `(earlier.id → later.id, axon: "temporal", weight: 0.8)` for consecutive pairs
  - Only create synapses when group has 2+ instances

- [ ] **TASK-CAL-13**: Handle cancelled events in upsert flow
  - When `transform()` returns entity draft with `attributes._cancelled: true`
  - In `CortexStore.syncConnector()` (or within connector's own upsert path): look up existing entity by `source_external_id`
  - If found, update `status = "archived"` via `db.updateEntityStatus(id, "archived")`
  - If not found, skip (no entity to archive)

- [ ] **TASK-CAL-14**: Register connector in `src/store.ts`
  - Add `import { CalendarConnector } from "./connectors/calendar.js"` at top of file
  - In `CortexStore` constructor, after Slack/Notion registrations:
    ```typescript
    if (process.env.GOOGLE_CALENDAR_CREDENTIALS) {
      this.connectorRegistry.register(new CalendarConnector());
    }
    ```

- [ ] **TASK-CAL-15**: Add pagination unit tests
  - Mock `fetch` to return two pages (first with `nextPageToken`, second without)
  - Assert all events from both pages are yielded
  - Assert `fetch` was called twice with correct `pageToken` parameter

- [ ] **TASK-CAL-16**: Add auth unit tests
  - Mock `fetch` for JWT exchange endpoint, assert correct request body fields (`grant_type`, `assertion`)
  - Assert token caching: second call to `getAccessToken()` within expiry window does NOT call `fetch`
  - Assert token refresh: call after expiry DOES call `fetch`
  - Assert OAuth2 refresh writes updated token back to file

- [ ] **TASK-CAL-17**: Manual integration test
  - Document steps in `tests/integration/calendar-connector.md`:
    1. Obtain service account key or OAuth2 token
    2. Set env vars
    3. Run `hive-memory sync google-calendar`
    4. Run `hive-memory stats` and verify entity counts
    5. Run sync again, verify no duplicate entities
    6. Query `memory_recall` for a known meeting title
