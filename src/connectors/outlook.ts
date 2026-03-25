/**
 * Microsoft Outlook/Exchange Calendar Connector — syncs calendar events as
 * meeting/event entities with person entities for attendees via Microsoft Graph API.
 *
 * Required environment variables:
 *   OUTLOOK_TOKEN       — Path to OAuth2 token JSON with access_token, refresh_token,
 *                         client_id, client_secret, tenant_id
 *   OUTLOOK_CALENDARS   — (Optional) Comma-separated calendar IDs (default: "primary")
 */

import { readFileSync, writeFileSync, accessSync, constants } from "node:fs";
import type { ConnectorPlugin, RawDocument, EntityDraft } from "./types.js";
import type { HiveDatabase } from "../db/database.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface OutlookEmailAddress {
  name?: string;
  address: string;
}

interface OutlookAttendee {
  emailAddress: OutlookEmailAddress;
  status?: { response?: string };
  type?: string;
}

interface OutlookEvent {
  id: string;
  subject?: string;
  bodyPreview?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  location?: { displayName?: string };
  isCancelled?: boolean;
  isOnlineMeeting?: boolean;
  organizer?: { emailAddress: OutlookEmailAddress };
  attendees?: OutlookAttendee[];
  onlineMeeting?: { joinUrl?: string };
  lastModifiedDateTime?: string;
  seriesMasterId?: string;
}

interface GraphEventListResponse {
  value?: OutlookEvent[];
  "@odata.nextLink"?: string;
}

interface OutlookTokenFile {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  client_id?: string;
  client_secret?: string;
  tenant_id?: string;
}

class OutlookApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`Outlook API error (${status}): ${message}`);
    this.name = "OutlookApiError";
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err: unknown): boolean {
  return (
    err instanceof OutlookApiError &&
    (err.status === 429 || err.status === 503)
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

function shouldPromoteToMeeting(event: OutlookEvent): boolean {
  const attendeeCount = (event.attendees ?? []).length;
  return attendeeCount >= 3 || (event.isOnlineMeeting ?? false);
}

function getMeetingType(
  attendeeCount: number,
): "one-on-one" | "small-group" | "large-meeting" {
  if (attendeeCount <= 2) return "one-on-one";
  if (attendeeCount <= 8) return "small-group";
  return "large-meeting";
}

// ── OutlookAuth ───────────────────────────────────────────────────────────────

class OutlookAuth {
  private accessToken: string | null = null;
  private expiresAt = 0;

  constructor(private tokenPath: string) {}

  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt) {
      return this.accessToken;
    }
    await this.refreshToken();
    return this.accessToken!;
  }

  private async refreshToken(): Promise<void> {
    const raw = readFileSync(this.tokenPath, "utf-8");
    const token = JSON.parse(raw) as OutlookTokenFile;

    // Check if token is still valid (with 60s buffer)
    if (token.expires_at && token.expires_at * 1000 > Date.now() + 60_000) {
      this.accessToken = token.access_token;
      this.expiresAt = token.expires_at * 1000;
      return;
    }

    if (
      !token.refresh_token ||
      !token.client_id ||
      !token.client_secret ||
      !token.tenant_id
    ) {
      // Use access_token as-is even if possibly expired
      if (token.access_token) {
        this.accessToken = token.access_token;
        this.expiresAt = Date.now() + 3600_000;
        return;
      }
      throw new Error(
        "OutlookConnector: auth failed — token expired and missing refresh credentials",
      );
    }

    const tenantId = token.tenant_id;
    const res = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: token.refresh_token,
          client_id: token.client_id,
          client_secret: token.client_secret,
          scope: "https://graph.microsoft.com/Calendars.Read offline_access",
        }).toString(),
      },
    );

    if (!res.ok) {
      throw new Error(
        `OutlookConnector: auth failed — refresh failed ${res.status}`,
      );
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + (data.expires_in - 60) * 1000;

    // Write updated token back
    const updatedToken: OutlookTokenFile = {
      ...token,
      access_token: data.access_token,
      ...(data.refresh_token && { refresh_token: data.refresh_token }),
      expires_at: Math.floor(this.expiresAt / 1000),
    };
    writeFileSync(this.tokenPath, JSON.stringify(updatedToken, null, 2));
  }
}

// ── OutlookConnector ──────────────────────────────────────────────────────────

export class OutlookConnector implements ConnectorPlugin {
  readonly id = "outlook-calendar";
  readonly name = "Microsoft Outlook Calendar";
  readonly description =
    "Syncs Outlook/Exchange calendar events as meeting and event entities with person relationships";
  readonly entityTypes = ["event", "meeting", "person"];
  readonly domains = ["meetings"];

  private auth: OutlookAuth;
  private _lastSyncStart?: string;
  private _syncedDrafts: Array<{
    event: OutlookEvent;
    calendarId: string;
    entityDrafts: EntityDraft[];
  }> = [];

  constructor() {
    const tokenPath = process.env["OUTLOOK_TOKEN"] ?? "";
    this.auth = new OutlookAuth(tokenPath);
  }

  isConfigured(): boolean {
    const tokenPath = process.env["OUTLOOK_TOKEN"];
    if (!tokenPath) return false;
    try {
      accessSync(tokenPath, constants.R_OK);
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
    const until = new Date(
      Date.now() + 365 * 24 * 60 * 60 * 1000,
    ).toISOString();
    yield* this.fetchCalendarView(since, until);
  }

  async *incrementalSync(cursor?: string): AsyncGenerator<RawDocument> {
    this._lastSyncStart = new Date().toISOString();
    this._syncedDrafts = [];
    if (cursor) {
      yield* this.fetchEvents({ lastModifiedSince: cursor });
    } else {
      yield* this.fullSync();
    }
  }

  private async *fetchCalendarView(
    startDateTime: string,
    endDateTime: string,
  ): AsyncGenerator<RawDocument> {
    const calendarIds = (process.env["OUTLOOK_CALENDARS"] ?? "primary")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    for (const calendarId of calendarIds) {
      const baseUrl =
        calendarId === "primary"
          ? "https://graph.microsoft.com/v1.0/me/calendarView"
          : `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/calendarView`;

      let nextLink: string | undefined;
      const initialUrl = new URL(baseUrl);
      initialUrl.searchParams.set("startDateTime", startDateTime);
      initialUrl.searchParams.set("endDateTime", endDateTime);
      initialUrl.searchParams.set("$top", "250");
      initialUrl.searchParams.set(
        "$select",
        "id,subject,bodyPreview,start,end,location,isCancelled,isOnlineMeeting,organizer,attendees,onlineMeeting,lastModifiedDateTime,seriesMasterId",
      );

      let currentUrl: string = initialUrl.toString();

      do {
        const token = await this.auth.getAccessToken();
        const data = await withRetry(async () => {
          const res = await fetch(currentUrl, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) {
            throw new OutlookApiError(res.status, await res.text());
          }
          return (await res.json()) as GraphEventListResponse;
        });

        for (const event of data.value ?? []) {
          try {
            yield this.eventToRawDoc(event, calendarId);
          } catch (err) {
            console.error(
              `[outlook] Failed to process event ${event.id} in calendar ${calendarId}:`,
              err,
            );
          }
        }

        nextLink = data["@odata.nextLink"];
        currentUrl = nextLink ?? "";
      } while (nextLink);
    }
  }

  private async *fetchEvents(params: {
    lastModifiedSince?: string;
  }): AsyncGenerator<RawDocument> {
    const calendarIds = (process.env["OUTLOOK_CALENDARS"] ?? "primary")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    for (const calendarId of calendarIds) {
      const baseUrl =
        calendarId === "primary"
          ? "https://graph.microsoft.com/v1.0/me/events"
          : `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/events`;

      let nextLink: string | undefined;
      const initialUrl = new URL(baseUrl);
      initialUrl.searchParams.set("$top", "250");
      initialUrl.searchParams.set(
        "$select",
        "id,subject,bodyPreview,start,end,location,isCancelled,isOnlineMeeting,organizer,attendees,onlineMeeting,lastModifiedDateTime,seriesMasterId",
      );
      if (params.lastModifiedSince) {
        initialUrl.searchParams.set(
          "$filter",
          `lastModifiedDateTime ge '${params.lastModifiedSince}'`,
        );
      }

      let currentUrl: string = initialUrl.toString();

      do {
        const token = await this.auth.getAccessToken();
        const data = await withRetry(async () => {
          const res = await fetch(currentUrl, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) {
            throw new OutlookApiError(res.status, await res.text());
          }
          return (await res.json()) as GraphEventListResponse;
        });

        for (const event of data.value ?? []) {
          try {
            yield this.eventToRawDoc(event, calendarId);
          } catch (err) {
            console.error(
              `[outlook] Failed to process event ${event.id} in calendar ${calendarId}:`,
              err,
            );
          }
        }

        nextLink = data["@odata.nextLink"];
        currentUrl = nextLink ?? "";
      } while (nextLink);
    }
  }

  private eventToRawDoc(event: OutlookEvent, calendarId: string): RawDocument {
    const startTime = event.start?.dateTime ?? "";
    return {
      externalId: `outlook:event:${event.id}`,
      source: "outlook-calendar",
      content: event.bodyPreview ?? "",
      title: event.subject ?? "(No title)",
      url: event.onlineMeeting?.joinUrl,
      author: event.organizer?.emailAddress.address,
      timestamp: event.lastModifiedDateTime ?? startTime,
      metadata: { calendarId, rawEvent: event },
    };
  }

  transform(doc: RawDocument): EntityDraft[] {
    const event = doc.metadata.rawEvent as OutlookEvent;
    const drafts: EntityDraft[] = [];
    const seenEmails = new Set<string>();

    const startTime = event.start?.dateTime ?? "";
    const endTime = event.end?.dateTime ?? "";
    const attendees = event.attendees ?? [];
    const isMeeting = shouldPromoteToMeeting(event);
    const entityType = isMeeting ? "meeting" : "event";
    const isCancelled = event.isCancelled ?? false;
    const conferenceUrl = event.onlineMeeting?.joinUrl;

    // Build content
    let content = doc.content;
    if (event.location?.displayName) {
      content += `\nLocation: ${event.location.displayName}`;
    }
    if (attendees.length > 0) {
      content += `\nAttendees: ${attendees
        .map((a) => a.emailAddress.name ?? a.emailAddress.address)
        .join(", ")}`;
    }

    // Main event/meeting entity
    const eventDraft: EntityDraft = {
      entityType,
      title: doc.title,
      content: content || (doc.title ?? "(No title)"),
      tags: isMeeting ? ["meeting"] : ["calendar-event"],
      attributes: {
        startTime,
        endTime,
        ...(event.location?.displayName && {
          location: event.location.displayName,
        }),
        ...(event.seriesMasterId && {
          seriesMasterId: event.seriesMasterId,
        }),
        ...(event.organizer && {
          organizer: event.organizer.emailAddress.address,
        }),
        ...(conferenceUrl && { conferenceUrl }),
        ...(isMeeting && {
          meetingType: getMeetingType(attendees.length),
        }),
        attendees: attendees.map((a) => ({
          email: a.emailAddress.address,
          displayName: a.emailAddress.name,
          responseStatus: a.status?.response,
        })),
      },
      source: {
        system: "outlook-calendar",
        externalId: `outlook:event:${event.id}`,
        ...(conferenceUrl && { url: conferenceUrl }),
        connector: "outlook-calendar",
      },
      author: event.organizer?.emailAddress.address,
      domain: "meetings",
      confidence: "confirmed",
      ...(isCancelled && { status: "archived" as const }),
    };
    drafts.push(eventDraft);

    // Person entities for attendees
    for (const attendee of attendees) {
      const email = attendee.emailAddress.address;
      if (!email || seenEmails.has(email)) continue;
      seenEmails.add(email);

      drafts.push({
        entityType: "person",
        title: attendee.emailAddress.name ?? email,
        content: `${attendee.emailAddress.name ?? email} (${email})`,
        tags: ["calendar-attendee"],
        attributes: {
          email,
          ...(attendee.emailAddress.name && {
            displayName: attendee.emailAddress.name,
          }),
        },
        source: {
          system: "outlook-calendar",
          externalId: `outlook:person:${email}`,
          connector: "outlook-calendar",
        },
        domain: "meetings",
        confidence: "confirmed",
      });
    }

    // Track for postSync synapse creation
    this._syncedDrafts.push({
      event,
      calendarId: doc.metadata.calendarId as string,
      entityDrafts: drafts,
    });

    return drafts;
  }

  getCursor(): string | undefined {
    return this._lastSyncStart;
  }

  postSync(db: HiveDatabase, entityMap: Map<string, string>): void {
    // Create "attended" synapses (person → meeting)
    for (const { event, entityDrafts } of this._syncedDrafts) {
      const meetingDraft = entityDrafts.find(
        (d) => d.entityType === "meeting",
      );
      if (!meetingDraft) continue;

      const meetingId = entityMap.get(meetingDraft.source.externalId);
      if (!meetingId) continue;

      for (const attendee of event.attendees ?? []) {
        const response = attendee.status?.response?.toLowerCase();
        if (response === "declined") continue;
        const email = attendee.emailAddress.address;
        if (!email) continue;
        const personId = entityMap.get(`outlook:person:${email}`);
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

    for (const { event } of this._syncedDrafts) {
      if (!event.seriesMasterId) continue;
      const externalId = `outlook:event:${event.id}`;
      const entityId = entityMap.get(externalId);
      if (!entityId) continue;

      const startTime = event.start?.dateTime ?? "";
      const series = seriesMap.get(event.seriesMasterId) ?? [];
      series.push({ id: entityId, startTime });
      seriesMap.set(event.seriesMasterId, series);
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
