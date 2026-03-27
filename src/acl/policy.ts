import type { ACLPolicy } from './types.js';

export const defaultACLPolicy: ACLPolicy = {
  canRead(entity, ctx) {
    // DM: ONLY if userId in aclMembers (admin excluded!)
    if (entity.visibility === 'dm') {
      return (entity.aclMembers ?? []).includes(ctx.userId);
    }

    // Admin: can read everything except DM (already handled above)
    if (ctx.userRole === 'admin') {
      return true;
    }

    // Public: always readable
    if (entity.visibility === 'public') {
      return true;
    }

    // Private: only if ownerId === userId
    if (entity.visibility === 'private') {
      return entity.ownerId === ctx.userId;
    }

    // Team/org: all authenticated users
    if (entity.visibility === 'team' || entity.visibility === 'org') {
      // Apply label + member gate if either is non-empty
      const requiredLabels = entity.requiredLabels ?? [];
      const aclMembers = entity.aclMembers ?? [];

      if (requiredLabels.length === 0 && aclMembers.length === 0) {
        return true;
      }

      // OR logic: user has ALL required labels, OR is in acl_members
      const hasAllLabels =
        requiredLabels.length > 0 &&
        requiredLabels.every((label) => ctx.userLabels.includes(label));
      const isMember = aclMembers.length > 0 && aclMembers.includes(ctx.userId);

      return hasAllLabels || isMember;
    }

    // personal (legacy) — treat as private
    if (entity.visibility === 'personal') {
      return entity.ownerId === ctx.userId;
    }

    return false;
  },

  canWrite(entity, ctx) {
    // DM: only participants can write
    if (entity.visibility === 'dm') {
      return (entity.aclMembers ?? []).includes(ctx.userId);
    }

    // Admin: can write everything except DM
    if (ctx.userRole === 'admin') {
      return true;
    }

    // Owner can write
    if (entity.ownerId === ctx.userId) {
      return true;
    }

    return false;
  },

  sqlWhereClause(ctx) {
    if (ctx.userRole === 'admin') {
      // Admin sees all except DM (unless participant)
      const clause = `(e.visibility != 'dm' OR (e.visibility = 'dm' AND EXISTS(SELECT 1 FROM json_each(e.acl_members) WHERE value = @_acl_uid)))`;
      return {
        clause,
        params: { _acl_uid: ctx.userId },
      };
    }

    // Member: full visibility + label + member check
    const clause = `(
      (e.visibility = 'public')
      OR (e.visibility = 'private' AND e.owner_id = @_acl_uid)
      OR (e.visibility = 'personal' AND e.owner_id = @_acl_uid)
      OR (
        e.visibility IN ('team', 'org')
        AND (
          (
            e.required_labels = '[]'
            OR NOT EXISTS (
              SELECT value FROM json_each(e.required_labels)
              WHERE value NOT IN (SELECT value FROM json_each(@_acl_labels))
            )
          )
          OR (
            e.acl_members != '[]'
            AND EXISTS (
              SELECT value FROM json_each(e.acl_members)
              WHERE value = @_acl_uid
            )
          )
        )
      )
      OR (
        e.visibility = 'dm'
        AND EXISTS (
          SELECT value FROM json_each(e.acl_members)
          WHERE value = @_acl_uid
        )
      )
    )`;

    return {
      clause,
      params: {
        _acl_uid: ctx.userId,
        _acl_labels: JSON.stringify(ctx.userLabels),
      },
    };
  },
};
