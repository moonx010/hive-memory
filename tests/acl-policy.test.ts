import { describe, it, expect } from 'vitest';
import { defaultACLPolicy } from '../src/acl/policy.js';
import type { ACLContext } from '../src/acl/types.js';

// ── Fixture helpers ────────────────────────────────────────────────────────────

const adminCtx: ACLContext = {
  userId: 'admin1',
  userRole: 'admin',
  userLabels: [],
};

const memberCtx: ACLContext = {
  userId: 'user1',
  userRole: 'member',
  userLabels: [],
};

const hrMemberCtx: ACLContext = {
  userId: 'user2',
  userRole: 'member',
  userLabels: ['hr'],
};

// ── canRead tests ──────────────────────────────────────────────────────────────

describe('DefaultACLPolicy.canRead', () => {
  it('admin can read private entity owned by someone else', () => {
    const entity = { visibility: 'private', ownerId: 'someone-else' };
    expect(defaultACLPolicy.canRead(entity, adminCtx)).toBe(true);
  });

  it('admin CANNOT read DM entity even if admin is listed as owner', () => {
    const entity = { visibility: 'dm', ownerId: 'admin1', aclMembers: ['user1', 'user3'] };
    expect(defaultACLPolicy.canRead(entity, adminCtx)).toBe(false);
  });

  it('admin can read DM entity when listed as participant', () => {
    const entity = { visibility: 'dm', aclMembers: ['admin1', 'user1'] };
    expect(defaultACLPolicy.canRead(entity, adminCtx)).toBe(true);
  });

  it('member cannot read private entity owned by someone else', () => {
    const entity = { visibility: 'private', ownerId: 'user2' };
    expect(defaultACLPolicy.canRead(entity, memberCtx)).toBe(false);
  });

  it('member can read own private entity', () => {
    const entity = { visibility: 'private', ownerId: 'user1' };
    expect(defaultACLPolicy.canRead(entity, memberCtx)).toBe(true);
  });

  it('DM entity readable only by users listed in aclMembers', () => {
    const entity = { visibility: 'dm', aclMembers: ['user1', 'user3'] };
    expect(defaultACLPolicy.canRead(entity, memberCtx)).toBe(true);
    const outsider: ACLContext = { userId: 'user99', userRole: 'member', userLabels: [] };
    expect(defaultACLPolicy.canRead(entity, outsider)).toBe(false);
  });

  it('entity with required_labels=[hr] denied to user without hr label', () => {
    const entity = { visibility: 'team', requiredLabels: ['hr'], aclMembers: [] };
    expect(defaultACLPolicy.canRead(entity, memberCtx)).toBe(false);
  });

  it('entity with required_labels=[hr] and acl_members=[user2] — user2 can read (OR logic)', () => {
    const entity = { visibility: 'team', requiredLabels: ['hr'], aclMembers: ['user2'] };
    const user2Ctx: ACLContext = { userId: 'user2', userRole: 'member', userLabels: [] };
    expect(defaultACLPolicy.canRead(entity, user2Ctx)).toBe(true);
  });

  it('entity with required_labels=[hr,legal] denied to user with only hr label', () => {
    const entity = { visibility: 'team', requiredLabels: ['hr', 'legal'], aclMembers: [] };
    expect(defaultACLPolicy.canRead(entity, hrMemberCtx)).toBe(false);
  });

  it('entity with required_labels=[] and acl_members=[] readable by all members', () => {
    const entity = { visibility: 'team', requiredLabels: [], aclMembers: [] };
    expect(defaultACLPolicy.canRead(entity, memberCtx)).toBe(true);
  });

  it('member with hr label can read entity with required_labels=[hr]', () => {
    const entity = { visibility: 'team', requiredLabels: ['hr'], aclMembers: [] };
    expect(defaultACLPolicy.canRead(entity, hrMemberCtx)).toBe(true);
  });

  it('public entity readable by any member', () => {
    const entity = { visibility: 'public' };
    expect(defaultACLPolicy.canRead(entity, memberCtx)).toBe(true);
  });

  it('org entity readable by all members when no labels or member gate', () => {
    const entity = { visibility: 'org', requiredLabels: [], aclMembers: [] };
    expect(defaultACLPolicy.canRead(entity, memberCtx)).toBe(true);
  });
});

// ── canWrite tests ─────────────────────────────────────────────────────────────

describe('DefaultACLPolicy.canWrite', () => {
  it('canWrite allows owner of a private entity', () => {
    const entity = { visibility: 'private', ownerId: 'user1' };
    expect(defaultACLPolicy.canWrite(entity, memberCtx)).toBe(true);
  });

  it('canWrite denies non-owner member on private entity', () => {
    const entity = { visibility: 'private', ownerId: 'user2' };
    expect(defaultACLPolicy.canWrite(entity, memberCtx)).toBe(false);
  });

  it('canWrite allows DM participant', () => {
    const entity = { visibility: 'dm', aclMembers: ['user1', 'user3'] };
    expect(defaultACLPolicy.canWrite(entity, memberCtx)).toBe(true);
  });

  it('canWrite denies non-participant on DM entity', () => {
    const entity = { visibility: 'dm', aclMembers: ['user2', 'user3'] };
    expect(defaultACLPolicy.canWrite(entity, memberCtx)).toBe(false);
  });

  it('canWrite allows admin on non-DM entity', () => {
    const entity = { visibility: 'team' };
    expect(defaultACLPolicy.canWrite(entity, adminCtx)).toBe(true);
  });

  it('canWrite denies admin on DM entity (unless participant)', () => {
    const entity = { visibility: 'dm', aclMembers: ['user1', 'user2'] };
    expect(defaultACLPolicy.canWrite(entity, adminCtx)).toBe(false);
  });
});

// ── sqlWhereClause tests ───────────────────────────────────────────────────────

describe('DefaultACLPolicy.sqlWhereClause', () => {
  it('admin clause contains visibility != dm check', () => {
    const { clause, params } = defaultACLPolicy.sqlWhereClause(adminCtx);
    expect(clause).toContain("e.visibility != 'dm'");
    expect(params).toHaveProperty('_acl_uid', 'admin1');
  });

  it('admin clause includes DM participant subquery', () => {
    const { clause } = defaultACLPolicy.sqlWhereClause(adminCtx);
    expect(clause).toContain('acl_members');
    expect(clause).toContain('json_each');
  });

  it('member clause includes @_acl_uid param', () => {
    const { params } = defaultACLPolicy.sqlWhereClause(memberCtx);
    expect(params).toHaveProperty('_acl_uid', 'user1');
  });

  it('member clause includes @_acl_labels param as JSON string', () => {
    const ctx: ACLContext = { userId: 'user1', userRole: 'member', userLabels: ['hr', 'eng'] };
    const { params } = defaultACLPolicy.sqlWhereClause(ctx);
    expect(params).toHaveProperty('_acl_labels');
    expect(JSON.parse(params._acl_labels as string)).toEqual(['hr', 'eng']);
  });

  it('member clause contains private visibility check', () => {
    const { clause } = defaultACLPolicy.sqlWhereClause(memberCtx);
    expect(clause).toContain("e.visibility = 'private'");
    expect(clause).toContain('e.owner_id = @_acl_uid');
  });

  it('member clause contains DM participant check', () => {
    const { clause } = defaultACLPolicy.sqlWhereClause(memberCtx);
    expect(clause).toContain("e.visibility = 'dm'");
  });

  it('member clause uses no string interpolation for user input', () => {
    const maliciousCtx: ACLContext = {
      userId: "' OR 1=1 --",
      userRole: 'member',
      userLabels: ["' DROP TABLE entities --"],
    };
    const { clause, params } = defaultACLPolicy.sqlWhereClause(maliciousCtx);
    // Clause must not contain the injected string
    expect(clause).not.toContain('DROP TABLE');
    expect(clause).not.toContain('1=1');
    // All user values go through params only
    expect(params._acl_uid).toBe("' OR 1=1 --");
  });
});
