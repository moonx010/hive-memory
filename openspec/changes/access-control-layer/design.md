# Design: access-control-layer

## Overview

Adds entity-level access control to hive-memory with four enforcement mechanisms: visibility-based access (private/dm/team/org/public), owner-based access (only creator can see private entities), label-based mandatory access (OR-logic with acl_members), and DM-specific multi-participant access. Enforcement happens at the SQL query layer via WHERE clause injection, ensuring no tool can accidentally bypass ACL. Admins can see all entities except DMs.

**ADR:** See `docs/acl-decisions.md` for full decision record with rationale.

## Directory / File Layout

```
src/
  acl/
    types.ts              <- NEW: ACLContext, ACLPolicy, VisibilityLevel interfaces
    policy.ts             <- NEW: DefaultACLPolicy with canRead, canWrite, sqlWhereClause
    source-inherit.ts     <- NEW: derive visibility from connector source metadata + enrichment inheritance
  db/
    schema.ts             <- MODIFY: schema v5 (labels, user_labels tables; owner_id, required_labels, acl_members columns)
    database.ts           <- MODIFY: inject ACL WHERE clause into search/list/get/count methods
  store.ts                <- MODIFY: accept ACLContext, pass through to database methods
  connectors/
    slack.ts              <- MODIFY: set visibility based on channel is_private/is_im, set acl_members for DMs
    calendar.ts           <- MODIFY: set visibility + owner from attendee list
  tools/
    index.ts              <- MODIFY: extract ACLContext from auth middleware, pass to ALL tool registrations
    browse-tools.ts       <- MODIFY: accept aclResolver, apply to all queries
    trail-tools.ts        <- MODIFY: accept aclResolver, apply to all queries
    advisor-tools.ts      <- MODIFY: accept aclResolver, apply to all queries
    user-tools.ts         <- MODIFY: add admin role check
  cli.ts                  <- MODIFY: add "label" subcommand (create, assign, list, revoke)
  types.ts                <- MODIFY: add VisibilityLevel expansion (dm), ownerId, acl_members to Entity
  auth.ts                 <- MODIFY: add revoked_at timestamp tracking
```

## Schema Design (v5)

```sql
-- New columns on entities (additive migration via ALTER TABLE)
ALTER TABLE entities ADD COLUMN owner_id TEXT REFERENCES users(id);
ALTER TABLE entities ADD COLUMN required_labels TEXT NOT NULL DEFAULT '[]';
ALTER TABLE entities ADD COLUMN acl_members TEXT NOT NULL DEFAULT '[]';

-- Label definitions
CREATE TABLE IF NOT EXISTS labels (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

-- User-to-label assignments (with role for future extensibility)
CREATE TABLE IF NOT EXISTS user_labels (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label_id   TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member',
  granted_by TEXT REFERENCES users(id),
  granted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, label_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_user_labels_user ON user_labels(user_id);
CREATE INDEX IF NOT EXISTS idx_entities_owner ON entities(owner_id);
CREATE INDEX IF NOT EXISTS idx_entities_visibility ON entities(visibility);
-- Partial index for entities without labels (fast path for common case)
CREATE INDEX IF NOT EXISTS idx_entities_no_labels ON entities(id) WHERE required_labels = '[]';
```

## ACL Types

```typescript
// src/acl/types.ts

export type VisibilityLevel = 'private' | 'dm' | 'team' | 'org' | 'public';

export interface ACLContext {
  userId: string;
  userRole: string;        // 'admin' | 'member'
  userLabels: string[];    // label IDs held by this user
}

/** Sentinel for single-user / no-auth mode */
export const NO_ACL: ACLContext | null = null;

export interface ACLPolicy {
  canRead(entity: Entity, ctx: ACLContext): boolean;
  canWrite(entity: Entity, ctx: ACLContext): boolean;
  sqlWhereClause(ctx: ACLContext): { clause: string; params: Record<string, unknown> };
}

/** ACL resolver factory — returns null when CORTEX_ACL=off */
export type ACLResolver = (userContext: { userId?: string; userName?: string }) => ACLContext | null;
```

## ACL Policy Implementation

```typescript
// src/acl/policy.ts

// Visibility restrictiveness ordering (higher = more restrictive)
const VISIBILITY_ORDER: Record<VisibilityLevel, number> = {
  public: 0, org: 1, team: 2, private: 3, dm: 4,
};

export class DefaultACLPolicy implements ACLPolicy {
  canRead(entity: Entity, ctx: ACLContext): boolean {
    // DM: only participants can read, even admins cannot
    if (entity.visibility === 'dm') {
      const members = entity.aclMembers ?? [];
      return members.includes(ctx.userId);
    }

    // Admin can read everything except DMs (handled above)
    if (ctx.userRole === 'admin') return true;

    // Public: always readable
    if (entity.visibility === 'public') return true;

    // Private: only owner
    if (entity.visibility === 'private' && entity.ownerId !== ctx.userId) return false;

    // Team/org: visible to authenticated users (base check passes)

    // Label + member gate (OR logic)
    const requiredLabels = entity.requiredLabels ?? [];
    const aclMembers = entity.aclMembers ?? [];

    if (requiredLabels.length === 0 && aclMembers.length === 0) return true;

    // OR: user has all required labels, OR user is in acl_members
    const hasLabels = requiredLabels.length > 0 &&
      requiredLabels.every(l => ctx.userLabels.includes(l));
    const isMember = aclMembers.length > 0 && aclMembers.includes(ctx.userId);

    return hasLabels || isMember;
  }

  canWrite(entity: Entity, ctx: ACLContext): boolean {
    // DM: only participants can write
    if (entity.visibility === 'dm') {
      const members = entity.aclMembers ?? [];
      return members.includes(ctx.userId);
    }
    if (ctx.userRole === 'admin') return true;
    return entity.ownerId === ctx.userId;
  }

  sqlWhereClause(ctx: ACLContext): { clause: string; params: Record<string, unknown> } {
    if (ctx.userRole === 'admin') {
      // Admin sees everything except DMs
      return {
        clause: `e.visibility != 'dm'`,
        params: {},
      };
    }

    return {
      clause: `(
        e.visibility = 'public'
        OR e.visibility IN ('team', 'org')
        OR (e.visibility = 'private' AND e.owner_id = @_acl_uid)
        OR (e.visibility = 'dm' AND EXISTS (
          SELECT value FROM json_each(e.acl_members) WHERE value = @_acl_uid
        ))
      ) AND (
        (e.required_labels = '[]' AND e.acl_members = '[]')
        OR (
          e.required_labels != '[]' AND NOT EXISTS (
            SELECT value FROM json_each(e.required_labels)
            WHERE value NOT IN (SELECT value FROM json_each(@_acl_labels))
          )
        )
        OR (
          e.acl_members != '[]' AND EXISTS (
            SELECT value FROM json_each(e.acl_members) WHERE value = @_acl_uid
          )
        )
      )`,
      params: {
        _acl_uid: ctx.userId,
        _acl_labels: JSON.stringify(ctx.userLabels),
      },
    };
  }
}
```

## Database Integration

All entity query methods in `HiveDatabase` gain an optional `acl?: ACLContext` parameter. When present, the ACL WHERE clause is injected.

```typescript
// In src/db/database.ts

searchEntities(query: string, options: SearchEntitiesOptions = {}): Entity[] {
  const { project, entityType, domain, namespace, limit = 20, acl } = options;

  const extraConditions: string[] = [];
  const params: Record<string, unknown> = { query, limit };

  // ... existing filters ...

  // ACL enforcement
  if (acl) {
    const { clause, params: aclParams } = this.aclPolicy.sqlWhereClause(acl);
    extraConditions.push(clause);
    Object.assign(params, aclParams);
  }

  // ... rest of query building ...
}
```

Same pattern applied to: `listEntities`, `getEntity`, `countEntities`.

For `getEntity(id)`, post-query `canRead` check:

```typescript
getEntity(id: string, acl?: ACLContext): Entity | null {
  const entity = /* existing query */;
  if (entity && acl && !this.aclPolicy.canRead(entity, acl)) {
    return null; // Silently deny — no existence leak
  }
  return entity;
}
```

## Tool ACL Integration

All tool registration functions receive an `ACLResolver` to build per-request ACLContext.

```typescript
// In src/tools/index.ts

export function registerTools(
  server: { tool: (...) => void },
  store: CortexStore,
  userContext?: UserContext,
) {
  const safeTool: SafeToolFn = (name, description, schema, handler) =>
    server.tool(name, description, schema, wrapHandler(handler));

  const db = store.database;

  // Build ACL resolver (returns null when CORTEX_ACL=off)
  const aclResolver: ACLResolver = (uc) => {
    if (process.env.CORTEX_ACL !== 'on') return null;
    if (!uc.userId) return null;  // fail closed: no user = no access
    const user = db.getUserById(uc.userId);
    if (!user) return null;
    const labels = db.getUserLabels(uc.userId).map(l => l.labelId);
    return { userId: uc.userId, userRole: user.role, userLabels: labels };
  };

  // Pass aclResolver to ALL tool groups
  registerProjectTools(safeTool, store, aclResolver);
  registerMemoryTools(safeTool, store, userContext, aclResolver);
  registerSessionTools(safeTool, store, userContext, aclResolver);
  registerBrowseTools(safeTool, db, aclResolver, userContext);
  registerTrailTools(safeTool, db, aclResolver, userContext);
  registerConnectorTools(safeTool, db, store, aclResolver);
  registerTeamTools(safeTool, store, aclResolver);
  registerContextTools(safeTool, store, aclResolver);
  registerMeetingTools(safeTool, store, aclResolver);
  registerStewardTools(safeTool, store, aclResolver);
  registerAdvisorTools(safeTool, db, aclResolver, userContext);
  registerUserTools(safeTool, db, userContext);  // userContext for admin check
}
```

## user_manage Auth Check

```typescript
// In src/tools/user-tools.ts — add at top of handler

async (args) => {
  // Admin-only check
  if (userContext?.userId) {
    const user = db.getUserById(userContext.userId);
    if (!user || user.role !== 'admin') {
      return {
        content: [{ type: "text", text: "Error: user_manage requires admin role" }],
        isError: true,
      };
    }
  }
  // ... existing handler logic ...
}
```

## Source Inheritance Rules

```typescript
// src/acl/source-inherit.ts

export interface SourceACLRule {
  connector: string;
  derive(metadata: Record<string, unknown>): {
    visibility: VisibilityLevel;
    ownerId?: string;
    aclMembers?: string[];
    requiredLabels?: string[];
  };
}

export const SLACK_ACL_RULE: SourceACLRule = {
  connector: 'slack',
  derive(meta) {
    if (meta.is_im || meta.is_mpim) {
      return {
        visibility: 'dm',
        aclMembers: (meta.participants as string[]) ?? [],
      };
    }
    if (meta.is_private) return { visibility: 'private' };
    return { visibility: 'team' };  // public channel
  },
};

export const CALENDAR_ACL_RULE: SourceACLRule = {
  connector: 'calendar',
  derive(meta) {
    const visibility = (meta.visibility as string) === 'private' ? 'private' as const : 'team' as const;
    return { visibility };
  },
};

export const GITHUB_ACL_RULE: SourceACLRule = {
  connector: 'github',
  derive(meta) {
    return { visibility: (meta.private === true) ? 'private' : 'team' };
  },
};

// ── Enrichment Inheritance ───────────────────────────────────────────────────

const VISIBILITY_RESTRICTIVENESS: Record<VisibilityLevel, number> = {
  public: 0, org: 1, team: 2, private: 3, dm: 4,
};

/**
 * Derive ACL for entities created by enrichment from source entities.
 * Uses most-restrictive merge: highest visibility, union of labels, intersection of members.
 */
export function deriveACLFromSources(sources: Entity[]): {
  visibility: VisibilityLevel;
  requiredLabels: string[];
  aclMembers: string[];
} {
  if (sources.length === 0) return { visibility: 'team', requiredLabels: [], aclMembers: [] };

  // Most restrictive visibility
  let maxRestriction = 0;
  let resultVisibility: VisibilityLevel = 'public';
  for (const src of sources) {
    const level = VISIBILITY_RESTRICTIVENESS[src.visibility as VisibilityLevel] ?? 0;
    if (level > maxRestriction) {
      maxRestriction = level;
      resultVisibility = src.visibility as VisibilityLevel;
    }
  }

  // Union of required_labels
  const allLabels = new Set<string>();
  for (const src of sources) {
    for (const label of src.requiredLabels ?? []) allLabels.add(label);
  }

  // Intersection of acl_members
  const memberSets = sources
    .map(s => new Set(s.aclMembers ?? []))
    .filter(s => s.size > 0);
  let resultMembers: string[] = [];
  if (memberSets.length > 0) {
    resultMembers = [...memberSets[0]].filter(m => memberSets.every(s => s.has(m)));
  }

  return {
    visibility: resultVisibility,
    requiredLabels: [...allLabels],
    aclMembers: resultMembers,
  };
}
```

## Connector Integration

```typescript
// In src/connectors/slack.ts — within buildEntityDraft()

const channelInfo = await this.getChannelInfo(channelId);
const aclData = SLACK_ACL_RULE.derive({
  is_im: channelInfo.is_im,
  is_private: channelInfo.is_private,
  is_mpim: channelInfo.is_mpim,
  participants: channelInfo.is_im || channelInfo.is_mpim
    ? await this.resolveParticipantIds(channelInfo.members)
    : undefined,
});

return {
  // ... existing fields ...
  visibility: aclData.visibility,
  owner_id: message.user ? await this.resolveUserId(message.user) : undefined,
  acl_members: aclData.aclMembers ? JSON.stringify(aclData.aclMembers) : '[]',
};
```

## Orphaned Data Policy

```typescript
// In src/db/database.ts or src/steward/index.ts

/**
 * Clean up entities owned by revoked users after 90-day grace period.
 * Called by steward audit or nightly cleanup job.
 */
cleanupOrphanedEntities(): { archived: number; cleared: number } {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  // Private/DM entities: archive (soft-delete)
  const archived = this.db.prepare(`
    UPDATE entities SET status = 'archived'
    WHERE owner_id IN (
      SELECT id FROM users WHERE status = 'revoked' AND revoked_at < @cutoff
    )
    AND visibility IN ('private', 'dm')
    AND status = 'active'
  `).run({ cutoff }).changes;

  // Team/Org/Public entities: clear owner (keep accessible)
  const cleared = this.db.prepare(`
    UPDATE entities SET owner_id = NULL
    WHERE owner_id IN (
      SELECT id FROM users WHERE status = 'revoked' AND revoked_at < @cutoff
    )
    AND visibility NOT IN ('private', 'dm')
  `).run({ cutoff }).changes;

  return { archived, cleared };
}
```

## UserContext Race Condition Fix

```typescript
// In src/tools/index.ts — CRITICAL FIX

// BEFORE (shared mutable — race condition in concurrent HTTP requests):
// export function registerTools(server, store, userContext?: UserContext) { ... }

// AFTER (per-request immutable context via closure):
// Each HTTP request creates a fresh registerTools call with its own frozen userContext.
// The userContext object is Object.freeze'd at creation in the HTTP middleware.
// Tool handlers receive it as a closure capture, not a mutable shared ref.
```

## Feature Flag

```bash
# Enable ACL enforcement (default: off for backward compat)
CORTEX_ACL=on

# When off: all queries skip ACL WHERE clause, all entities visible
# When on: every query requires ACLContext (from auth middleware)
# When on + no ACLContext (STDIO mode): fail closed (deny all)
# Warning logged on startup when >1 user exists and CORTEX_ACL is not 'on'
```

## CLI: Label Management

```bash
# Create a label (admin only)
hive-memory label create hr --description "Human Resources team"

# Assign label to user (admin only)
hive-memory label assign <user-id> hr

# List all labels
hive-memory label list

# List labels for a user
hive-memory label list --user <user-id>

# Revoke label from user (admin only)
hive-memory label revoke <user-id> hr

# Reassign entity ownership (admin only)
hive-memory entity reassign --from <user-id> --to <user-id>
```

## VisibilityType Update

```typescript
// src/types.ts — expand the existing type
export type VisibilityType = 'private' | 'dm' | 'team' | 'org' | 'public';

// Entity interface — add new fields
export interface Entity {
  // ... existing fields ...
  ownerId?: string;
  requiredLabels?: string[];
  aclMembers?: string[];       // NEW: explicit participant list (used for DMs)
}
```

## Migration Strategy

1. Schema v5 migration adds columns with defaults -- existing entities get `owner_id = NULL`, `required_labels = '[]'`, `acl_members = '[]'`.
2. Existing entities with `visibility = 'personal'` are migrated to `visibility = 'private'` (rename for consistency).
3. With `CORTEX_ACL=off`, behavior is identical to pre-ACL. No migration required for single-user deployments.
4. For team deployments, admin runs `hive-memory label create` and `hive-memory label assign` to set up initial labels.
5. `revoked_at` column added to `users` table for orphan cleanup tracking.

## Key Design Decisions

1. **SQL-level enforcement, not post-filter.** ACL WHERE clause is injected into the SQL query itself. This prevents data leaks even if new tool paths are added without remembering to filter. Performance is better than loading all rows and filtering in JS.
2. **OR logic for labels + acl_members.** User can access an entity if they have all required labels OR are listed in acl_members. This models two natural access patterns: role-based (labels) and individual grants (members). Additive, intuitive, auditable.
3. **Silent denial (return null/empty).** `getEntity` returns null for ACL-denied entities, not an error. This prevents existence inference attacks while keeping the API simple.
4. **Feature flag default off.** `CORTEX_ACL=off` means zero overhead for single-user mode. The ACL code path is completely skipped. Fail closed when on.
5. **Visibility rename: personal -> private.** The existing `personal` value is semantically identical to `private`. Migration renames for consistency.
6. **DM as distinct visibility level.** `dm` is separate from `private` because it has fundamentally different access semantics (multi-participant, admin-excluded). Uses `acl_members` instead of label prefix.
7. **Admin excluded from DMs.** Admins see all entities except `visibility = 'dm'`. Balances operational need with privacy expectation.
8. **Enrichment inherits most-restrictive ACL.** Derived entities inherit the highest visibility restriction, union of labels, and intersection of members from sources. Prevents private data leakage through enrichment.
9. **No group admin delegation in v1.** Only system admins manage labels. Keeps the authorization model simple and auditable.
10. **90-day orphan retention.** Revoked users' private/DM entities are archived after 90 days. Team-visible entities persist with cleared ownership.
