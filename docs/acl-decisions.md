# ACL Architecture Decision Record

**Date:** 2026-03-27
**Status:** ACCEPTED
**Reviewers:** PM, Tech Lead, Security Lead
**Decider:** Chief Architect

---

## Decision 1: Admin Access Scope

**Decision:** Admins can read/write ALL entities EXCEPT those with `visibility = 'dm'`. DM entities are only accessible by participants listed in `acl_members`.

**Rationale:** PM recommended no admin access, Security recommended no DM access for admins, Tech Lead recommended admin-sees-all-except-DMs. The Tech Lead position is the correct balance. Admins need operational access for debugging, orphan cleanup, and audit -- blocking them entirely creates operational burden that leads to workarounds (shared accounts, direct DB access) which are worse for security. However, DMs carry a reasonable expectation of privacy that even admins should not violate without a defined escalation process. This follows the principle of least surprise: an admin managing a team knowledge base should see team knowledge, but not read private conversations.

**Implementation:**
- `sqlWhereClause` for admin role: `WHERE visibility != 'dm'` (instead of `1=1`)
- `canRead` for admin: return `entity.visibility !== 'dm'`
- Future: add `admin_dm_override` flag with audit trail for compliance-required access

---

## Decision 2: required_labels + acl_members Logic

**Decision:** OR logic. An entity is readable if the user satisfies ANY of: (a) has all `required_labels`, OR (b) is listed in `acl_members`. These are additive access paths on top of the base visibility check.

**Rationale:** All three reviewers recommended OR logic. AND logic (requiring both labels AND membership) creates a dead-end UX where adding access controls makes entities less accessible. OR logic models two natural access patterns: role-based ("all HR team members") via labels, and individual grants ("share this with Alice") via acl_members. Security's audit complexity concern is addressed by logging which path granted access (label match vs member match) in the audit trail.

**Implementation:**
```sql
-- Visibility gate (base check)
AND (
  -- Label path: user has all required labels
  (e.required_labels = '[]' OR NOT EXISTS (
    SELECT value FROM json_each(e.required_labels)
    WHERE value NOT IN (SELECT value FROM json_each(@_acl_labels))
  ))
  OR
  -- Member path: user is explicitly listed
  (e.acl_members != '[]' AND EXISTS (
    SELECT value FROM json_each(e.acl_members)
    WHERE value = @_acl_uid
  ))
)
```

---

## Decision 3: Group Admin Delegation

**Decision:** NO group admin delegation in v1. Only system admins can create labels, assign users to labels, and modify entity ACL.

**Rationale:** Unanimous across all reviewers. Group admin delegation adds significant complexity (delegation chains, permission escalation risks, revocation cascading) with limited benefit at the 5-50 user scale. Adding it later is a purely additive change. The v1 label management surface (create/assign/revoke) is small enough that a single admin can manage it. If demand arises, v2 can add a `label_admin` role scoped to specific labels.

---

## Decision 4: DM Privacy Mechanism

**Decision:** Introduce `visibility = 'dm'` as a distinct visibility level. DM entities use `acl_members` (JSON array of participant user IDs) as the sole access gate. Admins cannot read DMs. The `__dm__` prefix convention is NOT used; visibility level is the authoritative signal.

**Rationale:** The original design used `visibility = 'private'` with a single `owner_id`, which is a critical bug: in a DM between Alice and Bob, only the owner can see the message. A separate `dm` visibility level is cleaner than overloading `private` because: (1) the access logic is fundamentally different (multi-participant vs single-owner), (2) admin exclusion rules can target it precisely, (3) it is self-documenting. Using `acl_members` instead of a `__dm__` label prefix avoids polluting the label namespace and keeps the DM participant list explicit and queryable.

**Implementation:**
- `VisibilityLevel = 'private' | 'dm' | 'team' | 'org' | 'public'`
- DM entities: `visibility = 'dm'`, `acl_members = '["user1_id", "user2_id"]'`
- Private entities: `visibility = 'private'`, `owner_id` = creator (single-owner, admin CAN see)
- Slack connector: `is_im` or `is_mpim` -> `visibility = 'dm'`, `acl_members` = participant IDs

---

## Decision 5: Orphaned Data Policy

**Decision:** 90-day retention with admin reassignment. When a user is revoked, their owned entities enter a 90-day grace period. During this period, an admin can reassign ownership. After 90 days, orphaned private/dm entities are soft-deleted (status = 'archived'). Team/org/public entities remain accessible (ownership is cleared, not deleted).

**Rationale:** All reviewers agreed on 90-day retention. Immediate deletion risks data loss; indefinite retention creates ghost data. The 90-day window matches typical offboarding timelines. Soft-delete (archive) preserves data for compliance while removing it from search results. Team-visible entities should persist because they represent organizational knowledge, not personal data.

**Implementation:**
- On `revokeUser`: set `users.revoked_at` timestamp
- Nightly/weekly cleanup job: find entities where `owner_id` references a user with `revoked_at < now() - 90 days`
  - Private/DM entities: `UPDATE entities SET status = 'archived' WHERE ...`
  - Team/Org/Public entities: `UPDATE entities SET owner_id = NULL WHERE ...`
- Admin CLI: `hive-memory entity reassign --from <user-id> --to <user-id>`

---

## Decision 6: "Group" vs "Label" Terminology

**Decision:** Use "label" throughout. The term "group" is retired from the ACL design.

**Rationale:** "Group" implies a container with members, admin hierarchy, and lifecycle -- concepts we explicitly decided against for v1 (no group admin delegation). "Label" correctly communicates the semantics: a tag applied to users that gates access. Labels are flat, have no hierarchy, and no inherent admin. The use cases that referenced "groups" will be updated to use "label" terminology. This also avoids confusion with future features (Slack user groups, org teams) that may use "group" with different semantics.

---

## Decision 7: CRITICAL Security Fixes (Must Ship Before ACL)

**Decision:** Three CRITICAL fixes must be resolved BEFORE the ACL feature ships. These are P0 blockers.

1. **Shared mutable userContext race condition:** The current `UserContext` in `tools/index.ts` is a mutable object shared across requests. In HTTP mode with concurrent requests, user A's context can leak into user B's request. **Fix:** Make `UserContext` immutable and scoped per-request. Pass it as a parameter through the tool handler chain, not as a shared mutable reference. This is a pre-existing bug independent of ACL, but ACL makes it a security vulnerability (wrong user's labels applied to queries).

2. **Browse tools bypass ACL entirely:** `registerBrowseTools` receives only `db: HiveDatabase`, not `userContext` or `ACLContext`. All browse tool queries (memory_ls, memory_tree, memory_grep, memory_inspect, memory_timeline) execute without ACL filtering. **Fix:** Pass `ACLContext` to all tool registration functions. Every database query must go through the ACL-aware path.

3. **user_manage has no auth check:** The `user_manage` tool can create users, list users, and revoke users with no authorization check. Any authenticated user can create admin accounts. **Fix:** Add admin role check at the tool handler level. Only `userRole === 'admin'` or requests authenticated via `CORTEX_AUTH_TOKEN` can call user_manage.

---

## Decision 8: Browse Tools ACL Bypass Fix

**Decision:** All tool registration functions must receive `ACLContext` (or a factory to build it). The `registerBrowseTools`, `registerTrailTools`, and `registerAdvisorTools` signatures must be updated to accept either the full `CortexStore` (which can build ACLContext) or an explicit ACL resolver.

**Implementation:**
- Change `registerBrowseTools(safeTool, db)` to `registerBrowseTools(safeTool, db, aclResolver)`
- `aclResolver`: `(userContext: UserContext) => ACLContext | null` -- returns null when `CORTEX_ACL=off`
- Every query in browse tools calls `aclResolver(userContext)` and passes result to DB methods
- Same pattern for `registerTrailTools` and `registerAdvisorTools`
- The `registerTools` function builds the `aclResolver` closure from `userContext` + DB lookups

---

## Decision 9: Enrichment-Derived Entity ACL Inheritance

**Decision:** Derived entities inherit the MOST RESTRICTIVE ACL from their source entities. When an enrichment provider creates a new entity from one or more source entities, the derived entity inherits: (a) the most restrictive visibility level, (b) the union of all required_labels, (c) the intersection of acl_members.

**Rationale:** Enrichment can extract insights from private data (e.g., extracting a decision from a private Slack DM). If the derived entity gets a less restrictive ACL than its source, private data leaks. The most-restrictive merge is the safe default. Admins can manually relax ACL on derived entities if needed.

**Implementation:**
- Add `deriveACLFromSources(sourceEntities: Entity[]): { visibility, requiredLabels, aclMembers }` to `src/acl/source-inherit.ts`
- Visibility ordering: `dm > private > team > org > public` (most to least restrictive)
- `requiredLabels`: union of all source labels (AND logic -- user needs all)
- `acl_members`: intersection (only users who can see ALL sources)
- `EnrichmentEngine.enrichEntity` calls this when creating derived entities
- Synapses from derived -> source entity are created with axon type `derived_from`

---

## Decision 10: CORTEX_ACL Default

**Decision:** `CORTEX_ACL=off` by default. Auto-enable is NOT implemented. Admins must explicitly set `CORTEX_ACL=on` to enable access control.

**Rationale:** Auto-enable (triggering ACL when >1 user exists) is dangerous because it changes query behavior without the admin's knowledge. An admin might create a second user for testing and suddenly all queries start filtering. Explicit opt-in is the safer default. The onboarding flow (via `team_init` or documentation) will recommend enabling ACL, but the system never silently changes its enforcement posture.

**Implementation:**
- `CORTEX_ACL` env var: `'on'` enables enforcement, anything else (including unset) disables
- When off: all ACL parameters are ignored, no WHERE clause injection, all entities visible
- When on but no `ACLContext` provided (e.g., STDIO mode): deny all queries (fail closed, not open)
- Log a warning on startup when >1 user exists and `CORTEX_ACL` is off

---

## Consequences

### Positive
- DM privacy is cryptographically enforced at the query layer
- Label-based access provides flexible role-based filtering without complex group hierarchies
- OR logic for labels/members makes the system intuitive for admins
- Explicit opt-in prevents surprise behavior changes

### Negative
- Admin DM exclusion means admins cannot help debug DM-related issues without a future escalation mechanism
- OR logic requires audit logging to track which path granted access
- Enrichment inheritance (most-restrictive merge) may over-restrict derived entities, requiring manual adjustment

### Follow-ups (v2)
- Admin DM escalation with audit trail
- Label hierarchy (engineering -> engineering-frontend)
- Per-entity sharing UI
- Group admin delegation
- ACL dashboard / audit log viewer
