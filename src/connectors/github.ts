/**
 * GitHub Connector — extracts PRs, Issues, ADR files and CODEOWNERS
 * from GitHub repositories via the REST API.
 *
 * Required environment variables:
 *   GITHUB_TOKEN  — Personal access token
 *   GITHUB_REPOS  — Comma-separated list of repos, e.g. "owner/repo1,owner/repo2"
 */

import type { ConnectorPlugin, RawDocument, EntityDraft } from "./types.js";
import type { CheckpointManager } from "./checkpoint.js";
import type { HiveDatabase } from "../db/database.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface GitHubPR {
  number: number;
  title: string;
  body: string | null;
  state: string;
  merged_at: string | null;
  html_url: string;
  updated_at: string;
  created_at: string;
  user: { login: string } | null;
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  updated_at: string;
  created_at: string;
  user: { login: string } | null;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  pull_request?: unknown; // present when the issue is actually a PR
}

interface GitHubContent {
  name: string;
  path: string;
  download_url: string | null;
  type: "file" | "dir" | "symlink" | "submodule";
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function extractDecisionSections(body: string): string | null {
  const patterns = [
    /##\s*decision[s]?\s*\n([\s\S]*?)(?=\n##|\s*$)/i,
    /##\s*why\s*\n([\s\S]*?)(?=\n##|\s*$)/i,
    /tl;dr[:\s]*([\s\S]*?)(?=\n##|\n\n|$)/i,
    /##\s*context\s*\n([\s\S]*?)(?=\n##|\s*$)/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(body);
    if (match?.[1]?.trim().length ?? 0 > 30) {
      return match![1].trim();
    }
  }
  return null;
}

function parseAdr(content: string, path: string): { title: string; status: string; body: string } {
  const titleMatch = /^#\s+(.+)/m.exec(content);
  const statusMatch = /##\s*status\s*\n+([^\n]+)/i.exec(content);
  const title = titleMatch?.[1]?.trim() ?? path.split("/").pop() ?? path;
  const status = statusMatch?.[1]?.trim().toLowerCase() ?? "unknown";
  return { title, status, body: content };
}

async function githubFetch(url: string, token: string): Promise<Response> {
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (res.status === 429 || res.status === 403) {
    const retryAfter = res.headers.get("Retry-After");
    const resetAt = res.headers.get("X-RateLimit-Reset");
    let waitMs = 60_000;
    if (retryAfter) {
      waitMs = parseInt(retryAfter, 10) * 1000;
    } else if (resetAt) {
      waitMs = Math.max(0, parseInt(resetAt, 10) * 1000 - Date.now()) + 1000;
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return githubFetch(url, token);
  }

  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status} for ${url}: ${await res.text()}`);
  }

  return res;
}

// ── Connector ────────────────────────────────────────────────────────────────

export class GitHubConnector implements ConnectorPlugin {
  readonly id = "github";
  readonly name = "GitHub";
  readonly description = "Syncs PRs, Issues, ADR files, and CODEOWNERS from GitHub repositories";
  readonly entityTypes = ["document", "task", "decision", "person"];
  readonly domains = ["code", "documents"];

  private cursor: string | undefined;
  private readonly token: string;
  private readonly repos: string[];
  private _syncedPRExternalIds: Array<{ docExternalId: string; authorLogin: string }> = [];

  constructor() {
    this.token = process.env.GITHUB_TOKEN ?? "";
    this.repos = (process.env.GITHUB_REPOS ?? "")
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
  }

  isConfigured(): boolean {
    return this.token.length > 0 && this.repos.length > 0;
  }

  getCursor(): string | undefined {
    return this.cursor;
  }

  async *fullSync(checkpoint?: CheckpointManager): AsyncGenerator<RawDocument> {
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    yield* this._syncAll(since, checkpoint);
  }

  async *incrementalSync(cursor?: string): AsyncGenerator<RawDocument> {
    const since = cursor ?? this.cursor;
    yield* this._syncAll(since);
  }

  async *rollbackSync(window: { since: string; until: string }): AsyncGenerator<RawDocument> {
    // Re-fetch PRs and issues updated within the rollback window.
    // ADRs and CODEOWNERS are skipped (static content, rarely change).
    for (const repo of this.repos) {
      yield* this._syncPRs(repo, window.since);
      yield* this._syncIssues(repo, window.since);
    }
  }

  private async *_syncAll(since?: string, checkpoint?: CheckpointManager): AsyncGenerator<RawDocument> {
    this.cursor = new Date().toISOString();
    this._syncedPRExternalIds = [];

    for (const repo of this.repos) {
      yield* this._syncPRs(repo, since, checkpoint);
      yield* this._syncIssues(repo, since, checkpoint);
      yield* this._syncADRFiles(repo, checkpoint);
      yield* this._syncCodeowners(repo);
    }
  }

  private async *_syncPRs(
    repo: string,
    since?: string,
    checkpoint?: CheckpointManager,
  ): AsyncGenerator<RawDocument> {
    const streamId = `github:${repo}:pulls`;

    // Skip if stream was completed in a previous run
    if (checkpoint?.isStreamComplete(streamId)) return;

    const sinceParam = since ? `&since=${since}` : "";
    const baseUrl = `https://api.github.com/repos/${repo}/pulls?state=all&per_page=100&sort=updated&direction=desc${sinceParam}`;

    // Resume from checkpoint page token if available
    let url: string | null = checkpoint?.getStreamPageToken(streamId) ?? baseUrl;

    while (url) {
      const res = await githubFetch(url, this.token);
      const items = (await res.json()) as GitHubPR[];

      for (const pr of items) {
        // Skip very old PRs when doing incremental
        if (since && pr.updated_at < since) {
          checkpoint?.updateStream(streamId, { complete: true });
          checkpoint?.flush();
          return;
        }

        // Track for postSync synapse creation
        if (pr.user?.login) {
          this._syncedPRExternalIds.push({
            docExternalId: `github:pr:${repo}:${pr.number}`,
            authorLogin: pr.user.login,
          });
        }

        yield {
          externalId: `github:pr:${repo}:${pr.number}`,
          source: "github",
          content: [pr.title, pr.body ?? ""].join("\n\n"),
          title: pr.title,
          url: pr.html_url,
          author: pr.user?.login,
          timestamp: pr.updated_at,
          metadata: {
            type: "pull_request",
            repo,
            number: pr.number,
            state: pr.state,
            mergedAt: pr.merged_at,
            createdAt: pr.created_at,
          },
        };
      }

      // Parse next page URL from Link header
      const link = res.headers.get("Link") ?? "";
      const nextMatch = /<([^>]+)>;\s*rel="next"/.exec(link);
      const nextUrl = nextMatch?.[1] ?? null;

      // Checkpoint after each page
      if (checkpoint) {
        const pagesProcessed = (checkpoint.getProgress()?.streams ?? 0) + 1;
        checkpoint.updateStream(streamId, {
          pageToken: nextUrl ?? undefined,
          pagesProcessed,
        });
        checkpoint.flush();
      }

      url = nextUrl;
    }

    checkpoint?.updateStream(streamId, { complete: true });
    checkpoint?.flush();
  }

  private async *_syncIssues(
    repo: string,
    since?: string,
    checkpoint?: CheckpointManager,
  ): AsyncGenerator<RawDocument> {
    const streamId = `github:${repo}:issues`;

    // Skip if stream was completed in a previous run
    if (checkpoint?.isStreamComplete(streamId)) return;

    const sinceParam = since ? `&since=${since}` : "";
    const baseUrl = `https://api.github.com/repos/${repo}/issues?state=all&per_page=100&sort=updated&direction=desc${sinceParam}`;

    // Resume from checkpoint page token if available
    let url: string | null = checkpoint?.getStreamPageToken(streamId) ?? baseUrl;

    while (url) {
      const res = await githubFetch(url, this.token);
      const items = (await res.json()) as GitHubIssue[];

      for (const issue of items) {
        // GitHub returns PRs in the issues endpoint — skip them
        if (issue.pull_request !== undefined) continue;
        if (since && issue.updated_at < since) {
          checkpoint?.updateStream(streamId, { complete: true });
          checkpoint?.flush();
          return;
        }

        // Track for postSync synapse creation
        if (issue.user?.login) {
          this._syncedPRExternalIds.push({
            docExternalId: `github:issue:${repo}:${issue.number}`,
            authorLogin: issue.user.login,
          });
        }

        yield {
          externalId: `github:issue:${repo}:${issue.number}`,
          source: "github",
          content: [issue.title, issue.body ?? ""].join("\n\n"),
          title: issue.title,
          url: issue.html_url,
          author: issue.user?.login,
          timestamp: issue.updated_at,
          metadata: {
            type: "issue",
            repo,
            number: issue.number,
            state: issue.state,
            labels: issue.labels.map((l) => l.name),
            assignees: issue.assignees.map((a) => a.login),
            createdAt: issue.created_at,
          },
        };
      }

      // Parse next page URL from Link header
      const link = res.headers.get("Link") ?? "";
      const nextMatch = /<([^>]+)>;\s*rel="next"/.exec(link);
      const nextUrl = nextMatch?.[1] ?? null;

      // Checkpoint after each page
      if (checkpoint) {
        const pagesProcessed = (checkpoint.getProgress()?.streams ?? 0) + 1;
        checkpoint.updateStream(streamId, {
          pageToken: nextUrl ?? undefined,
          pagesProcessed,
        });
        checkpoint.flush();
      }

      url = nextUrl;
    }

    checkpoint?.updateStream(streamId, { complete: true });
    checkpoint?.flush();
  }

  private async *_syncADRFiles(
    repo: string,
    checkpoint?: CheckpointManager,
  ): AsyncGenerator<RawDocument> {
    const adrPaths = ["docs/decisions", "docs/adr"];

    for (const adrPath of adrPaths) {
      const streamId = `github:${repo}:adr:${adrPath}`;

      // Skip if stream was completed in a previous run
      if (checkpoint?.isStreamComplete(streamId)) continue;

      let items: GitHubContent[];
      try {
        const res = await githubFetch(
          `https://api.github.com/repos/${repo}/contents/${adrPath}`,
          this.token,
        );
        items = (await res.json()) as GitHubContent[];
      } catch {
        // Directory doesn't exist — skip silently
        checkpoint?.updateStream(streamId, { complete: true });
        checkpoint?.flush();
        continue;
      }

      for (const item of items) {
        if (item.type !== "file" || !item.name.endsWith(".md")) continue;
        if (!item.download_url) continue;

        try {
          const contentRes = await fetch(item.download_url);
          if (!contentRes.ok) continue;
          const rawContent = await contentRes.text();

          yield {
            externalId: `github:adr:${repo}:${item.path}`,
            source: "github",
            content: rawContent,
            title: item.name.replace(/\.md$/, ""),
            url: `https://github.com/${repo}/blob/HEAD/${item.path}`,
            timestamp: new Date().toISOString(),
            metadata: {
              type: "adr",
              repo,
              path: item.path,
            },
          };
        } catch {
          // Individual file failure — skip and continue
          continue;
        }
      }

      checkpoint?.updateStream(streamId, { complete: true });
      checkpoint?.flush();
    }
  }

  private async *_syncCodeowners(repo: string): AsyncGenerator<RawDocument> {
    const codeownerPaths = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"];

    for (const path of codeownerPaths) {
      try {
        const res = await githubFetch(
          `https://api.github.com/repos/${repo}/contents/${path}`,
          this.token,
        );
        const info = (await res.json()) as { download_url: string | null; content?: string; encoding?: string };

        let rawContent: string;
        if (info.encoding === "base64" && info.content) {
          rawContent = Buffer.from(info.content.replace(/\n/g, ""), "base64").toString("utf-8");
        } else if (info.download_url) {
          const dl = await fetch(info.download_url);
          rawContent = await dl.text();
        } else {
          continue;
        }

        yield {
          externalId: `github:codeowners:${repo}`,
          source: "github",
          content: rawContent,
          title: `CODEOWNERS — ${repo}`,
          url: `https://github.com/${repo}/blob/HEAD/${path}`,
          timestamp: new Date().toISOString(),
          metadata: {
            type: "codeowners",
            repo,
            path,
          },
        };
        // Found one — stop looking
        break;
      } catch {
        continue;
      }
    }
  }

  transform(doc: RawDocument): EntityDraft[] {
    const drafts: EntityDraft[] = [];
    const meta = doc.metadata as Record<string, unknown>;
    const repo = meta.repo as string;

    switch (meta.type) {
      case "pull_request":
        drafts.push(...this._transformPR(doc, repo));
        break;
      case "issue":
        drafts.push(...this._transformIssue(doc, repo));
        break;
      case "adr":
        drafts.push(...this._transformADR(doc, repo));
        break;
      case "codeowners":
        drafts.push(...this._transformCodeowners(doc, repo));
        break;
    }

    return drafts;
  }

  private _transformPR(doc: RawDocument, repo: string): EntityDraft[] {
    const meta = doc.metadata as Record<string, unknown>;
    const drafts: EntityDraft[] = [];
    const body = doc.content;
    const keywords = extractKeywords(body);

    // Main PR document entity
    drafts.push({
      entityType: "document",
      title: doc.title,
      content: body,
      tags: ["pull-request", repo.split("/")[1] ?? repo],
      attributes: {
        repo,
        prNumber: meta.number,
        state: meta.state,
        mergedAt: meta.mergedAt,
        createdAt: meta.createdAt,
        keywords,
      },
      source: {
        system: "github",
        externalId: doc.externalId,
        url: doc.url,
        connector: this.id,
      },
      author: doc.author,
      domain: "code",
      confidence: "confirmed",
    });

    // Decision entity if PR body has decision sections
    const rawBody = (doc.content.split("\n\n").slice(1).join("\n\n") || "").trim();
    if (rawBody.length > 50) {
      const decisionText = extractDecisionSections(rawBody);
      if (decisionText) {
        drafts.push({
          entityType: "decision",
          title: `Decision: ${doc.title ?? ""}`,
          content: decisionText,
          tags: ["decision", "pull-request", repo.split("/")[1] ?? repo],
          attributes: {
            repo,
            prNumber: meta.number,
            source: "pr-description",
          },
          source: {
            system: "github",
            externalId: `${doc.externalId}:decision`,
            url: doc.url,
            connector: this.id,
          },
          author: doc.author,
          domain: "code",
          confidence: "inferred",
        });
      }
    }

    // Person entity for PR author
    if (doc.author) {
      drafts.push(this._personDraft(doc.author, repo));
    }

    return drafts;
  }

  private _transformIssue(doc: RawDocument, repo: string): EntityDraft[] {
    const meta = doc.metadata as Record<string, unknown>;
    const keywords = extractKeywords(doc.content);
    const labels = (meta.labels as string[]) ?? [];
    const assignees = (meta.assignees as string[]) ?? [];
    const drafts: EntityDraft[] = [];

    drafts.push({
      entityType: "task",
      title: doc.title,
      content: doc.content,
      tags: ["issue", repo.split("/")[1] ?? repo, ...labels],
      attributes: {
        repo,
        issueNumber: meta.number,
        state: meta.state,
        labels,
        assignees,
        createdAt: meta.createdAt,
        keywords,
      },
      source: {
        system: "github",
        externalId: doc.externalId,
        url: doc.url,
        connector: this.id,
      },
      author: doc.author,
      domain: "code",
      confidence: "confirmed",
    });

    // Person entities for assignees
    for (const login of assignees) {
      drafts.push(this._personDraft(login, repo));
    }

    return drafts;
  }

  private _transformADR(doc: RawDocument, repo: string): EntityDraft[] {
    const meta = doc.metadata as Record<string, unknown>;
    const parsed = parseAdr(doc.content, meta.path as string);
    const keywords = extractKeywords(doc.content);

    return [
      {
        entityType: "decision",
        title: parsed.title,
        content: parsed.body,
        tags: ["adr", "architecture", repo.split("/")[1] ?? repo],
        attributes: {
          repo,
          path: meta.path,
          adrStatus: parsed.status,
          keywords,
        },
        source: {
          system: "github",
          externalId: doc.externalId,
          url: doc.url,
          connector: this.id,
        },
        domain: "documents",
        confidence: "confirmed",
      },
    ];
  }

  private _transformCodeowners(doc: RawDocument, repo: string): EntityDraft[] {
    const drafts: EntityDraft[] = [];
    const lines = doc.content.split("\n");

    // Parse CODEOWNERS and create person entities with ownership info
    const ownershipMap: Record<string, string[]> = {};

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const parts = trimmed.split(/\s+/);
      const pattern = parts[0];
      const owners = parts.slice(1).filter((o) => o.startsWith("@"));

      if (!pattern || owners.length === 0) continue;

      for (const owner of owners) {
        const login = owner.replace(/^@/, "").split("/").pop() ?? owner;
        if (!ownershipMap[login]) ownershipMap[login] = [];
        ownershipMap[login].push(pattern ?? "");
      }
    }

    for (const [login, patterns] of Object.entries(ownershipMap)) {
      drafts.push({
        entityType: "person",
        title: login,
        content: `GitHub user ${login} owns: ${patterns.slice(0, 10).join(", ")}`,
        tags: ["person", "codeowner", repo.split("/")[1] ?? repo],
        attributes: {
          login,
          repo,
          ownedPaths: patterns,
        },
        source: {
          system: "github",
          externalId: `github:person:${login}`,
          url: `https://github.com/${login}`,
          connector: this.id,
        },
        domain: "code",
        confidence: "confirmed",
      });
    }

    return drafts;
  }

  private _personDraft(login: string, repo: string): EntityDraft {
    return {
      entityType: "person",
      title: login,
      content: `GitHub user ${login}`,
      tags: ["person", repo.split("/")[1] ?? repo],
      attributes: { login, repo },
      source: {
        system: "github",
        externalId: `github:person:${login}`,
        url: `https://github.com/${login}`,
        connector: this.id,
      },
      domain: "code",
      confidence: "inferred",
    };
  }

  postSync(db: HiveDatabase, entityMap: Map<string, string>): void {
    // Create "authored" synapses: person → document/task
    for (const { docExternalId, authorLogin } of this._syncedPRExternalIds) {
      const docId = entityMap.get(docExternalId);
      const personId = entityMap.get(`github:person:${authorLogin}`);
      if (!docId || !personId) continue;

      db.upsertSynapse({
        sourceId: personId,
        targetId: docId,
        axon: "authored",
        weight: 1.0,
      });
    }
  }
}
