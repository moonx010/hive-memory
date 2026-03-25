/**
 * Notion Connector — extracts pages and database entries from Notion
 * via the Notion API v1.
 *
 * Required environment variables:
 *   NOTION_TOKEN      — Integration token (secret_...)
 *   NOTION_DATABASES  — Comma-separated database IDs (optional)
 *   NOTION_PAGES      — Comma-separated page IDs (optional)
 */

import type { ConnectorPlugin, RawDocument, EntityDraft } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface NotionPage {
  id: string;
  object: "page";
  created_time: string;
  last_edited_time: string;
  url: string;
  properties: Record<string, NotionProperty>;
  parent: {
    type: "database_id" | "page_id" | "workspace";
    database_id?: string;
    page_id?: string;
  };
  created_by?: { id: string };
  last_edited_by?: { id: string };
}

interface NotionProperty {
  type: string;
  title?: Array<{ plain_text: string }>;
  rich_text?: Array<{ plain_text: string }>;
  select?: { name: string } | null;
  multi_select?: Array<{ name: string }>;
  status?: { name: string } | null;
  number?: number | null;
  checkbox?: boolean;
  date?: { start: string; end?: string } | null;
  people?: Array<{ id: string; name?: string }>;
  url?: string | null;
}

interface NotionBlock {
  id: string;
  type: string;
  has_children: boolean;
  paragraph?: { rich_text: Array<{ plain_text: string }> };
  heading_1?: { rich_text: Array<{ plain_text: string }> };
  heading_2?: { rich_text: Array<{ plain_text: string }> };
  heading_3?: { rich_text: Array<{ plain_text: string }> };
  bulleted_list_item?: { rich_text: Array<{ plain_text: string }> };
  numbered_list_item?: { rich_text: Array<{ plain_text: string }> };
  code?: { rich_text: Array<{ plain_text: string }>; language?: string };
  toggle?: { rich_text: Array<{ plain_text: string }> };
  callout?: { rich_text: Array<{ plain_text: string }>; icon?: { emoji?: string } };
  quote?: { rich_text: Array<{ plain_text: string }> };
  divider?: Record<string, unknown>;
  child_page?: { title: string };
  child_database?: { title: string };
}

interface NotionSearchResponse {
  results: NotionPage[];
  has_more: boolean;
  next_cursor?: string | null;
}

interface NotionBlocksResponse {
  results: NotionBlock[];
  has_more: boolean;
  next_cursor?: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimum delay between requests to stay within the 3 req/s rate limit */
const REQUEST_DELAY_MS = 350;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractTitle(page: NotionPage): string {
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title" && prop.title?.length) {
      return prop.title.map((t) => t.plain_text).join("");
    }
  }
  return page.id;
}

function extractStatus(page: NotionPage): string | undefined {
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "status" && prop.status?.name) return prop.status.name;
    if (prop.type === "select" && prop.select?.name) return prop.select.name;
  }
  return undefined;
}

function propertiesToAttributes(props: Record<string, NotionProperty>): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};

  for (const [key, prop] of Object.entries(props)) {
    switch (prop.type) {
      case "title":
        attrs[key] = prop.title?.map((t) => t.plain_text).join("") ?? "";
        break;
      case "rich_text":
        attrs[key] = prop.rich_text?.map((t) => t.plain_text).join("") ?? "";
        break;
      case "select":
        attrs[key] = prop.select?.name ?? null;
        break;
      case "multi_select":
        attrs[key] = (prop.multi_select ?? []).map((s) => s.name);
        break;
      case "status":
        attrs[key] = prop.status?.name ?? null;
        break;
      case "number":
        attrs[key] = prop.number ?? null;
        break;
      case "checkbox":
        attrs[key] = prop.checkbox ?? false;
        break;
      case "date":
        attrs[key] = prop.date ? { start: prop.date.start, end: prop.date.end } : null;
        break;
      case "url":
        attrs[key] = prop.url ?? null;
        break;
      case "people":
        attrs[key] = (prop.people ?? []).map((p) => p.name ?? p.id);
        break;
    }
  }

  return attrs;
}

function blockToText(block: NotionBlock): string {
  const richTextOf = (arr: Array<{ plain_text: string }> | undefined): string =>
    (arr ?? []).map((t) => t.plain_text).join("");

  switch (block.type) {
    case "paragraph":
      return richTextOf(block.paragraph?.rich_text) + "\n";
    case "heading_1":
      return `# ${richTextOf(block.heading_1?.rich_text)}\n`;
    case "heading_2":
      return `## ${richTextOf(block.heading_2?.rich_text)}\n`;
    case "heading_3":
      return `### ${richTextOf(block.heading_3?.rich_text)}\n`;
    case "bulleted_list_item":
      return `- ${richTextOf(block.bulleted_list_item?.rich_text)}\n`;
    case "numbered_list_item":
      return `1. ${richTextOf(block.numbered_list_item?.rich_text)}\n`;
    case "code": {
      const lang = block.code?.language ?? "";
      const code = richTextOf(block.code?.rich_text);
      return `\`\`\`${lang}\n${code}\n\`\`\`\n`;
    }
    case "toggle":
      return richTextOf(block.toggle?.rich_text) + "\n";
    case "callout": {
      const emoji = block.callout?.icon?.emoji ? `${block.callout.icon.emoji} ` : "";
      return `> ${emoji}${richTextOf(block.callout?.rich_text)}\n`;
    }
    case "quote":
      return `> ${richTextOf(block.quote?.rich_text)}\n`;
    case "divider":
      return "---\n";
    case "child_page":
      return `[Page: ${block.child_page?.title ?? ""}]\n`;
    case "child_database":
      return `[Database: ${block.child_database?.title ?? ""}]\n`;
    default:
      return "";
  }
}

function extractKeywords(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .slice(0, 20),
    ),
  ];
}

function isTaskPage(page: NotionPage): boolean {
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "status" || prop.type === "checkbox") return true;
  }
  // If page is in a database and has status-like properties
  return page.parent.type === "database_id";
}

// ── API helpers ──────────────────────────────────────────────────────────────

async function notionFetch(
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Response> {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After") ?? "5";
    await sleep(parseInt(retryAfter, 10) * 1000);
    return notionFetch(path, token, options);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Notion API error ${res.status} for ${path}: ${body}`);
  }

  return res;
}

// ── Connector ────────────────────────────────────────────────────────────────

export class NotionConnector implements ConnectorPlugin {
  readonly id = "notion";
  readonly name = "Notion";
  readonly description = "Syncs pages and database entries from Notion workspaces";
  readonly entityTypes = ["document", "task"];
  readonly domains = ["documents"];

  private cursor: string | undefined;
  private readonly token: string;
  private readonly databases: string[];
  private readonly pages: string[];

  constructor() {
    this.token = process.env.NOTION_TOKEN ?? "";
    this.databases = (process.env.NOTION_DATABASES ?? "")
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    this.pages = (process.env.NOTION_PAGES ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
  }

  isConfigured(): boolean {
    return this.token.length > 0;
  }

  getCursor(): string | undefined {
    return this.cursor;
  }

  async *fullSync(): AsyncGenerator<RawDocument> {
    this.cursor = new Date().toISOString();
    yield* this._searchAll(undefined);
  }

  async *incrementalSync(cursor?: string): AsyncGenerator<RawDocument> {
    const since = cursor ?? this.cursor;
    this.cursor = new Date().toISOString();
    yield* this._searchAll(since);
  }

  private async *_searchAll(since?: string): AsyncGenerator<RawDocument> {
    if (this.databases.length > 0) {
      for (const dbId of this.databases) {
        yield* this._queryDatabase(dbId, since);
      }
    } else if (this.pages.length > 0) {
      for (const pageId of this.pages) {
        yield* this._fetchPage(pageId);
      }
    } else {
      // Search all accessible pages
      yield* this._searchPages(since);
    }
  }

  private async *_searchPages(since?: string): AsyncGenerator<RawDocument> {
    let nextCursor: string | undefined;

    do {
      await sleep(REQUEST_DELAY_MS);

      const body: Record<string, unknown> = {
        filter: { value: "page", property: "object" },
        page_size: 100,
      };

      if (since) {
        body["filter"] = {
          and: [
            { value: "page", property: "object" },
            { timestamp: "last_edited_time", last_edited_time: { on_or_after: since } },
          ],
        };
      }

      if (nextCursor) body["start_cursor"] = nextCursor;

      const res = await notionFetch("/search", this.token, { method: "POST", body });
      const data = (await res.json()) as NotionSearchResponse;

      for (const page of data.results) {
        const doc = await this._pageToRawDocument(page);
        if (doc) yield doc;
      }

      nextCursor = data.next_cursor ?? undefined;
    } while (nextCursor);
  }

  private async *_queryDatabase(
    databaseId: string,
    since?: string,
  ): AsyncGenerator<RawDocument> {
    let nextCursor: string | undefined;

    do {
      await sleep(REQUEST_DELAY_MS);

      const body: Record<string, unknown> = { page_size: 100 };

      if (since) {
        body["filter"] = {
          timestamp: "last_edited_time",
          last_edited_time: { on_or_after: since },
        };
      }

      if (nextCursor) body["start_cursor"] = nextCursor;

      const res = await notionFetch(`/databases/${databaseId}/query`, this.token, {
        method: "POST",
        body,
      });
      const data = (await res.json()) as NotionSearchResponse;

      for (const page of data.results) {
        const doc = await this._pageToRawDocument(page);
        if (doc) yield doc;
      }

      nextCursor = data.next_cursor ?? undefined;
    } while (nextCursor);
  }

  private async *_fetchPage(pageId: string): AsyncGenerator<RawDocument> {
    await sleep(REQUEST_DELAY_MS);
    const res = await notionFetch(`/pages/${pageId}`, this.token);
    const page = (await res.json()) as NotionPage;
    const doc = await this._pageToRawDocument(page);
    if (doc) yield doc;
  }

  private async _pageToRawDocument(page: NotionPage): Promise<RawDocument | null> {
    try {
      const title = extractTitle(page);
      const content = await this._fetchBlockContent(page.id);
      const fullContent = content.trim() || title;

      return {
        externalId: `notion:page:${page.id}`,
        source: "notion",
        content: fullContent,
        title,
        url: page.url,
        timestamp: page.last_edited_time,
        metadata: {
          pageId: page.id,
          parentType: page.parent.type,
          parentId: page.parent.database_id ?? page.parent.page_id,
          createdTime: page.created_time,
          properties: page.properties,
          isDatabase: page.parent.type === "database_id",
          status: extractStatus(page),
        },
      };
    } catch {
      return null;
    }
  }

  private async _fetchBlockContent(pageId: string, depth = 0): Promise<string> {
    if (depth > 2) return ""; // limit recursion

    await sleep(REQUEST_DELAY_MS);

    let text = "";
    let nextCursor: string | undefined;

    do {
      let path = `/blocks/${pageId}/children?page_size=100`;
      if (nextCursor) path += `&start_cursor=${encodeURIComponent(nextCursor)}`;

      const res = await notionFetch(path, this.token);
      const data = (await res.json()) as NotionBlocksResponse;

      for (const block of data.results) {
        text += blockToText(block);

        if (block.has_children && depth < 2) {
          await sleep(REQUEST_DELAY_MS);
          const childText = await this._fetchBlockContent(block.id, depth + 1);
          text += childText;
        }
      }

      nextCursor = data.next_cursor ?? undefined;
    } while (nextCursor);

    return text;
  }

  transform(doc: RawDocument): EntityDraft[] {
    const meta = doc.metadata as Record<string, unknown>;
    const isDatabase = meta.isDatabase as boolean;
    const status = meta.status as string | undefined;
    const props = meta.properties as Record<string, NotionProperty> | undefined;

    const keywords = extractKeywords(doc.content);
    const attributes = props ? propertiesToAttributes(props) : {};
    attributes["keywords"] = keywords;
    if (status) attributes["status"] = status;

    // Determine entity type based on presence of status-like properties
    const entityType =
      isDatabase && (status !== undefined || this._hasTaskProperties(props ?? {}))
        ? "task"
        : "document";

    // Derive tags from multi_select and select properties
    const tags: string[] = ["notion"];
    if (props) {
      for (const prop of Object.values(props)) {
        if (prop.type === "multi_select") {
          for (const s of prop.multi_select ?? []) {
            tags.push(s.name.toLowerCase().replace(/\s+/g, "-"));
          }
        }
      }
    }

    return [
      {
        entityType,
        title: doc.title,
        content: doc.content,
        tags,
        attributes,
        source: {
          system: "notion",
          externalId: doc.externalId,
          url: doc.url,
          connector: this.id,
        },
        domain: "documents",
        confidence: "confirmed",
      },
    ];
  }

  private _hasTaskProperties(props: Record<string, NotionProperty>): boolean {
    return Object.values(props).some(
      (p) => p.type === "status" || p.type === "checkbox" || p.type === "select",
    );
  }
}
