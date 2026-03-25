/**
 * Meeting output sharing — post meeting notes to Slack and/or Notion.
 */

// ── Slack ─────────────────────────────────────────────────────────────────────

/**
 * Convert markdown to Slack mrkdwn format.
 * - `# Heading` → `*Heading*`
 * - `## Heading` → `*Heading*`
 * - `- [ ] item` → `☐ item`
 * - `**text**` → `*text*`
 */
function markdownToMrkdwn(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => {
      // H1/H2/H3 headers → bold
      if (/^#{1,3}\s/.test(line)) {
        return `*${line.replace(/^#{1,3}\s+/, "")}*`;
      }
      // Unchecked task list items
      if (/^- \[ \]/.test(line)) {
        return line.replace(/^- \[ \]/, "☐");
      }
      // Checked task list items
      if (/^- \[x\]/i.test(line)) {
        return line.replace(/^- \[x\]/i, "☑");
      }
      // Bold: **text** → *text*
      return line.replace(/\*\*([^*]+)\*\*/g, "*$1*");
    })
    .join("\n");
}

export async function postToSlack(opts: {
  webhookUrl: string;
  markdown: string;
  channel?: string;
}): Promise<void> {
  const text = markdownToMrkdwn(opts.markdown);

  const body: Record<string, unknown> = { text };
  if (opts.channel) {
    body.channel = opts.channel;
  }

  const response = await fetch(opts.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`Slack webhook failed (${response.status}): ${errorText}`);
  }
}

// ── Notion ────────────────────────────────────────────────────────────────────

type NotionRichText = {
  type: "text";
  text: { content: string };
};

type NotionBlock =
  | { object: "block"; type: "heading_2"; heading_2: { rich_text: NotionRichText[] } }
  | { object: "block"; type: "bulleted_list_item"; bulleted_list_item: { rich_text: NotionRichText[] } }
  | { object: "block"; type: "to_do"; to_do: { rich_text: NotionRichText[]; checked: boolean } }
  | { object: "block"; type: "paragraph"; paragraph: { rich_text: NotionRichText[] } };

function richText(content: string): NotionRichText[] {
  return [{ type: "text", text: { content } }];
}

function markdownToNotionBlocks(markdown: string): NotionBlock[] {
  const blocks: NotionBlock[] = [];

  for (const line of markdown.split("\n")) {
    if (line.trim() === "") continue;

    // H1 (treat as heading_2 since it's a sub-page)
    if (/^# /.test(line)) {
      blocks.push({
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: richText(line.replace(/^# /, "")) },
      });
      continue;
    }

    // H2/H3 → heading_2
    if (/^#{2,3} /.test(line)) {
      blocks.push({
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: richText(line.replace(/^#{2,3} /, "")) },
      });
      continue;
    }

    // Unchecked task list
    if (/^- \[ \]/.test(line)) {
      blocks.push({
        object: "block",
        type: "to_do",
        to_do: {
          rich_text: richText(line.replace(/^- \[ \]\s*/, "")),
          checked: false,
        },
      });
      continue;
    }

    // Checked task list
    if (/^- \[x\]/i.test(line)) {
      blocks.push({
        object: "block",
        type: "to_do",
        to_do: {
          rich_text: richText(line.replace(/^- \[x\]\s*/i, "")),
          checked: true,
        },
      });
      continue;
    }

    // Bullet list
    if (/^- /.test(line)) {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: richText(line.replace(/^- /, "")) },
      });
      continue;
    }

    // Paragraph
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: richText(line) },
    });
  }

  return blocks;
}

export async function postToNotion(opts: {
  token: string;
  parentPageId: string;
  title: string;
  markdown: string;
}): Promise<string> {
  const blocks = markdownToNotionBlocks(opts.markdown);

  const body = {
    parent: { type: "page_id", page_id: opts.parentPageId },
    properties: {
      title: {
        title: [{ type: "text", text: { content: opts.title } }],
      },
    },
    children: blocks,
  };

  const response = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`Notion API failed (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as { url?: string; id: string };
  return data.url ?? `https://www.notion.so/${data.id.replace(/-/g, "")}`;
}
