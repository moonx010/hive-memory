/**
 * Slack Connector — extracts significant threads, decision messages,
 * and channel members from Slack channels via the Web API.
 *
 * Required environment variables:
 *   SLACK_TOKEN    — Bot or User OAuth token (xoxb-... or xoxp-...)
 *   SLACK_CHANNELS — Comma-separated channel IDs to monitor
 */

import type { ConnectorPlugin, RawDocument, EntityDraft } from "./types.js";
import { deriveACLFromSource } from "../acl/source-inherit.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface SlackMessage {
  ts: string;
  text: string;
  user?: string;
  username?: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: Array<{ name: string; count: number }>;
  subtype?: string;
}

interface SlackHistoryResponse {
  ok: boolean;
  messages: SlackMessage[];
  has_more: boolean;
  response_metadata?: { next_cursor?: string };
  error?: string;
}

interface SlackRepliesResponse {
  ok: boolean;
  messages: SlackMessage[];
  has_more: boolean;
  response_metadata?: { next_cursor?: string };
  error?: string;
}

interface SlackMembersResponse {
  ok: boolean;
  members: string[];
  response_metadata?: { next_cursor?: string };
  error?: string;
}

interface SlackChannelInfoResponse {
  ok: boolean;
  channel?: {
    id: string;
    is_private: boolean;
    is_im: boolean;
    is_mpim: boolean;
    members?: string[];
  };
  error?: string;
}

interface SlackUserResponse {
  ok: boolean;
  user?: {
    id: string;
    name: string;
    real_name?: string;
    profile?: { display_name?: string; real_name?: string };
  };
  error?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const DECISION_PATTERNS = [
  /결정\s*:/i,
  /decided\s*:/i,
  /tl;dr\s*:/i,
  /decision\s*:/i,
  /action item\s*:/i,
  /action items\s*:/i,
];

const EMOJI_ONLY_PATTERN = /^[\s:a-zA-Z0-9_+-]+:?[\s]*$/;
const SKIP_SUBTYPES = new Set(["channel_join", "channel_leave", "bot_message"]);

function isEmojiOnly(text: string): boolean {
  // Slack emoji shortcodes like :thumbsup: plus optional whitespace
  return /^(\s*:[a-z0-9_+-]+:\s*)+$/.test(text) || EMOJI_ONLY_PATTERN.test(text.replace(/:[a-z0-9_+-]+:/g, ""));
}

function isSignificant(text: string): boolean {
  if (text.length < 20) return false;
  if (isEmojiOnly(text)) return false;
  // Short acknowledgements
  const lower = text.toLowerCase().trim();
  const skipPhrases = ["ok", "okay", "thanks", "thank you", "got it", "sure", "lgtm", "👍", "+1", "done"];
  if (skipPhrases.includes(lower)) return false;
  return true;
}

function matchesDecisionPattern(text: string): boolean {
  return DECISION_PATTERNS.some((p) => p.test(text));
}

function totalReactions(msg: SlackMessage): number {
  return (msg.reactions ?? []).reduce((sum, r) => sum + r.count, 0);
}

function extractKeywords(text: string): string[] {
  return [
    ...new Set(
      text
        .replace(/:[a-z0-9_+-]+:/g, " ") // strip emoji
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .slice(0, 20),
    ),
  ];
}

function tsToIso(ts: string): string {
  const secs = parseFloat(ts);
  return new Date(secs * 1000).toISOString();
}

// ── API helpers ──────────────────────────────────────────────────────────────

async function slackFetch(url: string, token: string, method = "GET"): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After") ?? "10";
    await new Promise((resolve) => setTimeout(resolve, parseInt(retryAfter, 10) * 1000));
    return slackFetch(url, token);
  }

  if (!res.ok) {
    throw new Error(`Slack API HTTP error ${res.status} for ${url}`);
  }

  return res;
}

// ── Connector ────────────────────────────────────────────────────────────────

export class SlackConnector implements ConnectorPlugin {
  readonly id = "slack";
  readonly name = "Slack";
  readonly description = "Syncs significant threads, decisions, and members from Slack channels";
  readonly entityTypes = ["conversation", "decision", "person"];
  readonly domains = ["conversations"];

  private cursor: string | undefined;
  private readonly token: string;
  private readonly channels: string[];
  private readonly _channelInfoCache = new Map<string, { isPrivate: boolean; isDM: boolean; isMPIM: boolean; members?: string[] }>();

  constructor() {
    this.token = process.env.SLACK_TOKEN ?? "";
    this.channels = (process.env.SLACK_CHANNELS ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
  }

  isConfigured(): boolean {
    return this.token.length > 0 && this.channels.length > 0;
  }

  getCursor(): string | undefined {
    return this.cursor;
  }

  async *fullSync(): AsyncGenerator<RawDocument> {
    // 30 days back
    const oldest = ((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000).toString();
    yield* this._syncChannels(oldest);
  }

  async *incrementalSync(cursor?: string): AsyncGenerator<RawDocument> {
    const since = cursor ?? this.cursor;
    // cursor is ISO date — convert to Unix timestamp
    const oldest = since
      ? (new Date(since).getTime() / 1000).toString()
      : undefined;
    yield* this._syncChannels(oldest);
  }

  async *rollbackSync(window: { since: string; until: string }): AsyncGenerator<RawDocument> {
    // Re-fetch messages from the window period. Member syncing is skipped
    // (members don't change frequently during a 6-hour window).
    this.cursor = new Date().toISOString();
    const oldest = (new Date(window.since).getTime() / 1000).toString();
    for (const channelId of this.channels) {
      yield* this._syncChannel(channelId, oldest);
    }
  }

  private async *_syncChannels(oldest?: string): AsyncGenerator<RawDocument> {
    this.cursor = new Date().toISOString();

    for (const channelId of this.channels) {
      yield* this._syncChannel(channelId, oldest);
      yield* this._syncMembers(channelId);
    }
  }

  private async _fetchChannelInfo(channelId: string): Promise<{ isPrivate: boolean; isDM: boolean; isMPIM: boolean; members?: string[] }> {
    const cached = this._channelInfoCache.get(channelId);
    if (cached) return cached;

    try {
      const res = await slackFetch(
        `https://slack.com/api/conversations.info?channel=${channelId}&include_num_members=true`,
        this.token,
      );
      const data = (await res.json()) as SlackChannelInfoResponse;
      const info = data.ok && data.channel
        ? {
            isPrivate: data.channel.is_private,
            isDM: data.channel.is_im,
            isMPIM: data.channel.is_mpim,
            members: data.channel.members,
          }
        : { isPrivate: false, isDM: false, isMPIM: false };
      this._channelInfoCache.set(channelId, info);
      return info;
    } catch {
      const fallback = { isPrivate: false, isDM: false, isMPIM: false };
      this._channelInfoCache.set(channelId, fallback);
      return fallback;
    }
  }

  private async *_syncChannel(
    channelId: string,
    oldest?: string,
  ): AsyncGenerator<RawDocument> {
    // Fetch channel type info once per channel (cached)
    const channelInfo = await this._fetchChannelInfo(channelId);
    let nextCursor: string | undefined;

    do {
      let url = `https://slack.com/api/conversations.history?channel=${channelId}&limit=100`;
      if (oldest) url += `&oldest=${oldest}`;
      if (nextCursor) url += `&cursor=${encodeURIComponent(nextCursor)}`;

      const res = await slackFetch(url, this.token);
      const data = (await res.json()) as SlackHistoryResponse;

      if (!data.ok) {
        if (data.error === "not_in_channel") {
          // Auto-join the channel and retry
          await fetch("https://slack.com/api/conversations.join", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ channel: channelId }),
          });
          const retryRes = await slackFetch(url, this.token);
          const retryData = (await retryRes.json()) as SlackHistoryResponse;
          if (!retryData.ok) {
            throw new Error(`Slack conversations.history error after join: ${retryData.error}`);
          }
          Object.assign(data, retryData);
        } else {
          throw new Error(`Slack conversations.history error: ${data.error}`);
        }
      }

      for (const msg of data.messages) {
        if (msg.subtype && SKIP_SUBTYPES.has(msg.subtype)) continue;
        if (!msg.text) continue;

        const reactions = totalReactions(msg);
        const isDecision = matchesDecisionPattern(msg.text);
        const isThread = (msg.reply_count ?? 0) >= 3;
        const isImportant = reactions >= 3;

        if (!isDecision && !isThread && !isImportant) continue;
        if (!isSignificant(msg.text)) continue;

        // If it's a thread starter, fetch reply context
        let threadContent = msg.text;
        let replyAuthors: string[] = [];

        if (isThread && msg.thread_ts) {
          const { summary, authors } = await this._fetchThreadSummary(
            channelId,
            msg.thread_ts,
          );
          threadContent = `${msg.text}\n\n--- Thread replies ---\n${summary}`;
          replyAuthors = authors;
        }

        yield {
          externalId: `slack:msg:${channelId}:${msg.ts}`,
          source: "slack",
          content: threadContent,
          author: msg.user,
          timestamp: tsToIso(msg.ts),
          metadata: {
            channelId,
            ts: msg.ts,
            threadTs: msg.thread_ts,
            replyCount: msg.reply_count ?? 0,
            reactionCount: reactions,
            isDecision,
            isThread,
            replyAuthors,
            reactions: (msg.reactions ?? []).map((r) => r.name),
            // Channel ACL metadata
            isPrivate: channelInfo.isPrivate,
            isDM: channelInfo.isDM,
            isMPIM: channelInfo.isMPIM,
            channelMembers: channelInfo.members,
          },
        };
      }

      nextCursor = data.response_metadata?.next_cursor;
    } while (nextCursor);
  }

  private async _fetchThreadSummary(
    channelId: string,
    threadTs: string,
  ): Promise<{ summary: string; authors: string[] }> {
    const url = `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${threadTs}&limit=100`;
    const res = await slackFetch(url, this.token);
    const data = (await res.json()) as SlackRepliesResponse;

    if (!data.ok) {
      return { summary: "", authors: [] };
    }

    const replies = data.messages.slice(1); // skip the parent
    const significant = replies.filter((r) => isSignificant(r.text ?? ""));
    const authors = [...new Set(replies.map((r) => r.user).filter((u): u is string => Boolean(u)))];
    const summary = significant
      .slice(0, 10)
      .map((r) => r.text ?? "")
      .join("\n");

    return { summary, authors };
  }

  private async *_syncMembers(channelId: string): AsyncGenerator<RawDocument> {
    let nextCursor: string | undefined;

    do {
      let url = `https://slack.com/api/conversations.members?channel=${channelId}&limit=200`;
      if (nextCursor) url += `&cursor=${encodeURIComponent(nextCursor)}`;

      const res = await slackFetch(url, this.token);
      const data = (await res.json()) as SlackMembersResponse;

      if (!data.ok) break;

      for (const userId of data.members) {
        // Fetch user info
        try {
          const userRes = await slackFetch(
            `https://slack.com/api/users.info?user=${userId}`,
            this.token,
          );
          const userData = (await userRes.json()) as SlackUserResponse;
          if (!userData.ok || !userData.user) continue;

          const u = userData.user;
          const displayName =
            u.profile?.display_name || u.profile?.real_name || u.real_name || u.name;

          yield {
            externalId: `slack:person:${userId}`,
            source: "slack",
            content: `Slack user ${displayName} (${u.name})`,
            title: displayName,
            author: userId,
            timestamp: new Date().toISOString(),
            metadata: {
              type: "person",
              userId,
              username: u.name,
              realName: u.real_name,
              channelId,
            },
          };
        } catch {
          // Skip individual user failures
          continue;
        }
      }

      nextCursor = data.response_metadata?.next_cursor;
    } while (nextCursor);
  }

  transform(doc: RawDocument): EntityDraft[] {
    const meta = doc.metadata as Record<string, unknown>;

    if (meta.type === "person") {
      return this._transformPerson(doc);
    }

    return this._transformMessage(doc);
  }

  private _transformMessage(doc: RawDocument): EntityDraft[] {
    const meta = doc.metadata as Record<string, unknown>;
    const keywords = extractKeywords(doc.content);
    const isDecision = meta.isDecision as boolean;
    const channelId = meta.channelId as string;
    const reactionCount = meta.reactionCount as number;
    const replyCount = meta.replyCount as number;

    const entityType = isDecision ? "decision" : "conversation";
    const tags = [entityType, `channel:${channelId}`];
    if (isDecision) tags.push("decision");
    if (reactionCount >= 3) tags.push("highly-reacted");

    // Derive ACL from channel type metadata
    const acl = deriveACLFromSource({
      connector: this.id,
      isPrivate: meta.isPrivate as boolean | undefined,
      isDM: meta.isDM as boolean | undefined,
      isMPIM: meta.isMPIM as boolean | undefined,
      channelMembers: meta.channelMembers as string[] | undefined,
      // For DMs, channel members are the participants
      participants: (meta.isDM || meta.isMPIM)
        ? (meta.channelMembers as string[] | undefined)
        : undefined,
      author: doc.author,
    });

    return [
      {
        entityType,
        content: doc.content,
        tags,
        attributes: {
          channelId,
          ts: meta.ts,
          threadTs: meta.threadTs,
          replyCount,
          reactionCount,
          reactions: meta.reactions,
          replyAuthors: meta.replyAuthors,
          keywords,
        },
        source: {
          system: "slack",
          externalId: doc.externalId,
          connector: this.id,
        },
        author: doc.author,
        domain: "conversations",
        confidence: "inferred",
        visibility: acl.visibility,
        aclMembers: acl.aclMembers,
        ownerId: acl.ownerId,
      },
    ];
  }

  private _transformPerson(doc: RawDocument): EntityDraft[] {
    const meta = doc.metadata as Record<string, unknown>;

    return [
      {
        entityType: "person",
        title: (meta.realName as string) || (meta.username as string),
        content: doc.content,
        tags: ["person", "slack"],
        attributes: {
          userId: meta.userId,
          username: meta.username,
          realName: meta.realName,
        },
        source: {
          system: "slack",
          externalId: doc.externalId,
          connector: this.id,
        },
        domain: "conversations",
        confidence: "confirmed",
      },
    ];
  }
}
