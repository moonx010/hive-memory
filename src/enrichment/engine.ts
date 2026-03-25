import { randomUUID } from "node:crypto";
import type { HiveDatabase } from "../db/database.js";
import type {
  BatchFilter,
  BatchResult,
  Entity,
  EnrichmentContext,
  EnrichmentProvider,
  EnrichmentResult,
  LLMProvider,
} from "./types.js";

export class EnrichmentEngine {
  private providers: EnrichmentProvider[] = [];

  constructor(
    private db: HiveDatabase,
    private llm?: LLMProvider,
  ) {}

  register(provider: EnrichmentProvider): void {
    this.providers.push(provider);
    this.providers.sort((a, b) => a.priority - b.priority);
  }

  getProviders(): readonly EnrichmentProvider[] {
    return this.providers;
  }

  async enrichEntity(entityId: string): Promise<EnrichmentResult[]> {
    const entity = this.db.getEntity(entityId);
    if (!entity) throw new Error(`Entity not found: ${entityId}`);

    // Skip re-enrichment if content hasn't changed since last enrichment
    if (
      entity.contentHash !== undefined &&
      entity.contentHash === entity.attributes._enrichedContentHash
    ) {
      return [];
    }

    const ctx: EnrichmentContext = {
      db: this.db,
      findRelated: (query, opts) =>
        this.db.searchEntities(query, {
          entityType: opts?.entityType,
          limit: opts?.limit ?? 10,
        }),
      llm: this.llm,
    };

    const results: EnrichmentResult[] = [];
    const enrichedBy: string[] = [];

    for (const provider of this.providers) {
      const applicable = provider.applicableTo as readonly string[];
      if (!applicable.includes("*") && !applicable.includes(entity.entityType)) {
        continue;
      }
      if (!provider.shouldEnrich(entity)) continue;

      try {
        const result = await provider.enrich(entity, ctx);
        const hasContent =
          !!result.attributes ||
          !!result.tags?.length ||
          !!result.keywords?.length ||
          !!result.synapses?.length ||
          !!result.derivedEntities?.length;
        if (hasContent) {
          this.applyResult(entity, result);
          results.push(result);
          enrichedBy.push(provider.id);
        }
      } catch (err) {
        console.error(
          `[enrichment] provider ${provider.id} failed on ${entityId}:`,
          err,
        );
      }
    }

    if (enrichedBy.length > 0) {
      this.db.updateEntityAttributes(entityId, {
        _enrichedAt: new Date().toISOString(),
        _enrichedBy: enrichedBy,
        _enrichedContentHash: entity.contentHash,
      });
    }

    return results;
  }

  async enrichBatch(filter: BatchFilter = {}): Promise<BatchResult> {
    const batchId = randomUUID();
    const batchLimit = filter.limit ?? 100;
    const chunkSize = 50;

    let processed = 0;
    let enriched = 0;
    let errors = 0;
    let offset = 0;

    while (processed < batchLimit) {
      const fetchLimit = Math.min(chunkSize, batchLimit - processed);
      const entities = this.db.listEntities({
        entityType: filter.entityType,
        since: filter.since,
        unenrichedOnly: filter.unenrichedOnly,
        limit: fetchLimit,
        offset,
      });

      if (entities.length === 0) break;

      for (const entity of entities) {
        processed++;
        try {
          const results = await this.enrichEntity(entity.id);
          if (results.length > 0) {
            this.db.updateEntityAttributes(entity.id, { _batchId: batchId });
            enriched++;
          }
        } catch {
          errors++;
        }
        if (processed % 50 === 0) {
          console.error(
            `[enrichment] processed ${processed} entities`,
          );
        }
      }

      // When unenrichedOnly, the result set shrinks as entities get _enrichedAt stamped,
      // so always query from offset 0. Otherwise, advance the offset normally.
      if (!filter.unenrichedOnly) {
        offset += entities.length;
      }
    }

    return { processed, enriched, errors, batchId };
  }

  private applyResult(entity: Entity, result: EnrichmentResult): void {
    if (result.attributes) {
      this.db.updateEntityAttributes(entity.id, result.attributes);
    }
    if (result.tags?.length) {
      this.db.addEntityTags(entity.id, result.tags);
    }
    if (result.keywords?.length) {
      this.db.addEntityKeywords(entity.id, result.keywords);
    }

    // Upsert derived entities first, tracking externalId → entityId mapping
    const externalIdMap = new Map<string, string>();
    for (const draft of result.derivedEntities ?? []) {
      const entityId = this.db.upsertEntity(draft);
      if (draft.source?.externalId) {
        externalIdMap.set(draft.source.externalId, entityId);
      }
    }

    // Create synapses, resolving externalId references to real entity IDs
    for (const syn of result.synapses ?? []) {
      const resolvedTargetId = externalIdMap.get(syn.targetId) ?? syn.targetId;
      this.db.upsertSynapse({
        sourceId: entity.id,
        targetId: resolvedTargetId,
        axon: syn.axon,
        weight: syn.weight,
        metadata: syn.metadata,
      });
    }
  }
}
