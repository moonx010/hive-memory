/**
 * Entity operations — standalone functions that operate on a raw BetterSqlite3 database.
 * HiveDatabase delegates to these functions.
 */
import BetterSqlite3 from "better-sqlite3";
import crypto from "node:crypto";
import type { Entity } from "../types.js";
import type { ACLContext } from "../acl/types.js";
import { defaultACLPolicy } from "../acl/policy.js";
import { getCDCEventBus } from "../pipeline/cdc.js";

// ── Option types (owned here, re-exported from database.ts) ──────────────────

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
  /** ACL context — when provided, results are filtered per policy. */
  acl?: ACLContext;
  /** When true, include entities with a non-null valid_to (temporally superseded). Default: false */
  includeSuperseded?: boolean;
  /** Tenant isolation: when set, only return entities with this org_id */
  orgId?: string;
}

export interface SearchEntitiesOptions {
  project?: string;
  entityType?: string;
  domain?: string;
  namespace?: string;
  limit?: number;
  /** ACL context — when provided, results are filtered per policy. */
  acl?: ACLContext;
  /** When true, include entities with a non-null valid_to (temporally superseded). Default: false */
  includeSuperseded?: boolean;
  /** Tenant isolation: when set, only return entities with this org_id */
  orgId?: string;
}

export interface CountEntitiesOptions {
  project?: string;
  entityType?: string;
  domain?: string;
  namespace?: string;
  status?: string;
}

// ── Row types ─────────────────────────────────────────────────────────────────

export interface EntityRow {
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
  valid_from: string | null;
  valid_to: string | null;
  org_id: string | null;
}

// ── Row converters ─────────────────────────────────────────────────────────────

export function rowToEntity(row: EntityRow): Entity {
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
    validFrom: row.valid_from ?? undefined,
    validTo: row.valid_to ?? undefined,
    orgId: row.org_id ?? undefined,
  };
}

export function entityToRow(entity: Entity): Record<string, unknown> {
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
    valid_from: entity.validFrom ?? null,
    valid_to: entity.validTo ?? null,
    org_id: entity.orgId ?? null,
  };
}

/** SHA-256 hex of content, truncated to first 16 chars. */
export function computeContentHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ── FTS5 query sanitization ───────────────────────────────────────────────────

/**
 * Sanitize user input for FTS5 MATCH queries.
 * Strips FTS5 operators and special syntax that would cause parse errors.
 */
export function sanitizeFTS5Query(query: string): string {
  // Remove FTS5 column filters (e.g., "title:" or "content:")
  let sanitized = query.replace(/\b\w+\s*:/g, "");
  // Remove special FTS5 operators: ^, *, NEAR()
  sanitized = sanitized.replace(/[*^]/g, "");
  sanitized = sanitized.replace(/\bNEAR\s*\([^)]*\)/gi, "");
  // Balance double quotes — if odd number, remove all
  const quoteCount = (sanitized.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    sanitized = sanitized.replace(/"/g, "");
  }
  // Remove parentheses that could break grouping
  sanitized = sanitized.replace(/[()]/g, "");
  // Collapse whitespace
  sanitized = sanitized.replace(/\s+/g, " ").trim();
  // If empty after sanitization, return a safe fallback
  if (!sanitized) return '""';
  return sanitized;
}

// ── Entity CRUD ───────────────────────────────────────────────────────────────

export function insertEntity(db: BetterSqlite3.Database, entity: Entity): void {
  if (!entity.contentHash) {
    entity.contentHash = computeContentHash(entity.content);
  }
  if (!entity.validFrom) {
    entity.validFrom = entity.createdAt;
  }
  const row = entityToRow(entity);
  db.prepare(`
    INSERT INTO entities (
      id, entity_type, project, namespace, title, content,
      tags, keywords, attributes,
      source_system, source_external_id, source_url, source_connector,
      author, visibility, domain, confidence,
      created_at, updated_at, expires_at, status, superseded_by, content_hash,
      valid_from, valid_to, org_id
    ) VALUES (
      @id, @entity_type, @project, @namespace, @title, @content,
      @tags, @keywords, @attributes,
      @source_system, @source_external_id, @source_url, @source_connector,
      @author, @visibility, @domain, @confidence,
      @created_at, @updated_at, @expires_at, @status, @superseded_by, @content_hash,
      @valid_from, @valid_to, @org_id
    )
  `).run(row);
  getCDCEventBus().emit({
    type: "insert",
    entityId: entity.id,
    entityType: entity.entityType,
    source: entity.source?.system ?? "unknown",
    timestamp: new Date().toISOString(),
  }).catch(() => { /* non-critical */ });
}

export function getEntity(db: BetterSqlite3.Database, id: string, acl?: ACLContext): Entity | null {
  const row = db
    .prepare("SELECT * FROM entities WHERE id = ?")
    .get(id) as EntityRow | undefined;
  if (!row) return null;
  const entity = rowToEntity(row);
  if (acl && !defaultACLPolicy.canRead({
    visibility: entity.visibility,
    ownerId: (entity.attributes?.ownerId as string | undefined),
    requiredLabels: (entity.attributes?.requiredLabels as string[] | undefined),
    aclMembers: (entity.attributes?.aclMembers as string[] | undefined),
  }, acl)) {
    return null;
  }
  return entity;
}

export function updateEntity(db: BetterSqlite3.Database, id: string, updates: Partial<Omit<Entity, "id">>): { changed: boolean } {
  const existing = getEntity(db, id);
  if (!existing) throw new Error(`Entity not found: ${id}`);

  const merged: Entity = { ...existing, ...updates, id };

  const newHash = computeContentHash(merged.content);
  const changed = newHash !== existing.contentHash;
  merged.contentHash = newHash;

  const row = entityToRow(merged);

  db.prepare(`
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
      valid_from = @valid_from,
      valid_to = @valid_to
    WHERE id = @id
  `).run(row);
  getCDCEventBus().emit({
    type: "update",
    entityId: id,
    entityType: merged.entityType,
    source: merged.source?.system ?? "unknown",
    timestamp: new Date().toISOString(),
  }).catch(() => { /* non-critical */ });

  return { changed };
}

export function deleteEntity(db: BetterSqlite3.Database, id: string): void {
  db.prepare("DELETE FROM entities WHERE id = ?").run(id);
  getCDCEventBus().emit({
    type: "delete",
    entityId: id,
    entityType: "unknown",
    source: "unknown",
    timestamp: new Date().toISOString(),
  }).catch(() => { /* non-critical */ });
}

export function listEntities(db: BetterSqlite3.Database, options: ListEntitiesOptions = {}): Entity[] {
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
    includeSuperseded = false,
    orgId,
  } = options;

  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (project !== undefined) {
    conditions.push("e.project = @project");
    params.project = project;
  }
  if (entityType !== undefined) {
    if (Array.isArray(entityType)) {
      if (entityType.length > 0) {
        const placeholders = entityType.map((_, i) => `@et${i}`);
        conditions.push(`e.entity_type IN (${placeholders.join(", ")})`);
        entityType.forEach((t, i) => { params[`et${i}`] = t; });
      }
    } else {
      conditions.push("e.entity_type = @entityType");
      params.entityType = entityType;
    }
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
  if (since !== undefined) {
    conditions.push("e.updated_at >= @since");
    params.since = since;
  }
  if (until !== undefined) {
    conditions.push("e.updated_at <= @until");
    params.until = until;
  }
  if (unenrichedOnly) {
    conditions.push("JSON_EXTRACT(e.attributes, '$._enrichedAt') IS NULL");
  }
  if (hasKeywords) {
    conditions.push("e.keywords != '[]'");
  }
  if (!includeSuperseded) {
    conditions.push("e.valid_to IS NULL");
  }
  if (acl) {
    const { clause, params: aclParams } = defaultACLPolicy.sqlWhereClause(acl);
    conditions.push(clause);
    Object.assign(params, aclParams);
  }
  if (orgId !== undefined) {
    conditions.push("e.org_id = @_acl_org_id");
    params._acl_org_id = orgId;
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  let sortCol: string;
  if (sort === "created_at") {
    sortCol = "e.created_at";
  } else if (sort === "name") {
    sortCol = "COALESCE(e.title, e.id)";
  } else {
    sortCol = "e.updated_at";
  }
  const sortDir = order === "asc" ? "ASC" : "DESC";

  params.limit = limit;
  params.offset = offset;

  const rows = db
    .prepare(
      `SELECT e.* FROM entities e ${where} ORDER BY ${sortCol} ${sortDir} LIMIT @limit OFFSET @offset`,
    )
    .all(params) as EntityRow[];

  return rows.map(rowToEntity);
}

export function searchEntities(db: BetterSqlite3.Database, query: string, options: SearchEntitiesOptions = {}): Entity[] {
  const { project, entityType, domain, namespace, limit = 20, acl, includeSuperseded = false, orgId } = options;

  // Sanitize to prevent FTS5 parse errors from user input
  const safeQuery = sanitizeFTS5Query(query);

  const extraConditions: string[] = [];
  const params: Record<string, unknown> = { query: safeQuery, limit };

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
  if (!includeSuperseded) {
    extraConditions.push("e.valid_to IS NULL");
  }

  if (acl) {
    const { clause, params: aclParams } = defaultACLPolicy.sqlWhereClause(acl);
    extraConditions.push(clause);
    Object.assign(params, aclParams);
  }
  if (orgId !== undefined) {
    extraConditions.push("e.org_id = @_acl_org_id");
    params._acl_org_id = orgId;
  }

  const extraWhere =
    extraConditions.length > 0
      ? `AND ${extraConditions.join(" AND ")}`
      : "";

  try {
    const rows = db
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
  } catch {
    // FTS5 query parse error — return empty results instead of crashing
    return [];
  }
}

export function countEntities(db: BetterSqlite3.Database, options: CountEntitiesOptions = {}): number {
  const { project, entityType, domain, namespace, status = "active" } = options;

  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (project !== undefined) {
    conditions.push("project = @project");
    params.project = project;
  }
  if (entityType !== undefined) {
    conditions.push("entity_type = @entityType");
    params.entityType = entityType;
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

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = db
    .prepare(`SELECT COUNT(*) as cnt FROM entities ${where}`)
    .get(params) as { cnt: number };

  return result.cnt;
}

export function getByExternalId(db: BetterSqlite3.Database, system: string, externalId: string): Entity | null {
  const row = db
    .prepare(
      "SELECT * FROM entities WHERE source_system = ? AND source_external_id = ? LIMIT 1",
    )
    .get(system, externalId) as EntityRow | undefined;
  return row ? rowToEntity(row) : null;
}

export function updateEntityAttributes(db: BetterSqlite3.Database, id: string, attributes: Record<string, unknown>): void {
  const existing = getEntity(db, id);
  if (!existing) throw new Error(`Entity not found: ${id}`);
  updateEntity(db, id, {
    attributes: { ...existing.attributes, ...attributes },
    updatedAt: new Date().toISOString(),
  });
}

export function addEntityTags(db: BetterSqlite3.Database, id: string, tags: string[]): void {
  const existing = getEntity(db, id);
  if (!existing) throw new Error(`Entity not found: ${id}`);
  const merged = [...new Set([...existing.tags, ...tags])];
  updateEntity(db, id, { tags: merged, updatedAt: new Date().toISOString() });
}

export function addEntityKeywords(db: BetterSqlite3.Database, id: string, keywords: string[]): void {
  const existing = getEntity(db, id);
  if (!existing) throw new Error(`Entity not found: ${id}`);
  const merged = [...new Set([...existing.keywords, ...keywords])];
  updateEntity(db, id, { keywords: merged, updatedAt: new Date().toISOString() });
}

export function upsertEntity(db: BetterSqlite3.Database, draft: {
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
  insertEntity(db, entity);
  return id;
}

export function findPersonsByEmail(db: BetterSqlite3.Database, email: string, excludeSystem?: string): Entity[] {
  const rows = excludeSystem
    ? db.prepare(`
        SELECT * FROM entities
        WHERE entity_type = 'person'
          AND JSON_EXTRACT(attributes, '$.email') = ?
          AND source_system != ?
          AND status = 'active'
      `).all(email, excludeSystem) as EntityRow[]
    : db.prepare(`
        SELECT * FROM entities
        WHERE entity_type = 'person'
          AND JSON_EXTRACT(attributes, '$.email') = ?
          AND status = 'active'
      `).all(email) as EntityRow[];
  return rows.map(rowToEntity);
}

export function findPersonsByNormalizedName(db: BetterSqlite3.Database, name: string, excludeSystem?: string): Entity[] {
  const rows = excludeSystem
    ? db.prepare(`
        SELECT * FROM entities
        WHERE entity_type = 'person'
          AND LOWER(TRIM(title)) = ?
          AND source_system != ?
          AND status = 'active'
      `).all(name, excludeSystem) as EntityRow[]
    : db.prepare(`
        SELECT * FROM entities
        WHERE entity_type = 'person'
          AND LOWER(TRIM(title)) = ?
          AND status = 'active'
      `).all(name) as EntityRow[];
  return rows.map(rowToEntity);
}

export function findPersonsByHandle(db: BetterSqlite3.Database, handle: string, excludeSystem?: string): Entity[] {
  const rows = excludeSystem
    ? db.prepare(`
        SELECT * FROM entities
        WHERE entity_type = 'person'
          AND (JSON_EXTRACT(attributes, '$.handle') = ? OR JSON_EXTRACT(attributes, '$.username') = ?)
          AND source_system != ?
          AND status = 'active'
      `).all(handle, handle, excludeSystem) as EntityRow[]
    : db.prepare(`
        SELECT * FROM entities
        WHERE entity_type = 'person'
          AND (JSON_EXTRACT(attributes, '$.handle') = ? OR JSON_EXTRACT(attributes, '$.username') = ?)
          AND status = 'active'
      `).all(handle, handle) as EntityRow[];
  return rows.map(rowToEntity);
}
