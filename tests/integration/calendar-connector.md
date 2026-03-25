# Google Calendar Connector — Manual Integration Test Steps

These steps verify the end-to-end behavior of the `google-calendar` connector against a real Google Calendar API.

## Prerequisites

- A Google Cloud project with the Calendar API enabled
- Either a service account key (JSON) or an OAuth2 token JSON file
- The `hive-memory` CLI installed and pointing to your cortex database

## Steps

### 1. Obtain credentials

**Service account**: Download the service account key JSON from the Google Cloud Console (IAM → Service Accounts → Keys → Add Key → JSON). Share the target calendar(s) with the service account email.

**OAuth2**: Complete the OAuth2 flow and save the resulting token to a JSON file containing at minimum `access_token` and `token_type`.

### 2. Set environment variables

```bash
export GOOGLE_CALENDAR_CREDENTIALS=/path/to/credentials.json
export GOOGLE_CALENDAR_IDS=primary,team-calendar@example.com   # comma-separated, default: primary
```

### 3. Run the sync

```bash
hive-memory sync google-calendar
```

Expected: The command completes without errors and prints a summary of entities upserted (meetings, events, persons).

### 4. Verify entity counts

```bash
hive-memory stats
```

Expected: The `meeting`, `event`, and `person` entity counts reflect the calendars synced. There should be at least one entity per calendar event fetched.

### 5. Run sync again and verify no duplicates

```bash
hive-memory sync google-calendar
hive-memory stats
```

Expected: Entity counts remain the same as after the first sync. The connector uses `externalId` deduplication (`gcal:event:<calendarId>:<eventId>`), so re-running sync must not create duplicate entities.
