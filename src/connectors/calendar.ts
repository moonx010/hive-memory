/**
 * Google Calendar Connector — syncs calendar events as meeting/event entities
 * with person entities for attendees.
 *
 * Required environment variables:
 *   GOOGLE_CALENDAR_CREDENTIALS — Path to service account JSON or credentials file
 *   GOOGLE_CALENDAR_TOKEN       — (Optional) Path to OAuth2 token JSON
 *   GOOGLE_CALENDAR_IDS         — (Optional) Comma-separated calendar IDs (default: "primary")
 */

import { readFileSync, writeFileSync, accessSync, constants } from "node:fs";
import { createSign } from "node:crypto";
import type { ConnectorPlugin, RawDocument, EntityDraft } from "./types.js";
import type { HiveDatabase } from "../db/database.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface CalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  status?: string;
  organizer?: { email: string; displayName?: string };
  attendees?: Array<{
    email: string;
    displayName?: string;
    responseStatus?: string;
  }>;
  conferenceData?: {
    entryPoints?: Array<{ uri: string; entryPointType: string }>;
  };
  recurringEventId?: string;
  attachments?: Array<{ title: string; fileUrl: string }>;
  updated?: string;
}

interface EventListResponse {
  items?: CalendarEvent[];
  nextPageToken?: string;
}

interface ServiceAccountKey {
  type: string;
  client_email: string;
  private_key: string;
}

interface OAuth2Token {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  token_type: string;
  client_id?: string;
  client_secret?: string;
}

class CalendarApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`Calendar API error (${status}): ${message}`);
    this.name = "CalendarApiError";
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err: unknown): boolean {
  return (
    err instanceof CalendarApiError &&
    (err.status === 429 || err.status === 403)
  );
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 5,
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt === maxAttempts - 1) throw err;
      const delay = Math.min(1000 * 2 ** attempt, 32000);
      const jitter = delay * 0.4 * (Math.random() - 0.5);
      await sleep(delay + jitter);
    }
  }
  throw new Error("unreachable");
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function base64url(data: string | Buffer): string {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  return buf.toString("base64url");
}

function shouldPromoteToMeeting(event: CalendarEvent): boolean {
  const attendeeCount = (event.attendees ?? []).length;
  const hasConference = event.conferenceData != null;
  return attendeeCount >= 3 || hasConference;
}

function getMeetingType(
  attendeeCount: number,
): "one-on-one" | "small-group" | "large-meeting" {
  if (attendeeCount <= 2) return "one-on-one";
  if (attendeeCount <= 8) return "small-group";
  return "large-meeting";
}

// ── GoogleAuth ───────────────────────────────────────────────────────────────

class GoogleAuth {
  private accessToken: string | null = null;
  private expiresAt = 0;

  constructor(
    private credentialsPath: string,
    private tokenPath?: string,
  ) {}

  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt) {
      return this.accessToken;
    }

    // Try service account first
    if (this.credentialsPath) {
      try {
        const raw = readFileSync(this.credentialsPath, "utf-8");
        const creds = JSON.parse(raw) as ServiceAccountKey;
        if (creds.type === "service_account") {
          await this.refreshServiceAccountToken(creds);
          return this.accessToken!;
        }
      } catch {
        // Fall through to OAuth2
      }
    }

    // OAuth2 token file
    if (this.tokenPath) {
      await this.refreshOAuth2Token();
      return this.accessToken!;
    }

    throw new Error(
      "CalendarConnector: auth failed — no valid credentials or token found",
    );
  }

  private async refreshServiceAccountToken(
    creds: ServiceAccountKey,
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64url(
      JSON.stringify({
        iss: creds.client_email,
        scope: "https://www.googleapis.com/auth/calendar.readonly",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      }),
    );

    const sign = createSign("RSA-SHA256");
    sign.update(`${header}.${payload}`);
    const signature = sign.sign(creds.private_key, "base64url");

    const jwt = `${header}.${payload}.${signature}`;

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ietf:params:oauth2:grant_type:jwt-bearer&assertion=${jwt}`,
    });

    if (!res.ok) {
      throw new Error(
        `CalendarConnector: auth failed — ${res.status} ${res.statusText}`,
      );
    }

    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
  }

  private async refreshOAuth2Token(): Promise<void> {
    if (!this.tokenPath) throw new Error("No token path");

    const raw = readFileSync(this.tokenPath, "utf-8");
    const token = JSON.parse(raw) as OAuth2Token;

    // Check if token is still valid
    if (token.expires_at && token.expires_at * 1000 > Date.now()) {
      this.accessToken = token.access_token;
      this.expiresAt = token.expires_at * 1000;
      return;
    }

    if (!token.refresh_token || !token.client_id || !token.client_secret) {
      throw new Error(
        "CalendarConnector: auth failed — token expired and missing refresh credentials",
      );
    }

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: token.client_id,
        client_secret: token.client_secret,
      }).toString(),
    });

    if (!res.ok) {
      throw new Error(
        `CalendarConnector: auth failed — refresh failed ${res.status}`,
      );
    }

    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + (data.expires_in - 60) * 1000;

    // Write updated token back
    const updatedToken: OAuth2Token = {
      ...token,
      access_token: data.access_token,
      expires_at: Math.floor(this.expiresAt / 1000),
    };
    writeFileSync(this.tokenPath, JSON.stringify(updatedToken, null, 2));
  }
}

// ── CalendarConnector ────────────────────────────────────────────────────────

export class CalendarConnector implements ConnectorPlugin {
  readonly id = "google-calendar";
  readonly name = "Google Calendar";
  readonly description =
    "Syncs calendar events as meeting and event entities with person relationships";
  readonly entityTypes = ["event", "meeting", "person"];
  readonly domains = ["meetings"];

  private auth: GoogleAuth;
  private _lastSyncStart?: string;
  private _syncedDrafts: Array<{
    event: CalendarEvent;
    calendarId: string;
    entityDrafts: EntityDraft[];
  }> = [];

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
    this._lastSyncStart = new Date().toISOString();
    this._syncedDrafts = [];
    const since = new Date(
      Date.now() - 90 * 24 * 60 * 60 * 1000,
    ).toISOString();
    yield* this.fetchEvents({ timeMin: since });
  }

  async *incrementalSync(cursor?: string): AsyncGenerator<RawDocument> {
    this._lastSyncStart = new Date().toISOString();
    this._syncedDrafts = [];
    if (cursor) {
      yield* this.fetchEvents({ updatedMin: cursor });
    } else {
      yield* this.fullSync();
    }
  }

  async *rollbackSync(window: { since: string; until: string }): AsyncGenerator<RawDocument> {
    this._lastSyncStart = new Date().toISOString();
    this._syncedDrafts = [];
    yield* this.fetchEvents({ updatedMin: window.since });
  }

  private async *fetchEvents(params: {
    timeMin?: string;
    updatedMin?: string;
  }): AsyncGenerator<RawDocument> {
    const calendarIds = (process.env.GOOGLE_CALENDAR_IDS ?? "primary")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    for (const calendarId of calendarIds) {
      let pageToken: string | undefined;

      do {
        const token = await this.auth.getAccessToken();
        const url = new URL(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
        );
        url.searchParams.set("maxResults", "250");
        url.searchParams.set("singleEvents", "true");
        // Google Calendar API requires orderBy=startTime when singleEvents=true
        url.searchParams.set("orderBy", "startTime");
        if (params.timeMin) url.searchParams.set("timeMin", params.timeMin);
        if (params.updatedMin)
          url.searchParams.set("updatedMin", params.updatedMin);
        if (pageToken) url.searchParams.set("pageToken", pageToken);

        const data = await withRetry(async () => {
          const res = await fetch(url.toString(), {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) {
            throw new CalendarApiError(res.status, await res.text());
          }
          return (await res.json()) as EventListResponse;
        });

        for (const event of data.items ?? []) {
          try {
            const startTime =
              event.start?.dateTime ?? event.start?.date ?? "";
            const doc: RawDocument = {
              externalId: `gcal:event:${calendarId}:${event.id}`,
              source: "google-calendar",
              content: event.description
                ? stripHtml(event.description)
                : "",
              title: event.summary ?? "(No title)",
              url: undefined,
              author: event.organizer?.email,
              timestamp: event.updated ?? startTime,
              metadata: { calendarId, rawEvent: event },
            };
            yield doc;
          } catch (err) {
            console.error(
              `[calendar] Failed to process event ${event.id} in calendar ${calendarId}:`,
              err,
            );
          }
        }

        pageToken = data.nextPageToken;
      } while (pageToken);
    }
  }

  transform(doc: RawDocument): EntityDraft[] {
    const event = doc.metadata.rawEvent as CalendarEvent;
    const calendarId = doc.metadata.calendarId as string;
    const drafts: EntityDraft[] = [];
    const seenEmails = new Set<string>();

    const startTime = event.start?.dateTime ?? event.start?.date ?? "";
    const endTime = event.end?.dateTime ?? event.end?.date ?? "";
    const attendees = event.attendees ?? [];
    const isMeeting = shouldPromoteToMeeting(event);
    const entityType = isMeeting ? "meeting" : "event";
    const isCancelled = event.status === "cancelled";

    // Build content
    let content = doc.content;
    if (event.location) content += `\nLocation: ${event.location}`;
    if (attendees.length > 0) {
      content += `\nAttendees: ${attendees.map((a) => a.displayName ?? a.email).join(", ")}`;
    }

    // Main event/meeting entity
    const conferenceUrl =
      event.conferenceData?.entryPoints?.[0]?.uri ?? undefined;

    const eventDraft: EntityDraft = {
      entityType,
      title: doc.title,
      content: content || (doc.title ?? "(No title)"),
      tags: isMeeting ? ["meeting"] : ["calendar-event"],
      attributes: {
        startTime,
        endTime,
        ...(event.location && { location: event.location }),
        ...(event.recurringEventId && {
          recurringEventId: event.recurringEventId,
        }),
        ...(event.organizer && { organizer: event.organizer.email }),
        ...(conferenceUrl && { conferenceUrl }),
        ...(isMeeting && {
          meetingType: getMeetingType(attendees.length),
        }),
        attendees: attendees.map((a) => ({
          email: a.email,
          displayName: a.displayName,
          responseStatus: a.responseStatus,
        })),
        ...(event.attachments && { attachments: event.attachments }),
      },
      source: {
        system: "google-calendar",
        externalId: `gcal:event:${calendarId}:${event.id}`,
        connector: "google-calendar",
      },
      author: event.organizer?.email,
      domain: "meetings",
      confidence: "confirmed",
      ...(isCancelled && { status: "archived" as const }),
    };
    drafts.push(eventDraft);

    // Person entities for attendees
    for (const attendee of attendees) {
      if (seenEmails.has(attendee.email)) continue;
      seenEmails.add(attendee.email);

      drafts.push({
        entityType: "person",
        title: attendee.displayName ?? attendee.email,
        content: `${attendee.displayName ?? attendee.email} (${attendee.email})`,
        tags: ["calendar-attendee"],
        attributes: {
          email: attendee.email,
          ...(attendee.displayName && { displayName: attendee.displayName }),
        },
        source: {
          system: "google-calendar",
          externalId: `gcal:person:${attendee.email}`,
          connector: "google-calendar",
        },
        domain: "meetings",
        confidence: "confirmed",
      });
    }

    // Track for postSync synapse creation
    this._syncedDrafts.push({ event, calendarId, entityDrafts: drafts });

    return drafts;
  }

  getCursor(): string | undefined {
    return this._lastSyncStart;
  }

  postSync(
    db: HiveDatabase,
    entityMap: Map<string, string>,
  ): void {
    // Create "attended" synapses (person → meeting)
    for (const { event, calendarId: _calendarId, entityDrafts } of this._syncedDrafts) {
      const meetingDraft = entityDrafts.find(
        (d) => d.entityType === "meeting",
      );
      if (!meetingDraft) continue;

      const meetingId = entityMap.get(meetingDraft.source.externalId);
      if (!meetingId) continue;

      for (const attendee of event.attendees ?? []) {
        if (attendee.responseStatus === "declined") continue;
        const personId = entityMap.get(`gcal:person:${attendee.email}`);
        if (!personId) continue;

        db.upsertSynapse({
          sourceId: personId,
          targetId: meetingId,
          axon: "attended",
          weight: 1.0,
        });
      }
    }

    // Create "temporal" synapses for recurring event series
    const seriesMap = new Map<string, Array<{ id: string; startTime: string }>>();

    for (const { event, calendarId } of this._syncedDrafts) {
      if (!event.recurringEventId) continue;
      const externalId = `gcal:event:${calendarId}:${event.id}`;
      const entityId = entityMap.get(externalId);
      if (!entityId) continue;

      const startTime = event.start?.dateTime ?? event.start?.date ?? "";
      const series = seriesMap.get(event.recurringEventId) ?? [];
      series.push({ id: entityId, startTime });
      seriesMap.set(event.recurringEventId, series);
    }

    for (const [, instances] of seriesMap) {
      if (instances.length < 2) continue;
      instances.sort((a, b) => a.startTime.localeCompare(b.startTime));

      for (let i = 0; i < instances.length - 1; i++) {
        db.upsertSynapse({
          sourceId: instances[i].id,
          targetId: instances[i + 1].id,
          axon: "temporal",
          weight: 0.8,
        });
      }
    }

    // Clear tracked data
    this._syncedDrafts = [];
  }
}
