import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { HiveDatabase } from "../db/database.js";

export interface SlackExport {
  /** Root directory of Slack Enterprise export */
  exportDir: string;
}

export interface ImportResult {
  channels: number;
  messages: number;
  users: number;
  errors: number;
  durationMs: number;
}

interface SlackUser {
  id: string;
  name: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: {
    title?: string;
    email?: string;
    real_name?: string;
    display_name?: string;
  };
}

interface SlackChannel {
  id: string;
  name: string;
  purpose?: { value?: string };
  topic?: { value?: string };
}

interface SlackMessage {
  type?: string;
  subtype?: string;
  ts?: string;
  user?: string;
  username?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: Array<{ name: string; count: number }>;
}

function extractKeywords(text: string): string[] {
  return [
    ...new Set(
      text
        .replace(/:[a-z0-9_+-]+:/g, " ")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .slice(0, 20),
    ),
  ];
}

function _tsToIso(ts: string): string {
  const secs = parseFloat(ts);
  return new Date(secs * 1000).toISOString();
}

const DECISION_PATTERNS = [
  /결정\s*:/i,
  /decided\s*:/i,
  /tl;dr\s*:/i,
  /decision\s*:/i,
  /action item\s*:/i,
];

function matchesDecisionPattern(text: string): boolean {
  return DECISION_PATTERNS.some((p) => p.test(text));
}

/**
 * Import Slack Enterprise Grid export (bulk JSON files).
 * Format: exportDir/
 *   channels.json — channel metadata
 *   users.json — user list
 *   {channel-name}/ — directory per channel
 *     YYYY-MM-DD.json — messages per day
 */
export async function importSlackExport(
  db: HiveDatabase,
  opts: SlackExport,
): Promise<ImportResult> {
  const start = Date.now();
  let messages = 0;
  let errors = 0;
  let channels = 0;
  let users = 0;

  // 1. Parse users.json → create person entities
  const usersFile = join(opts.exportDir, "users.json");
  if (existsSync(usersFile)) {
    let slackUsers: SlackUser[] = [];
    try {
      slackUsers = JSON.parse(readFileSync(usersFile, "utf-8")) as SlackUser[];
    } catch {
      errors++;
    }

    for (const user of slackUsers) {
      if (user.deleted || user.is_bot) continue;
      try {
        const displayName = user.real_name || user.name;
        db.upsertEntity({
          entityType: "person",
          title: displayName,
          content: `${displayName} (@${user.name})${user.profile?.title ? ` - ${user.profile.title}` : ""}`,
          tags: ["slack-user"],
          attributes: {
            email: user.profile?.email ?? null,
            handle: user.name,
            slackId: user.id,
          },
          source: {
            system: "slack",
            externalId: `slack:user:${user.id}`,
            connector: "slack-import",
          },
          domain: "conversations",
          confidence: "confirmed",
        });
        users++;
      } catch {
        errors++;
      }
    }
  }

  // 2. Parse channels.json → get channel list
  const channelsFile = join(opts.exportDir, "channels.json");
  let channelList: SlackChannel[] = [];
  if (existsSync(channelsFile)) {
    try {
      channelList = JSON.parse(readFileSync(channelsFile, "utf-8")) as SlackChannel[];
    } catch {
      errors++;
    }
  }

  // 3. For each channel directory, read day files
  for (const channel of channelList) {
    const channelDir = join(opts.exportDir, channel.name);
    if (!existsSync(channelDir) || !statSync(channelDir).isDirectory()) continue;
    channels++;

    let dayFiles: string[];
    try {
      dayFiles = readdirSync(channelDir).filter((f) => f.endsWith(".json")).sort();
    } catch {
      errors++;
      continue;
    }

    const insertBatch = db.rawDb.transaction((msgs: SlackMessage[]) => {
      for (const msg of msgs) {
        try {
          const ts = msg.ts ?? "";
          const text = msg.text ?? "";
          const isDecision = matchesDecisionPattern(text);
          const entityType = isDecision ? "decision" : "conversation";
          const tags = [entityType, `channel:${channel.name}`];
          if (isDecision) tags.push("decision");

          db.upsertEntity({
            entityType,
            content: text,
            tags,
            attributes: {
              channelId: channel.id,
              channelName: channel.name,
              ts,
              threadTs: msg.thread_ts ?? null,
              replyCount: msg.reply_count ?? 0,
              keywords: extractKeywords(text),
            },
            source: {
              system: "slack",
              externalId: `slack:msg:${channel.id}:${ts}`,
              connector: "slack-import",
            },
            domain: "conversations",
            confidence: "confirmed",
          });
          messages++;
        } catch {
          errors++;
        }
      }
    });

    for (const dayFile of dayFiles) {
      try {
        const raw = readFileSync(join(channelDir, dayFile), "utf-8");
        const msgs = JSON.parse(raw) as SlackMessage[];
        // Filter significant messages
        const significant = msgs.filter(
          (m) =>
            (m.text?.length ?? 0) > 20 &&
            !m.subtype &&
            m.type === "message",
        );
        insertBatch(significant);
      } catch {
        errors++;
      }
    }
  }

  return { channels, messages, users, errors, durationMs: Date.now() - start };
}
