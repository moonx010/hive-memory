# Tasks: Graph Connectivity + Schema Extensibility

## Task 1: Cross-tenant synapse isolation (SECURITY)

**Files**: `src/db/schema.ts`, `src/db/synapse-ops.ts`

**What to build**:
1. Add trigger preventing synapses between entities with different org_id
2. Migration script to audit existing synapses for violations

**Acceptance criteria**:
- [ ] INSERT synapse across orgs → ABORT
- [ ] Existing cross-org synapses logged and quarantined
- [ ] npm test passes

---

## Task 2: Slack connector postSync — link decisions/people

**File**: `src/connectors/slack.ts`

**What to build**:
Add `postSync()` method following Calendar connector pattern:
1. For each `conversation` entity: create `participated` synapse to author `person` entity
2. For each `decision` entity: create `authored` synapse to the person who made it
3. Match by `source_external_id` pattern: `slack:person:{userId}`

**Acceptance criteria**:
- [ ] Slack decisions linked to their authors via synapse
- [ ] Slack conversations linked to participants
- [ ] npm test passes

---

## Task 3: GitHub connector postSync — link PRs/issues to people

**File**: `src/connectors/github.ts`

**What to build**:
1. For each PR/issue `document` entity: create `authored` synapse to PR author `person` entity
2. For review comments: create `reviewed` synapse from reviewer to PR
3. Match by `source_external_id` pattern: `github:person:{login}`

**Acceptance criteria**:
- [ ] GitHub PRs linked to authors
- [ ] Review relationships captured
- [ ] npm test passes

---

## Task 4: Notion connector postSync — link pages to projects

**File**: `src/connectors/notion.ts`

**What to build**:
1. For each `document` entity from Notion: create `belongs_to` synapse to project entity (if identifiable from Notion database/workspace)
2. For pages with `people` properties: create `authored` synapse

**Acceptance criteria**:
- [ ] Notion pages linked to projects when possible
- [ ] npm test passes

---

## Task 5: Wire TopicStitcher into EnrichmentEngine

**Files**: `src/store.ts`, `src/enrichment/providers/topic-stitch.ts`

**What to build**:
1. Refactor TopicStitcher to implement EnrichmentProvider interface (stage: "stitch")
2. Register in EnrichmentEngine alongside other providers
3. Batch by time window (last 24h) to avoid O(n²) on full corpus

**Acceptance criteria**:
- [ ] TopicStitcher runs automatically on new entities via CDC
- [ ] Cross-source `related` synapses created based on keyword Jaccard similarity
- [ ] Batched by time window, not full corpus scan
- [ ] npm test passes

---

## Task 6: Wire EntityResolver into EnrichmentEngine

**File**: `src/store.ts`

**What to build**:
1. Register EntityResolver as EnrichmentProvider with stage: "resolve"
2. Auto-merge person entities across sources (Slack userId, Calendar email, GitHub login)

**Acceptance criteria**:
- [ ] Same person from Slack + Calendar auto-merged
- [ ] Merge preserves all source references
- [ ] npm test passes

---

## Task 7: Open EntityType and AxonType

**File**: `src/types.ts`

**What to build**:
1. Change `EntityType` from closed union to open: `"memory" | "decision" | ... | (string & {})`
2. Same for axon types if they're a closed union
3. Preserve auto-complete for existing types

**Acceptance criteria**:
- [ ] Existing code compiles unchanged
- [ ] New entity types (e.g., "policy", "claim") can be used without code changes
- [ ] npm run build passes

---

## Task 8: Domain schema registry table

**Files**: `src/db/schema.ts`, `src/db/database.ts`

**What to build**:
```sql
CREATE TABLE IF NOT EXISTS domain_schemas (
  domain TEXT NOT NULL,
  kind TEXT NOT NULL,       -- "entity_type" or "axon_type"
  value TEXT NOT NULL,
  description TEXT,
  constraints TEXT DEFAULT '{}',
  PRIMARY KEY (domain, kind, value)
);
```

Add `registerDomainSchema()` and `getDomainSchemas()` to database.

**Acceptance criteria**:
- [ ] Table created on migration
- [ ] CRUD operations work
- [ ] npm test passes

---

## Task 9: Retrieval eval benchmark

**File**: `src/enrichment/eval/retrieval-eval.ts` (new)

**What to build**:
Compare 4 retrieval strategies on the same queries:
1. BM25 only (FTS5)
2. Vector only (sqlite-vec)
3. Graph traversal only (seed entity → follow synapses → collect neighbors)
4. Hybrid (current RRF fusion)

Output: accuracy, recall, latency per strategy.

**Acceptance criteria**:
- [ ] At least 20 test queries with ground-truth answers
- [ ] Results saved as JSON report
- [ ] Runnable via `npm run eval:retrieval`

---

## Summary

| Task | File(s) | Priority | Complexity |
|------|---------|----------|------------|
| 1 | schema.ts, synapse-ops.ts | P1 (Security) | Low |
| 2 | connectors/slack.ts | P1 | Medium |
| 3 | connectors/github.ts | P1 | Medium |
| 4 | connectors/notion.ts | P1 | Medium |
| 5 | store.ts, topic-stitch.ts | P1 | Medium |
| 6 | store.ts | P1 | Low |
| 7 | types.ts | P3 | Low |
| 8 | schema.ts, database.ts | P3 | Low |
| 9 | eval/retrieval-eval.ts | P2 | Medium |

**Parallel execution**:
- Tasks 1-6: all independent, can run in parallel
- Task 7-8: independent of each other
- Task 9: depends on tasks 2-6 (needs connected graph for meaningful eval)
