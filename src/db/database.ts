import BetterSqlite3 from "better-sqlite3";
import crypto from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { createSchema } from "./schema.js";
import type { Entity, ConnectorConfig, Organization, Workspace } from "../types.js";
import { VectorStore } from "../search/vector-store.js";
import { rrfFusion, buildEmbedText } from "../search/hybrid.js";
import type { ACLContext } from "../acl/types.js";
import { defaultACLPolicy } from "../acl/policy.js";
import * as entityOps from "./entity-ops.js";
import type { ListEntitiesOptions, SearchEntitiesOptions, CountEntitiesOptions } from "./entity-ops.js";
import * as synapseOps from "./synapse-ops.js";

// Re-export Entity so consumers can import it from this module
export type { Entity } from "../types.js";

// ── Row types (raw SQLite rows before JSON parsing) ───────────────────────────
// EntityRow is defined in entity-ops.ts; SynapseRow kept here for mergeEntities.

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  status: string;
}

interface WorkspaceRow {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  created_at: string;
  status: string;
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

// CoactivationRow moved to synapse-ops.ts

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

// ── Filter / option types (defined in entity-ops.ts, re-exported here) ───────

export type { ListEntitiesOptions, SearchEntitiesOptions, CountEntitiesOptions } from "./entity-ops.js";

// ── Helpers ──────────────────────────────────────────────────────────────────
// rowToEntity, entityToRow, computeContentHash → entity-ops.ts
// rowToSynapse → synapse-ops.ts

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

// ── Content hash helper (defined in entity-ops.ts, re-exported here) ─────────
export { computeContentHash } from "./entity-ops.js";

// ── HiveDatabase ──────────────────────────────────────────────────────────────
// Concrete synchronous implementation backed by better-sqlite3.
// This is the main class — it is also used as the structural type for the
// async adapter (AsyncHiveDb in adapter.ts) and the legacy shim in store.ts.
// All public methods are synchronous (better-sqlite3 is blocking).

// HiveDatabase satisfies the IHiveDatabase interface defined in src/pipeline/db-interface.ts.
// The implements clause is omitted to avoid a circular module dependency.
export class HiveDatabase {
  private db: BetterSqlite3.Database;
  private _vectorStore: VectorStore | null = null;

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
    this.db.pragma("busy_timeout = 5000");

    createSchema(this.db);

    // Initialize vector store (graceful degradation if sqlite-vec unavailable)
    this._vectorStore = new VectorStore(this.db);
  }

  /** Expose raw SQLite database for advanced queries (e.g. transactions in pipeline code). */
  get rawDb(): BetterSqlite3.Database {
    return this.db;
  }

  /** Expose VectorStore for external embedding pipeline. */
  get vectorStore(): VectorStore {
    if (!this._vectorStore) {
      this._vectorStore = new VectorStore(this.db);
    }
    return this._vectorStore;
  }

  // ── Entity methods (delegated to entity-ops.ts) ────────────────────────────

  insertEntity(entity: Entity): void {
    entityOps.insertEntity(this.db, entity);
  }

  updateEntity(id: string, updates: Partial<Omit<Entity, "id">>): { changed: boolean } {
    return entityOps.updateEntity(this.db, id, updates);
  }

  deleteEntity(id: string): void {
    entityOps.deleteEntity(this.db, id);
  }

  getEntity(id: string, acl?: ACLContext): Entity | null {
    return entityOps.getEntity(this.db, id, acl);
  }

  listEntities(options: ListEntitiesOptions = {}): Entity[] {
    return entityOps.listEntities(this.db, options);
  }

  searchEntities(query: string, options: SearchEntitiesOptions = {}): Entity[] {
    return entityOps.searchEntities(this.db, query, options);
  }

  countEntities(options: CountEntitiesOptions = {}): number {
    return entityOps.countEntities(this.db, options);
  }

  /** Group-by counts for namespace, entity_type, or project. */
  countEntitiesByGroup(
    groupBy: "namespace" | "entity_type" | "project",
    filter?: { project?: string; namespace?: string; acl?: ACLContext },
  ): Array<{ key: string; count: number }> {
    const conditions: string[] = ["e.status = 'active'", "e.valid_to IS NULL"];
    const params: Record<string, unknown> = {};

    if (filter?.project) {
      conditions.push("e.project = @project");
      params.project = filter.project;
    }
    if (filter?.namespace) {
      conditions.push("e.namespace = @namespace");
      params.namespace = filter.namespace;
    }
    if (filter?.acl) {
      const { clause, params: aclParams } = defaultACLPolicy.sqlWhereClause(filter.acl);
      conditions.push(clause);
      Object.assign(params, aclParams);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const col = groupBy === "entity_type" ? "e.entity_type" : `e.${groupBy}`;

    const rows = this.db.prepare(
      `SELECT ${col} as grp, COUNT(*) as cnt FROM entities e ${where} GROUP BY ${col} ORDER BY cnt DESC`
    ).all(params) as Array<{ grp: string | null; cnt: number }>;

    return rows
      .filter(r => r.grp !== null)
      .map(r => ({ key: r.grp!, count: r.cnt }));
  }

  // ── Synapse methods (delegated to synapse-ops.ts) ──────────────────────────

  insertSynapse(synapse: SynapseRecord): void {
    synapseOps.insertSynapse(this.db, synapse);
  }

  getSynapsesByEntry(
    entryId: string,
    direction: "outgoing" | "incoming" | "both" = "both",
    axonType?: string,
  ): SynapseRecord[] {
    return synapseOps.getSynapsesByEntry(this.db, entryId, direction, axonType);
  }

  getNeighborIds(
    entryId: string,
    direction: "outgoing" | "incoming" | "both" = "both",
  ): string[] {
    return synapseOps.getNeighborIds(this.db, entryId, direction);
  }

  updateSynapseWeight(id: string, weight: number): void {
    synapseOps.updateSynapseWeight(this.db, id, weight);
  }

  applyDecay(factor = 0.95, pruneThreshold = 0.05): number {
    return synapseOps.applyDecay(this.db, factor, pruneThreshold);
  }

  // ── Coactivation methods ────────────────────────────────────────────────────

  recordCoactivation(entryIds: string[]): void {
    synapseOps.recordCoactivation(this.db, entryIds);
  }

  getCoactivationAboveThreshold(threshold: number): { pairKey: string; count: number }[] {
    return synapseOps.getCoactivationAboveThreshold(this.db, threshold);
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
    return entityOps.getByExternalId(this.db, system, externalId);
  }

  // ── Enrichment convenience methods ──────────────────────────────────────────

  /** Merge attributes into an existing entity (does not replace, only adds/overwrites keys). */
  updateEntityAttributes(id: string, attributes: Record<string, unknown>): void {
    entityOps.updateEntityAttributes(this.db, id, attributes);
  }

  /** Append unique tags to an existing entity. */
  addEntityTags(id: string, tags: string[]): void {
    entityOps.addEntityTags(this.db, id, tags);
  }

  /** Append unique keywords to an existing entity. */
  addEntityKeywords(id: string, keywords: string[]): void {
    entityOps.addEntityKeywords(this.db, id, keywords);
  }

  /** Get all synapses for a given axon type. */
  getSynapsesByAxon(axon: string): SynapseRecord[] {
    return synapseOps.getSynapsesByAxon(this.db, axon);
  }

  /**
   * Mark an entity as superseded by a newer entity.
   * Sets valid_to + superseded_by + status='superseded' on old entity,
   * then creates a refinement synapse from new → old.
   */
  supersede(oldId: string, newId: string): void {
    const now = new Date().toISOString();
    this.updateEntity(oldId, {
      validTo: now,
      supersededBy: newId,
      status: "superseded" as Entity["status"],
    });
    this.upsertSynapse({ sourceId: newId, targetId: oldId, axon: "refinement", weight: 1.0 });
  }

  /** Upsert a synapse with set-weight semantics (not +0.1 accumulation). */
  upsertSynapse(opts: {
    sourceId: string;
    targetId: string;
    axon: string;
    weight: number;
    metadata?: Record<string, string>;
  }): void {
    synapseOps.upsertSynapse(this.db, opts);
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
    return entityOps.upsertEntity(this.db, draft);
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
    return entityOps.findPersonsByEmail(this.db, email, excludeSystem);
  }

  /** Find person entities matching by normalized name, excluding a source system. */
  findPersonsByNormalizedName(name: string, excludeSystem?: string): Entity[] {
    return entityOps.findPersonsByNormalizedName(this.db, name, excludeSystem);
  }

  /** Find person entities matching by handle or username attribute, excluding a source system. */
  findPersonsByHandle(handle: string, excludeSystem?: string): Entity[] {
    return entityOps.findPersonsByHandle(this.db, handle, excludeSystem);
  }

  // ── User methods ────────────────────────────────────────────────────────────

  insertUser(user: { id: string; name: string; email?: string; apiKeyHash: string; role: string; createdAt: string; status: string; orgId?: string; workspaceId?: string }): void {
    this.db.prepare(`
      INSERT INTO users (id, name, email, api_key_hash, role, created_at, status, org_id, workspace_id)
      VALUES (@id, @name, @email, @api_key_hash, @role, @created_at, @status, @org_id, @workspace_id)
    `).run({
      id: user.id,
      name: user.name,
      email: user.email ?? null,
      api_key_hash: user.apiKeyHash,
      role: user.role,
      created_at: user.createdAt,
      status: user.status,
      org_id: user.orgId ?? null,
      workspace_id: user.workspaceId ?? null,
    });
  }

  getUserByApiKeyHash(hash: string): { id: string; name: string; email?: string; role: string; createdAt: string; status: string; orgId?: string; workspaceId?: string } | null {
    const row = this.db
      .prepare("SELECT * FROM users WHERE api_key_hash = ? AND status = 'active'")
      .get(hash) as { id: string; name: string; email: string | null; api_key_hash: string; role: string; created_at: string; status: string; org_id: string | null; workspace_id: string | null } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      email: row.email ?? undefined,
      role: row.role,
      createdAt: row.created_at,
      status: row.status,
      orgId: row.org_id ?? undefined,
      workspaceId: row.workspace_id ?? undefined,
    };
  }

  listUsers(): { id: string; name: string; email?: string; role: string; createdAt: string; status: string; orgId?: string; workspaceId?: string }[] {
    const rows = this.db
      .prepare("SELECT * FROM users ORDER BY created_at ASC")
      .all() as { id: string; name: string; email: string | null; api_key_hash: string; role: string; created_at: string; status: string; org_id: string | null; workspace_id: string | null }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email ?? undefined,
      role: row.role,
      createdAt: row.created_at,
      status: row.status,
      orgId: row.org_id ?? undefined,
      workspaceId: row.workspace_id ?? undefined,
    }));
  }

  updateUserStatus(userId: string, status: string): void {
    this.db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, userId);
  }

  /** Get label IDs associated with a user (from user_labels table). */
  getUserLabels(userId: string): string[] {
    const rows = this.db
      .prepare("SELECT label_id FROM user_labels WHERE user_id = ?")
      .all(userId) as { label_id: string }[];
    return rows.map((r) => r.label_id);
  }

  /** Assign a user to an organization (and optionally a workspace). */
  assignUserToOrg(userId: string, orgId: string, workspaceId?: string): void {
    this.db.prepare("UPDATE users SET org_id = ?, workspace_id = ? WHERE id = ?")
      .run(orgId, workspaceId ?? null, userId);
  }

  rotateUserApiKey(userId: string, newHash: string): void {
    this.db.prepare("UPDATE users SET api_key_hash = ? WHERE id = ?")
      .run(newHash, userId);
  }

  // ── Organization methods ─────────────────────────────────────────────────────

  createOrganization(name: string, slug: string): Organization {
    if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
      throw new Error(`Invalid slug "${slug}": must be lowercase alphanumeric with hyphens only`);
    }
    const existing = this.getOrganizationBySlug(slug);
    if (existing) {
      throw new Error(`Organization with slug "${slug}" already exists`);
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO organizations (id, name, slug, created_at, status)
      VALUES (?, ?, ?, ?, 'active')
    `).run(id, name, slug, now);
    return { id, name, slug, createdAt: now, status: "active" };
  }

  getOrganization(id: string): Organization | null {
    const row = this.db
      .prepare("SELECT * FROM organizations WHERE id = ?")
      .get(id) as OrganizationRow | undefined;
    if (!row) return null;
    return { id: row.id, name: row.name, slug: row.slug, createdAt: row.created_at, status: row.status };
  }

  getOrganizationBySlug(slug: string): Organization | null {
    const row = this.db
      .prepare("SELECT * FROM organizations WHERE slug = ?")
      .get(slug) as OrganizationRow | undefined;
    if (!row) return null;
    return { id: row.id, name: row.name, slug: row.slug, createdAt: row.created_at, status: row.status };
  }

  listOrganizations(): Organization[] {
    const rows = this.db
      .prepare("SELECT * FROM organizations ORDER BY created_at ASC")
      .all() as OrganizationRow[];
    return rows.map((row) => ({ id: row.id, name: row.name, slug: row.slug, createdAt: row.created_at, status: row.status }));
  }

  // ── Workspace methods ─────────────────────────────────────────────────────────

  createWorkspace(orgId: string, name: string, slug: string): Workspace {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO workspaces (id, org_id, name, slug, created_at, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(id, orgId, name, slug, now);
    return { id, orgId, name, slug, createdAt: now, status: "active" };
  }

  getWorkspace(id: string): Workspace | null {
    const row = this.db
      .prepare("SELECT * FROM workspaces WHERE id = ?")
      .get(id) as WorkspaceRow | undefined;
    if (!row) return null;
    return { id: row.id, orgId: row.org_id, name: row.name, slug: row.slug, createdAt: row.created_at, status: row.status };
  }

  listWorkspaces(orgId: string): Workspace[] {
    const rows = this.db
      .prepare("SELECT * FROM workspaces WHERE org_id = ? ORDER BY created_at ASC")
      .all(orgId) as WorkspaceRow[];
    return rows.map((row) => ({ id: row.id, orgId: row.org_id, name: row.name, slug: row.slug, createdAt: row.created_at, status: row.status }));
  }

  // ── Audit log methods ─────────────────────────────────────────────────────────

  insertAuditEntry(entry: {
    timestamp: string;
    userId?: string;
    action: string;
    toolName?: string;
    resourceId?: string;
    query?: string;
    resultCount?: number;
    ipAddress?: string;
    metadata?: Record<string, unknown>;
  }): void {
    this.db.prepare(`
      INSERT INTO audit_log (timestamp, user_id, action, tool_name, resource_id, query, result_count, ip_address, metadata)
      VALUES (@timestamp, @user_id, @action, @tool_name, @resource_id, @query, @result_count, @ip_address, @metadata)
    `).run({
      timestamp: entry.timestamp,
      user_id: entry.userId ?? null,
      action: entry.action,
      tool_name: entry.toolName ?? null,
      resource_id: entry.resourceId ?? null,
      query: entry.query ?? null,
      result_count: entry.resultCount ?? null,
      ip_address: entry.ipAddress ?? null,
      metadata: JSON.stringify(entry.metadata ?? {}),
    });
  }

  queryAuditLog(filters: {
    userId?: string;
    since?: string;
    until?: string;
    action?: string;
    limit?: number;
  } = {}): Array<{
    id: number;
    timestamp: string;
    userId?: string;
    action: string;
    toolName?: string;
    resourceId?: string;
    query?: string;
    resultCount?: number;
    ipAddress?: string;
    metadata: Record<string, unknown>;
  }> {
    const { userId, since, until, action, limit = 100 } = filters;
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (userId !== undefined) {
      conditions.push("user_id = @userId");
      params.userId = userId;
    }
    if (since !== undefined) {
      conditions.push("timestamp >= @since");
      params.since = since;
    }
    if (until !== undefined) {
      conditions.push("timestamp <= @until");
      params.until = until;
    }
    if (action !== undefined) {
      conditions.push("action = @action");
      params.action = action;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.limit = limit;

    const rows = this.db
      .prepare(`SELECT * FROM audit_log ${where} ORDER BY timestamp DESC LIMIT @limit`)
      .all(params) as Array<{
        id: number;
        timestamp: string;
        user_id: string | null;
        action: string;
        tool_name: string | null;
        resource_id: string | null;
        query: string | null;
        result_count: number | null;
        ip_address: string | null;
        metadata: string;
      }>;

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      userId: row.user_id ?? undefined,
      action: row.action,
      toolName: row.tool_name ?? undefined,
      resourceId: row.resource_id ?? undefined,
      query: row.query ?? undefined,
      resultCount: row.result_count ?? undefined,
      ipAddress: row.ip_address ?? undefined,
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    }));
  }

  // ── Backup ────────────────────────────────────────────────────────────────────

  backup(outputPath: string): void {
    this.db.backup(outputPath);
  }

  // ── Hybrid Search ────────────────────────────────────────────────────────────

  /**
   * Hybrid search: BM25 (FTS5) + vector similarity fused via RRF.
   *
   * When a query embedding is provided and the vector store is available, results
   * from both retrieval paths are merged with Reciprocal Rank Fusion.
   * Falls back to FTS5-only if no embedding or vector store unavailable.
   */
  hybridSearch(
    query: string,
    options: SearchEntitiesOptions & { embedding?: Float32Array } = {},
  ): Entity[] {
    const { embedding, ...searchOptions } = options;
    const limit = searchOptions.limit ?? 20;

    // Step 1: FTS5 BM25 search
    const bm25Results = this.searchEntities(query, { ...searchOptions, limit: limit * 3 });

    // Step 2: Vector search (if embedding provided and store available)
    const vs = this._vectorStore;
    if (embedding && vs?.isAvailable) {
      const vectorResults = vs.searchSimilar(embedding, limit * 3);

      // Build entity map for RRF lookup (populate with bm25 results + fetch vector hits)
      const entityMap = new Map<string, Entity>();
      for (const e of bm25Results) entityMap.set(e.id, e);

      for (const vr of vectorResults) {
        if (!entityMap.has(vr.entityId)) {
          const entity = this.getEntity(vr.entityId);
          if (entity && entity.status === "active") {
            // Apply project filter if set
            if (searchOptions.project && entity.project !== searchOptions.project) continue;
            entityMap.set(vr.entityId, entity);
          }
        }
      }

      // Step 3: RRF fusion
      return rrfFusion(bm25Results, vectorResults, entityMap, 60, limit).map(
        (r) => r.entity,
      );
    }

    return bm25Results.slice(0, limit);
  }

  /**
   * Index an entity's embedding into the vector store.
   * Builds contextual embed text (prefix + title + content).
   * No-op if vector store unavailable.
   */
  indexEntityEmbedding(entity: Entity, embedding: Float32Array): void {
    const vs = this._vectorStore;
    if (!vs?.isAvailable) return;
    vs.upsertVector(entity.id, embedding);
  }

  /**
   * Remove entity embedding from vector store.
   * No-op if vector store unavailable.
   */
  removeEntityEmbedding(entityId: string): void {
    const vs = this._vectorStore;
    if (!vs?.isAvailable) return;
    vs.deleteVector(entityId);
  }

  /**
   * Build embed text for an entity (contextual prefix + title + content).
   * Exported for use by ingestion pipeline.
   */
  static buildEmbedText(entity: Entity): string {
    return buildEmbedText(entity);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}
