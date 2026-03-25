import { z } from "zod";
import { HiveDatabase } from "../db/database.js";
import type { Entity } from "../types.js";
import type { SafeToolFn } from "./index.js";

// ── Helpers ──

function snippet(content: string, maxLen = 120): string {
  const cleaned = content.replace(/\s+/g, " ").trim();
  return cleaned.length <= maxLen ? cleaned : `${cleaned.slice(0, maxLen)}…`;
}

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

/** Weight for recency scoring: more recent = higher score */
function recencyWeight(iso: string): number {
  const ageDays = (Date.now() - new Date(iso).getTime()) / 86_400_000;
  // Decay: score = 1 / (1 + age_days / 30) — halves around 30 days
  return 1 / (1 + ageDays / 30);
}

export function registerTrailTools(safeTool: SafeToolFn, db: HiveDatabase) {
  // ── memory_trail ──

  safeTool(
    "memory_trail",
    "Cross-domain timeline for a topic. Searches for a topic across all domains and presents a unified timeline grouped by domain.",
    {
      topic: z
        .string()
        .describe("Topic or concept to trace across domains (e.g. 'sqlite migration', 'auth')"),
      domains: z
        .array(z.string())
        .optional()
        .describe("Domain filter — only show entries from these domains"),
      limit: z.number().optional().describe("Max entries to show (default 20)"),
    },
    async (args) => {
      const topic = args.topic as string;
      const domains = args.domains as string[] | undefined;
      const limit = (args.limit as number | undefined) ?? 20;

      // FTS5 search across all domains
      const results = db.searchEntities(topic, { limit: limit * 3 });

      if (results.length === 0) {
        return {
          content: [
            { type: "text" as const, text: `No entries found for topic: "${topic}".` },
          ],
        };
      }

      // Filter by domains if specified
      const filtered = domains && domains.length > 0
        ? results.filter((e) => domains.includes(e.domain))
        : results;

      if (filtered.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No entries found for topic: "${topic}" in domains: ${domains!.join(", ")}.`,
            },
          ],
        };
      }

      // Sort by date descending, cap at limit
      const sorted = filtered
        .slice(0, limit)
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

      // Group by domain
      const byDomain = new Map<string, Entity[]>();
      for (const e of sorted) {
        const group = byDomain.get(e.domain) ?? [];
        group.push(e);
        byDomain.set(e.domain, group);
      }

      const lines: string[] = [
        `Trail: "${topic}"  — ${sorted.length} result(s) across ${byDomain.size} domain(s)`,
        ``,
      ];

      // Chronological cross-domain timeline
      lines.push(`── Chronological ──`);
      lines.push(``);
      for (const e of sorted) {
        const date = formatDate(e.updatedAt);
        const projectLabel = e.project ? `[${e.project}] ` : "";
        const title = e.title ?? snippet(e.content, 60);
        lines.push(`  ${date}  <${e.domain}>  ${projectLabel}${title}`);
        lines.push(`           id:${e.id}  type:${e.entityType}`);
      }
      lines.push(``);

      // By-domain summary
      lines.push(`── By Domain ──`);
      lines.push(``);
      for (const [domain, entries] of byDomain.entries()) {
        lines.push(`  ${domain} (${entries.length})`);
        for (const e of entries.slice(0, 3)) {
          const title = e.title ?? snippet(e.content, 60);
          lines.push(`    · ${title}  (${formatDate(e.updatedAt)})`);
        }
        if (entries.length > 3) {
          lines.push(`    · … ${entries.length - 3} more`);
        }
        lines.push(``);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  // ── memory_who ──

  safeTool(
    "memory_who",
    "Find expertise on a topic. Searches for entries about a topic, groups by author, and ranks by entry count weighted by recency.",
    {
      topic: z
        .string()
        .describe("Topic or concept to find expertise for (e.g. 'typescript generics', 'auth')"),
      limit: z.number().optional().describe("Max authors to return (default 5)"),
    },
    async (args) => {
      const topic = args.topic as string;
      const limit = (args.limit as number | undefined) ?? 5;

      // Search broadly so we can rank authors
      const results = db.searchEntities(topic, { limit: 100 });

      if (results.length === 0) {
        return {
          content: [
            { type: "text" as const, text: `No entries found for topic: "${topic}".` },
          ],
        };
      }

      // Group by author
      const authorMap = new Map<
        string,
        { entries: Entity[]; score: number }
      >();

      for (const e of results) {
        const author = e.author ?? "(unknown)";
        const existing = authorMap.get(author) ?? { entries: [], score: 0 };
        existing.entries.push(e);
        existing.score += recencyWeight(e.updatedAt);
        authorMap.set(author, existing);
      }

      // Sort by score descending
      const ranked = [...authorMap.entries()]
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, limit);

      const lines: string[] = [
        `Who knows about: "${topic}"  — ${ranked.length} author(s) found`,
        ``,
      ];

      for (let i = 0; i < ranked.length; i++) {
        const [author, { entries, score }] = ranked[i];
        const rank = `${i + 1}.`;
        const entryCount = entries.length;
        const latestDate = entries
          .map((e) => e.updatedAt)
          .sort()
          .reverse()[0];

        lines.push(
          `${rank} ${author}  (${entryCount} entries, score:${score.toFixed(2)}, last:${formatDate(latestDate ?? "")})`,
        );

        // Show up to 3 relevant entries
        const topEntries = entries
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
          .slice(0, 3);

        for (const e of topEntries) {
          const title = e.title ?? snippet(e.content, 60);
          const projectLabel = e.project ? `[${e.project}] ` : "";
          lines.push(
            `   · ${projectLabel}${title}  (${formatDate(e.updatedAt)}, ${e.entityType})`,
          );
        }
        if (entries.length > 3) {
          lines.push(`   · … ${entries.length - 3} more`);
        }
        lines.push(``);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  // ── memory_decay ──

  safeTool(
    "memory_decay",
    "Run memory decay and cleanup. Identifies stale entries and applies synapse weight decay (LTD). Use dry_run=true (default) to preview changes.",
    {
      dry_run: z
        .boolean()
        .optional()
        .describe("Preview only — do not apply changes (default true)"),
    },
    async (args) => {
      const dryRun = (args.dry_run as boolean | undefined) ?? true;

      // 1. Find entities past their expiresAt
      const now = new Date().toISOString();
      const candidateEntities = db.listEntities({ sort: "updated_at", order: "asc", limit: 10000 });
      const trueExpired = candidateEntities.filter(
        (e) => e.expiresAt && e.expiresAt <= now && e.status !== "archived",
      );

      // 2. Find stale inferred entries (confidence=inferred, 90+ days old)
      const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
      const staleInferred = candidateEntities.filter((e) => {
        if (e.confidence !== "inferred") return false;
        if (e.status === "archived") return false;
        return Date.now() - new Date(e.updatedAt).getTime() > ninetyDaysMs;
      });

      const lines: string[] = [
        `Memory Decay Report${dryRun ? " (DRY RUN — no changes applied)" : " (APPLIED)"}`,
        ``,
        `━━━ Expired Entries (past expiresAt) ━━━`,
        ``,
        `  Found: ${trueExpired.length} entries`,
      ];

      if (trueExpired.length > 0) {
        for (const e of trueExpired.slice(0, 10)) {
          const title = e.title ?? snippet(e.content, 50);
          lines.push(`  · [${e.id}]  ${title}  (expired: ${e.expiresAt ?? "?"})`);
        }
        if (trueExpired.length > 10) {
          lines.push(`  · … ${trueExpired.length - 10} more`);
        }
      }

      lines.push(``);
      lines.push(
        `━━━ Stale Inferred Entries (confidence=inferred, 90+ days old) ━━━`,
      );
      lines.push(``);
      lines.push(`  Found: ${staleInferred.length} entries`);

      if (staleInferred.length > 0) {
        for (const e of staleInferred.slice(0, 10)) {
          const title = e.title ?? snippet(e.content, 50);
          const ageDays = Math.floor(
            (Date.now() - new Date(e.updatedAt).getTime()) / 86_400_000,
          );
          lines.push(`  · [${e.id}]  ${title}  (${ageDays}d old)`);
        }
        if (staleInferred.length > 10) {
          lines.push(`  · … ${staleInferred.length - 10} more`);
        }
      }

      lines.push(``);
      lines.push(`━━━ Synapse Decay (LTD) ━━━`);
      lines.push(``);

      let prunedSynapses = 0;

      if (!dryRun) {
        // Archive expired entries
        for (const e of trueExpired) {
          db.updateEntity(e.id, { status: "archived" });
        }
        // Archive stale inferred entries
        for (const e of staleInferred) {
          db.updateEntity(e.id, { status: "archived" });
        }
        // Apply synapse LTD decay + prune
        prunedSynapses = db.applyDecay();

        lines.push(`  Entries archived: ${trueExpired.length + staleInferred.length}`);
        lines.push(`  Synapses pruned (LTD): ${prunedSynapses}`);
      } else {
        lines.push(`  Would archive: ${trueExpired.length + staleInferred.length} entries`);
        lines.push(`  Synapse decay: would apply LTD and prune below threshold`);
        lines.push(``);
        lines.push(`  Run with dry_run=false to apply.`);
      }

      lines.push(``);
      lines.push(
        dryRun
          ? `Dry run complete. No changes made.`
          : `Decay applied. ${trueExpired.length + staleInferred.length} entries archived, ${prunedSynapses} synapses pruned.`,
      );

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );
}
