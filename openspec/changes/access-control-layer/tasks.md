# Tasks: access-control-layer

**Estimated effort:** 4 weeks (was 3 weeks; +1 week for P0 security fixes)
**Dependencies:** `multi-user-access` (already shipped in schema v4)
**ADR:** `docs/acl-decisions.md`

## Phase 0: P0 Security Fixes (MUST SHIP BEFORE ACL) — Week 1

- [ ] **TASK-SEC-01**: Fix shared mutable UserContext race condition
  - In `src/tools/index.ts`, the `UserContext` object is shared mutably across concurrent HTTP requests
  - Refactor: make `UserContext` immutable (`Object.freeze`) and scoped per-request
  - Each HTTP request creates its own frozen `UserContext` instance in the auth middleware
  - Tool handlers capture it via closure, not shared mutable reference
  - **Acceptance:** Write a concurrent request test (2 simultaneous requests with different users) that verifies each request sees its own userId throughout the handler chain
  - **Acceptance:** `UserContext` is `Readonly<UserContext>` in TypeScript

- [ ] **TASK-SEC-02**: Add admin auth check to user_manage tool
  - In `src/tools/user-tools.ts`, add authorization check at the top of the handler
  - Only allow `user_manage` calls from: (a) users with `role = 'admin'`, or (b) requests authenticated via `CORTEX_AUTH_TOKEN` (system token, no userId)
  - Members calling user_manage get: `Error: user_manage requires admin role`
  - **Acceptance:** Test: member user calling `user_manage add` returns error
  - **Acceptance:** Test: admin user calling `user_manage add` succeeds
  - **Acceptance:** Test: system token (no userId) calling `user_manage add` succeeds

- [ ] **TASK-SEC-03**: Parameterize FTS5 queries to prevent injection
  - Audit all FTS5 `MATCH` queries in `src/db/database.ts`
  - Ensure search query input is sanitized: strip FTS5 operators (`OR`, `AND`, `NOT`, `*`, `"`, `(`, `)`, `NEAR`)
  - Use parameterized binding for all user-supplied search terms
  - **Acceptance:** Test: search query containing `") OR 1=1 --` returns zero results, no SQL error
  - **Acceptance:** Test: normal search queries still work correctly after sanitization

## Phase 1: ACL Types + Policy + Schema (Week 2)

- [ ] **TASK-ACL-01**: Create `src/acl/types.ts`
  - Define `VisibilityLevel` type: `'private' | 'dm' | 'team' | 'org' | 'public'` (includes new `dm` level)
  - Define `ACLContext` interface: `userId`, `userRole`, `userLabels`
  - Define `ACLPolicy` interface: `canRead`, `canWrite`, `sqlWhereClause`
  - Define `ACLResolver` type: `(userContext) => ACLContext | null`
  - Export `NO_ACL` sentinel constant (null)

- [ ] **TASK-ACL-02**: Create `src/acl/policy.ts` -- `DefaultACLPolicy`
  - Implement `canRead(entity, ctx)`:
    - DM: return `aclMembers.includes(ctx.userId)` (admins excluded)
    - Admin: return true (for all non-DM)
    - Public: always readable
    - Private: readable only if `entity.ownerId === ctx.userId`
    - Team/org: readable by all authenticated users
    - Label + member gate: OR logic -- user has all required labels, OR is in acl_members
  - Implement `canWrite(entity, ctx)`: DM participants, admin (non-DM), or owner
  - Implement `sqlWhereClause(ctx)`:
    - Admin: `e.visibility != 'dm'`
    - Member: visibility check with DM participant subquery + OR logic for labels/members
  - **Acceptance:** All SQL uses parameterized `@_acl_uid` and `@_acl_labels`, no string interpolation

- [ ] **TASK-ACL-03**: Add unit tests for `DefaultACLPolicy`
  - Test: admin can read private entity owned by someone else
  - Test: admin CANNOT read DM entity (even if they own it -- DMs are participant-only)
  - Test: member cannot read private entity owned by someone else
  - Test: member can read own private entity
  - Test: DM entity readable only by users listed in aclMembers
  - Test: entity with `required_labels: ['hr']` denied to user without `hr` label
  - Test: entity with `required_labels: ['hr']` AND `acl_members: ['user2']` -- user2 can read (OR logic)
  - Test: entity with `required_labels: ['hr', 'legal']` denied to user with only `hr` label
  - Test: entity with `required_labels: []` and `acl_members: []` readable by all members
  - Test: `sqlWhereClause` generates valid SQL (parse test, not execution)
  - Test: `canWrite` allows owner, denies non-owner member
  - Test: `canWrite` allows DM participant, denies non-participant

- [ ] **TASK-ACL-04**: Schema v5 migration in `src/db/schema.ts`
  - Bump `SCHEMA_VERSION` to 5
  - Add `owner_id TEXT REFERENCES users(id)` column to entities
  - Add `required_labels TEXT NOT NULL DEFAULT '[]'` column to entities
  - Add `acl_members TEXT NOT NULL DEFAULT '[]'` column to entities (NEW)
  - Create `labels` table: `id TEXT PK`, `name TEXT UNIQUE`, `description TEXT`, `created_at TEXT`
  - Create `user_labels` table: `user_id TEXT`, `label_id TEXT`, `role TEXT DEFAULT 'member'`, `granted_by TEXT`, `granted_at TEXT`, `PRIMARY KEY(user_id, label_id)`
  - Create indexes: `idx_user_labels_user`, `idx_entities_owner`, `idx_entities_visibility`
  - Create partial index: `idx_entities_no_labels ON entities(id) WHERE required_labels = '[]'`
  - Migration: `UPDATE entities SET visibility = 'private' WHERE visibility = 'personal'`
  - Add `revoked_at TEXT` column to `users` table for orphan tracking

- [ ] **TASK-ACL-05**: Update `src/types.ts`
  - Expand `VisibilityType` to `'private' | 'dm' | 'team' | 'org' | 'public'`
  - Add `ownerId?: string` to `Entity` interface
  - Add `requiredLabels?: string[]` to `Entity` interface
  - Add `aclMembers?: string[]` to `Entity` interface (NEW)
  - Add `Label` interface: `id`, `name`, `description`, `createdAt`
  - Add `UserLabel` interface: `userId`, `labelId`, `role`, `grantedBy`, `grantedAt`

## Phase 2: Database + Tool Integration (Week 3)

- [ ] **TASK-ACL-06**: Modify `src/db/database.ts` -- ACL enforcement
  - Add `acl?: ACLContext` to `SearchEntitiesOptions` interface
  - Add `acl?: ACLContext` to `ListEntitiesOptions` interface
  - In `searchEntities`: if `acl` present, call `defaultACLPolicy.sqlWhereClause(acl)`, append clause and params
  - In `listEntities`: same ACL WHERE injection
  - In `getEntity`: if `acl` present, call `defaultACLPolicy.canRead()` post-query, return null if denied
  - In `countEntities`: same ACL WHERE injection
  - Add `rowToEntity` mapping for `owner_id` -> `ownerId`, `required_labels` -> `requiredLabels`, `acl_members` -> `aclMembers`
  - Add CRUD methods: `createLabel`, `deleteLabel`, `listLabels`, `assignUserLabel`, `revokeUserLabel`, `getUserLabels`
  - Read `CORTEX_ACL` env var -- when not `'on'`, skip all ACL injection
  - When `CORTEX_ACL=on` and no ACL context provided: fail closed (return empty results, not unfiltered)
  - **Acceptance:** Log warning on startup when >1 user exists and `CORTEX_ACL` is not `'on'`

- [ ] **TASK-ACL-07**: Add integration tests for ACL-enforced queries
  - Setup: create 2 users + 1 admin, entities across all visibility levels (private, dm, team, public)
  - Test: `searchEntities` with user1 ACL returns only accessible entities
  - Test: `searchEntities` with admin ACL returns all except DM entities
  - Test: `searchEntities` with DM participant returns DM entities
  - Test: `getEntity` with private entity returns null for non-owner
  - Test: `getEntity` with DM entity returns null for non-participant (including admin)
  - Test: `listEntities` respects visibility filter
  - Test: `countEntities` with ACL returns correct count
  - Test: with `CORTEX_ACL=off`, all entities visible regardless of ACL context
  - Test: OR logic -- user with matching label but not in acl_members CAN read
  - Test: OR logic -- user in acl_members but without matching labels CAN read
  - **Acceptance:** FTS5 + ACL combined query returns correct results in <10ms for 1000 entities

- [ ] **TASK-ACL-08**: Modify `src/store.ts` -- ACL context threading
  - Add `acl?: ACLContext` parameter to `CortexStore.recall()`, `CortexStore.search()`, list/count methods
  - Pass `acl` through to underlying `HiveDatabase` methods
  - Build `ACLContext` from `userId` + `db.getUserLabels(userId)` helper

- [ ] **TASK-ACL-09**: Modify ALL tool handlers to pass ACL context
  - Refactor `registerTools` in `src/tools/index.ts`:
    - Build `ACLResolver` closure from `CORTEX_ACL` env var + DB lookups
    - Pass `aclResolver` to ALL tool registration functions (not just memory tools)
  - Update `registerBrowseTools(safeTool, db)` -> `registerBrowseTools(safeTool, db, aclResolver, userContext)`
  - Update `registerTrailTools(safeTool, db)` -> `registerTrailTools(safeTool, db, aclResolver, userContext)`
  - Update `registerAdvisorTools(safeTool, db)` -> `registerAdvisorTools(safeTool, db, aclResolver, userContext)`
  - Every DB query in every tool calls `aclResolver(userContext)` and passes result
  - `memory_store`: set `owner_id` to authenticated user's ID on entity creation
  - **Acceptance:** No tool registration function accepts only `db` without `aclResolver` (grep check)
  - **Acceptance:** Test: browse tool queries return filtered results matching ACL

## Phase 3: Source Inheritance + Enrichment (Week 3-4)

- [ ] **TASK-ACL-10**: Create `src/acl/source-inherit.ts`
  - Define `SourceACLRule` interface: `connector`, `derive(metadata) => { visibility, ownerId?, aclMembers?, requiredLabels? }`
  - Implement `SLACK_ACL_RULE`: `is_im`/`is_mpim` -> `dm` visibility + `aclMembers` from participants, `is_private` -> `private`, else -> `team`
  - Implement `CALENDAR_ACL_RULE`: private events -> `private`, else -> `team`
  - Implement `GITHUB_ACL_RULE`: private repos -> `private`, else -> `team`
  - Implement `deriveACLFromSources(sources: Entity[])`: most-restrictive merge for enrichment
    - Visibility: highest restrictiveness wins (`dm > private > team > org > public`)
    - Required labels: union of all source labels
    - ACL members: intersection of all source member lists
  - **Acceptance:** Test: `deriveACLFromSources([dmEntity, teamEntity])` returns `dm` visibility

- [ ] **TASK-ACL-11**: Modify Slack connector for source inheritance
  - In `src/connectors/slack.ts`, in the entity draft builder:
    - Fetch channel info via `conversations.info` API (cache per-sync)
    - Call `SLACK_ACL_RULE.derive(...)` to get visibility and aclMembers
    - Set `visibility`, `acl_members` on EntityDraft
    - For DMs/group DMs: resolve Slack user IDs to hive-memory user IDs for `acl_members`
    - Set `owner_id` from message author
  - Add `getChannelInfo(channelId)` helper with in-memory cache
  - Add `resolveParticipantIds(slackUserIds)` helper using entity_aliases

- [ ] **TASK-ACL-12**: Integrate enrichment ACL inheritance
  - In `EnrichmentEngine.enrichEntity`, when a provider creates a derived entity:
    - Collect source entities (via synapse `derived_from` links or provider context)
    - Call `deriveACLFromSources(sourceEntities)` to compute ACL
    - Apply computed visibility, requiredLabels, aclMembers to the derived entity
  - In `EnrichmentContext`, add `sourceEntities?: Entity[]` for providers to reference
  - **Acceptance:** Test: decision extracted from private Slack DM inherits `dm` visibility and participant list
  - **Acceptance:** Test: topic stitched from team + private entities inherits `private` visibility

- [ ] **TASK-ACL-13**: Add tests for source inheritance
  - Test: Slack DM (`is_im: true`) -> visibility `dm`, aclMembers populated
  - Test: Slack group DM (`is_mpim: true`) -> visibility `dm`, aclMembers populated
  - Test: Slack private channel (`is_private: true`) -> visibility `private`
  - Test: Slack public channel -> visibility `team`
  - Test: Calendar private event -> visibility `private`
  - Test: GitHub private repo -> visibility `private`
  - Test: `deriveACLFromSources` with mixed visibilities returns most restrictive
  - Test: `deriveACLFromSources` with overlapping members returns intersection

## Phase 4: Labels + CLI + Orphan Cleanup (Week 4)

- [ ] **TASK-ACL-14**: Add label CLI subcommands to `src/cli.ts`
  - `hive-memory label create <name> [--description TEXT]`: call `db.createLabel()` (admin only)
  - `hive-memory label list [--user USER_ID]`: call `db.listLabels()` or `db.getUserLabels(userId)`
  - `hive-memory label assign <user-id> <label-name>`: look up label by name, call `db.assignUserLabel()` (admin only)
  - `hive-memory label revoke <user-id> <label-name>`: call `db.revokeUserLabel()` (admin only)
  - Print formatted table output for `label list`
  - Validate caller has admin role for assign/revoke/create operations

- [ ] **TASK-ACL-15**: Add `entity reassign` CLI command
  - `hive-memory entity reassign --from <user-id> --to <user-id>`: reassign entity ownership (admin only)
  - Updates `owner_id` on all entities owned by source user
  - For DM entities: adds new user to `acl_members` (does not remove original)
  - **Acceptance:** Test: after reassign, new owner can read previously-private entities

- [ ] **TASK-ACL-16**: Implement orphaned data cleanup
  - Add `revoked_at` column tracking to `revokeUser()` in `src/auth.ts`
  - Add `cleanupOrphanedEntities()` to `HiveDatabase` or `MemorySteward`
  - Private/DM entities owned by users revoked >90 days: `status = 'archived'`
  - Team/Org/Public entities owned by revoked users: `owner_id = NULL` (keep accessible)
  - Integrate with existing cleanup job or steward audit
  - **Acceptance:** Test: entity owned by user revoked 91 days ago is archived
  - **Acceptance:** Test: entity owned by user revoked 89 days ago is NOT archived
  - **Acceptance:** Test: team entity owned by revoked user has owner_id cleared, remains searchable

- [ ] **TASK-ACL-17**: Add label-gated entity tests (end-to-end)
  - Create label `hr`, assign to user1, not user2
  - Create entity with `required_labels: ['hr']`
  - `searchEntities` with user1 ACL -> entity found
  - `searchEntities` with user2 ACL -> entity not found
  - `getEntity` with user2 ACL -> returns null
  - Add user2 to entity's `acl_members` -> user2 can now read (OR logic)
  - Remove `hr` label from user1 -> user1 can no longer read (unless in acl_members)

- [ ] **TASK-ACL-18**: Documentation and feature flag validation
  - Add `CORTEX_ACL` to CLAUDE.md config section
  - Ensure `CORTEX_ACL=off` (default) passes all existing tests unchanged
  - Run full test suite with `CORTEX_ACL=on` and new ACL tests
  - Verify backward compat: existing entities without `owner_id` are treated as `team` visibility
  - Document label management workflow in setup docs
  - Add startup warning when >1 user and CORTEX_ACL is off
  - **Acceptance:** All 125+ existing tests pass with no modifications when `CORTEX_ACL=off`
