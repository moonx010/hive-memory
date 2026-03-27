import BetterSqlite3 from "better-sqlite3";
import crypto from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { createSchema } from "./schema.js";
import type { Entity, ConnectorConfig } from "../types.js";
import type { ACLContext } from "../acl/types.js";
import { defaultACLPolicy } from "../acl/policy.js";

// Re-export Entity so consumers can import it from this module
export type { Entity } from "../types.js";

// ── Row types (raw SQLite rows before JSON parsing) ───────────────────────────

interface EntityRow {
  id: string;
  entity_type: string;
  project: string | null;
  namespace: string;
  title: string | null;
  content: string;
  tags: string;
  keywords: string;
  attributes: string;
  source_system: string;
  source_external_id: string | null;
  source_url: string | null;
  source_connector: string | null;
  author: string | null;
  visibility: string;
  domain: string;
  confidence: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  status: string;
  superseded_by: string | null;
  content_hash: string | null;
  owner_id: string | null;
  required_labels: string;
  acl_members: string;
}

interface SynapseRow {
  id: string;
  source: string;
  target: string;
  axon: string;
  weight: number;
  metadata: string;
  formed_at: string;
  last_potentiated: string;
}

interface CoactivationRow {
  pair_key: string;
  count: number;
}

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  description: string;
  tags: string;
  last_active: string;
  status: string;
  one_liner: string;
  tech_stack: string;
  modules: string;
  current_focus: string;
  last_session: string | null;
  stats: string;
}

interface SessionRow {
  id: number;
  project: string;
  date: string;
  summary: string;
  next_tasks: string;
  decisions: string;
  learnings: string;
  created_at: string;
}

interface ConnectorRow {
  id: string;
  connector_type: string;
  config: string;
  last_sync: string | null;
  status: string;
  sync_cursor: string | null;
  sync_phase: string;
  sync_history: string;
}

interface EntityAliasRow {
  id: string;
  canonical_id: string;
  alias_system: string;
  alias_value: string;
  alias_type: string;
  confidence: string;
  created_at: string;
}

// ── Domain types ─────────────────────────────────────────────────────────────

export interface SynapseRecord {
  id: string;
  source: string;
  target: string;
  axon: string;
  weight: number;
  metadata: Record<string, unknown>;
  formedAt: string;
  lastPotentiated: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  description: string;
  tags: string[];
  lastActive: string;
  status: string;
  oneLiner: string;
  techStack: string[];
  modules: string[];
  currentFocus: string;
  lastSession: {
    date: string;
    summary: string;
    nextTasks: string[];
  } | null;
  stats: Record<string, unknown>;
}

export interface SessionRecord {
  id?: number;
  project: string;
  date: string;
  summary: string;
  nextTasks: string[];
  decisions: string[];
  learnings: string[];
  createdAt: string;
}

export interface EntityAlias {
  id: string;
  canonicalId: string;
  aliasSystem: string;
  aliasValue: string;
  aliasType: "external_id" | "email" | "name" | "handle";
  confidence: "confirmed" | "inferred";
  createdAt: string;
}

export interface ConnectorStatus {
  id: string;
  name: string;
  status: "active" | "idle" | "error" | "never_synced";
  lastSync?: string;
  entryCount: number;
  errorMessage?: string;
}

// ── Filter / option types ─────────────────────────────────────────────────────

export interface ListEntitiesOptions {
  project?: string;
  entityType?: string | string[];
  domain?: string;
  namespace?: string;
  status?: string;
  /** ISO string: only include entries updated at or after this time */
  since?: string;
  /** ISO string: only include entries updated at or before this time */
  until?: string;
  sort?: "created_at" | "updated_at" | "recent" | "name" | "relevance";
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
  /** When true, only return entities without _enrichedAt attribute */
  unenrichedOnly?: boolean;
  /** When true, only return entities with non-empty keywords array */
  hasKeywords?: boolean;
  /** ACL context for access filtering (only active when CORTEX_ACL=on) */
  acl?: ACLContext;
}

export interface SearchEntitiesOptions {
  project?: string;
  entityType?: string;
  domain?: string;
  namespace?: string;
  limit?: number;
  /** ACL context for access filtering (only active when CORTEX_ACL=on) */
  acl?: ACLContext;
}

export interface CountEntitiesOptions {
  project?: string;
  entityType?: string;
  domain?: string;
  namespace?: string;
  status?: string;
  /** ACL context for access filtering (only active when CORTEX_ACL=on) */
  acl?: ACLContext;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sanitize a user-supplied FTS5 search query to prevent injection attacks.
 * Strips boolean operators, special characters, and column prefix syntax.
 */
function sanitizeFTS5Query(input: string): string {
  return input
    .replace(/\b(OR|AND|NOT|NEAR)\b/gi, "")  // Strip FTS5 boolean operators
    .replace(/[*"(){}[\]^~]/g, "")             // Strip special chars
    .replace(/\b\w+:/g, "")                     // Strip column: prefixes
    .replace(/\s+/g, " ")
    .trim();
}

function rowToEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    entityType: row.entity_type as Entity["entityType"],
    project: row.project ?? undefined,
    namespace: row.namespace,
    title: row.title ?? undefined,
    content: row.content,
    tags: JSON.parse(row.tags) as string[],
    keywords: JSON.parse(row.keywords) as string[],
    attributes: JSON.parse(row.attributes) as Record<string, unknown>,
    source: {
      system: row.source_system,
      externalId: row.source_external_id ?? undefined,
      url: row.source_url ?? undefined,
      connector: row.source_connector ?? undefined,
    },
    author: row.author ?? undefined,
    visibility: row.visibility as Entity["visibility"],
    domain: row.domain as Entity["domain"],
    confidence: row.confidence as Entity["confidence"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at ?? undefined,
    status: row.status as Entity["status"],
    supersededBy: row.superseded_by ?? undefined,
    contentHash: row.content_hash ?? undefined,
    ownerId: row.owner_id ?? undefined,
    requiredLabels: JSON.parse(row.required_labels ?? '[]') as string[],
    aclMembers: JSON.parse(row.acl_members ?? '[]') as string[],
  };
}

function entityToRow(entity: Entity): Record<string, unknown> {
  return {
    id: entity.id,
    entity_type: entity.entityType,
    project: entity.project ?? null,
    namespace: entity.namespace,
    title: entity.title ?? null,
    content: entity.content,
    tags: JSON.stringify(entity.tags),
    keywords: JSON.stringify(entity.keywords),
    attributes: JSON.stringify(entity.attributes),
    source_system: entity.source.system,
    source_external_id: entity.source.externalId ?? null,
    source_url: entity.source.url ?? null,
    source_connector: entity.source.connector ?? null,
    author: entity.author ?? null,
    visibility: entity.visibility,
    domain: entity.domain,
    confidence: entity.confidence,
    created_at: entity.createdAt,
    updated_at: entity.updatedAt,
    expires_at: entity.expiresAt ?? null,
    status: entity.status,
    superseded_by: entity.supersededBy ?? null,
    content_hash: entity.contentHash ?? null,
    owner_id: entity.ownerId ?? null,
    required_labels: JSON.stringify(entity.requiredLabels ?? []),
    acl_members: JSON.stringify(entity.aclMembers ?? []),
  };
}

function rowToSynapse(row: SynapseRow): SynapseRecord {
  return {
    id: row.id,
    source: row.source,
    target: row.target,
    axon: row.axon,
    weight: row.weight,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    formedAt: row.formed_at,
    lastPotentiated: row.last_potentiated,
  };
}

function rowToProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    description: row.description,
    tags: JSON.parse(row.tags) as string[],
    lastActive: row.last_active,
    status: row.status,
    oneLiner: row.one_liner,
    techStack: JSON.parse(row.tech_stack) as string[],
    modules: JSON.parse(row.modules) as string[],
    currentFocus: row.current_focus,
    lastSession: row.last_session
      ? (JSON.parse(row.last_session) as ProjectRecord["lastSession"])
      : null,
    stats: JSON.parse(row.stats) as Record<string, unknown>,
  };
}

function rowToSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    project: row.project,
    date: row.date,
    summary: row.summary,
    nextTasks: JSON.parse(row.next_tasks) as string[],
    decisions: JSON.parse(row.decisions) as string[],
    learnings: JSON.parse(row.learnings) as string[],
    createdAt: row.created_at,
  };
}

function rowToAlias(row: EntityAliasRow): EntityAlias {
  return {
    id: row.id,
    canonicalId: row.canonical_id,
    aliasSystem: row.alias_system,
    aliasValue: row.alias_value,
    aliasType: row.alias_type as EntityAlias["aliasType"],
    confidence: row.confidence as EntityAlias["confidence"],
    createdAt: row.created_at,
  };
}

function rowToConnector(row: ConnectorRow): ConnectorConfig {
  return {
    id: row.id,
    connectorType: row.connector_type,
    config: JSON.parse(row.config) as Record<string, unknown>,
    lastSync: row.last_sync ?? undefined,
    status: row.status as ConnectorConfig["status"],
    syncCursor: row.sync_cursor ?? undefined,
    syncPhase: row.sync_phase ?? "initial",
    syncHistory: row.sync_history ?? "[]",
  };
}

// ── Content hash helper ───────────────────────────────────────────────────────

/** SHA-256 hex of content, truncated to first 16 chars. */
export function computeContentHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ── HiveDatabase ──────────────────────────────────────────────────────────────
// Concrete synchronous implementation backed by better-sqlite3.
// This is the main class — it is also used as the structural type for the
// async adapter (AsyncHiveDb in adapter.ts) and the legacy shim in store.ts.
// All public methods are synchronous (better-sqlite3 is blocking).

export class HiveDatabase {
  private db: BetterSqlite3.Database;

  constructor(dbPath?: string) {
    const defaultPath = join(homedir(), ".cortex", "cortex.db");
    const resolvedPath = dbPath ?? defaultPath;

    // Ensure parent directory exists
    const lastSlash = resolvedPath.lastIndexOf("/");
    if (lastSlash > 0) {
      mkdirSync(resolvedPath.substring(0, lastSlash), { recursive: true });
    }

    this.db = new BetterSqlite3(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    createSchema(this.db);
  }

  // ── Entity methods ──────────────────────────────────────────────────────────

  insertEntity(entity: Entity): void {
    if (!entity.contentHash) {
      entity.contentHash = computeContentHash(entity.content);
    }
    const row = entityToRow(entity);
    this.db.prepare(`
      INSERT INTO entities (
        id, entity_type, project, namespace, title, content,
        tags, keywords, attributes,
        source_system, source_external_id, source_url, source_connector,
        author, visibility, domain, confidence,
        created_at, updated_at, expires_at, status, superseded_by, content_hash,
        owner_id, required_labels, acl_members
      ) VALUES (
        @id, @entity_type, @project, @namespace, @title, @content,
        @tags, @keywords, @attributes,
        @source_system, @source_external_id, @source_url, @source_connector,
        @author, @visibility, @domain, @confidence,
        @created_at, @updated_at, @expires_at, @status, @superseded_by, @content_hash,
        @owner_id, @required_labels, @acl_members
      )
    `).run(row);
  }

  updateEntity(id: string, updates: Partial<Omit<Entity, "id">>): { changed: boolean } {
    const existing = this.getEntity(id);
    if (!existing) throw new Error(`Entity not found: ${id}`);

    const merged: Entity = { ...existing, ...updates, id };

    // Compute new content hash and compare with existing
    const newHash = computeContentHash(merged.content);
    const changed = newHash !== existing.contentHash;
    merged.contentHash = newHash;

    const row = entityToRow(merged);

    this.db.prepare(`
      UPDATE entities SET
        entity_type = @entity_type,
        project = @project,
        namespace = @namespace,
        title = @title,
        content = @content,
        tags = @tags,
        keywords = @keywords,
        attributes = @attributes,
        source_system = @source_system,
        source_external_id = @source_external_id,
        source_url = @source_url,
        source_connector = @source_connector,
        author = @author,
        visibility = @visibility,
        domain = @domain,
        confidence = @confidence,
        updated_at = @updated_at,
        expires_at = @expires_at,
        status = @status,
        superseded_by = @superseded_by,
        content_hash = @content_hash,
        owner_id = @owner_id,
        required_labels = @required_labels,
        acl_members = @acl_members
      WHERE id = @id
    `).run(row);

    return { changed };
  }

  deleteEntity(id: string): void {
    this.db.prepare("DELETE FROM entities WHERE id = ?").run(id);
  }

  getEntity(id: string, acl?: ACLContext): Entity | null {
    const row = this.db
      .prepare("SELECT * FROM entities WHERE id = ?")
      .get(id) as EntityRow | undefined;
    if (!row) return null;
    const entity = rowToEntity(row);

    const aclEnabled = process.env.CORTEX_ACL === 'on';
    if (aclEnabled && acl) {
      if (!defaultACLPolicy.canRead(entity, acl)) return null;
    }

    return entity;
  }

  listEntities(options: ListEntitiesOptions = {}): Entity[] {
    const {
      project,
      entityType,
      domain,
      namespace,
      status = "active",
      since,
      until,
      sort = "updated_at",
      order = "desc",
      limit = 50,
      offset = 0,
      unenrichedOnly = false,
      hasKeywords = false,
      acl,
    } = options;

    const aclEnabled = process.env.CORTEX_ACL === 'on';

    // Fail closed: ACL enabled but no context → return empty
    if (aclEnabled && !acl) {
      return [];
    }

    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (project !== undefined) {
      conditions.push("project = @project");
      params.project = project;
    }
    if (entityType !== undefined) {
      if (Array.isArray(entityType)) {
        if (entityType.length > 0) {
          const placeholders = entityType.map((_, i) => `@et${i}`);
          conditions.push(`entity_type IN (${placeholders.join(", ")})`);
          entityType.forEach((t, i) => { params[`et${i}`] = t; });
        }
      } else {
        conditions.push("entity_type = @entityType");
        params.entityType = entityType;
      }
    }
    if (domain !== undefined) {
      conditions.push("domain = @domain");
      params.domain = domain;
    }
    if (namespace !== undefined) {
      conditions.push("namespace = @namespace");
      params.namespace = namespace;
    }
    if (status !== undefined) {
      conditions.push("status = @status");
      params.status = status;
    }
    if (since !== undefined) {
      conditions.push("updated_at >= @since");
      params.since = since;
    }
    if (until !== undefined) {
      conditions.push("updated_at <= @until");
      params.until = until;
    }
    if (unenrichedOnly) {
      conditions.push("JSON_EXTRACT(attributes, '$._enrichedAt') IS NULL");
    }
    if (hasKeywords) {
      conditions.push("keywords != '[]'");
    }

    // ACL WHERE injection — listEntities uses plain table alias, not "e."
    // We wrap with a subquery alias to use "e." prefix from policy clause
    let aclClause = "";
    if (aclEnabled && acl) {
      const { clause, params: aclParams } = defaultACLPolicy.sqlWhereClause(acl);
      // The policy clause uses "e." prefix, so we need to handle it in a subquery
      // We'll add it directly but replace "e." with empty string since this is a flat query
      aclClause = clause;
      Object.assign(params, aclParams);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Normalize sort to a valid SQL column
    let sortCol: string;
    if (sort === "created_at") {
      sortCol = "created_at";
    } else if (sort === "name") {
      sortCol = "COALESCE(title, id)";
    } else {
      // "updated_at" | "recent" | "relevance" — default to updated_at
      sortCol = "updated_at";
    }
    const sortDir = order === "asc" ? "ASC" : "DESC";

    params.limit = limit;
    params.offset = offset;

    let sql: string;
    if (aclEnabled && acl && aclClause) {
      // Use subquery with alias "e" to match policy clause
      const whereClause = conditions.length > 0
        ? `WHERE ${conditions.join(" AND ")} AND ${aclClause}`
        : `WHERE ${aclClause}`;
      sql = `SELECT * FROM entities e ${whereClause} ORDER BY ${sortCol} ${sortDir} LIMIT @limit OFFSET @offset`;
    } else {
      sql = `SELECT * FROM entities ${where} ORDER BY ${sortCol} ${sortDir} LIMIT @limit OFFSET @offset`;
    }

    const rows = this.db.prepare(sql).all(params) as EntityRow[];

    return rows.map(rowToEntity);
  }

  searchEntities(query: string, options: SearchEntitiesOptions = {}): Entity[] {
    const { project, entityType, domain, namespace, limit = 20, acl } = options;

    const aclEnabled = process.env.CORTEX_ACL === 'on';

    // Fail closed: ACL enabled but no context → return empty
    if (aclEnabled && !acl) {
      return [];
    }

    const sanitizedQuery = sanitizeFTS5Query(query);
    // If sanitization strips everything, return empty results rather than running a broken query.
    if (!sanitizedQuery) return [];

    const extraConditions: string[] = [];
    const params: Record<string, unknown> = { query: sanitizedQuery, limit };

    if (project !== undefined) {
      extraConditions.push("e.project = @project");
      params.project = project;
    }
    if (entityType !== undefined) {
      extraConditions.push("e.entity_type = @entityType");
      params.entityType = entityType;
    }
    if (domain !== undefined) {
      extraConditions.push("e.domain = @domain");
      params.domain = domain;
    }
    if (namespace !== undefined) {
      extraConditions.push("e.namespace = @namespace");
      params.namespace = namespace;
    }

    // ACL WHERE injection
    if (aclEnabled && acl) {
      const { clause, params: aclParams } = defaultACLPolicy.sqlWhereClause(acl);
      extraConditions.push(clause);
      Object.assign(params, aclParams);
    }

    const extraWhere =
      extraConditions.length > 0
        ? `AND ${extraConditions.join(" AND ")}`
        : "";

    const rows = this.db
      .prepare(
        `SELECT e.*
         FROM entities_fts f
         JOIN entities e ON f.rowid = e.rowid
         WHERE entities_fts MATCH @query
           AND e.status = 'active'
           ${extraWhere}
         ORDER BY bm25(entities_fts)
         LIMIT @limit`,
      )
      .all(params) as EntityRow[];

    return rows.map(rowToEntity);
  }

  countEntities(options: CountEntitiesOptions = {}): number {
    const { project, entityType, domain, namespace, status = "active", acl } = options;

    const aclEnabled = process.env.CORTEX_ACL === 'on';

    // Fail closed: ACL enabled but no context → return 0
    if (aclEnabled && !acl) {
      return 0;
    }

    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (project !== undefined) {
      conditions.push("e.project = @project");
      params.project = project;
    }
    if (entityType !== undefined) {
      conditions.push("e.entity_type = @entityType");
      params.entityType = entityType;
    }
    if (domain !== undefined) {
      conditions.push("e.domain = @domain");
      params.domain = domain;
    }
    if (namespace !== undefined) {
      conditions.push("e.namespace = @namespace");
      params.namespace = namespace;
    }
    if (status !== undefined) {
      conditions.push("e.status = @status");
      params.status = status;
    }

    // ACL WHERE injection
    if (aclEnabled && acl) {
      const { clause, params: aclParams } = defaultACLPolicy.sqlWhereClause(acl);
      conditions.push(clause);
      Object.assign(params, aclParams);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM entities e ${where}`)
      .get(params) as { cnt: number };

    return result.cnt;
  }

  // ── Synapse methods ─────────────────────────────────────────────────────────

  insertSynapse(synapse: SynapseRecord): void {
    this.db.prepare(`
      INSERT INTO synapses (id, source, target, axon, weight, metadata, formed_at, last_potentiated)
      VALUES (@id, @source, @target, @axon, @weight, @metadata, @formed_at, @last_potentiated)
      ON CONFLICT(source, target, axon) DO UPDATE SET
        weight = MIN(1.0, weight + 0.1),
        last_potentiated = excluded.last_potentiated
    `).run({
      id: synapse.id,
      source: synapse.source,
      target: synapse.target,
      axon: synapse.axon,
      weight: synapse.weight,
      metadata: JSON.stringify(synapse.metadata),
      formed_at: synapse.formedAt,
      last_potentiated: synapse.lastPotentiated,
    });
  }

  getSynapsesByEntry(
    entryId: string,
    direction: "outgoing" | "incoming" | "both" = "both",
    axonType?: string,
  ): SynapseRecord[] {
    const params: Record<string, unknown> = { entryId };
    const axonFilter = axonType ? "AND axon = @axonType" : "";
    if (axonType) params.axonType = axonType;

    let sql: string;
    if (direction === "outgoing") {
      sql = `SELECT * FROM synapses WHERE source = @entryId ${axonFilter}`;
    } else if (direction === "incoming") {
      sql = `SELECT * FROM synapses WHERE target = @entryId ${axonFilter}`;
    } else {
      sql = `SELECT * FROM synapses WHERE (source = @entryId OR target = @entryId) ${axonFilter}`;
    }

    const rows = this.db.prepare(sql).all(params) as SynapseRow[];
    return rows.map(rowToSynapse);
  }

  getNeighborIds(
    entryId: string,
    direction: "outgoing" | "incoming" | "both" = "both",
  ): string[] {
    const params: Record<string, unknown> = { entryId };
    let sql: string;

    if (direction === "outgoing") {
      sql = "SELECT target AS neighbor FROM synapses WHERE source = @entryId";
    } else if (direction === "incoming") {
      sql = "SELECT source AS neighbor FROM synapses WHERE target = @entryId";
    } else {
      sql = `
        SELECT target AS neighbor FROM synapses WHERE source = @entryId
        UNION
        SELECT source AS neighbor FROM synapses WHERE target = @entryId
      `;
    }

    const rows = this.db.prepare(sql).all(params) as { neighbor: string }[];
    return rows.map((r) => r.neighbor);
  }

  updateSynapseWeight(id: string, weight: number): void {
    this.db
      .prepare("UPDATE synapses SET weight = ?, last_potentiated = ? WHERE id = ?")
      .run(Math.min(1.0, Math.max(0.0, weight)), new Date().toISOString(), id);
  }

  applyDecay(factor = 0.95, pruneThreshold = 0.05): number {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE synapses SET weight = weight * ?, last_potentiated = ?")
      .run(factor, now);
    return this.db
      .prepare("DELETE FROM synapses WHERE weight < ?")
      .run(pruneThreshold).changes;
  }

  // ── Coactivation methods ────────────────────────────────────────────────────

  recordCoactivation(entryIds: string[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO coactivations (pair_key, count)
      VALUES (?, 1)
      ON CONFLICT(pair_key) DO UPDATE SET count = count + 1
    `);

    this.db.transaction((ids: string[]) => {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = ids[i] < ids[j] ? ids[i] : ids[j];
          const b = ids[i] < ids[j] ? ids[j] : ids[i];
          stmt.run(`${a}:${b}`);
        }
      }
    })(entryIds);
  }

  getCoactivationAboveThreshold(threshold: number): { pairKey: string; count: number }[] {
    const rows = this.db
      .prepare(
        "SELECT pair_key, count FROM coactivations WHERE count >= ? ORDER BY count DESC",
      )
      .all(threshold) as CoactivationRow[];
    return rows.map((r) => ({ pairKey: r.pair_key, count: r.count }));
  }

  // ── Project methods ─────────────────────────────────────────────────────────

  upsertProject(project: ProjectRecord): void {
    this.db.prepare(`
      INSERT INTO projects (
        id, name, path, description, tags, last_active, status,
        one_liner, tech_stack, modules, current_focus, last_session, stats
      ) VALUES (
        @id, @name, @path, @description, @tags, @last_active, @status,
        @one_liner, @tech_stack, @modules, @current_focus, @last_session, @stats
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        path = excluded.path,
        description = excluded.description,
        tags = excluded.tags,
        last_active = excluded.last_active,
        status = excluded.status,
        one_liner = excluded.one_liner,
        tech_stack = excluded.tech_stack,
        modules = excluded.modules,
        current_focus = excluded.current_focus,
        last_session = excluded.last_session,
        stats = excluded.stats
    `).run({
      id: project.id,
      name: project.name,
      path: project.path,
      description: project.description,
      tags: JSON.stringify(project.tags),
      last_active: project.lastActive,
      status: project.status,
      one_liner: project.oneLiner,
      tech_stack: JSON.stringify(project.techStack),
      modules: JSON.stringify(project.modules),
      current_focus: project.currentFocus,
      last_session: project.lastSession ? JSON.stringify(project.lastSession) : null,
      stats: JSON.stringify(project.stats),
    });
  }

  getProject(id: string): ProjectRecord | null {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE id = ?")
      .get(id) as ProjectRow | undefined;
    return row ? rowToProject(row) : null;
  }

  listProjects(query = "", limit = 50): ProjectRecord[] {
    let rows: ProjectRow[];
    if (query.trim() === "") {
      rows = this.db
        .prepare("SELECT * FROM projects ORDER BY last_active DESC LIMIT ?")
        .all(limit) as ProjectRow[];
    } else {
      const like = `%${query}%`;
      rows = this.db
        .prepare(
          `SELECT * FROM projects
           WHERE name LIKE ? OR id LIKE ? OR description LIKE ?
           ORDER BY last_active DESC LIMIT ?`,
        )
        .all(like, like, like, limit) as ProjectRow[];
    }
    return rows.map(rowToProject);
  }

  getProjectSummary(
    id: string,
  ): Pick<ProjectRecord, "id" | "oneLiner" | "techStack" | "modules" | "currentFocus" | "lastSession" | "stats"> | null {
    const row = this.db
      .prepare(
        "SELECT id, one_liner, tech_stack, modules, current_focus, last_session, stats FROM projects WHERE id = ?",
      )
      .get(id) as Pick<ProjectRow, "id" | "one_liner" | "tech_stack" | "modules" | "current_focus" | "last_session" | "stats"> | undefined;

    if (!row) return null;

    return {
      id: row.id,
      oneLiner: row.one_liner,
      techStack: JSON.parse(row.tech_stack) as string[],
      modules: JSON.parse(row.modules) as string[],
      currentFocus: row.current_focus,
      lastSession: row.last_session
        ? (JSON.parse(row.last_session) as ProjectRecord["lastSession"])
        : null,
      stats: JSON.parse(row.stats) as Record<string, unknown>,
    };
  }

  // ── Session methods ─────────────────────────────────────────────────────────

  insertSession(projectId: string, session: Omit<SessionRecord, "id" | "project">): number {
    const result = this.db.prepare(`
      INSERT INTO sessions (project, date, summary, next_tasks, decisions, learnings, created_at)
      VALUES (@project, @date, @summary, @next_tasks, @decisions, @learnings, @created_at)
    `).run({
      project: projectId,
      date: session.date,
      summary: session.summary,
      next_tasks: JSON.stringify(session.nextTasks),
      decisions: JSON.stringify(session.decisions),
      learnings: JSON.stringify(session.learnings),
      created_at: session.createdAt,
    });
    return result.lastInsertRowid as number;
  }

  getRecentSessions(projectId: string, limit = 5): SessionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE project = ? ORDER BY created_at DESC LIMIT ?")
      .all(projectId, limit) as SessionRow[];
    return rows.map(rowToSession);
  }

  // ── Connector methods ───────────────────────────────────────────────────────

  upsertConnector(connector: ConnectorConfig): void {
    this.db.prepare(`
      INSERT INTO connectors (id, connector_type, config, last_sync, status, sync_cursor, sync_phase, sync_history)
      VALUES (@id, @connector_type, @config, @last_sync, @status, @sync_cursor, @sync_phase, @sync_history)
      ON CONFLICT(id) DO UPDATE SET
        connector_type = excluded.connector_type,
        config = excluded.config,
        last_sync = excluded.last_sync,
        status = excluded.status,
        sync_cursor = excluded.sync_cursor,
        sync_phase = excluded.sync_phase,
        sync_history = excluded.sync_history
    `).run({
      id: connector.id,
      connector_type: connector.connectorType,
      config: JSON.stringify(connector.config),
      last_sync: connector.lastSync ?? null,
      status: connector.status,
      sync_cursor: connector.syncCursor ?? null,
      sync_phase: connector.syncPhase ?? "initial",
      sync_history: connector.syncHistory ?? "[]",
    });
  }

  getConnector(id: string): ConnectorConfig | null {
    const row = this.db
      .prepare("SELECT * FROM connectors WHERE id = ?")
      .get(id) as ConnectorRow | undefined;
    return row ? rowToConnector(row) : null;
  }

  listConnectors(): ConnectorConfig[] {
    const rows = this.db
      .prepare("SELECT * FROM connectors ORDER BY id")
      .all() as ConnectorRow[];
    return rows.map(rowToConnector);
  }

  // ── Extended convenience methods ────────────────────────────────────────────

  /** Returns status summary for all configured connectors. */
  getConnectorStatuses(): ConnectorStatus[] {
    return this.listConnectors().map((c) => ({
      id: c.id,
      name: c.connectorType,
      status: (c.status === "error"
        ? "error"
        : c.lastSync
          ? "active"
          : "idle") as ConnectorStatus["status"],
      lastSync: c.lastSync,
      entryCount: this.countEntities({ namespace: c.id }),
    }));
  }

  /** Find entity by source system + external ID (direct SQL, not FTS5). */
  getByExternalId(system: string, externalId: string): Entity | null {
    const row = this.db
      .prepare(
        "SELECT * FROM entities WHERE source_system = ? AND source_external_id = ? LIMIT 1",
      )
      .get(system, externalId) as EntityRow | undefined;
    return row ? rowToEntity(row) : null;
  }

  // ── Enrichment convenience methods ──────────────────────────────────────────

  /** Merge attributes into an existing entity (does not replace, only adds/overwrites keys). */
  updateEntityAttributes(id: string, attributes: Record<string, unknown>): void {
    const existing = this.getEntity(id);
    if (!existing) throw new Error(`Entity not found: ${id}`);
    this.updateEntity(id, {
      attributes: { ...existing.attributes, ...attributes },
      updatedAt: new Date().toISOString(),
    });
  }

  /** Append unique tags to an existing entity. */
  addEntityTags(id: string, tags: string[]): void {
    const existing = this.getEntity(id);
    if (!existing) throw new Error(`Entity not found: ${id}`);
    const merged = [...new Set([...existing.tags, ...tags])];
    this.updateEntity(id, { tags: merged, updatedAt: new Date().toISOString() });
  }

  /** Append unique keywords to an existing entity. */
  addEntityKeywords(id: string, keywords: string[]): void {
    const existing = this.getEntity(id);
    if (!existing) throw new Error(`Entity not found: ${id}`);
    const merged = [...new Set([...existing.keywords, ...keywords])];
    this.updateEntity(id, { keywords: merged, updatedAt: new Date().toISOString() });
  }

  /** Upsert a synapse with set-weight semantics (not +0.1 accumulation). */
  upsertSynapse(opts: {
    sourceId: string;
    targetId: string;
    axon: string;
    weight: number;
    metadata?: Record<string, string>;
  }): void {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO synapses (id, source, target, axon, weight, metadata, formed_at, last_potentiated)
      VALUES (@id, @source, @target, @axon, @weight, @metadata, @formed_at, @last_potentiated)
      ON CONFLICT(source, target, axon) DO UPDATE SET
        weight = excluded.weight,
        metadata = excluded.metadata,
        last_potentiated = excluded.last_potentiated
    `).run({
      id,
      source: opts.sourceId,
      target: opts.targetId,
      axon: opts.axon,
      weight: Math.min(1.0, Math.max(0.0, opts.weight)),
      metadata: JSON.stringify(opts.metadata ?? {}),
      formed_at: now,
      last_potentiated: now,
    });
  }

  /** Create an entity from a draft shape, returning the generated id. */
  upsertEntity(draft: {
    entityType: string;
    project?: string;
    title?: string;
    content: string;
    tags: string[];
    attributes: Record<string, unknown>;
    source: { system: string; externalId?: string; connector?: string };
    domain: string;
    confidence: string;
  }): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const entity: Entity = {
      id,
      entityType: draft.entityType as Entity["entityType"],
      project: draft.project,
      namespace: "local",
      title: draft.title,
      content: draft.content,
      tags: draft.tags,
      keywords: [],
      attributes: draft.attributes,
      source: {
        system: draft.source.system,
        externalId: draft.source.externalId,
        connector: draft.source.connector,
      },
      visibility: "personal",
      domain: draft.domain as Entity["domain"],
      confidence: draft.confidence as Entity["confidence"],
      createdAt: now,
      updatedAt: now,
      status: "active",
    };
    this.insertEntity(entity);
    return id;
  }

  // ── Entity alias methods ────────────────────────────────────────────────────

  /** Upsert an alias. Returns true if inserted, false if already existed. */
  upsertAlias(alias: {
    canonicalId: string;
    aliasSystem: string;
    aliasValue: string;
    aliasType: "external_id" | "email" | "name" | "handle";
    confidence: "confirmed" | "inferred";
  }): boolean {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO entity_aliases (id, canonical_id, alias_system, alias_value, alias_type, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, alias.canonicalId, alias.aliasSystem, alias.aliasValue, alias.aliasType, alias.confidence, now);
    return result.changes > 0;
  }

  /** Get all aliases for a canonical entity. */
  getAliases(canonicalId: string): EntityAlias[] {
    const rows = this.db.prepare(
      "SELECT * FROM entity_aliases WHERE canonical_id = ?",
    ).all(canonicalId) as EntityAliasRow[];
    return rows.map(rowToAlias);
  }

  /**
   * Merge superseded entity into primary entity.
   * Moves synapses, archives superseded, creates aliases.
   */
  mergeEntities(
    primaryId: string,
    supersededId: string,
  ): { synapsesMoved: number; aliasesCreated: number } {
    return this.db.transaction(() => {
      let synapsesMoved = 0;

      // 1. Move outgoing synapses from superseded → primary
      const outgoing = this.db.prepare(
        "SELECT * FROM synapses WHERE source = ?",
      ).all(supersededId) as SynapseRow[];
      for (const syn of outgoing) {
        if (syn.target === primaryId) continue; // skip self-referencing
        try {
          this.db.prepare(`
            INSERT OR IGNORE INTO synapses (id, source, target, axon, weight, metadata, formed_at, last_potentiated)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(crypto.randomUUID(), primaryId, syn.target, syn.axon, syn.weight, syn.metadata, syn.formed_at, syn.last_potentiated);
          synapsesMoved++;
        } catch { /* duplicate */ }
      }

      // 2. Move incoming synapses to superseded → primary
      const incoming = this.db.prepare(
        "SELECT * FROM synapses WHERE target = ?",
      ).all(supersededId) as SynapseRow[];
      for (const syn of incoming) {
        if (syn.source === primaryId) continue;
        try {
          this.db.prepare(`
            INSERT OR IGNORE INTO synapses (id, source, target, axon, weight, metadata, formed_at, last_potentiated)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(crypto.randomUUID(), syn.source, primaryId, syn.axon, syn.weight, syn.metadata, syn.formed_at, syn.last_potentiated);
          synapsesMoved++;
        } catch { /* duplicate */ }
      }

      // 3. Archive superseded entity
      this.db.prepare(
        "UPDATE entities SET status = 'archived', superseded_by = ?, updated_at = ? WHERE id = ?",
      ).run(primaryId, new Date().toISOString(), supersededId);

      // 4. Create aliases from superseded's identifiers
      const superseded = this.getEntity(supersededId);
      let aliasesCreated = 0;
      if (superseded) {
        const aliasesToCreate: Array<{
          system: string;
          value: string;
          type: "external_id" | "email" | "handle";
        }> = [];

        if (superseded.source.externalId) {
          aliasesToCreate.push({
            system: superseded.source.system,
            value: superseded.source.externalId,
            type: "external_id",
          });
        }
        const email = superseded.attributes?.email as string | undefined;
        if (email) {
          aliasesToCreate.push({
            system: superseded.source.system,
            value: email,
            type: "email",
          });
        }
        const handle = superseded.attributes?.handle as string | undefined;
        if (handle) {
          aliasesToCreate.push({
            system: superseded.source.system,
            value: handle,
            type: "handle",
          });
        }

        for (const a of aliasesToCreate) {
          if (this.upsertAlias({
            canonicalId: primaryId,
            aliasSystem: a.system,
            aliasValue: a.value,
            aliasType: a.type,
            confidence: "confirmed",
          })) {
            aliasesCreated++;
          }
        }
      }

      return { synapsesMoved, aliasesCreated };
    })();
  }

  // ── Person finder methods ──────────────────────────────────────────────────

  /** Find person entities matching by email, excluding a source system. */
  findPersonsByEmail(email: string, excludeSystem?: string): Entity[] {
    const rows = excludeSystem
      ? this.db.prepare(`
          SELECT * FROM entities
          WHERE entity_type = 'person'
            AND JSON_EXTRACT(attributes, '$.email') = ?
            AND source_system != ?
            AND status = 'active'
        `).all(email, excludeSystem) as EntityRow[]
      : this.db.prepare(`
          SELECT * FROM entities
          WHERE entity_type = 'person'
            AND JSON_EXTRACT(attributes, '$.email') = ?
            AND status = 'active'
        `).all(email) as EntityRow[];
    return rows.map(rowToEntity);
  }

  /** Find person entities matching by normalized name, excluding a source system. */
  findPersonsByNormalizedName(name: string, excludeSystem?: string): Entity[] {
    const rows = excludeSystem
      ? this.db.prepare(`
          SELECT * FROM entities
          WHERE entity_type = 'person'
            AND LOWER(TRIM(title)) = ?
            AND source_system != ?
            AND status = 'active'
        `).all(name, excludeSystem) as EntityRow[]
      : this.db.prepare(`
          SELECT * FROM entities
          WHERE entity_type = 'person'
            AND LOWER(TRIM(title)) = ?
            AND status = 'active'
        `).all(name) as EntityRow[];
    return rows.map(rowToEntity);
  }

  /** Find person entities matching by handle or username attribute, excluding a source system. */
  findPersonsByHandle(handle: string, excludeSystem?: string): Entity[] {
    const rows = excludeSystem
      ? this.db.prepare(`
          SELECT * FROM entities
          WHERE entity_type = 'person'
            AND (JSON_EXTRACT(attributes, '$.handle') = ? OR JSON_EXTRACT(attributes, '$.username') = ?)
            AND source_system != ?
            AND status = 'active'
        `).all(handle, handle, excludeSystem) as EntityRow[]
      : this.db.prepare(`
          SELECT * FROM entities
          WHERE entity_type = 'person'
            AND (JSON_EXTRACT(attributes, '$.handle') = ? OR JSON_EXTRACT(attributes, '$.username') = ?)
            AND status = 'active'
        `).all(handle, handle) as EntityRow[];
    return rows.map(rowToEntity);
  }

  // ── User methods ────────────────────────────────────────────────────────────

  insertUser(user: { id: string; name: string; email?: string; apiKeyHash: string; role: string; createdAt: string; status: string }): void {
    this.db.prepare(`
      INSERT INTO users (id, name, email, api_key_hash, role, created_at, status)
      VALUES (@id, @name, @email, @api_key_hash, @role, @created_at, @status)
    `).run({
      id: user.id,
      name: user.name,
      email: user.email ?? null,
      api_key_hash: user.apiKeyHash,
      role: user.role,
      created_at: user.createdAt,
      status: user.status,
    });
  }

  getUserById(id: string): { id: string; name: string; email?: string; role: string; createdAt: string; status: string } | null {
    const row = this.db
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(id) as { id: string; name: string; email: string | null; api_key_hash: string; role: string; created_at: string; status: string } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      email: row.email ?? undefined,
      role: row.role,
      createdAt: row.created_at,
      status: row.status,
    };
  }

  getUserByApiKeyHash(hash: string): { id: string; name: string; email?: string; role: string; createdAt: string; status: string } | null {
    const row = this.db
      .prepare("SELECT * FROM users WHERE api_key_hash = ? AND status = 'active'")
      .get(hash) as { id: string; name: string; email: string | null; api_key_hash: string; role: string; created_at: string; status: string } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      email: row.email ?? undefined,
      role: row.role,
      createdAt: row.created_at,
      status: row.status,
    };
  }

  listUsers(): { id: string; name: string; email?: string; role: string; createdAt: string; status: string }[] {
    const rows = this.db
      .prepare("SELECT * FROM users ORDER BY created_at ASC")
      .all() as { id: string; name: string; email: string | null; api_key_hash: string; role: string; created_at: string; status: string }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email ?? undefined,
      role: row.role,
      createdAt: row.created_at,
      status: row.status,
    }));
  }

  updateUserStatus(userId: string, status: string): void {
    this.db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, userId);
  }

  // ── Label methods ───────────────────────────────────────────────────────────

  createLabel(id: string, name: string, description?: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO labels (id, name, description, created_at)
      VALUES (?, ?, ?, ?)
    `).run(id, name, description ?? null, now);
  }

  listLabels(): { id: string; name: string; description?: string; createdAt: string }[] {
    const rows = this.db
      .prepare("SELECT * FROM labels ORDER BY name ASC")
      .all() as { id: string; name: string; description: string | null; created_at: string }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description ?? undefined,
      createdAt: r.created_at,
    }));
  }

  getLabelByName(name: string): { id: string; name: string; description?: string; createdAt: string } | null {
    const row = this.db
      .prepare("SELECT * FROM labels WHERE name = ?")
      .get(name) as { id: string; name: string; description: string | null; created_at: string } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      createdAt: row.created_at,
    };
  }

  deleteLabel(id: string): void {
    this.db.prepare("DELETE FROM labels WHERE id = ?").run(id);
  }

  assignUserLabel(userId: string, labelId: string, grantedBy?: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO user_labels (user_id, label_id, granted_by, granted_at)
      VALUES (?, ?, ?, ?)
    `).run(userId, labelId, grantedBy ?? null, now);
  }

  revokeUserLabel(userId: string, labelId: string): void {
    this.db.prepare(
      "DELETE FROM user_labels WHERE user_id = ? AND label_id = ?",
    ).run(userId, labelId);
  }

  getUserLabels(userId: string): string[] {
    const rows = this.db.prepare(`
      SELECT l.name
      FROM user_labels ul
      JOIN labels l ON ul.label_id = l.id
      WHERE ul.user_id = ?
    `).all(userId) as { name: string }[];
    return rows.map((r) => r.name);
  }

  // ── Entity ownership methods ─────────────────────────────────────────────────

  updateUserRevokedAt(userId: string, revokedAt: string): void {
    this.db.prepare("UPDATE users SET revoked_at = ? WHERE id = ?").run(revokedAt, userId);
  }

  reassignEntityOwnership(fromUserId: string, toUserId: string): number {
    const result = this.db.prepare(
      "UPDATE entities SET owner_id = ? WHERE owner_id = ?",
    ).run(toUserId, fromUserId);
    // For DM entities under the new owner: add new user to acl_members
    const dmEntities = this.db.prepare(
      "SELECT id, acl_members FROM entities WHERE owner_id = ? AND visibility = 'dm'",
    ).all(toUserId) as { id: string; acl_members: string }[];
    for (const e of dmEntities) {
      const members: string[] = JSON.parse(e.acl_members ?? '[]');
      if (!members.includes(toUserId)) {
        members.push(toUserId);
        this.db.prepare("UPDATE entities SET acl_members = ? WHERE id = ?")
          .run(JSON.stringify(members), e.id);
      }
    }
    return result.changes as number;
  }

  cleanupOrphanedEntities(gracePeriodDays = 90): { archived: number; cleared: number } {
    const cutoff = new Date(Date.now() - gracePeriodDays * 24 * 60 * 60 * 1000).toISOString();

    // Archive private/DM entities owned by users revoked >gracePeriodDays ago
    const archiveResult = this.db.prepare(`
      UPDATE entities SET status = 'archived'
      WHERE owner_id IN (
        SELECT id FROM users WHERE status = 'revoked' AND revoked_at IS NOT NULL AND revoked_at < ?
      )
      AND visibility IN ('private', 'dm')
      AND status != 'archived'
    `).run(cutoff);

    // Clear owner_id for team/org/public entities owned by revoked users
    const clearResult = this.db.prepare(`
      UPDATE entities SET owner_id = NULL
      WHERE owner_id IN (
        SELECT id FROM users WHERE status = 'revoked' AND revoked_at IS NOT NULL AND revoked_at < ?
      )
      AND visibility NOT IN ('private', 'dm')
    `).run(cutoff);

    return {
      archived: archiveResult.changes as number,
      cleared: clearResult.changes as number,
    };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }

  /** Emit a startup warning when >1 user exists and CORTEX_ACL is not 'on'. */
  warnIfAclDisabled(): void {
    if (process.env.CORTEX_ACL === 'on') return;
    try {
      const result = this.db
        .prepare("SELECT COUNT(*) as cnt FROM users WHERE status = 'active'")
        .get() as { cnt: number };
      if (result.cnt > 1) {
        console.error(
          `[hive-memory] WARNING: ${result.cnt} active users exist but CORTEX_ACL is not 'on'. ` +
          `Set CORTEX_ACL=on to enforce access control.`,
        );
      }
    } catch {
      // table may not exist in tests
    }
  }
}
