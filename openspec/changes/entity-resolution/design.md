# Design: entity-resolution

## Overview

Entity resolution is split into two layers with distinct implementation homes:

- **Layer 1 (schema.ts + database.ts)** — source-level dedup via `UNIQUE` constraint on `(source_system, source_external_id)`. Already partially in place; this change hardens and documents it.
- **Layer 2 (entity-resolver.ts)** — `EntityResolver` class with candidate discovery, LLM fuzzy matching, and merge operation.

The `entity_resolve` MCP tool is the human-facing interface for confirming and executing merges.

## File Layout

```
src/db/
  schema.ts                     ← add entity_aliases table, bump SCHEMA_VERSION to 2 (modified)
  database.ts                   ← add upsertAlias(), getAliases(), mergeEntities() methods (modified)

src/enrichment/
  entity-resolver.ts            ← EntityResolver class (new file)

src/tools/
  context-tools.ts              ← add entity_resolve tool (modified)
  index.ts                      ← register entity_resolve (modified)

src/store.ts                    ← expose entityResolver instance (modified)
```

## Schema Changes (`src/db/schema.ts`)

```typescript
export const SCHEMA_VERSION = 2;  // bumped from 1

// Added to createSchema():
db.exec(`
  -- ── entity_aliases ────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS entity_aliases (
    id              TEXT PRIMARY KEY,
    canonical_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    alias_system    TEXT NOT NULL,
    alias_value     TEXT NOT NULL,
    alias_type      TEXT NOT NULL CHECK(alias_type IN ('external_id','email','name','handle')),
    confidence      TEXT NOT NULL DEFAULT 'inferred'
                    CHECK(confidence IN ('confirmed','inferred')),
    created_at      TEXT NOT NULL,
    UNIQUE(alias_system, alias_value)
  );

  CREATE INDEX IF NOT EXISTS idx_entity_aliases_canonical
    ON entity_aliases(canonical_id);
`);
```

## HiveDatabase Additions (`src/db/database.ts`)

New methods added to the existing `HiveDatabase` class:

```typescript
/** Upsert an alias. Returns false if alias already points to a different canonical. */
upsertAlias(alias: {
  canonicalId: string;
  aliasSystem: string;
  aliasValue: string;
  aliasType: "external_id" | "email" | "name" | "handle";
  confidence: "confirmed" | "inferred";
}): boolean;

/** Get all aliases for a canonical entity. */
getAliases(canonicalId: string): EntityAlias[];

/**
 * Merge superseded entity into primary entity.
 * Executes in a single transaction.
 * Returns counts of moved synapses and created aliases.
 */
mergeEntities(primaryId: string, supersededId: string): { synapsesMoved: number; aliasesCreated: number };

/**
 * Find person entities matching by email, name, or handle across source systems.
 * Excludes entities from the same source_system as the target.
 */
findPersonCandidates(entity: Entity): EntityCandidateRow[];
```

`mergeEntities` implementation:

```typescript
mergeEntities(primaryId: string, supersededId: string): { synapsesMoved: number; aliasesCreated: number } {
  return this.db.transaction(() => {
    // 1. Copy synapses from superseded as source
    const fromSynapses = this.db.prepare(
      `SELECT * FROM synapses WHERE source_id = ?`
    ).all(supersededId) as Synapse[];

    let synapsesMoved = 0;
    for (const syn of fromSynapses) {
      try {
        this.db.prepare(
          `INSERT OR IGNORE INTO synapses (id, source_id, target_id, axon_type, weight, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(randomUUID(), primaryId, syn.target_id, syn.axon_type, syn.weight, syn.metadata, syn.created_at);
        synapsesMoved++;
      } catch { /* duplicate */ }
    }

    // 2. Copy synapses to superseded as target
    const toSynapses = this.db.prepare(
      `SELECT * FROM synapses WHERE target_id = ?`
    ).all(supersededId) as Synapse[];
    for (const syn of toSynapses) {
      try {
        this.db.prepare(
          `INSERT OR IGNORE INTO synapses (id, source_id, target_id, axon_type, weight, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(randomUUID(), syn.source_id, primaryId, syn.axon_type, syn.weight, syn.metadata, syn.created_at);
        synapsesMoved++;
      } catch { /* duplicate */ }
    }

    // 3. Archive superseded entity
    this.db.prepare(
      `UPDATE entities SET status = 'archived', superseded_by = ?, updated_at = ? WHERE id = ?`
    ).run(primaryId, new Date().toISOString(), supersededId);

    // 4. Create aliases from superseded's identifiers
    const superseded = this.db.prepare(`SELECT * FROM entities WHERE id = ?`).get(supersededId) as Entity;
    let aliasesCreated = 0;
    const aliasesToCreate = [
      { system: superseded.source_system, value: superseded.source_external_id, type: "external_id" as const },
      superseded.attributes?.email ? { system: superseded.source_system, value: superseded.attributes.email as string, type: "email" as const } : null,
      superseded.attributes?.handle ? { system: superseded.source_system, value: superseded.attributes.handle as string, type: "handle" as const } : null,
    ].filter(Boolean);

    for (const a of aliasesToCreate) {
      const inserted = this.upsertAlias({
        canonicalId: primaryId,
        aliasSystem: a!.system,
        aliasValue: a!.value,
        aliasType: a!.type,
        confidence: "confirmed",
      });
      if (inserted) aliasesCreated++;
    }

    return { synapsesMoved, aliasesCreated };
  })();
}
```

## EntityResolver Class (`src/enrichment/entity-resolver.ts`)

```typescript
import { randomUUID } from "node:crypto";
import type { HiveDatabase } from "../db/database.js";
import type { LLMProvider } from "./types.js";

export interface ResolutionCandidate {
  entity: Entity;
  matchType: "exact_email" | "exact_name" | "handle" | "llm_fuzzy";
  confidence: "confirmed" | "inferred";
}

export class EntityResolver {
  constructor(private db: HiveDatabase) {}

  findCandidates(entity: Entity): ResolutionCandidate[] {
    if (entity.entityType !== "person") return [];

    const candidates: ResolutionCandidate[] = [];
    const seen = new Set<string>();

    // 1. Exact email match
    const email = entity.attributes?.email as string | undefined;
    if (email) {
      const matches = this.db.findPersonsByEmail(email, entity.sourceSystem);
      for (const m of matches) {
        if (!seen.has(m.id)) {
          candidates.push({ entity: m, matchType: "exact_email", confidence: "confirmed" });
          seen.add(m.id);
        }
      }
    }

    // 2. Exact name match (normalized)
    const normalizedTitle = entity.title?.toLowerCase().trim() ?? "";
    if (normalizedTitle.length >= 3) {
      const nameMatches = this.db.findPersonsByNormalizedName(normalizedTitle, entity.sourceSystem);
      for (const m of nameMatches) {
        if (!seen.has(m.id)) {
          candidates.push({ entity: m, matchType: "exact_name", confidence: "confirmed" });
          seen.add(m.id);
        }
      }
    }

    // 3. Handle match
    const handle = entity.attributes?.handle as string | undefined
      ?? entity.attributes?.username as string | undefined;
    if (handle) {
      const handleMatches = this.db.findPersonsByHandle(handle, entity.sourceSystem);
      for (const m of handleMatches) {
        if (!seen.has(m.id)) {
          candidates.push({ entity: m, matchType: "handle", confidence: "inferred" });
          seen.add(m.id);
        }
      }
    }

    return candidates.slice(0, 10);
  }

  async resolveWithLLM(a: Entity, b: Entity, llm: LLMProvider): Promise<boolean> {
    const distance = levenshtein(a.title ?? "", b.title ?? "");
    if (distance === 0 || distance > 3) return distance === 0;

    const prompt = `Are these two person profiles the same individual?

Person A:
- Name: ${a.title}
- Email: ${(a.attributes?.email as string) ?? "unknown"}
- Source: ${a.sourceSystem}
- Additional info: ${JSON.stringify(a.attributes ?? {})}

Person B:
- Name: ${b.title}
- Email: ${(b.attributes?.email as string) ?? "unknown"}
- Source: ${b.sourceSystem}
- Additional info: ${JSON.stringify(b.attributes ?? {})}

Answer with JSON: { "same_person": true/false, "reasoning": "one sentence" }`;

    const result = await llm.extract<{ same_person: boolean; reasoning: string }>(prompt, {
      type: "object",
      properties: {
        same_person: { type: "boolean" },
        reasoning: { type: "string" },
      },
      required: ["same_person"],
    });

    return result.same_person;
  }

  merge(primaryId: string, supersededId: string): MergeResult {
    const result = this.db.mergeEntities(primaryId, supersededId);
    console.error(
      `[entity-resolver] merged ${supersededId} → ${primaryId} ` +
      `(${result.synapsesMoved} synapses, ${result.aliasesCreated} aliases)`
    );
    return { primaryId, supersededId, ...result };
  }

  getAliases(entityId: string): EntityAlias[] {
    return this.db.getAliases(entityId);
  }
}

/** Compute Levenshtein distance between two strings (inline, no deps). */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}
```

## MCP Tool — `entity_resolve`

Added to `src/tools/context-tools.ts`:

```typescript
server.tool(
  "entity_resolve",
  "Discover cross-source identity matches and merge duplicate person entities",
  {
    action: z.enum(["list_candidates", "merge", "list_aliases"]),
    entityId: z.string(),
    mergeIntoId: z.string().optional(),
    confirmed: z.boolean().optional(),
  },
  async ({ action, entityId, mergeIntoId, confirmed }) => {
    const entity = store.db.getEntity(entityId);
    if (!entity) throw new Error(`Entity not found: ${entityId}`);

    if (action === "list_candidates") {
      const candidates = store.entityResolver.findCandidates(entity);
      return { content: [{ type: "text", text: JSON.stringify({ entityId, entityTitle: entity.title, candidates }) }] };
    }

    if (action === "merge") {
      if (!mergeIntoId) throw new Error("mergeIntoId required for action=merge");
      if (confirmed !== true) throw new Error("entity_resolve merge requires confirmed: true");
      const result = store.entityResolver.merge(mergeIntoId, entityId);
      return { content: [{ type: "text", text: JSON.stringify({ merged: true, ...result }) }] };
    }

    if (action === "list_aliases") {
      const aliases = store.entityResolver.getAliases(entityId);
      return { content: [{ type: "text", text: JSON.stringify({ entityId, aliases }) }] };
    }
  }
);
```

## Upsert Safety (Layer 1 Hardening)

`HiveDatabase.upsertEntity()` must NOT overwrite `status` or `superseded_by` when they are already set to `"archived"`:

```typescript
// In the INSERT OR REPLACE / ON CONFLICT UPDATE clause:
// Preserve status if already archived
UPDATE SET
  title = excluded.title,
  content = excluded.content,
  attributes = excluded.attributes,
  tags = excluded.tags,
  updated_at = excluded.updated_at,
  -- Do NOT update status or superseded_by if archived:
  status = CASE WHEN entities.status = 'archived' THEN entities.status ELSE excluded.status END,
  superseded_by = CASE WHEN entities.superseded_by IS NOT NULL THEN entities.superseded_by ELSE NULL END
WHERE source_external_id = excluded.source_external_id
  AND source_system = excluded.source_system
```
