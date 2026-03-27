import { z } from "zod";
import { HiveDatabase } from "../db/database.js";
import type { Entity } from "../types.js";
import type { SafeToolFn, ACLResolver, GetUserContext } from "./index.js";

// ── Helpers ──

function snippet(content: string, maxLen = 120): string {
  const cleaned = content.replace(/\s+/g, " ").trim();
  return cleaned.length <= maxLen ? cleaned : `${cleaned.slice(0, maxLen)}…`;
}

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Parse a path string into { namespace, project, entityType }.
 * "/" → top level (namespaces)
 * "/local" → namespace only
 * "/local/jarvis" → project within namespace
 * "/local/jarvis/decision" → entity type within project
 */
function parsePath(path: string): { namespace?: string; project?: string; entityType?: string } {
  const parts = path.replace(/^\//, "").split("/").filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { namespace: parts[0] };
  if (parts.length === 2) return { namespace: parts[0], project: parts[1] };
  return { namespace: parts[0], project: parts[1], entityType: parts[2] };
}

/** Type icons for timeline display */
const TYPE_ICONS: Record<string, string> = {
  decision: "[!]",
  memory: "[m]",
  reference: "[r]",
  note: "[n]",
  learning: "[l]",
  status: "[s]",
};

function typeIcon(entityType: string): string {
  return TYPE_ICONS[entityType] ?? "[*]";
}

export function registerBrowseTools(safeTool: SafeToolFn, db: HiveDatabase, aclResolver?: ACLResolver, getUserContext?: GetUserContext) {
  // Helper to resolve ACL for the current request
  function resolveAcl() {
    if (!aclResolver || !getUserContext) return undefined;
    return aclResolver(getUserContext(), db) ?? undefined;
  }

  // ── memory_ls ──

  safeTool(
    "memory_ls",
    'Browse entities like `ls`. Use "/" to list namespaces, "/local" for all projects, "/local/{project}" for entity type breakdown, "/local/{project}/{type}" for entries.',
    {
      path: z
        .string()
        .default("/")
        .describe(
          'Path to browse: "/" (namespaces), "/local" (projects), "/local/{project}" (entity types), "/local/{project}/{entityType}" (entries)',
        ),
      sort: z
        .enum(["recent", "name"])
        .optional()
        .describe('Sort order: "recent" (default), "name"'),
      limit: z.number().optional().describe("Max entries to show (default 20)"),
      offset: z.number().optional().describe("Offset for pagination (default 0)"),
    },
    async (args) => {
      const path = (args.path as string | undefined) ?? "/";
      const sortArg = (args.sort as "recent" | "name" | undefined) ?? "recent";
      const dbSort = sortArg === "name" ? "created_at" : "updated_at";
      const limit = (args.limit as number | undefined) ?? 20;
      const offset = (args.offset as number | undefined) ?? 0;
      const acl = resolveAcl();

      const { namespace, project, entityType } = parsePath(path);

      // Level 0: "/" — list all namespaces with counts
      if (!namespace) {
        const total = db.countEntities({ acl });
        const localCount = db.countEntities({ namespace: "local", acl });
        const lines: string[] = [
          `/ (${total} total entries)`,
          ``,
          `  local/   (${localCount} entries)`,
        ];
        // List additional namespaces if any (beyond "local")
        const allEntities = db.listEntities({ limit: 5000, acl });
        const namespaces = new Map<string, number>();
        for (const e of allEntities) {
          namespaces.set(e.namespace, (namespaces.get(e.namespace) ?? 0) + 1);
        }
        for (const [ns, count] of namespaces.entries()) {
          if (ns !== "local") {
            lines.push(`  ${ns}/   (${count} entries)`);
          }
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      }

      // Level 1: "/local" — list all projects with counts
      if (!project) {
        const projects = db.listProjects();
        if (projects.length === 0) {
          return {
            content: [{ type: "text" as const, text: `/${namespace}/ — no projects found.` }],
          };
        }
        const lines: string[] = [`/${namespace}/ (${projects.length} projects)`, ``];
        for (const p of projects) {
          const count = db.countEntities({ project: p.id, namespace, acl });
          lines.push(`  ${p.id}/   (${count} entries) — ${p.description}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      }

      // Level 2: "/local/{project}" — entity type breakdown
      if (!entityType) {
        const allForProject = db.listEntities({ project, namespace, limit: 5000, acl });
        if (allForProject.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `/${namespace}/${project}/ — no entries found.`,
              },
            ],
          };
        }
        const byType = new Map<string, number>();
        for (const e of allForProject) {
          byType.set(e.entityType, (byType.get(e.entityType) ?? 0) + 1);
        }
        const lines: string[] = [
          `/${namespace}/${project}/ (${allForProject.length} entries)`,
          ``,
        ];
        for (const [type, count] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
          lines.push(`  ${type}/   (${count})`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      }

      // Level 3: "/local/{project}/{entityType}" — list entries
      const entries = db.listEntities({
        project,
        namespace,
        entityType,
        sort: dbSort,
        order: "desc",
        limit,
        offset,
        acl,
      });

      if (entries.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `/${namespace}/${project}/${entityType}/ — no entries found.`,
            },
          ],
        };
      }

      const total = db.countEntities({ project, namespace, entityType, acl });
      const lines: string[] = [
        `/${namespace}/${project}/${entityType}/ (${total} total, showing ${offset + 1}–${offset + entries.length})`,
        ``,
      ];

      for (const e of entries) {
        const title = e.title ?? snippet(e.content, 60);
        const date = formatDate(e.updatedAt);
        lines.push(`  [${e.id}]  ${title}`);
        lines.push(`           ${date}  ${snippet(e.content, 80)}`);
        lines.push(``);
      }

      if (offset + entries.length < total) {
        lines.push(`  … ${total - offset - entries.length} more (use offset=${offset + limit})`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  // ── memory_tree ──

  safeTool(
    "memory_tree",
    "Structural overview of the memory store like `tree`. Shows namespace → project → entity type hierarchy with entry counts.",
    {
      path: z
        .string()
        .optional()
        .describe('Scope to show (default "/")'),
      depth: z.number().optional().describe("Display depth (default 2)"),
    },
    async (args) => {
      const rootPath = (args.path as string | undefined) ?? "/";
      const maxDepth = (args.depth as number | undefined) ?? 2;
      const acl = resolveAcl();

      const { namespace } = parsePath(rootPath);

      // Gather all projects
      const projects = db.listProjects();

      // For each project, gather entity type counts
      type ProjectTree = {
        id: string;
        name: string;
        total: number;
        types: { type: string; count: number }[];
      };

      const trees: ProjectTree[] = [];
      for (const p of projects) {
        const ns = namespace ?? "local";
        const total = db.countEntities({ project: p.id, namespace: ns, acl });
        if (total === 0 && namespace) continue;

        const allEntries = db.listEntities({ project: p.id, namespace: ns, limit: 5000, acl });
        const byType = new Map<string, number>();
        for (const e of allEntries) {
          byType.set(e.entityType, (byType.get(e.entityType) ?? 0) + 1);
        }
        trees.push({
          id: p.id,
          name: p.name,
          total,
          types: [...byType.entries()]
            .map(([type, count]) => ({ type, count }))
            .sort((a, b) => b.count - a.count),
        });
      }

      if (trees.length === 0) {
        return { content: [{ type: "text" as const, text: "No projects found." }] };
      }

      const lines: string[] = [namespace ? `/${namespace}` : "/"];

      for (let i = 0; i < trees.length; i++) {
        const tree = trees[i];
        const isLastProject = i === trees.length - 1;
        const projectPrefix = isLastProject ? "└── " : "├── ";
        const childIndent = isLastProject ? "    " : "│   ";

        lines.push(`${projectPrefix}${tree.id} (${tree.total} entries)`);

        if (maxDepth >= 2) {
          for (let j = 0; j < tree.types.length; j++) {
            const { type, count } = tree.types[j];
            const isLastType = j === tree.types.length - 1;
            const typePrefix = isLastType ? "└── " : "├── ";
            lines.push(`${childIndent}${typePrefix}${type} (${count})`);
          }
        }
      }

      const totalAll = trees.reduce((sum, t) => sum + t.total, 0);
      lines.push(``);
      lines.push(`${trees.length} project(s), ${totalAll} entries total`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  // ── memory_grep ──

  safeTool(
    "memory_grep",
    'Full-text search like `grep`. Uses FTS5 — supports AND, OR, NOT, and quoted phrases (e.g., "sqlite migration", "sdk OR session").',
    {
      pattern: z
        .string()
        .describe('FTS5 query string (e.g. "sqlite migration", "sdk OR session", "NOT cache")'),
      scope: z
        .string()
        .optional()
        .describe("Optional project ID or entity type to restrict the search"),
      limit: z.number().optional().describe("Max results (default 10)"),
    },
    async (args) => {
      const pattern = args.pattern as string;
      const scope = args.scope as string | undefined;
      const limit = (args.limit as number | undefined) ?? 10;
      const acl = resolveAcl();

      // Determine if scope is a project ID or entity type
      let projectFilter: string | undefined;
      let typeFilter: string | undefined;

      if (scope) {
        // Heuristic: if scope matches a known entity type keyword, treat it as entityType.
        const knownTypes = ["decision", "memory", "note", "learning", "reference", "status",
          "person", "document", "conversation", "message", "meeting", "task", "event", "snippet"];
        if (knownTypes.includes(scope)) {
          typeFilter = scope;
        } else {
          projectFilter = scope;
        }
      }

      const results = db.searchEntities(pattern, {
        project: projectFilter,
        entityType: typeFilter,
        limit,
        acl,
      });

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No results for "${pattern}"${scope ? ` in ${scope}` : ""}.`,
            },
          ],
        };
      }

      const lines: string[] = [
        `Search: "${pattern}"${scope ? `  scope:${scope}` : ""}  — ${results.length} result(s)`,
        ``,
      ];

      for (const e of results) {
        const title = e.title ?? snippet(e.content, 60);
        const date = formatDate(e.updatedAt);
        const projectLabel = e.project ? `${e.project}/` : "";
        lines.push(`[${projectLabel}${e.entityType}]  ${title}  (${date})`);
        lines.push(`  id: ${e.id}`);
        lines.push(`  ${snippet(e.content, 160)}`);
        if (e.tags.length > 0) {
          lines.push(`  tags: ${e.tags.join(", ")}`);
        }
        lines.push(``);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  // ── memory_inspect ──

  safeTool(
    "memory_inspect",
    "Deep view of a single entity like `cat`. Shows full content, metadata, and synaptic connections. Use depth > 0 to follow connections.",
    {
      id: z.string().describe("Entity ID to inspect"),
      depth: z
        .number()
        .optional()
        .describe("How many synapse hops to follow (default 1, use 0 for entity only)"),
    },
    async (args) => {
      const id = args.id as string;
      const depth = (args.depth as number | undefined) ?? 1;
      const acl = resolveAcl();

      const entity = db.getEntity(id, acl);
      if (!entity) {
        return {
          content: [{ type: "text" as const, text: `Entity not found: ${id}` }],
        };
      }

      const lines: string[] = [];

      // Header
      lines.push(`━━━ ${entity.title ?? entity.id} ━━━`);
      lines.push(``);

      // Metadata block
      lines.push(`ID:          ${entity.id}`);
      lines.push(`Type:        ${entity.entityType}`);
      if (entity.project) lines.push(`Project:     ${entity.project}`);
      lines.push(`Namespace:   ${entity.namespace}`);
      lines.push(`Domain:      ${entity.domain}`);
      lines.push(`Confidence:  ${entity.confidence}`);
      lines.push(`Status:      ${entity.status}`);
      lines.push(`Created:     ${formatDate(entity.createdAt)}`);
      lines.push(`Updated:     ${formatDate(entity.updatedAt)}`);
      if (entity.expiresAt) lines.push(`Expires:     ${formatDate(entity.expiresAt)}`);
      if (entity.author) lines.push(`Author:      ${entity.author}`);
      if (entity.tags.length > 0) lines.push(`Tags:        ${entity.tags.join(", ")}`);
      if (entity.keywords.length > 0) lines.push(`Keywords:    ${entity.keywords.join(", ")}`);
      if (entity.source.system !== "unknown") {
        const src = [entity.source.system];
        if (entity.source.connector) src.push(`connector:${entity.source.connector}`);
        if (entity.source.url) src.push(entity.source.url);
        lines.push(`Source:      ${src.join("  ")}`);
      }
      if (entity.supersededBy) lines.push(`Superseded by: ${entity.supersededBy}`);

      // Content
      lines.push(``);
      lines.push(`─── Content ───`);
      lines.push(``);
      lines.push(entity.content);
      lines.push(``);

      // Attributes
      const attrKeys = Object.keys(entity.attributes);
      if (attrKeys.length > 0) {
        lines.push(`─── Attributes ───`);
        lines.push(``);
        for (const key of attrKeys) {
          lines.push(`  ${key}: ${JSON.stringify(entity.attributes[key])}`);
        }
        lines.push(``);
      }

      // Enrichment Stage Status
      const stageKeys: Record<string, string> = {
        classify: "_classifiedAt",
        extract: "_extractedAt",
        stitch: "_stitchedAt",
        resolve: "_resolvedAt",
      };
      const enrichedAt = entity.attributes?._enrichedAt as string | undefined;
      const enrichedBy = entity.attributes?._enrichedBy as string[] | undefined;
      if (enrichedAt || enrichedBy) {
        lines.push(`─── Enrichment Status ───`);
        lines.push(``);
        lines.push(`| Stage    | Status |`);
        lines.push(`|----------|--------|`);
        for (const [stage, key] of Object.entries(stageKeys)) {
          const val = entity.attributes?.[key] as string | undefined;
          lines.push(`| ${stage.padEnd(8)} | ${val ? `Done (${val})` : "Pending"} |`);
        }
        lines.push(``);
        lines.push(`| Enriched At | ${enrichedAt ?? "never"} |`);
        lines.push(`| Enriched By | ${(enrichedBy ?? []).join(", ") || "none"} |`);
        lines.push(``);
      }

      // Sync Provenance (connector-sourced entities only)
      if (entity.source?.connector) {
        lines.push(`─── Sync Provenance ───`);
        lines.push(``);
        lines.push(`| Field | Value |`);
        lines.push(`|-------|-------|`);
        lines.push(`| Last Synced | ${entity.attributes?._lastSyncedAt ?? "never"} |`);
        lines.push(`| Sync Cursor | ${entity.attributes?._syncCursor ?? "N/A"} |`);
        lines.push(`| Sync Phase | ${entity.attributes?._syncPhase ?? "N/A"} |`);
        lines.push(`| Connector | ${entity.attributes?._syncConnector ?? entity.source.connector} |`);
        lines.push(`| Source Deleted | ${entity.attributes?._sourceDeleted ? "Yes" : "No"} |`);
        lines.push(`| Content Hash | ${entity.contentHash?.slice(0, 12) ?? "N/A"}... |`);
        lines.push(``);
      }

      // Synapses
      const synapses = db.getSynapsesByEntry(id, "both");
      if (synapses.length > 0) {
        lines.push(`─── Synapses (${synapses.length}) ───`);
        lines.push(``);

        // Group by axon type
        const byAxon = new Map<string, typeof synapses>();
        for (const s of synapses) {
          const group = byAxon.get(s.axon) ?? [];
          group.push(s);
          byAxon.set(s.axon, group);
        }

        for (const [axon, group] of byAxon.entries()) {
          lines.push(`  ${axon}:`);
          for (const s of group) {
            const dir = s.source === id ? "→" : "←";
            const otherId = s.source === id ? s.target : s.source;
            const weightStr = s.weight.toFixed(2);

            if (depth > 0) {
              // Load connected entity for title
              const connected = db.getEntity(otherId);
              const label = connected
                ? (connected.title ?? snippet(connected.content, 50))
                : otherId;
              lines.push(`    ${dir} [w:${weightStr}]  ${otherId}  "${label}"`);
            } else {
              lines.push(`    ${dir} [w:${weightStr}]  ${otherId}`);
            }
          }
          lines.push(``);
        }
      } else {
        lines.push(`No synaptic connections.`);
        lines.push(``);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  // ── memory_timeline ──

  safeTool(
    "memory_timeline",
    "Temporal view like `git log`. Shows entries sorted by date, grouped by day, with type icons.",
    {
      scope: z.string().optional().describe("Project ID to limit the timeline to"),
      types: z
        .array(z.string())
        .optional()
        .describe('Entity types to include (e.g. ["decision", "memory"])'),
      limit: z.number().optional().describe("Max entries to show (default 20)"),
    },
    async (args) => {
      const scope = args.scope as string | undefined;
      const types = args.types as string[] | undefined;
      const limit = (args.limit as number | undefined) ?? 20;
      const acl = resolveAcl();

      let entities: Entity[];

      if (types && types.length === 1) {
        // Optimized single-type query
        entities = db.listEntities({
          project: scope,
          entityType: types[0],
          sort: "updated_at",
          order: "desc",
          limit,
          acl,
        });
      } else {
        // Fetch and filter client-side for multi-type
        const fetched = db.listEntities({
          project: scope,
          sort: "updated_at",
          order: "desc",
          limit: types && types.length > 0 ? limit * types.length : limit,
          acl,
        });
        entities = types && types.length > 0
          ? fetched.filter((e) => types.includes(e.entityType)).slice(0, limit)
          : fetched;
      }

      if (entities.length === 0) {
        const scopeLabel = scope ? ` for ${scope}` : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `No entries found${scopeLabel}.`,
            },
          ],
        };
      }

      // Group by day
      const byDay = new Map<string, Entity[]>();
      for (const e of entities) {
        const day = formatDate(e.updatedAt);
        const group = byDay.get(day) ?? [];
        group.push(e);
        byDay.set(day, group);
      }

      const headerParts: string[] = ["Timeline"];
      if (scope) headerParts.push(`project:${scope}`);
      if (types && types.length > 0) headerParts.push(`types:${types.join(",")}`);

      const lines: string[] = [`${headerParts.join("  ")}`, ``];

      for (const [day, dayEntries] of byDay.entries()) {
        lines.push(`── ${day} ──`);
        for (const e of dayEntries) {
          const icon = typeIcon(e.entityType);
          const title = e.title ?? snippet(e.content, 70);
          const projectLabel = e.project ? `[${e.project}] ` : "";
          lines.push(`  ${icon} ${projectLabel}${title}`);
          lines.push(`     id:${e.id}  type:${e.entityType}`);
        }
        lines.push(``);
      }

      lines.push(`${entities.length} entries shown`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );
}
