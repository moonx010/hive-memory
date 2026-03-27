# Design: access-control-layer

## Overview

Adds entity-level access control to hive-memory with three enforcement mechanisms: visibility-based access (private/team/org/public), owner-based access (only creator can see private entities), and label-based mandatory access (AND-logic label matching). Enforcement happens at the SQL query layer via WHERE clause injection, ensuring no tool can accidentally bypass ACL.

## Directory / File Layout

```
src/
  acl/
    types.ts              <- NEW: ACLContext, ACLPolicy, VisibilityLevel interfaces
    policy.ts             <- NEW: DefaultACLPolicy with canRead, canWrite, sqlWhereClause
    source-inherit.ts     <- NEW: derive visibility from connector source metadata
  db/
    schema.ts             <- MODIFY: schema v5 (labels, user_labels tables; owner_id, required_labels columns)
    database.ts           <- MODIFY: inject ACL WHERE clause into search/list/get/count methods
  store.ts                <- MODIFY: accept ACLContext, pass through to database methods
  connectors/
    slack.ts              <- MODIFY: set visibility based on channel is_private/is_im
    calendar.ts           <- MODIFY: set visibility + owner from attendee list
  tools/
    index.ts              <- MODIFY: extract ACLContext from auth middleware, pass to store
  cli.ts                  <- MODIFY: add "label" subcommand (create, assign, list, revoke)
  types.ts                <- MODIFY: add VisibilityLevel expansion, ownerId to Entity
```

## Schema Design (v5)

```sql
-- New columns on entities (additive migration via ALTER TABLE)
ALTER TABLE entities ADD COLUMN owner_id TEXT REFERENCES users(id);
ALTER TABLE entities ADD COLUMN required_labels TEXT NOT NULL DEFAULT '[]';

-- Label definitions
CREATE TABLE IF NOT EXISTS labels (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

-- User-to-label assignments
CREATE TABLE IF NOT EXISTS user_labels (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label_id   TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  granted_by TEXT REFERENCES users(id),
  granted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, label_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_user_labels_user ON user_labels(user_id);
CREATE INDEX IF NOT EXISTS idx_entities_owner ON entities(owner_id);
CREATE INDEX IF NOT EXISTS idx_entities_visibility ON entities(visibility);
```

## ACL Types

```typescript
// src/acl/types.ts

export type VisibilityLevel = 'private' | 'team' | 'org' | 'public';

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
```

## ACL Policy Implementation

```typescript
// src/acl/policy.ts

export class DefaultACLPolicy implements ACLPolicy {
  canRead(entity: Entity, ctx: ACLContext): boolean {
    if (ctx.userRole === 'admin') return true;
    if (entity.visibility === 'public') return true;
    if (entity.visibility === 'private' && entity.ownerId !== ctx.userId) return false;
    // team/org: visible to authenticated users

    // Label gate (AND logic)
    const required = entity.requiredLabels ?? [];
    if (required.length > 0) {
      return required.every(l => ctx.userLabels.includes(l));
    }
    return true;
  }

  canWrite(entity: Entity, ctx: ACLContext): boolean {
    if (ctx.userRole === 'admin') return true;
    return entity.ownerId === ctx.userId;
  }

  sqlWhereClause(ctx: ACLContext): { clause: string; params: Record<string, unknown> } {
    if (ctx.userRole === 'admin') {
      return { clause: '1=1', params: {} };
    }

    return {
      clause: `(
        e.visibility = 'public'
        OR e.visibility IN ('team', 'org')
        OR (e.visibility = 'private' AND e.owner_id = @_acl_uid)
      ) AND (
        e.required_labels = '[]'
        OR NOT EXISTS (
          SELECT value FROM json_each(e.required_labels)
          WHERE value NOT IN (SELECT value FROM json_each(@_acl_labels))
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

## Source Inheritance Rules

```typescript
// src/acl/source-inherit.ts

export interface SourceACLRule {
  connector: string;
  derive(metadata: Record<string, unknown>): {
    visibility: VisibilityLevel;
    ownerId?: string;
    requiredLabels?: string[];
  };
}

export const SLACK_ACL_RULE: SourceACLRule = {
  connector: 'slack',
  derive(meta) {
    if (meta.is_im) return { visibility: 'private' };
    if (meta.is_private) return { visibility: 'private' };
    if (meta.is_mpim) return { visibility: 'private' };  // group DM
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
```

## Connector Integration

```typescript
// In src/connectors/slack.ts — within buildEntityDraft()

const channelInfo = await this.getChannelInfo(channelId);
const aclData = SLACK_ACL_RULE.derive({
  is_im: channelInfo.is_im,
  is_private: channelInfo.is_private,
  is_mpim: channelInfo.is_mpim,
});

return {
  // ... existing fields ...
  visibility: aclData.visibility,
  owner_id: message.user ? await this.resolveUserId(message.user) : undefined,
};
```

## Feature Flag

```bash
# Enable ACL enforcement (default: off for backward compat)
CORTEX_ACL=on

# When off: all queries skip ACL WHERE clause, all entities visible
# When on: every query requires ACLContext (from auth middleware)
```

## CLI: Label Management

```bash
# Create a label
hive-memory label create hr --description "Human Resources team"

# Assign label to user
hive-memory label assign <user-id> hr

# List all labels
hive-memory label list

# List labels for a user
hive-memory label list --user <user-id>

# Revoke label from user
hive-memory label revoke <user-id> hr
```

## VisibilityType Update

```typescript
// src/types.ts — expand the existing type
export type VisibilityType = 'private' | 'team' | 'org' | 'public';

// Entity interface — add new fields
export interface Entity {
  // ... existing fields ...
  ownerId?: string;
  requiredLabels?: string[];
}
```

## Migration Strategy

1. Schema v5 migration adds columns with defaults — existing entities get `owner_id = NULL`, `required_labels = '[]'`.
2. Existing entities with `visibility = 'personal'` are migrated to `visibility = 'private'` (rename for consistency).
3. With `CORTEX_ACL=off`, behavior is identical to pre-ACL. No migration required for single-user deployments.
4. For team deployments, admin runs `hive-memory label create` and `hive-memory label assign` to set up initial labels.

## Key Design Decisions

1. **SQL-level enforcement, not post-filter.** ACL WHERE clause is injected into the SQL query itself. This prevents data leaks even if new tool paths are added without remembering to filter. Performance is better than loading all rows and filtering in JS.
2. **AND logic for labels.** User must have ALL required labels. OR logic is more permissive but harder to reason about. AND is the standard for mandatory access control (similar to SELinux MLS).
3. **Silent denial (return null/empty).** `getEntity` returns null for ACL-denied entities, not an error. This prevents existence inference attacks while keeping the API simple.
4. **Feature flag default off.** `CORTEX_ACL=off` means zero overhead for single-user mode. The ACL code path is completely skipped.
5. **Visibility rename: personal -> private.** The existing `personal` value is semantically identical to `private`. Migration renames for consistency with the expanded model.
