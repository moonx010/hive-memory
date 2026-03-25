# Requirements: entity-resolution

## Functional Requirements

### REQ-RES-01: Layer 1 — Source-Level Dedup (Mechanical)

- MUST enforce uniqueness of `(source_system, source_external_id)` pairs — no two entities with the same system + externalId.
- MUST implement this via `HiveDatabase.upsertEntity()` using `INSERT OR REPLACE` (or `ON CONFLICT UPDATE`) on the `source_external_id` + `source_system` composite key.
- MUST update existing entity fields (title, content, attributes, tags) on re-sync without creating a duplicate row.
- MUST NOT change entity `id` on upsert — existing synapses and aliases remain valid.
- Connector re-sync MUST be idempotent: running the same connector twice produces the same entity count.

### REQ-RES-02: Schema Addition — `entity_aliases` Table

- MUST add `entity_aliases` table to `src/db/schema.ts` as part of schema version 2:
  ```sql
  CREATE TABLE IF NOT EXISTS entity_aliases (
    id              TEXT PRIMARY KEY,
    canonical_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    alias_system    TEXT NOT NULL,
    alias_value     TEXT NOT NULL,
    alias_type      TEXT NOT NULL CHECK(alias_type IN ('external_id','email','name','handle')),
    confidence      TEXT NOT NULL DEFAULT 'inferred' CHECK(confidence IN ('confirmed','inferred')),
    created_at      TEXT NOT NULL,
    UNIQUE(alias_system, alias_value)
  );
  ```
- MUST bump `SCHEMA_VERSION` from 1 to 2 in `src/db/schema.ts`.
- Schema creation MUST be idempotent (`CREATE TABLE IF NOT EXISTS`).
- MUST add index: `CREATE INDEX IF NOT EXISTS idx_entity_aliases_canonical ON entity_aliases(canonical_id)`.

### REQ-RES-03: EntityResolver — Candidate Discovery

- MUST implement `EntityResolver` class in `src/enrichment/entity-resolver.ts`.
- `findCandidates(entity: Entity): ResolutionCandidate[]` MUST:
  - Only run on `entityType: "person"`.
  - Search by **exact email match**: find entities where `attributes.email = entity.attributes.email` (different `source_system`).
  - Search by **exact name match**: find entities where normalized `title` matches (lowercase, trimmed, same length ± 0).
  - Search by **handle match**: find entities where `attributes.handle` or `attributes.username` matches across sources.
  - Return candidates with `{ entity, matchType: "exact_email" | "exact_name" | "handle" | "llm_fuzzy", confidence: "confirmed" | "inferred" }`.
  - Exclude self (same entity ID) from results.
  - Return at most 10 candidates.
- `matchType: "exact_email"` and `matchType: "exact_name"` MUST have `confidence: "confirmed"`.
- `matchType: "handle"` MUST have `confidence: "inferred"`.

### REQ-RES-04: EntityResolver — LLM Fuzzy Matching

- `resolveWithLLM(a: Entity, b: Entity, llm: LLMProvider): Promise<boolean>` MUST:
  - Only call LLM when Levenshtein distance between `a.title` and `b.title` is <= 3 and not 0.
  - Send a prompt asking if two person descriptions refer to the same person.
  - Return `true` (same person) or `false`.
  - Be called only when `llm` is defined.
  - Results MUST have `confidence: "inferred"` — not auto-merged.
- MUST implement Levenshtein distance as an inline utility function (no npm dependency).

### REQ-RES-05: EntityResolver — Merge Operation

- `merge(primaryId: string, supersededId: string): MergeResult` MUST:
  - Execute in a single SQLite transaction.
  - Set `superseded.superseded_by = primaryId`.
  - Set `superseded.status = "archived"`.
  - Copy all synapses where `source_id = supersededId` to new rows with `source_id = primaryId` (skip if duplicate).
  - Copy all synapses where `target_id = supersededId` to new rows with `target_id = primaryId` (skip if duplicate).
  - Insert alias rows in `entity_aliases` for all of superseded's `source_external_id`, `attributes.email`, `attributes.handle`.
  - Return `{ primaryId, supersededId, synapsesMoved: number, aliasesCreated: number }`.
- MUST be non-destructive: original `superseded` entity row MUST remain in database.
- MUST NOT modify the `id` column of any entity.
- Merge MUST be idempotent: merging already-merged entities is a no-op.

### REQ-RES-06: MCP Tool — `entity_resolve`

- MUST register `entity_resolve` tool in `src/tools/context-tools.ts`.
- MUST support three actions:

  **`list_candidates`**:
  - Required: `entityId: string`
  - Run `EntityResolver.findCandidates(entity)` and optionally `resolveWithLLM()` for near-name matches.
  - Return: `{ entityId, entityTitle, candidates: [{ entityId, title, source, matchType, confidence }] }`

  **`merge`**:
  - Required: `entityId: string` (entity to supersede), `mergeIntoId: string` (primary), `confirmed: true` (explicit boolean safety gate).
  - MUST reject if `confirmed !== true` with error: `"entity_resolve merge requires confirmed: true"`.
  - Call `EntityResolver.merge(mergeIntoId, entityId)`.
  - Return: `{ merged: true, primaryId, supersededId, synapsesMoved, aliasesCreated }`.

  **`list_aliases`**:
  - Required: `entityId: string`
  - Query `entity_aliases WHERE canonical_id = entityId`.
  - Return: `{ entityId, aliases: [{ system, value, type, confidence }] }`

- MUST be registered in `src/tools/index.ts`.

### REQ-RES-07: Connector Sync Safety After Merge

- After a merge, connector re-sync MUST NOT un-archive superseded entities.
- `HiveDatabase.upsertEntity()` MUST preserve `status = "archived"` and `superseded_by` fields on update (do not overwrite with defaults).
- MUST add test: upsert an archived entity → `status` remains `"archived"`.

### REQ-RES-08: CortexStore Exposure

- MUST expose `EntityResolver` instance on `CortexStore` as `store.entityResolver`.
- MUST expose `store.resolveEntities(entityId)` as a convenience method returning `ResolutionCandidate[]`.

## Non-Functional Requirements

- MUST NOT add npm dependencies (Levenshtein computed inline, no external library).
- Merge transaction MUST complete in < 1 second for entities with up to 1,000 synapses.
- `findCandidates()` MUST return in < 100ms for typical databases (< 10,000 person entities).
- MUST preserve backward compatibility: existing databases without `entity_aliases` table are upgraded transparently by `createSchema()` (idempotent `CREATE TABLE IF NOT EXISTS`).
- All merge operations MUST be logged: `"[entity-resolver] merged {supersededId} → {primaryId} ({synapsesMoved} synapses, {aliasesCreated} aliases)"`.
