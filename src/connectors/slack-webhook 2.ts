import type { HiveDatabase } from "../db/database.js";
import { deriveACLFromSource } from "../acl/source-inherit.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SlackMessageEvent {
  type: string;
  subtype?: string;
  text?: string;
  user?: string;
  channel?: string;
  channel_type?: string; // "channel", "group", "im", "mpim"
  ts?: string;
  thread_ts?: string;
}

// ── Main function ────────────────────────────────────────────────────────────

/**
 * Process a Slack message event and store it as an entity.
 * Called from the /slack/events handler when a message event is received.
 */
export function processSlackMessageEvent(
  db: HiveDatabase,
  event: SlackMessageEvent,
): { stored: boolean; entityId?: string } {
  // Skip bot messages, subtypes (joins, leaves, etc.), empty messages
  if (event.subtype || !event.text || !event.user) {
    return { stored: false };
  }

  // Skip very short messages
  if (event.text.length < 20) {
    return { stored: false };
  }

  const externalId = `slack:msg:${event.channel}:${event.ts}`;

  // Check if already exists (dedup)
  const existing = db.getByExternalId("slack", externalId);
  if (existing) {
    return { stored: false };
  }

  // Derive ACL from channel type
  const acl = deriveACLFromSource({
    connector: "slack",
    isDM: event.channel_type === "im",
    isMPIM: event.channel_type === "mpim",
    isPrivate: event.channel_type === "group",
    author: event.user,
  });

  const entityId = db.upsertEntity({
    entityType: "message",
    content: event.text,
    tags: ["slack", "real-time"],
    attributes: {
      channelId: event.channel,
      channelType: event.channel_type,
      slackUserId: event.user,
      slackTs: event.ts,
      threadTs: event.thread_ts,
    },
    source: {
      system: "slack",
      externalId,
      connector: "slack-webhook",
    },
    domain: "conversations",
    confidence: "confirmed",
  });

  // Apply ACL fields via updateEntity after creation
  db.updateEntity(entityId, {
    visibility: acl.visibility as import("../types.js").Entity["visibility"],
    ...(acl.ownerId ? { author: acl.ownerId } : {}),
  });

  return { stored: true, entityId };
}
