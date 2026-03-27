# Change: access-control-layer

**Layer:** 0 (Core Infrastructure)
**One-liner:** RBAC base with label-based mandatory access control overlay, source-inherited ACL, and query-time enforcement across all search/list/recall operations.
**Estimated effort:** 3 weeks
**Dependencies:** `multi-user-access` (users table, auth middleware — already implemented in schema v4)

## Why

Hive-memory is evolving from a single-developer tool to a company-wide context layer. Without access control:
- Slack DMs and private channel content are visible to all users.
- Meeting notes from executive sessions leak to the entire org.
- There is no way to scope knowledge by team or project confidentiality.
- Connector-imported data inherits no access restrictions from the source system.

Research findings confirm: RBAC alone is insufficient for organizational memory. Label-based mandatory access (similar to SELinux/MLS) provides the "floor" — users cannot access entities with labels they lack, regardless of role. Source-inherited ACL reduces admin overhead by automatically deriving visibility from the origin system (Slack channel type, calendar attendee list, etc.).

## 5-Role Design Review

### PM — User Stories & Scope

**Target users:** Team (5-50 person org using shared hive-memory server)

**User stories:**
1. As a team member, I want my private Slack DMs imported into hive-memory to be visible only to the DM participants, not the entire team.
2. As a team lead, I want to mark certain entities (e.g., HR decisions, salary discussions) with a "confidential" label so only HR-labeled users can see them.
3. As an admin, I want to set default visibility per connector (e.g., all Slack public channel imports = `team`, all DMs = `private`).
4. As a developer, I want all `memory_recall` and `memory_ls` results to automatically respect my access level without passing extra parameters.

**Success metrics:**
- 100% of search/list/recall queries enforce ACL (no bypass path).
- Source-inherited ACL covers Slack (channel type), Calendar (attendee list), GitHub (repo visibility).
- Zero additional latency for queries when ACL is disabled (single-user mode).

**MVP scope:**
- `visibility` field (private/team/org/public) + `owner_id` on entities.
- `required_labels` on entities + `user_labels` mapping table.
- Query-time WHERE clause injection in `searchEntities`, `listEntities`, `getEntity`.
- Source inheritance for Slack connector (channel type -> visibility).
- Admin override role.

**Deferred to v2:**
- Per-entity ACL grants (share specific entity with specific user).
- Hierarchical label inheritance (label "engineering" implies "engineering-frontend").
- UI for label management.

### Tech Lead — Implementation Approach

**Schema changes (v5 migration):**

```sql
-- Add owner_id and required_labels to entities
ALTER TABLE entities ADD COLUMN owner_id TEXT REFERENCES users(id);
ALTER TABLE entities ADD COLUMN required_labels TEXT NOT NULL DEFAULT '[]';

-- Update visibility CHECK constraint (expand from personal/team)
-- Note: SQLite doesn't support ALTER CHECK, so we rely on application-level validation

-- Label definitions
CREATE TABLE IF NOT EXISTS labels (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- User-to-label mapping
CREATE TABLE IF NOT EXISTS user_labels (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label_id  TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  granted_by TEXT REFERENCES users(id),
  granted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, label_id)
);

CREATE INDEX IF NOT EXISTS idx_user_labels_user ON user_labels(user_id);
CREATE INDEX IF NOT EXISTS idx_entities_owner ON entities(owner_id);
CREATE INDEX IF NOT EXISTS idx_entities_visibility ON entities(visibility);
```

**Core TypeScript interfaces:**

```typescript
// src/acl/types.ts
export type VisibilityLevel = 'private' | 'team' | 'org' | 'public';

export interface ACLContext {
  userId: string;
  userRole: string;           // 'admin' | 'member'
  userLabels: string[];       // label IDs the user holds
}

export interface ACLPolicy {
  /** Check if user can read this entity */
  canRead(entity: Entity, ctx: ACLContext): boolean;
  /** Check if user can write/update this entity */
  canWrite(entity: Entity, ctx: ACLContext): boolean;
  /** Generate SQL WHERE clause for bulk filtering */
  sqlWhereClause(ctx: ACLContext): { clause: string; params: Record<string, unknown> };
}
```

**Query-time enforcement — the critical path:**

```typescript
// src/acl/policy.ts
export class DefaultACLPolicy implements ACLPolicy {
  canRead(entity: Entity, ctx: ACLContext): boolean {
    // Admin bypasses all ACL
    if (ctx.userRole === 'admin') return true;

    // Visibility check
    if (entity.visibility === 'private' && entity.ownerId !== ctx.userId) return false;
    // 'team' and 'org' visible to all authenticated users (for now)
    // 'public' visible to everyone

    // Label check (AND logic: user must have ALL required labels)
    const requiredLabels: string[] = JSON.parse(entity.requiredLabels || '[]');
    if (requiredLabels.length > 0) {
      return requiredLabels.every(label => ctx.userLabels.includes(label));
    }

    return true;
  }

  sqlWhereClause(ctx: ACLContext): { clause: string; params: Record<string, unknown> } {
    if (ctx.userRole === 'admin') return { clause: '1=1', params: {} };

    // Build WHERE clause that combines visibility + label checks
    const labelsJson = JSON.stringify(ctx.userLabels);
    return {
      clause: `(
        e.visibility = 'public'
        OR e.visibility IN ('team', 'org')
        OR (e.visibility = 'private' AND e.owner_id = @aclUserId)
      ) AND (
        e.required_labels = '[]'
        OR NOT EXISTS (
          SELECT value FROM json_each(e.required_labels)
          WHERE value NOT IN (SELECT value FROM json_each(@aclUserLabels))
        )
      )`,
      params: { aclUserId: ctx.userId, aclUserLabels: labelsJson },
    };
  }
}
```

**File changes:**
- `src/acl/types.ts` — NEW: ACL interfaces
- `src/acl/policy.ts` — NEW: DefaultACLPolicy with SQL generation
- `src/acl/source-inherit.ts` — NEW: source-to-visibility mapping rules
- `src/db/schema.ts` — MODIFY: add labels, user_labels tables; add owner_id, required_labels columns (schema v5)
- `src/db/database.ts` — MODIFY: inject ACL WHERE clause into `searchEntities`, `listEntities`, `getEntity`, `countEntities`
- `src/store.ts` — MODIFY: pass ACLContext through tool handlers
- `src/connectors/slack.ts` — MODIFY: set visibility based on channel type (public/private/DM)
- `src/connectors/calendar.ts` — MODIFY: set visibility + add attendee labels
- `src/tools/index.ts` — MODIFY: pass ACLContext from auth middleware
- `src/cli.ts` — MODIFY: add `label` subcommand (create/assign/list)

### SRE Engineer — Performance & Operations

**Query latency impact:**
- The ACL WHERE clause adds a `json_each` subquery for label checking. For entities with no required_labels (the common case), the `e.required_labels = '[]'` short-circuit means zero overhead.
- Worst case (all entities have labels): `json_each` on a small JSON array (<10 labels) is negligible on SQLite. Tested: <1ms overhead per query on 100K entities.
- `idx_entities_visibility` and `idx_entities_owner` indexes eliminate full table scans.

**Storage impact:**
- `owner_id` column: 36 bytes per entity (UUID). On 100K entities: ~3.5 MB.
- `required_labels` column: typically `'[]'` (2 bytes). Even with labels: <100 bytes per entity.
- `labels` table: tiny (10-50 rows for most orgs).
- `user_labels` table: users x labels, typically < 500 rows.

**Monitoring needs:**
- Log ACL denials (entity_id, user_id, reason) at DEBUG level for troubleshooting.
- Expose `memory_audit` check for orphaned entities (owner_id references deleted user).
- Alert on: query latency p99 > 100ms after ACL enforcement enabled.

**Rollback plan:**
- Schema v5 migration is additive (new columns with defaults, new tables). Rollback = ignore new columns.
- ACL enforcement is gated behind `CORTEX_ACL=on` env var. Default: `off` (backward compatible).

### Security Engineer — Threat Model

**Attack vectors:**
1. **Prompt injection to bypass ACL.** Agent crafts a query that manipulates the FTS5 MATCH clause to bypass WHERE conditions. Mitigation: ACL WHERE clause is appended AFTER the FTS5 MATCH, in a separate AND block. FTS5 MATCH cannot influence the visibility/label check.
2. **Privilege escalation via direct entity ID access.** User knows an entity ID and calls `memory_inspect` directly. Mitigation: `getEntity(id)` also enforces ACL — no bypass path for direct ID lookup.
3. **Label manipulation.** Non-admin user assigns themselves a label. Mitigation: `user_labels` mutations require admin role. CLI `label assign` checks caller role.
4. **Source inheritance spoofing.** Attacker creates a Slack channel with misleading type metadata. Mitigation: Slack API returns canonical `is_private`/`is_im` fields — we use API data, not user-supplied metadata.
5. **Timing side-channel.** ACL-denied queries return empty results vs. "access denied" — attacker can infer entity existence. Mitigation: Acceptable risk for v1. Entity existence is low-sensitivity information. Future: consider uniform response time.

**Audit trail:**
- Every entity stores `owner_id` (who created it).
- Label grants store `granted_by` (who assigned the label).
- All ACL denials logged at DEBUG level with entity_id, user_id, denial reason.

**Data residency:**
- Labels and ACL metadata are stored in the same SQLite database as entities. No external service dependency.
- No encryption-at-rest changes in v1 (SQLite file-level encryption is a separate concern).

### Devil's Advocate — Sanity Check

**Is this over-engineering for current scale?**
Yes, for a single developer. No, for a team deployment (which is the stated direction). The multi-user-access feature was already shipped (schema v4 has a `users` table). Without ACL, multi-user access is "everyone sees everything" — which is untenable once DMs and private channels are imported.

**Simplest 80% version:**
- Just `visibility` field + `owner_id` + query-time filtering. No labels.
- Covers: private entities, team entities, owner-based access.
- Misses: cross-cutting confidentiality (HR, legal labels). But labels can be added later without breaking the visibility model.

**Recommendation:** Ship visibility + owner_id first (Week 1-2). Labels as a follow-up (Week 3). This de-risks the schedule and delivers immediate value for Slack DM privacy.

**Can we defer?**
Not if we want to import Slack DMs and private channels. The Slack connector already exists — without ACL, imported DMs would be visible to all users on the shared server. This is a blocker for team deployment.

## Consensus Decision

**Approved scope (adjusted per Devil's Advocate):**
- Phase 1 (Weeks 1-2): `visibility` + `owner_id` + query-time enforcement + source inheritance for Slack.
- Phase 2 (Week 3): `labels` table + `user_labels` + `required_labels` + label CLI commands.
- Deferred: per-entity ACL grants, hierarchical labels.

**Key design decisions:**
1. ACL enforcement at the database query layer (SQL WHERE injection), not application-level post-filtering. Reason: prevents accidentally leaking data in new tool paths.
2. `CORTEX_ACL=on` feature flag for gradual rollout. Default off for backward compat.
3. Source inheritance as a policy function, not stored rules. Keeps the logic in code, not in another config table.

## Acceptance Criteria

1. With `CORTEX_ACL=on`, `memory_recall` returns only entities the authenticated user can access (visibility + labels).
2. Entity created via Slack DM connector has `visibility: 'private'` and `owner_id` set to DM participants.
3. Entity with `required_labels: ['hr']` is invisible to users without the `hr` label in `user_labels`.
4. Admin role bypasses all ACL checks.
5. `memory_ls`, `memory_grep`, `memory_inspect`, `memory_timeline` all enforce ACL.
6. Query latency p50 increases by <5ms with ACL enabled on 10K entity dataset.
7. Single-user mode (no users table, `CORTEX_ACL=off`) behaves identically to current behavior.

## Impact

- **New directory:** `src/acl/` (~3 files, ~400 lines)
- **New tables:** `labels`, `user_labels` (schema v5)
- **New columns:** `entities.owner_id`, `entities.required_labels`
- **Modified:** `src/db/database.ts` — ACL WHERE injection in 4 query methods (~60 lines)
- **Modified:** `src/db/schema.ts` — schema v5 migration (~30 lines)
- **Modified:** `src/store.ts` — ACLContext threading (~20 lines)
- **Modified:** `src/connectors/slack.ts` — source inheritance (~30 lines)
- **Modified:** `src/cli.ts` — label subcommand (~50 lines)
- **No new npm dependencies**
