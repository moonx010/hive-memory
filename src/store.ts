import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ProjectIndex,
  ProjectEntry,
  ProjectSummary,
  SessionSummary,
  MemoryEntry,
  MemoryCategory,
  CortexConfig,
  OnboardCandidate,
  AxonType,
  Synapse,
} from "./types.js";
import { writeJson } from "./store/io.js";
import { ProjectStore } from "./store/project-store.js";
import { MemoryStore } from "./store/memory-store.js";
import { SessionStore } from "./store/session-store.js";
import { ContextSync } from "./store/context-sync.js";
import type { CrossProjectInsight } from "./store/context-sync.js";
import { OnboardScanner } from "./store/onboard.js";
import { HiveStore } from "./store/hive-store.js";
import { HiveSearch } from "./store/hive-search.js";
import type { HiveSearchResult } from "./store/hive-search.js";
import { SynapseStore } from "./store/synapse-store.js";
import { migrateAllProjects, scanProjectReferences, syncReferences } from "./store/hive-migrate.js";
import { HiveDatabase } from "./db/database.js";
import type { ListEntitiesOptions, SearchEntitiesOptions } from "./db/database.js";
import type { Entity } from "./types.js";
import type { ConnectorRegistry, RawDocument } from "./connectors/types.js";
import { createConnectorRegistry } from "./connectors/types.js";
import { ConnectorStateMachine } from "./connectors/state-machine.js";
import { CheckpointManager } from "./connectors/checkpoint.js";
import type { TeamSync } from "./team/git-sync.js";
import { EnrichmentEngine } from "./enrichment/engine.js";
import { ClassifyProvider } from "./enrichment/providers/classify.js";
import { LLMEnrichProvider } from "./enrichment/providers/llm-enrich.js";
import { DecisionExtractorProvider } from "./enrichment/providers/decision-extractor.js";
import { createLLMProvider } from "./enrichment/llm/index.js";
import type { BatchFilter, BatchResult, EnrichmentResult, EnrichmentStage } from "./enrichment/types.js";
import { EntityResolver } from "./enrichment/entity-resolver.js";

// Re-export for backwards compatibility
export { validateId } from "./store/io.js";

// ── Helper: convert Entity → HiveSearchResult (v2 backward compat) ──

function entityToSearchResult(entity: Entity, score: number): HiveSearchResult {
  return {
    project: entity.project ?? "",
    category:
      entity.entityType === "decision"
        ? "decision"
        : ((entity.attributes?.kind as string | undefined) ?? entity.entityType),
    entryId: entity.id,
    agent: entity.attributes?.agentId as string | undefined,
    source: entity.source?.system,
    path: entity.attributes?.path as string | undefined,
    snippet: entity.content.slice(0, 300),
    score,
  };
}

/**
 * Spreading activation over HiveDatabase.
 * Uses getSynapsesByEntry to get weight info (since getNeighborIds only returns string[]).
 */
function spreadingActivationDb(
  db: HiveDatabase,
  seeds: string[],
  options: { maxDepth?: number; decay?: number; threshold?: number; maxResults?: number } = {},
): { entityId: string; activation: number }[] {
  const maxDepth = options.maxDepth ?? 2;
  const decay = options.decay ?? 0.5;
  const threshold = options.threshold ?? 0.1;
  const maxResults = options.maxResults ?? 20;

  const activations = new Map<string, number>();
  for (const seedId of seeds) {
    activations.set(seedId, 1.0);
  }

  let frontier = [...seeds];

  for (let depth = 1; depth <= maxDepth; depth++) {
    const nextFrontier: string[] = [];

    for (const entityId of frontier) {
      const current = activations.get(entityId);
      if (current === undefined) continue;

      const synapses = db.getSynapsesByEntry(entityId, "both");

      for (const synapse of synapses) {
        const neighborId = synapse.source === entityId ? synapse.target : synapse.source;
        const signal = current * synapse.weight * decay;
        if (signal < threshold) continue;

        const existing = activations.get(neighborId);
        if (existing !== undefined && existing >= signal) continue;

        activations.set(neighborId, signal);
        nextFrontier.push(neighborId);
      }
    }

    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  const seedSet = new Set(seeds);
  return [...activations.entries()]
    .filter(([id]) => !seedSet.has(id))
    .map(([entityId, activation]) => ({ entityId, activation }))
    .sort((a, b) => b.activation - a.activation)
    .slice(0, maxResults);
}

/**
 * RRF (Reciprocal Rank Fusion) merge of two ranked lists.
 */
function rrfFusion(
  listA: HiveSearchResult[],
  listB: HiveSearchResult[],
  limit: number,
): HiveSearchResult[] {
  const k = 60;
  const scoreMap = new Map<string, { score: number; result: HiveSearchResult }>();

  for (let i = 0; i < listA.length; i++) {
    const r = listA[i];
    const key = r.entryId ?? `a-${i}`;
    const rrfScore = 1 / (k + i + 1);
    const existing = scoreMap.get(key);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scoreMap.set(key, { score: rrfScore, result: r });
    }
  }

  for (let i = 0; i < listB.length; i++) {
    const r = listB[i];
    const key = r.entryId ?? `b-${i}`;
    const rrfScore = 1 / (k + i + 1);
    const existing = scoreMap.get(key);
    if (existing) {
      existing.score += rrfScore;
      if (r.graphDepth !== undefined) {
        existing.result.graphDepth = r.graphDepth;
      }
    } else {
      scoreMap.set(key, { score: rrfScore, result: r });
    }
  }

  return [...scoreMap.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ result, score }) => ({ ...result, score }));
}

/**
 * Facade over domain-specific stores.
 * Preserves the original public API so existing tests and tools keep working.
 * v3: integrates HiveDatabase, TeamSync, and ConnectorRegistry.
 */
export class CortexStore {
  private dataDir: string;
  private localContextEnabled: boolean;

  private projects!: ProjectStore;
  private memories!: MemoryStore;
  private sessions!: SessionStore;
  private context!: ContextSync;
  private onboard!: OnboardScanner;
  private hive!: HiveStore;
  private hiveSearch!: HiveSearch;
  private synapses!: SynapseStore;

  // v3 additions
  private _db: HiveDatabase | null = null;
  /** True only when _db was explicitly set via setDatabase() or is loaded with migrated data */
  private _dbExplicit = false;
  private _team: TeamSync | undefined = undefined;
  private _connectors: ConnectorRegistry;
  private _enrichmentEngine: EnrichmentEngine | null = null;
  private _entityResolver: EntityResolver | null = null;

  constructor(config: CortexConfig) {
    this.dataDir = config.dataDir;
    this.localContextEnabled = config.localContext.enabled ?? true;

    // Wire up sub-stores (no embedding dependency)
    this.projects = new ProjectStore(this.dataDir);
    this.hive = new HiveStore(this.dataDir);
    this.synapses = new SynapseStore(this.dataDir);
    this.hiveSearch = new HiveSearch(this.hive, this.synapses);
    this.memories = new MemoryStore(this.dataDir, this.projects, this.hive, this.hiveSearch, this.synapses);
    this.sessions = new SessionStore(this.dataDir, this.projects);
    this.context = new ContextSync(
      this.dataDir,
      config.localContext.filename,
      this.localContextEnabled,
      this.projects,
      this.memories,
    );
    this.onboard = new OnboardScanner(this.projects);
    this._connectors = createConnectorRegistry();
  }

  get localSyncEnabled(): boolean {
    return this.localContextEnabled;
  }

  // ── v3 accessors ──

  /**
   * Expose the underlying HiveDatabase for tools that need direct DB access.
   * Lazily initializes a HiveDatabase backed by the same data directory.
   */
  get database(): HiveDatabase {
    if (!this._db) {
      this._db = new HiveDatabase(join(this.dataDir, "cortex.db"));
    }
    return this._db;
  }

  /** Set the HiveDatabase implementation (called by init or external setup). */
  setDatabase(db: HiveDatabase): void {
    this._db = db;
    this._dbExplicit = true;
  }

  get teamSync(): TeamSync | undefined {
    return this._team;
  }

  setTeamSync(team: TeamSync): void {
    this._team = team;
  }

  get connectors(): ConnectorRegistry {
    return this._connectors;
  }

  /** Lazily initialize the enrichment engine. */
  get enrichmentEngine(): EnrichmentEngine {
    if (!this._enrichmentEngine) {
      const db = this.database;
      const enrichMode = process.env.CORTEX_ENRICHMENT ?? "rule";
      const llm = createLLMProvider();
      this._enrichmentEngine = new EnrichmentEngine(db, llm);

      if (enrichMode !== "off") {
        this._enrichmentEngine.register(new DecisionExtractorProvider());
        this._enrichmentEngine.register(new ClassifyProvider());
      }
      if (enrichMode === "llm" && llm) {
        this._enrichmentEngine.register(new LLMEnrichProvider());
      }
    }
    return this._enrichmentEngine;
  }

  /** Lazily initialize the entity resolver. */
  get entityResolver(): EntityResolver {
    if (!this._entityResolver) {
      this._entityResolver = new EntityResolver(this.database);
    }
    return this._entityResolver;
  }

  async enrichEntity(
    entityId: string,
    opts?: { force?: boolean; stage?: EnrichmentStage },
  ): Promise<EnrichmentResult[]> {
    return this.enrichmentEngine.enrichEntity(entityId, opts);
  }

  async enrichBatch(opts: BatchFilter = {}): Promise<BatchResult> {
    return this.enrichmentEngine.enrichBatch(opts);
  }

  // ── Lifecycle ──

  async init(): Promise<void> {
    await this.initDirs();
    await this.hive.ensureDirs();

    // Auto-migrate legacy knowledge/ → hive on first run
    const hiveIndex = await this.hive.loadHive();
    if (hiveIndex.totalEntries === 0) {
      await migrateAllProjects(this.dataDir, this.projects, this.hive);
    }
  }

  private async initDirs(): Promise<void> {
    const dirs = [
      this.dataDir,
      join(this.dataDir, "projects"),
      join(this.dataDir, "global"),
    ];
    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }
    const indexPath = join(this.dataDir, "index.json");
    if (!existsSync(indexPath)) {
      await writeJson(indexPath, { projects: [] });
    }
  }

  // ── Delegated project methods ──

  async getIndex(): Promise<ProjectIndex> { return this.projects.getIndex(); }
  async saveIndex(index: ProjectIndex): Promise<void> { return this.projects.saveIndex(index); }
  async searchProjects(query: string, limit?: number): Promise<ProjectEntry[]> { return this.projects.searchProjects(query, limit); }
  async upsertProject(entry: ProjectEntry): Promise<void> { return this.projects.upsertProject(entry); }
  async getProjectSummary(id: string): Promise<ProjectSummary | null> { return this.projects.getProjectSummary(id); }
  async saveProjectSummary(summary: ProjectSummary): Promise<void> { return this.projects.saveProjectSummary(summary); }
  async getProjectStatus(id: string): Promise<string | null> { return this.projects.getProjectStatus(id); }

  // ── Delegated memory methods ──

  async storeMemory(projectId: string, category: MemoryCategory, content: string, tags: string[], agentId?: string): Promise<MemoryEntry> {
    return this.memories.storeMemory(projectId, category, content, tags, agentId);
  }

  /**
   * Recall memories using FTS5 + spreading activation (v3 DB) or keyword search (v2 hive fallback).
   *
   * v3 flow (when _db is initialized):
   *   1. FTS5 search → initial results
   *   2. Top-3 seeds → spreading activation on synapse table
   *   3. RRF fusion of FTS5 + graph results
   *   4. Convert Entity[] → HiveSearchResult[] for backward compat
   *
   * v2 fallback: uses hive keyword search (HiveSearch).
   */
  async recallMemories(query: string, projectId?: string, limit = 5, agentId?: string): Promise<HiveSearchResult[]> {
    // Only use the v3 DB path when it was explicitly set — otherwise fall back to the v2 hive.
    // The `database` getter lazily creates a HiveDatabase for browse/tool use, but that
    // empty SQLite DB shouldn't override the populated v2 hive for recall.
    if (this._dbExplicit && this._db) {
      return this._recallViaDb(query, projectId, limit, agentId);
    }
    return this.memories.recallMemories(query, projectId, limit, agentId);
  }

  private _recallViaDb(
    query: string,
    projectId: string | undefined,
    limit: number,
    agentId: string | undefined,
  ): HiveSearchResult[] {
    const db = this._db!;
    const searchOptions: SearchEntitiesOptions = {
      ...(projectId ? { project: projectId } : {}),
      limit: limit * 3,
    };

    // Step 1: FTS5 search
    const ftsEntities = db.searchEntities(query, searchOptions);

    // Agent filter
    const filtered = agentId
      ? ftsEntities.filter((e) => e.attributes?.agentId === agentId)
      : ftsEntities;

    const ftsResults: HiveSearchResult[] = filtered.map((e, i) =>
      entityToSearchResult(e, 1 / (1 + i)),
    );

    // Step 2: Spreading activation from top-3 seeds
    const seedIds = filtered.slice(0, 3).map((e) => e.id);
    const graphResults: HiveSearchResult[] = [];

    if (seedIds.length > 0) {
      const activated = spreadingActivationDb(db, seedIds, {
        maxDepth: 2,
        decay: 0.5,
        threshold: 0.1,
        maxResults: limit * 2,
      });

      for (const act of activated) {
        const entity = db.getEntity(act.entityId);
        if (!entity) continue;
        if (projectId && entity.project !== projectId) continue;
        if (agentId && entity.attributes?.agentId !== agentId) continue;

        const result = entityToSearchResult(entity, act.activation * 10);
        result.graphDepth = 1;
        graphResults.push(result);
      }
    }

    // Step 3: RRF fusion
    return rrfFusion(ftsResults, graphResults, limit);
  }

  async traverseMemories(query: string, projectId?: string, limit = 10, depth = 3, decay = 0.5): Promise<HiveSearchResult[]> {
    return this.memories.traverseMemories(query, projectId, limit, depth, decay);
  }

  // ── Synapse methods ──

  async formSynapse(source: string, target: string, axon: AxonType, weight?: number, metadata?: Record<string, string>): Promise<Synapse> {
    return this.synapses.formSynapse(source, target, axon, weight, metadata);
  }
  async getConnections(entryId: string, direction?: "outgoing" | "incoming" | "both", axonType?: AxonType) {
    return this.synapses.getConnections(entryId, direction, axonType);
  }
  async getSynapseStats() {
    return this.synapses.getStats();
  }
  async applyDecay(): Promise<number> {
    return this.synapses.applyDecay();
  }

  // ── Delegated session methods ──

  async saveSession(projectId: string, session: SessionSummary): Promise<void> {
    await this.sessions.saveSession(projectId, session);
    await this.context.syncLocalContext(projectId);
  }

  // ── Delegated context methods ──

  async getCrossProjectContext(projectId: string, limit?: number): Promise<CrossProjectInsight[]> {
    return this.context.getCrossProjectContext(projectId, limit);
  }
  async syncLocalContext(projectId: string): Promise<string | null> {
    return this.context.syncLocalContext(projectId);
  }

  // ── Delegated onboard methods ──

  async scanForProjects(rootPath: string, depth?: number): Promise<OnboardCandidate[]> {
    return this.onboard.scanForProjects(rootPath, depth);
  }

  // ── Hive: reference scan on onboard ──

  async scanProjectReferences(projectId: string, projectPath: string): Promise<number> {
    return scanProjectReferences(projectId, projectPath, this.hive);
  }

  async syncReferences(projectId: string): Promise<number> {
    return syncReferences(projectId, this.hive);
  }

  // ── Cleanup ──

  async cleanupExpiredEntries(): Promise<number> {
    const STATUS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    return this.hive.removeEntries((entry) =>
      entry.type === "direct" &&
      entry.category === "status" &&
      now - new Date(entry.createdAt).getTime() > STATUS_TTL_MS,
    );
  }

  // ── v3 Browse methods (delegate to HiveDatabase) ──

  listEntities(options: ListEntitiesOptions): Entity[] {
    return this.database.listEntities(options);
  }

  searchEntities(query: string, options?: SearchEntitiesOptions): Entity[] {
    return this.database.searchEntities(query, options);
  }

  getEntityById(id: string): Entity | null {
    return this.database.getEntity(id);
  }

  // ── v3 Connector sync ──

  async syncConnector(connectorId: string, full = false): Promise<{
    added: number;
    updated: number;
    skipped: number;
    archived: number;
    errors: number;
    lastError?: string;
  }> {
    const connector = this._connectors.get(connectorId);
    if (!connector) {
      throw new Error(`Connector "${connectorId}" is not registered. Available: ${this._connectors.list().map(c => c.id).join(", ") || "(none)"}`);
    }
    if (!connector.isConfigured()) {
      throw new Error(`Connector "${connectorId}" is not configured (missing credentials).`);
    }

    const db = this.database;
    const sm = new ConnectorStateMachine(db);

    // Determine execution phase and mark connector as syncing
    const phase = sm.getExecutionPhase(connectorId, full);
    sm.startSync(connectorId, phase);

    // Checkpoint: only for initial phase syncs
    let cpManager: CheckpointManager | undefined;
    let resumedCounts = { added: 0, updated: 0, skipped: 0, errors: 0 };
    if (phase === "initial") {
      cpManager = new CheckpointManager(connectorId);
      const existingCp = cpManager.load();
      if (existingCp) {
        resumedCounts = existingCp.counts;
        console.error(`[sync:${connectorId}] Resuming from checkpoint (${existingCp.counts.added + existingCp.counts.updated} entities processed)`);
      } else {
        cpManager.create();
      }
    }

    let added = resumedCounts.added;
    let updated = resumedCounts.updated;
    let skipped = resumedCounts.skipped;
    let archived = 0;
    let errors = resumedCounts.errors;
    let lastError: string | undefined;
    const entityMap = new Map<string, string>(); // externalId → entityId

    // Select generator based on phase
    const cursor = phase === "initial" ? undefined : connector.getCursor();
    let gen: ReturnType<typeof connector.incrementalSync>;

    switch (phase) {
      case "initial":
        // Pass checkpoint to connectors that support it (optional parameter)
        gen = (connector.fullSync as (cp?: CheckpointManager) => AsyncGenerator<RawDocument>)(cpManager);
        break;
      case "rollback":
        if (connector.rollbackSync) {
          const rollbackWindow = sm.getRollbackWindow();
          gen = connector.rollbackSync(rollbackWindow);
        } else {
          gen = connector.incrementalSync(cursor);
        }
        break;
      case "incremental":
      default:
        gen = connector.incrementalSync(cursor);
        break;
    }

    // Build sync metadata object stamped on all entities during this sync
    const syncMeta = {
      _lastSyncedAt: new Date().toISOString(),
      _syncCursor: cursor ?? null,
      _syncPhase: phase,
      _syncConnector: connectorId,
      _sourceDeleted: false,
    };

    try {
      for await (const doc of gen) {
        try {
          // Check for source-reported deletion
          if (doc._deleted) {
            const existing = db.getByExternalId(doc.source, doc.externalId);
            if (existing) {
              db.updateEntityAttributes(existing.id, {
                ...syncMeta,
                _sourceDeleted: true,
              });
              if (existing.status !== "archived") {
                db.updateEntity(existing.id, {
                  status: "archived",
                  updatedAt: new Date().toISOString(),
                });
                archived++;
              }
            }
            continue;
          }

          const drafts = connector.transform(doc);

          for (const draft of drafts) {
            try {
              const existing = db.getByExternalId(draft.source.system, draft.source.externalId);
              const draftStatus = draft.status ?? "active";

              if (existing) {
                const result = db.updateEntity(existing.id, {
                  title: draft.title,
                  content: draft.content,
                  tags: draft.tags,
                  attributes: { ...draft.attributes, ...syncMeta },
                  status: draftStatus as Entity["status"],
                  updatedAt: new Date().toISOString(),
                });
                entityMap.set(draft.source.externalId, existing.id);
                if (result.changed) {
                  updated++;
                  cpManager?.updateCounts({ updated: 1 });
                } else {
                  // Content unchanged — still stamp sync metadata
                  db.updateEntityAttributes(existing.id, syncMeta);
                  skipped++;
                  cpManager?.updateCounts({ skipped: 1 });
                }
              } else {
                const now = new Date().toISOString();
                const keywords = this._extractKeywords(draft.content + " " + (draft.title ?? ""));
                const entity: Entity = {
                  id: randomUUID(),
                  entityType: draft.entityType as Entity["entityType"],
                  project: draft.project,
                  namespace: "local",
                  title: draft.title,
                  content: draft.content,
                  tags: draft.tags,
                  keywords,
                  attributes: { ...draft.attributes, ...syncMeta },
                  source: draft.source,
                  author: draft.author,
                  visibility: "personal",
                  domain: draft.domain as Entity["domain"],
                  confidence: draft.confidence,
                  createdAt: now,
                  updatedAt: now,
                  status: draftStatus as Entity["status"],
                };
                db.insertEntity(entity);
                entityMap.set(draft.source.externalId, entity.id);
                added++;
                cpManager?.updateCounts({ added: 1 });
              }
            } catch (err) {
              errors++;
              lastError = err instanceof Error ? err.message : String(err);
              cpManager?.updateCounts({ errors: 1 });
              console.error(`[sync:${connectorId}] Failed to upsert entity ${draft.source.externalId}: ${lastError}`);
            }
          }
        } catch (err) {
          errors++;
          lastError = err instanceof Error ? err.message : String(err);
          console.error(`[sync:${connectorId}] Failed to transform doc ${doc.externalId}: ${lastError}`);
        }
      }
    } catch (err) {
      // Generator-level error (e.g., API auth failure, network error)
      // Checkpoint is preserved on error so next run can resume
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`[sync:${connectorId}] Sync stream error: ${lastError}`);

      // Save partial progress before re-throwing fatal errors
      const now = new Date().toISOString();
      const finalErrors = errors + 1;
      sm.completeSync(connectorId, { added, updated, skipped, errors: finalErrors, lastError }, {
        lastSync: now,
        syncCursor: connector.getCursor(),
      });

      // Still run postSync for entities processed so far
      if (connector.postSync && entityMap.size > 0) {
        try {
          connector.postSync(db, entityMap);
        } catch (postErr) {
          console.error(`[sync:${connectorId}] postSync failed: ${postErr}`);
        }
      }

      return { added, updated, skipped, archived, errors: finalErrors, lastError };
    }

    // Post-sync hook for connector-specific synapse creation
    if (connector.postSync) {
      connector.postSync(db, entityMap);
    }

    // Delete checkpoint on successful completion
    cpManager?.delete();

    // Complete sync via state machine (handles phase transitions + history)
    const now = new Date().toISOString();
    sm.completeSync(connectorId, { added, updated, skipped, errors, lastError }, {
      lastSync: now,
      syncCursor: connector.getCursor(),
    });

    return { added, updated, skipped, archived, errors, lastError };
  }

  /** Simple keyword extraction (reuses hive-index logic) */
  private _extractKeywords(text: string): string[] {
    const lower = text.toLowerCase();
    const words = lower
      .split(/[\s,;:!?.()[\]{}"'`~@#$%^&*+=<>|/\\]+/)
      .filter(w => {
        if (!w || w.length === 0) return false;
        if (/^[a-z0-9-]+$/.test(w)) return w.length > 2;
        return true;
      });
    const freq = new Map<string, number>();
    for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);
  }
}
