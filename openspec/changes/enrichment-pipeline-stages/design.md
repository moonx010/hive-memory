# Design: enrichment-pipeline-stages

## EnrichmentStage Type

In `src/enrichment/types.ts`:

```typescript
export type EnrichmentStage = "classify" | "extract" | "stitch" | "resolve";

/** Stage ordering — lower index runs first. */
export const STAGE_ORDER: EnrichmentStage[] = ["classify", "extract", "stitch", "resolve"];

/** Per-stage timestamp attribute keys. */
export const STAGE_TIMESTAMP_KEYS: Record<EnrichmentStage, string> = {
  classify: "_classifiedAt",
  extract: "_extractedAt",
  stitch: "_stitchedAt",
  resolve: "_resolvedAt",
};
```

### Provider Interface Extension

```typescript
export interface EnrichmentProvider {
  readonly id: string;
  readonly name: string;
  readonly applicableTo: EntityType[] | ["*"];
  readonly priority: number;
  readonly stage: EnrichmentStage;  // NEW — which pipeline stage this provider belongs to
  shouldEnrich(entity: Entity): boolean;
  enrich(entity: Entity, ctx: EnrichmentContext): Promise<EnrichmentResult>;
}
```

### BatchFilter Extension

```typescript
export interface BatchFilter {
  entityType?: EntityType[];
  since?: string;
  unenrichedOnly?: boolean;
  limit?: number;
  stage?: EnrichmentStage;  // NEW — run only providers in this stage
}
```

## Provider Stage Assignments

### ClassifyProvider (stage: "classify")

```typescript
// In src/enrichment/providers/classify.ts
export class ClassifyProvider implements EnrichmentProvider {
  readonly id = "classify";
  readonly name = "Rule-Based Classifier";
  readonly stage: EnrichmentStage = "classify";  // NEW
  readonly priority = 100;
  // ...
}
```

### DecisionExtractorProvider (stage: "extract")

```typescript
// In src/enrichment/providers/decision-extractor.ts
export class DecisionExtractorProvider implements EnrichmentProvider {
  readonly id = "decision-extractor";
  readonly stage: EnrichmentStage = "extract";  // NEW
  readonly priority = 150;
  // ...
}
```

### LLMEnrichProvider (stage: "extract")

```typescript
// In src/enrichment/providers/llm-enrich.ts
export class LLMEnrichProvider implements EnrichmentProvider {
  readonly id = "llm-enrich";
  readonly stage: EnrichmentStage = "extract";  // NEW
  readonly priority = 200;
  // ...
}
```

### TopicStitcher — adapted as provider (stage: "stitch")

The TopicStitcher currently operates as a standalone batch job. To fit the stage model, it gets a thin provider wrapper:

```typescript
// In src/enrichment/providers/topic-stitch.ts
export class TopicStitchProvider implements EnrichmentProvider {
  readonly id = "topic-stitch";
  readonly stage: EnrichmentStage = "stitch";
  readonly priority = 300;
  readonly applicableTo: EntityType[] = ["*"];

  shouldEnrich(entity: Entity): boolean {
    // Only stitch entities with keywords
    return (entity.keywords?.length ?? 0) >= 3;
  }

  async enrich(entity: Entity, ctx: EnrichmentContext): Promise<EnrichmentResult> {
    // Find related entities by keyword overlap
    const related = ctx.findRelated(
      entity.keywords.slice(0, 5).join(" "),
      { limit: 10 },
    );

    const synapses: SynapseDraft[] = [];
    for (const match of related) {
      if (match.id === entity.id) continue;
      const jaccard = computeJaccard(entity.keywords, match.keywords);
      if (jaccard >= 0.4) {
        synapses.push({
          targetId: match.id,
          axon: "related",
          weight: jaccard,
        });
      }
    }

    return { synapses };
  }
}
```

### EntityResolver (stage: "resolve")

```typescript
// In src/enrichment/entity-resolver.ts — adapted as provider
export class EntityResolverProvider implements EnrichmentProvider {
  readonly id = "entity-resolver";
  readonly stage: EnrichmentStage = "resolve";
  readonly priority = 400;
  readonly applicableTo: EntityType[] = ["person"];
  // ...
}
```

## Refactored EnrichmentEngine

### enrichEntity() with stage filtering

```typescript
async enrichEntity(
  entityId: string,
  opts?: { force?: boolean; stage?: EnrichmentStage },
): Promise<EnrichmentResult[]> {
  const entity = this.db.getEntity(entityId);
  if (!entity) throw new Error(`Entity not found: ${entityId}`);

  // Content hash check (from content-hash-dedup)
  if (!opts?.force) {
    const enrichedHash = entity.attributes?._enrichedContentHash as string | undefined;
    const currentHash = entity.contentHash;
    if (enrichedHash && currentHash && enrichedHash === currentHash) {
      return [];
    }
  }

  const ctx: EnrichmentContext = { /* ... same as current ... */ };
  const results: EnrichmentResult[] = [];
  const enrichedBy: string[] = [];

  for (const provider of this.providers) {
    // Stage filter: skip providers not in requested stage
    if (opts?.stage && provider.stage !== opts.stage) continue;

    const applicable = provider.applicableTo as readonly string[];
    if (!applicable.includes("*") && !applicable.includes(entity.entityType)) continue;
    if (!provider.shouldEnrich(entity)) continue;

    try {
      const result = await provider.enrich(entity, ctx);
      const hasContent = /* ... same check as current ... */;
      if (hasContent) {
        this.applyResult(entity, result);
        results.push(result);
        enrichedBy.push(provider.id);
      }
    } catch (err) {
      console.error(`[enrichment] provider ${provider.id} failed on ${entityId}:`, err);
    }
  }

  if (enrichedBy.length > 0) {
    const now = new Date().toISOString();
    const attrs: Record<string, unknown> = {
      _enrichedAt: now,
      _enrichedBy: enrichedBy,
    };

    // Stamp per-stage completion timestamps
    if (opts?.stage) {
      const key = STAGE_TIMESTAMP_KEYS[opts.stage];
      attrs[key] = now;
    } else {
      // All stages ran — stamp all applicable stage timestamps
      const stagesRun = new Set(enrichedBy.map(id => this.getProviderStage(id)));
      for (const stage of stagesRun) {
        if (stage) attrs[STAGE_TIMESTAMP_KEYS[stage]] = now;
      }
    }

    // Track content hash at enrichment time
    if (entity.contentHash) {
      attrs._enrichedContentHash = entity.contentHash;
    }

    this.db.updateEntityAttributes(entityId, attrs);
  }

  return results;
}

private getProviderStage(providerId: string): EnrichmentStage | undefined {
  return this.providers.find(p => p.id === providerId)?.stage;
}
```

### enrichBatch() with stage filtering

```typescript
async enrichBatch(filter: BatchFilter = {}): Promise<BatchResult> {
  const batchId = randomUUID();
  const batchLimit = filter.limit ?? 100;
  // ... existing chunked iteration ...

  for (const entity of entities) {
    processed++;
    try {
      const results = await this.enrichEntity(entity.id, {
        stage: filter.stage,  // Pass stage through
      });
      if (results.length > 0) {
        this.db.updateEntityAttributes(entity.id, { _batchId: batchId });
        enriched++;
      }
    } catch {
      errors++;
    }
    // ... existing progress logging ...
  }

  return { processed, enriched, errors, batchId };
}
```

## context_enrich Tool Enhancement

```typescript
server.tool(
  "context_enrich",
  "Enrich entities with extracted metadata, classifications, and relationships",
  {
    scope: z.enum(["entity", "batch"]),
    entityId: z.string().optional(),
    entityType: z.array(z.string()).optional(),
    since: z.string().optional(),
    limit: z.number().int().positive().max(500).optional(),
    stage: z.enum(["classify", "extract", "stitch", "resolve"]).optional(),  // NEW
  },
  async ({ scope, entityId, entityType, since, limit, stage }) => {
    if (scope === "entity") {
      if (!entityId) throw new Error("entityId required for scope=entity");
      const results = await store.enrichEntity(entityId, { stage });
      return { content: [{ type: "text", text: JSON.stringify({ enriched: results.length, stage }) }] };
    }

    const result = await store.enrichBatch({
      entityType: entityType as EntityType[],
      since,
      limit,
      unenrichedOnly: !stage,  // When stage is specified, don't filter by unenriched
      stage,
    });

    return { content: [{ type: "text", text: JSON.stringify({ ...result, stage }) }] };
  }
);
```

## memory_inspect Stage Display

```typescript
// In browse-tools.ts, memory_inspect handler
const stageKeys = {
  classify: "_classifiedAt",
  extract: "_extractedAt",
  stitch: "_stitchedAt",
  resolve: "_resolvedAt",
};

const stageStatus = Object.entries(stageKeys).map(([stage, key]) => {
  const val = entity.attributes?.[key] as string | undefined;
  return `| ${stage} | ${val ? `Done (${val})` : "Pending"} |`;
});

const enrichmentSection = [
  `## Enrichment Status`,
  `| Stage | Status |`,
  `|-------|--------|`,
  ...stageStatus,
  ``,
  `| Enriched At | ${entity.attributes?._enrichedAt ?? "never"} |`,
  `| Enriched By | ${(entity.attributes?._enrichedBy as string[] ?? []).join(", ") || "none"} |`,
].join("\n");
```
