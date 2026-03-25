# Tasks: entity-resolution

**Phase:** B (parallel with decision-action-extraction, starts after enrichment-framework)
**Estimated effort:** 2 weeks
**Dependencies:** `enrichment-framework` (shares db access patterns; `EnrichmentContext.db` type)

## Week 1: Schema + Layer 1 Hardening + EntityResolver Core

- [x] **TASK-RES-01**: Add `entity_aliases` table to `src/db/schema.ts`
  - Bump `SCHEMA_VERSION` constant from `1` to `2`
  - Add `entity_aliases` table definition in `createSchema()` with:
    - Columns: `id`, `canonical_id`, `alias_system`, `alias_value`, `alias_type`, `confidence`, `created_at`
    - `UNIQUE(alias_system, alias_value)` constraint
    - `REFERENCES entities(id) ON DELETE CASCADE` foreign key on `canonical_id`
    - `CHECK` constraints on `alias_type` and `confidence`
  - Add index: `CREATE INDEX IF NOT EXISTS idx_entity_aliases_canonical ON entity_aliases(canonical_id)`
  - Verify `CREATE TABLE IF NOT EXISTS` (idempotent)

- [x] **TASK-RES-02**: Add tests for schema migration
  - Test: `createSchema()` on an empty database creates `entity_aliases` table
  - Test: `createSchema()` on existing v1 database (without `entity_aliases`) adds the table without error
  - Test: `SCHEMA_VERSION` equals `2`
  - Test: `UNIQUE(alias_system, alias_value)` constraint prevents duplicate insertion

- [x] **TASK-RES-03**: Add `upsertAlias()` and `getAliases()` to `HiveDatabase`
  - `upsertAlias(alias)`: INSERT OR IGNORE into `entity_aliases`; return `true` if inserted, `false` if already existed
  - `getAliases(canonicalId)`: SELECT all rows WHERE `canonical_id = ?`, return `EntityAlias[]`
  - Define `EntityAlias` interface in `src/db/database.ts`:
    ```typescript
    interface EntityAlias {
      id: string;
      canonicalId: string;
      aliasSystem: string;
      aliasValue: string;
      aliasType: "external_id" | "email" | "name" | "handle";
      confidence: "confirmed" | "inferred";
      createdAt: string;
    }
    ```
  - Add test: `upsertAlias` + `getAliases` round-trip

- [x] **TASK-RES-04**: Add `mergeEntities()` to `HiveDatabase`
  - Execute in a `db.transaction()`:
    1. SELECT synapses where `source_id = supersededId` → INSERT OR IGNORE with `source_id = primaryId`
    2. SELECT synapses where `target_id = supersededId` → INSERT OR IGNORE with `target_id = primaryId`
    3. UPDATE `entities SET status='archived', superseded_by=primaryId, updated_at=now WHERE id=supersededId`
    4. Call `upsertAlias()` for superseded's `source_external_id`, `attributes.email`, `attributes.handle`
  - Return `{ synapsesMoved: number; aliasesCreated: number }`
  - Be idempotent: merging already-merged entities is a no-op (superseded already archived)

- [x] **TASK-RES-05**: Add tests for `mergeEntities()`
  - Test: merge moves synapses from superseded to primary (both as source and target)
  - Test: superseded entity has `status: "archived"` and `superseded_by` set after merge
  - Test: aliases are created for superseded's identifiers
  - Test: duplicate synapses are not created (INSERT OR IGNORE handles conflicts)
  - Test: merging already-merged entities is a no-op

- [x] **TASK-RES-06**: Harden `upsertEntity()` to preserve archived status
  - Modify `HiveDatabase.upsertEntity()` ON CONFLICT UPDATE clause
  - Add CASE expression: preserve `status = 'archived'` and non-null `superseded_by` on update
  - Add test: upsert an entity with `status: "archived"` → status remains `"archived"` after upsert
  - Add test: re-syncing a connector after a merge does not restore the superseded entity

- [x] **TASK-RES-07**: Add finder methods to `HiveDatabase`
  - `findPersonsByEmail(email: string, excludeSystem?: string): Entity[]`
    - SELECT entities WHERE `attributes JSON_EXTRACT .email = ?` AND `source_system != ?` AND `entity_type = 'person'`
  - `findPersonsByNormalizedName(name: string, excludeSystem?: string): Entity[]`
    - SELECT entities WHERE `LOWER(TRIM(title)) = ?` AND `source_system != ?` AND `entity_type = 'person'`
  - `findPersonsByHandle(handle: string, excludeSystem?: string): Entity[]`
    - SELECT via JSON_EXTRACT on `attributes.handle` and `attributes.username`
  - Add tests for each finder with multi-source fixture data

## Week 2: EntityResolver + MCP Tool + Integration

- [x] **TASK-RES-08**: Create `src/enrichment/entity-resolver.ts`
  - Implement `EntityResolver` class with `constructor(db: HiveDatabase)`
  - Implement `findCandidates(entity)`: call DB finders, aggregate candidates, deduplicate by `seen` Set, cap at 10
  - Implement `resolveWithLLM(a, b, llm)`: compute Levenshtein, short-circuit on distance 0 (confirmed match) or > 3 (no match), call `llm.extract()` for borderline range
  - Implement `merge(primaryId, supersededId)`: delegate to `db.mergeEntities()`, log result
  - Implement `getAliases(entityId)`: delegate to `db.getAliases()`
  - Implement `levenshtein(a, b)` as private static helper (inline, no deps)
  - Export `ResolutionCandidate`, `MergeResult` interfaces

- [x] **TASK-RES-09**: Add tests for `EntityResolver`
  - Test: `findCandidates` on a non-person entity returns `[]`
  - Test: `findCandidates` finds candidate with `matchType: "exact_email"` when same email exists in another source
  - Test: `findCandidates` finds candidate with `matchType: "exact_name"` for matching normalized title
  - Test: `levenshtein("alice", "alice")` returns 0
  - Test: `levenshtein("alice", "alicee")` returns 1
  - Test: `levenshtein("alice", "bob")` returns 3 (exceeds threshold)
  - Test: `merge()` calls `db.mergeEntities()` and returns result

- [x] **TASK-RES-10**: Add `entity_resolve` tool to `src/tools/context-tools.ts`
  - Add to the existing `registerContextTools()` function
  - Implement `list_candidates` action: call `store.entityResolver.findCandidates(entity)`
  - Implement `merge` action: check `confirmed === true`, call `store.entityResolver.merge(mergeIntoId, entityId)`
  - Implement `list_aliases` action: call `store.entityResolver.getAliases(entityId)`
  - Use Zod validation for all input parameters
  - Return structured JSON responses

- [x] **TASK-RES-11**: Expose `EntityResolver` on `CortexStore`
  - Add `import { EntityResolver } from "./enrichment/entity-resolver.js"` to `src/store.ts`
  - Initialize `this.entityResolver = new EntityResolver(this.db)` in constructor (after `this.db` is ready)
  - Add `resolveEntities(entityId: string): ResolutionCandidate[]` convenience method

- [x] **TASK-RES-12**: Register `entity_resolve` in `src/tools/index.ts`
  - Verify `registerContextTools(server, store)` is already called (added by enrichment-framework)
  - Confirm new `entity_resolve` tool is included in registration
  - Add integration test: call `entity_resolve` via MCP tool handler, assert JSON response structure

- [x] **TASK-RES-13**: End-to-end integration test
  - Create two person entities with the same email from different source systems
  - Call `entity_resolve` with `action: "list_candidates"` → assert `matchType: "exact_email"` in results
  - Call `entity_resolve` with `action: "merge", confirmed: true` → assert merged
  - Assert superseded entity has `status: "archived"` in DB
  - Assert `memory_recall` for the person's name returns results attributed to primary entity
  - Assert connector re-sync does not restore archived superseded entity
