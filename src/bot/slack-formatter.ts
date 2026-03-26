/**
 * Slack Block Kit formatters for the Bumble Bee bot responses.
 */

import type { HiveSearchResult } from "../store/hive-search.js";
import type { Entity } from "../types.js";

export interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  elements?: Array<{ type: string; text: string }>;
}

const MAX_RESULTS = 5;
const MAX_CONTENT_LENGTH = 200;

function truncate(text: string, maxLen = MAX_CONTENT_LENGTH): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}

function escapeMarkdown(text: string): string {
  // Slack mrkdwn: escape < > & to avoid formatting issues
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Format memory recall results (FTS + graph search).
 */
export function formatRecallResults(query: string, results: HiveSearchResult[]): SlackBlock[] {
  const shown = results.slice(0, MAX_RESULTS);
  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `Memory Recall: ${query}` },
    },
  ];

  if (shown.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `_No memories found for "${escapeMarkdown(query)}"_` },
    });
    return blocks;
  }

  for (const r of shown) {
    const category = r.category ? `*[${r.category}]* ` : "";
    const snippet = truncate(r.snippet);
    const meta = [
      r.source ?? "",
      r.project ? `project: ${r.project}` : "",
      r.score !== undefined ? `score: ${r.score.toFixed(2)}` : "",
    ]
      .filter(Boolean)
      .join(" · ");

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${category}${escapeMarkdown(snippet)}${meta ? `\n_${escapeMarkdown(meta)}_` : ""}`,
      },
    });
  }

  const footer =
    results.length > MAX_RESULTS
      ? `Found ${results.length} memories · showing top ${MAX_RESULTS}`
      : `Found ${results.length} memor${results.length === 1 ? "y" : "ies"}`;

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: footer }],
  });

  return blocks;
}

/**
 * Format "who knows about X" results.
 * Input: array of {name, count, latest} sorted by count desc.
 */
export function formatWhoKnows(
  topic: string,
  authors: Array<{ name: string; count: number; latest?: string }>,
): SlackBlock[] {
  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `Who knows about: ${topic}` },
    },
  ];

  if (authors.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `_No contributors found for "${escapeMarkdown(topic)}"_` },
    });
    return blocks;
  }

  const lines = authors.slice(0, MAX_RESULTS).map((a, i) => {
    const latestStr = a.latest ? ` (latest: ${a.latest.slice(0, 10)})` : "";
    return `${i + 1}. *${escapeMarkdown(a.name)}* — ${a.count} related memor${a.count === 1 ? "y" : "ies"}${latestStr}`;
  });

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: lines.join("\n") },
  });

  return blocks;
}

/**
 * Format meeting notes results.
 */
export function formatMeetingNotes(date: string | undefined, meetings: Entity[]): SlackBlock[] {
  const title = date ? `Meeting Notes: ${date}` : "Recent Meeting Notes";
  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: title },
    },
  ];

  const shown = meetings.slice(0, MAX_RESULTS);

  if (shown.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `_No meeting notes found${date ? ` for ${date}` : ""}_` },
    });
    return blocks;
  }

  for (const m of shown) {
    const titleText = m.title ? `*${escapeMarkdown(m.title)}*` : "*Meeting*";
    const snippet = truncate(m.content);
    const datePart = m.createdAt ? `\n_${m.createdAt.slice(0, 10)}_` : "";

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${titleText}\n${escapeMarkdown(snippet)}${datePart}`,
      },
    });
  }

  if (meetings.length > MAX_RESULTS) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Showing ${MAX_RESULTS} of ${meetings.length} meetings`,
        },
      ],
    });
  }

  return blocks;
}

/**
 * Format action items (tasks).
 */
export function formatActionItems(items: Entity[]): SlackBlock[] {
  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "Action Items" },
    },
  ];

  const shown = items.slice(0, MAX_RESULTS);

  if (shown.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No active action items found_" },
    });
    return blocks;
  }

  const lines = shown.map((item, i) => {
    const label = item.title ? escapeMarkdown(item.title) : truncate(item.content, 100);
    const project = item.project ? ` _(${item.project})_` : "";
    return `${i + 1}. ${label}${project}`;
  });

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: lines.join("\n") },
  });

  if (items.length > MAX_RESULTS) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${items.length - MAX_RESULTS} more action items not shown`,
        },
      ],
    });
  }

  return blocks;
}

/**
 * Format a "no results" fallback message.
 */
export function formatNoResults(query: string): SlackBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `_No results found for "${escapeMarkdown(query)}"_\n\nTry rephrasing or use a broader term.`,
      },
    },
  ];
}

/**
 * Format help message listing available commands.
 */
export function formatHelp(): SlackBlock[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Bumble Bee — Hive Memory Bot" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          "*Available commands:*",
          "• `@BumbleBee what did we decide about <topic>` — search memories",
          "• `@BumbleBee find <topic>` — search memories",
          "• `@BumbleBee meeting notes [from <date>]` — list meeting notes",
          "• `@BumbleBee who knows about <topic>` — find contributors",
          "• `@BumbleBee action items` — list active tasks",
          "• `@BumbleBee help` — show this message",
          "",
          "_Korean is also supported: 찾아, 알려줘, 회의록, 누가, 할 일_",
        ].join("\n"),
      },
    },
  ];
}
