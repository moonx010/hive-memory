/**
 * Recall.ai Connector — inbound-only data ingestion.
 *
 * Syncs completed meeting recordings from Recall.ai as meeting entities.
 * Bot orchestration (join, schedule) lives in jarvis, not here.
 *
 * Environment variables:
 * - RECALL_API_KEY — API key from recall.ai dashboard
 * - RECALL_REGION — API region (default: us-west-2)
 * - RECALL_WEBHOOK_SECRET — Svix webhook signing secret (required for /recall/events)
 */

import type {
  ConnectorPlugin,
  RawDocument,
  EntityDraft,
} from "./types.js";
import type { HiveDatabase } from "../db/database.js";

// ── Recall.ai API types ──────────────────────────────────────────────────────

export interface RecallBot {
  id: string;
  meeting_url: string;
  bot_name: string;
  status: RecallBotStatus;
  status_changes: Array<{ code: string; sub_code?: string; created_at: string }>;
  recordings: RecallRecording[];
  created_at: string;
  metadata?: Record<string, unknown>;
}

export interface RecallRecording {
  id: string;
  status: { code: string };
  media_shortcuts: {
    transcript?: {
      id: string;
      data: { download_url: string };
    };
    video_mixed?: {
      id: string;
      data: { download_url: string };
    };
  };
}

export type RecallBotStatus =
  | "ready"
  | "joining"
  | "joined"
  | "recording"
  | "call_ended"
  | "done"
  | "fatal"
  | "analysis_done";

export interface RecallTranscriptEntry {
  speaker: string | null;
  speaker_id: number | null;
  words: Array<{
    text: string;
    start_time: number;
    end_time: number;
    language?: string;
    confidence?: number;
  }>;
}

export interface RecallWebhookPayload {
  event: string;
  data: {
    bot?: { id: string; metadata?: Record<string, unknown> };
    recording?: { id: string };
    status?: { code: string; sub_code?: string; updated_at: string };
    data?: { code: string; sub_code?: string };
  };
}

// ── API client ───────────────────────────────────────────────────────────────

export class RecallClient {
  private baseUrl: string;
  private apiKey: string;
  private botName: string;

  constructor() {
    this.apiKey = process.env["RECALL_API_KEY"] ?? "";
    const region = process.env["RECALL_REGION"] ?? "us-west-2";
    this.baseUrl = `https://${region}.recall.ai/api/v1`;
    this.botName = process.env["RECALL_BOT_NAME"] ?? "Bumble Bee 🐝";
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Token ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Recall API ${method} ${path} failed (${res.status}): ${text}`);
    }

    return (await res.json()) as T;
  }

  /** Get bot status and recordings (inbound read-only) */
  async getBot(botId: string): Promise<RecallBot> {
    return this.request<RecallBot>("GET", `/bot/${botId}`);
  }

  /** List bots with optional status filter */
  async listBots(opts?: {
    status?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ results: RecallBot[]; next: string | null }> {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status__in", opts.status);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.cursor) params.set("cursor", opts.cursor);
    const qs = params.toString();
    return this.request("GET", `/bot${qs ? `?${qs}` : ""}`);
  }

  /** Download transcript for a completed recording */
  async getTranscript(downloadUrl: string): Promise<RecallTranscriptEntry[]> {
    const res = await fetch(downloadUrl, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`Failed to download transcript: ${res.status}`);
    }
    return (await res.json()) as RecallTranscriptEntry[];
  }

  /** Convert Recall transcript to VTT-style plaintext for MeetingAgent */
  static transcriptToPlaintext(entries: RecallTranscriptEntry[]): string {
    const lines: string[] = [];
    for (const entry of entries) {
      const speaker = entry.speaker ?? `Speaker ${entry.speaker_id ?? 0}`;
      const text = entry.words.map((w) => w.text).join(" ");
      if (text.trim()) {
        lines.push(`${speaker}: ${text}`);
      }
    }
    return lines.join("\n");
  }

  /** Convert Recall transcript to VTT format */
  static transcriptToVTT(entries: RecallTranscriptEntry[]): string {
    const lines: string[] = ["WEBVTT", ""];
    for (const entry of entries) {
      if (entry.words.length === 0) continue;
      const speaker = entry.speaker ?? `Speaker ${entry.speaker_id ?? 0}`;
      const start = formatVTTTime(entry.words[0].start_time);
      const end = formatVTTTime(entry.words[entry.words.length - 1].end_time);
      const text = entry.words.map((w) => w.text).join(" ");
      lines.push(`${start} --> ${end}`);
      lines.push(`<v ${speaker}>${text}`);
      lines.push("");
    }
    return lines.join("\n");
  }
}

function formatVTTTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

// ── Connector plugin ─────────────────────────────────────────────────────────

export class RecallConnector implements ConnectorPlugin {
  readonly id = "recall";
  readonly name = "Recall.ai Meeting Bot";
  readonly description = "Records and transcribes Google Meet/Zoom meetings via Recall.ai bots";
  readonly entityTypes = ["meeting", "person"];
  readonly domains = ["meetings"];

  private client = new RecallClient();
  private cursor: string | undefined;

  isConfigured(): boolean {
    return Boolean(process.env["RECALL_API_KEY"]);
  }

  async *fullSync(): AsyncGenerator<RawDocument> {
    let nextCursor: string | undefined;
    let latestTimestamp: string | undefined;

    do {
      const page = await this.client.listBots({
        status: "done,analysis_done",
        limit: 50,
        cursor: nextCursor,
      });

      for (const bot of page.results) {
        const doc = await this.botToRawDocument(bot);
        if (doc) {
          yield doc;
          if (!latestTimestamp || bot.created_at > latestTimestamp) {
            latestTimestamp = bot.created_at;
          }
        }
      }

      nextCursor = page.next ?? undefined;
    } while (nextCursor);

    if (latestTimestamp) {
      this.cursor = latestTimestamp;
    }
  }

  async *incrementalSync(cursor?: string): AsyncGenerator<RawDocument> {
    // List bots created/completed since last sync
    const page = await this.client.listBots({
      status: "done,analysis_done",
      limit: 50,
    });

    const since = cursor ?? this.cursor;
    let latestTimestamp = since;

    for (const bot of page.results) {
      // Skip bots from before cursor
      if (since && bot.created_at <= since) continue;

      const doc = await this.botToRawDocument(bot);
      if (doc) {
        yield doc;
        if (!latestTimestamp || bot.created_at > latestTimestamp) {
          latestTimestamp = bot.created_at;
        }
      }
    }

    if (latestTimestamp) {
      this.cursor = latestTimestamp;
    }
  }

  transform(doc: RawDocument): EntityDraft[] {
    const drafts: EntityDraft[] = [];
    const meta = doc.metadata as {
      speakers: string[];
      durationMinutes: number;
      meetingUrl: string;
      botId: string;
      participantCount?: number;
    };

    // Meeting entity
    drafts.push({
      entityType: "meeting",
      title: doc.title ?? "Meeting",
      content: doc.content,
      tags: ["meeting", "recall", "transcript"],
      attributes: {
        date: doc.timestamp.slice(0, 10),
        speakers: meta.speakers,
        durationMinutes: meta.durationMinutes,
        meetingUrl: meta.meetingUrl,
        recallBotId: meta.botId,
        source: "recall",
      },
      source: {
        system: "recall",
        externalId: doc.externalId,
        url: meta.meetingUrl,
        connector: "recall",
      },
      domain: "meetings",
      confidence: "confirmed",
      visibility: "team",
    });

    // Person entities for speakers
    for (const speaker of meta.speakers) {
      const normalized = speaker.toLowerCase().replace(/\s+/g, "-");
      drafts.push({
        entityType: "person",
        title: speaker,
        content: speaker,
        tags: ["meeting-speaker", "recall"],
        attributes: { displayName: speaker },
        source: {
          system: "recall",
          externalId: `recall:speaker:${meta.botId}:${normalized}`,
          connector: "recall",
        },
        domain: "meetings",
        confidence: "inferred",
      });
    }

    return drafts;
  }

  getCursor(): string | undefined {
    return this.cursor;
  }

  postSync(db: HiveDatabase, entityMap: Map<string, string>): void {
    // Create "attended" synapses — match speaker to their specific meeting via botId
    for (const [externalId, entityId] of entityMap) {
      const speakerMatch = externalId.match(/^recall:speaker:([^:]+):/);
      if (!speakerMatch) continue;
      const botId = speakerMatch[1];
      const meetingEntityId = entityMap.get(`recall:bot:${botId}`);
      if (meetingEntityId) {
        db.upsertSynapse({
          sourceId: entityId,
          targetId: meetingEntityId,
          axon: "attended",
          weight: 1.0,
        });
      }
    }
  }

  /** Convert a completed Recall bot to a RawDocument */
  private async botToRawDocument(bot: RecallBot): Promise<RawDocument | null> {
    const recording = bot.recordings?.[0];
    if (!recording) return null;

    const transcriptUrl = recording.media_shortcuts?.transcript?.data?.download_url;
    if (!transcriptUrl) return null;

    try {
      const entries = await this.client.getTranscript(transcriptUrl);
      const plaintext = RecallClient.transcriptToPlaintext(entries);
      if (!plaintext.trim()) return null;

      const speakers = [...new Set(
        entries
          .map((e) => e.speaker ?? `Speaker ${e.speaker_id ?? 0}`)
          .filter(Boolean),
      )];

      // Calculate duration from word timestamps
      let maxTime = 0;
      for (const entry of entries) {
        for (const w of entry.words) {
          if (w.end_time > maxTime) maxTime = w.end_time;
        }
      }

      const title = (bot.metadata?.title as string) ?? `Meeting — ${bot.created_at.slice(0, 10)}`;

      return {
        externalId: `recall:bot:${bot.id}`,
        source: "recall",
        content: plaintext,
        title,
        url: bot.meeting_url,
        timestamp: bot.created_at,
        metadata: {
          speakers,
          durationMinutes: Math.round(maxTime / 60),
          meetingUrl: bot.meeting_url,
          botId: bot.id,
        },
      };
    } catch (err) {
      console.error(`[recall] Failed to fetch transcript for bot ${bot.id}:`, err);
      return null;
    }
  }
}

// ── Webhook handler ──────────────────────────────────────────────────────────

/**
 * Handle Recall.ai webhook events (recording.done, status changes).
 * When a recording completes, downloads transcript and runs MeetingAgent pipeline.
 */
export async function handleRecallWebhook(
  payload: unknown,
  store: import("../store.js").CortexStore,
): Promise<void> {
  const event = payload as RecallWebhookPayload;
  const eventType = event.event ?? (event.data?.data?.code ? "recording.done" : "unknown");

  console.error(`[recall] Webhook event: ${eventType}`);

  // Handle recording completion
  if (eventType === "recording.done" || event.data?.data?.code === "done") {
    const botId = event.data?.bot?.id;
    if (!botId) {
      console.error("[recall] Webhook missing bot ID");
      return;
    }

    try {
      const client = new RecallClient();
      const bot = await client.getBot(botId);

      const recording = bot.recordings?.[0];
      const transcriptUrl = recording?.media_shortcuts?.transcript?.data?.download_url;
      if (!transcriptUrl) {
        console.error(`[recall] No transcript available for bot ${botId}`);
        return;
      }

      // Download and convert transcript
      const entries = await client.getTranscript(transcriptUrl);
      const plaintext = RecallClient.transcriptToPlaintext(entries);
      if (!plaintext.trim()) {
        console.error(`[recall] Empty transcript for bot ${botId}`);
        return;
      }

      const title = (bot.metadata?.title as string) ?? `Meeting — ${bot.created_at.slice(0, 10)}`;
      const speakers = [...new Set(entries.map((e) => e.speaker ?? `Speaker ${e.speaker_id ?? 0}`))];

      console.error(`[recall] Processing transcript for "${title}" (${speakers.length} speakers)`);

      // Run through MeetingAgent pipeline
      const { MeetingAgent } = await import("../meeting/agent.js");
      const agent = new MeetingAgent(store.database, store.enrichmentEngine);

      const result = await agent.process({
        transcriptContent: plaintext,
        title,
        date: bot.created_at.slice(0, 10),
        attendees: speakers,
      });

      console.error(
        `[recall] Meeting processed: ${result.meetingEntityId} ` +
        `(${result.decisionsCreated} decisions, ${result.actionsCreated} actions)`,
      );

      // Notify external hooks (fire-and-forget)
      import("../hooks/notify.js")
        .then(({ notifyHooks }) =>
          notifyHooks({
            event: "meeting.processed",
            entityId: result.meetingEntityId,
            timestamp: new Date().toISOString(),
            meta: {
              title,
              speakers,
              decisionsCreated: result.decisionsCreated,
              actionsCreated: result.actionsCreated,
            },
          }),
        )
        .catch((err) => console.error("[recall] Hook notification error:", err));
    } catch (err) {
      console.error(`[recall] Failed to process recording for bot ${botId}:`, err);
    }
    return;
  }

  // Log other events
  if (event.data?.status) {
    console.error(`[recall] Bot ${event.data.bot?.id}: ${event.data.status.code}`);
  }
}

// ── Calendar auto-join ───────────────────────────────────────────────────────

// scheduleBotsForUpcomingMeetings, joinMeeting, getBotStatus
// extracted to jarvis — these are agent-layer orchestration
