import type { HiveDatabase } from "../db/database.js";
import type { Entity, EntityType } from "../types.js";

// Re-export for convenience
export type { Entity, EntityType } from "../types.js";

export interface SynapseDraft {
  targetId: string;
  axon: string;
  weight: number;
  metadata?: Record<string, string>;
}

export interface AliasDraft {
  canonicalId: string;
  aliasType: string;
  aliasValue: string;
  confidence: "confirmed" | "inferred";
}

export interface EntityDraft {
  entityType: EntityType;
  project?: string;
  title?: string;
  content: string;
  tags: string[];
  attributes: Record<string, unknown>;
  source: { system: string; externalId?: string; connector?: string };
  domain: string;
  confidence: "confirmed" | "inferred";
}

export interface EnrichmentResult {
  attributes?: Record<string, unknown>;
  tags?: string[];
  keywords?: string[];
  synapses?: SynapseDraft[];
  aliases?: AliasDraft[];
  derivedEntities?: EntityDraft[];
}

export interface EnrichmentContext {
  /** Direct in-process HiveDatabase reference. NOT MCP-over-MCP. */
  db: HiveDatabase;
  /** Convenience FTS5 search over entities. */
  findRelated(query: string, opts?: { entityType?: EntityType; limit?: number }): Entity[];
  /** Only defined when CORTEX_LLM_PROVIDER is set and CORTEX_ENRICHMENT=llm */
  llm?: LLMProvider;
}

export interface LLMProvider {
  readonly model: string;
  /** Text completion — returns raw string */
  complete(prompt: string, opts?: { maxTokens?: number; temperature?: number }): Promise<string>;
  /** Structured extraction — appends JSON schema to prompt, parses response */
  extract<T>(prompt: string, schema: Record<string, unknown>): Promise<T>;
}

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

export interface EnrichmentProvider {
  readonly id: string;
  readonly name: string;
  readonly applicableTo: EntityType[] | ["*"];
  /** Lower number runs first. ClassifyProvider=100, LLMEnrichProvider=200, TopicStitch=300 */
  readonly priority: number;
  /** Which pipeline stage this provider belongs to. */
  readonly stage: EnrichmentStage;
  shouldEnrich(entity: Entity): boolean;
  enrich(entity: Entity, ctx: EnrichmentContext): Promise<EnrichmentResult>;
}

export interface BatchFilter {
  entityType?: EntityType[];
  since?: string;
  unenrichedOnly?: boolean;
  limit?: number;
  /** Run only providers in this stage. */
  stage?: EnrichmentStage;
  /** Resume from this stage, skipping providers in earlier stages. */
  resumeFrom?: EnrichmentStage;
}

export interface BatchResult {
  processed: number;
  enriched: number;
  errors: number;
  batchId: string;
}
