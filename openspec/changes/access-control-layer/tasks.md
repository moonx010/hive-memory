# Tasks: access-control-layer

**Estimated effort:** 3 weeks
**Dependencies:** `multi-user-access` (already shipped in schema v4)

## Phase 1: Visibility + Owner + Query Enforcement (Weeks 1-2)

- [ ] **TASK-ACL-01**: Create `src/acl/types.ts`
  - Define `VisibilityLevel` type: `'private' | 'team' | 'org' | 'public'`
  - Define `ACLContext` interface: `userId`, `userRole`, `userLabels`
  - Define `ACLPolicy` interface: `canRead`, `canWrite`, `sqlWhereClause`
  - Export `NO_ACL` sentinel constant (null)
  - Pure type definitions — no runtime logic

- [ ] **TASK-ACL-02**: Create `src/acl/policy.ts` — `DefaultACLPolicy`
  - Implement `canRead(entity, ctx)`:
    - Admin bypass: return true if `ctx.userRole === 'admin'`
    - Public: always readable
    - Private: readable only if `entity.ownerId === ctx.userId`
    - Team/org: readable by all authenticated users
    - Label gate: AND-logic check (`every` required label in userLabels)
  - Implement `canWrite(entity, ctx)`: admin bypass OR owner match
  - Implement `sqlWhereClause(ctx)`: generate parameterized SQL with visibility check + `json_each` label check
  - Export singleton `defaultACLPolicy`

- [ ] **TASK-ACL-03**: Add unit tests for `DefaultACLPolicy`
  - Test: admin can read private entity owned by someone else
  - Test: member cannot read private entity owned by someone else
  - Test: member can read own private entity
  - Test: entity with `required_labels: ['hr']` denied to user without `hr` label
  - Test: entity with `required_labels: ['hr', 'legal']` denied to user with only `hr` label (AND logic)
  - Test: entity with `required_labels: []` readable by all members
  - Test: `sqlWhereClause` generates valid SQL (parse test, not execution)
  - Test: `canWrite` allows owner, denies non-owner member

- [ ] **TASK-ACL-04**: Schema v5 migration in `src/db/schema.ts`
  - Bump `SCHEMA_VERSION` to 5
  - Add `owner_id TEXT REFERENCES users(id)` column to entities (ALTER TABLE, try/catch)
  - Add `required_labels TEXT NOT NULL DEFAULT '[]'` column to entities (ALTER TABLE, try/catch)
  - Create `labels` table: `id TEXT PK`, `name TEXT UNIQUE`, `description TEXT`, `created_at TEXT`
  - Create `user_labels` table: `user_id TEXT`, `label_id TEXT`, `granted_by TEXT`, `granted_at TEXT`, `PRIMARY KEY(user_id, label_id)`
  - Create indexes: `idx_user_labels_user`, `idx_entities_owner`, `idx_entities_visibility`
  - Migration: `UPDATE entities SET visibility = 'private' WHERE visibility = 'personal'`

- [ ] **TASK-ACL-05**: Update `src/types.ts`
  - Expand `VisibilityType` to `'private' | 'team' | 'org' | 'public'`
  - Add `ownerId?: string` to `Entity` interface
  - Add `requiredLabels?: string[]` to `Entity` interface
  - Add `Label` interface: `id`, `name`, `description`, `createdAt`
  - Add `UserLabel` interface: `userId`, `labelId`, `grantedBy`, `grantedAt`

- [ ] **TASK-ACL-06**: Modify `src/db/database.ts` — ACL enforcement
  - Add `acl?: ACLContext` to `SearchEntitiesOptions` interface
  - Add `acl?: ACLContext` to `ListEntitiesOptions` interface
  - In `searchEntities`: if `acl` present, call `defaultACLPolicy.sqlWhereClause(acl)`, append clause and params
  - In `listEntities`: same ACL WHERE injection
  - In `getEntity`: if `acl` present, call `defaultACLPolicy.canRead()` post-query, return null if denied
  - In `countEntities`: same ACL WHERE injection
  - Add `rowToEntity` mapping for `owner_id` -> `ownerId` and `required_labels` -> `requiredLabels`
  - Add CRUD methods: `createLabel`, `deleteLabel`, `listLabels`, `assignUserLabel`, `revokeUserLabel`, `getUserLabels`
  - Read `CORTEX_ACL` env var — when `'off'`, skip all ACL injection

- [ ] **TASK-ACL-07**: Add integration tests for ACL-enforced queries
  - Setup: create 2 users, 3 entities (private/team/public), assign owners
  - Test: `searchEntities` with user1 ACL returns only accessible entities
  - Test: `searchEntities` with admin ACL returns all entities
  - Test: `getEntity` with private entity returns null for non-owner
  - Test: `listEntities` respects visibility filter
  - Test: `countEntities` with ACL returns correct count
  - Test: with `CORTEX_ACL=off`, all entities visible regardless of ACL context

- [ ] **TASK-ACL-08**: Modify `src/store.ts` — ACL context threading
  - Add `acl?: ACLContext` parameter to `CortexStore.recall()`, `CortexStore.search()`, list/count methods
  - Pass `acl` through to underlying `HiveDatabase` methods
  - Build `ACLContext` from `userId` + `db.getUserLabels(userId)` helper

- [ ] **TASK-ACL-09**: Modify tool handlers to pass ACL context
  - In `src/tools/index.ts` or tool registration: extract `userId` from request context (set by auth middleware)
  - Build `ACLContext` from `userId`, look up `userRole` from `users` table, look up labels from `user_labels`
  - Pass `acl` to all store methods in: `memory_recall`, `memory_ls`, `memory_grep`, `memory_inspect`, `memory_timeline`, `memory_tree`, `memory_trail`, `memory_who`, `memory_traverse`, `memory_connections`
  - `memory_store`: set `owner_id` to authenticated user's ID on entity creation

## Phase 2: Source Inheritance (Week 2)

- [ ] **TASK-ACL-10**: Create `src/acl/source-inherit.ts`
  - Define `SourceACLRule` interface: `connector: string`, `derive(metadata) => { visibility, ownerId?, requiredLabels? }`
  - Implement `SLACK_ACL_RULE`: `is_im`/`is_mpim` -> private, `is_private` -> private, else -> team
  - Implement `CALENDAR_ACL_RULE`: private events -> private, else -> team
  - Implement `GITHUB_ACL_RULE`: private repos -> private, else -> team
  - Export `SOURCE_ACL_RULES` map keyed by connector type
  - Export `deriveACL(connector, metadata)` convenience function

- [ ] **TASK-ACL-11**: Modify Slack connector for source inheritance
  - In `src/connectors/slack.ts`, in the entity draft builder:
    - Fetch channel info via `conversations.info` API (cache per-sync)
    - Call `SLACK_ACL_RULE.derive({ is_im, is_private, is_mpim })` to get visibility
    - Set `visibility` on EntityDraft
    - Set `owner_id` from Slack user -> hive-memory user mapping (via entity_aliases)
  - Add `getChannelInfo(channelId)` helper with in-memory cache

- [ ] **TASK-ACL-12**: Add tests for source inheritance
  - Test: Slack DM (`is_im: true`) -> visibility 'private'
  - Test: Slack private channel (`is_private: true`) -> visibility 'private'
  - Test: Slack public channel -> visibility 'team'
  - Test: Calendar private event -> visibility 'private'
  - Test: GitHub private repo -> visibility 'private'

## Phase 3: Labels (Week 3)

- [ ] **TASK-ACL-13**: Add label CLI subcommands to `src/cli.ts`
  - `hive-memory label create <name> [--description TEXT]`: call `db.createLabel()`
  - `hive-memory label list [--user USER_ID]`: call `db.listLabels()` or `db.getUserLabels(userId)`
  - `hive-memory label assign <user-id> <label-name>`: look up label by name, call `db.assignUserLabel()`
  - `hive-memory label revoke <user-id> <label-name>`: call `db.revokeUserLabel()`
  - Print formatted table output for `label list`
  - Validate that caller has admin role for assign/revoke/create operations

- [ ] **TASK-ACL-14**: Add label-gated entity tests (end-to-end)
  - Create label 'hr', assign to user1, not user2
  - Create entity with `required_labels: ['hr']`
  - `searchEntities` with user1 ACL -> entity found
  - `searchEntities` with user2 ACL -> entity not found
  - `getEntity` with user2 ACL -> returns null
  - Remove 'hr' label from user1 -> entity no longer accessible

- [ ] **TASK-ACL-15**: Documentation and feature flag validation
  - Add `CORTEX_ACL` to CLAUDE.md config section
  - Ensure `CORTEX_ACL=off` (default) passes all existing tests unchanged
  - Run full test suite with `CORTEX_ACL=on` and new ACL tests
  - Verify backward compat: existing entities without `owner_id` are treated as 'team' visibility (no owner restriction)
