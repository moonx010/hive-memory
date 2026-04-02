import type { HiveDatabase } from "../db/database.js";

const MAX_NODES = 500;
const MAX_EDGES = 2000;

export function handleApiRequest(
  db: HiveDatabase,
  pathname: string,
  params: URLSearchParams,
): unknown {
  switch (pathname) {
    case "/api/graph":
      return getGraph(db, params);
    case "/api/stats":
      return getStats(db, params);
    case "/api/timeline":
      return getTimeline(db, params);
    default:
      throw new Error(`Unknown API route: ${pathname}`);
  }
}

interface GraphNode {
  id: string;
  label: string;
  type: string;
  project: string | null;
  namespace: string;
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  axon: string;
  weight: number;
}

function getGraph(
  db: HiveDatabase,
  params: URLSearchParams,
): { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean } {
  const project = params.get("project") || undefined;
  const entityType = params.get("type") || undefined;
  const namespace = params.get("namespace") || undefined;

  const conditions: string[] = ["e.status = 'active'", "e.valid_to IS NULL"];
  const sqlParams: Record<string, unknown> = {};

  if (project) {
    conditions.push("e.project = @project");
    sqlParams.project = project;
  }
  if (entityType) {
    conditions.push("e.entity_type = @entityType");
    sqlParams.entityType = entityType;
  }
  if (namespace) {
    conditions.push("e.namespace = @namespace");
    sqlParams.namespace = namespace;
  }

  const where = conditions.join(" AND ");
  sqlParams.limit = MAX_NODES;

  const rows = db.rawDb
    .prepare(
      `SELECT id, entity_type, project, namespace, title, content
       FROM entities e WHERE ${where}
       ORDER BY updated_at DESC LIMIT @limit`,
    )
    .all(sqlParams) as Array<{
    id: string;
    entity_type: string;
    project: string | null;
    namespace: string;
    title: string | null;
    content: string;
  }>;

  const nodeIds = new Set(rows.map((r) => r.id));
  const nodes: GraphNode[] = rows.map((r) => ({
    id: r.id,
    label: r.title || r.content.slice(0, 50),
    type: r.entity_type,
    project: r.project,
    namespace: r.namespace,
  }));

  // Fetch synapses connecting these nodes
  const edges: GraphEdge[] = [];
  if (nodeIds.size > 0) {
    const allSynapses = db.rawDb
      .prepare(
        `SELECT id, source, target, axon, weight FROM synapses LIMIT ${MAX_EDGES * 2}`,
      )
      .all() as Array<{
      id: string;
      source: string;
      target: string;
      axon: string;
      weight: number;
    }>;

    for (const s of allSynapses) {
      if (nodeIds.has(s.source) && nodeIds.has(s.target)) {
        edges.push({
          id: s.id,
          source: s.source,
          target: s.target,
          axon: s.axon,
          weight: s.weight,
        });
        if (edges.length >= MAX_EDGES) break;
      }
    }
  }

  return {
    nodes,
    edges,
    truncated: rows.length >= MAX_NODES,
  };
}

function getStats(
  db: HiveDatabase,
  _params: URLSearchParams,
): {
  totalEntities: number;
  byType: Array<{ key: string; count: number }>;
  byProject: Array<{ key: string; count: number }>;
  byNamespace: Array<{ key: string; count: number }>;
  synapses: { total: number; avgWeight: number; byAxon: Array<{ axon: string; count: number }> };
} {
  const totalEntities = db.countEntities({});
  const byType = db.countEntitiesByGroup("entity_type", {});
  const byProject = db.countEntitiesByGroup("project", {});
  const byNamespace = db.countEntitiesByGroup("namespace", {});

  const synapseStats = db.rawDb
    .prepare("SELECT COUNT(*) as total, AVG(weight) as avg FROM synapses")
    .get() as { total: number; avg: number | null };

  const byAxon = db.rawDb
    .prepare("SELECT axon, COUNT(*) as count FROM synapses GROUP BY axon ORDER BY count DESC")
    .all() as Array<{ axon: string; count: number }>;

  return {
    totalEntities,
    byType,
    byProject,
    byNamespace,
    synapses: {
      total: synapseStats.total,
      avgWeight: synapseStats.avg ?? 0,
      byAxon,
    },
  };
}

function getTimeline(
  db: HiveDatabase,
  params: URLSearchParams,
): { dates: Array<{ date: string; entities: Array<{ id: string; type: string; project: string | null; title: string }> }> } {
  const project = params.get("project") || undefined;
  const days = parseInt(params.get("days") || "14", 10);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const entities = db.listEntities({
    project,
    sort: "created_at",
    order: "desc",
    limit: 200,
    since,
  });

  const grouped = new Map<string, Array<{ id: string; type: string; project: string | null; title: string }>>();
  for (const e of entities) {
    const date = e.createdAt.slice(0, 10);
    const list = grouped.get(date) ?? [];
    list.push({
      id: e.id,
      type: e.entityType,
      project: e.project ?? null,
      title: e.title ?? e.content.slice(0, 60),
    });
    grouped.set(date, list);
  }

  const dates = [...grouped.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, entities]) => ({ date, entities }));

  return { dates };
}
