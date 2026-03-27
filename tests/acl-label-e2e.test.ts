/**
 * TASK-ACL-17: End-to-end label-gated entity tests
 *
 * Validates:
 * - Label creation and user assignment
 * - required_labels gates access via searchEntities / getEntity (CORTEX_ACL=on)
 * - OR logic: user in acl_members bypasses label requirement
 * - Removing label revokes access (unless in acl_members)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HiveDatabase } from '../src/db/database.js';
import type { Entity } from '../src/types.js';
import type { ACLContext } from '../src/acl/types.js';

function makeEntity(overrides: Partial<Entity> = {}): Entity {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    entityType: 'decision',
    namespace: 'test',
    title: 'Test Entity',
    content: 'some content for label gate test',
    tags: [],
    keywords: [],
    attributes: {},
    source: { system: 'test' },
    visibility: 'team',
    domain: 'general',
    confidence: 'high',
    createdAt: now,
    updatedAt: now,
    status: 'active',
    requiredLabels: [],
    aclMembers: [],
    ...overrides,
  };
}

describe('ACL label-gated entities (TASK-ACL-17)', () => {
  let db: HiveDatabase;
  let tmpDir: string;

  const user1Id = 'user-label-e2e-1';
  const user2Id = 'user-label-e2e-2';

  const user1Ctx: ACLContext = { userId: user1Id, userRole: 'member', userLabels: ['hr'] };
  const user2Ctx: ACLContext = { userId: user2Id, userRole: 'member', userLabels: [] };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hive-acl-label-e2e-'));
    db = new HiveDatabase(join(tmpDir, 'test.db'));
    process.env.CORTEX_ACL = 'on';
  });

  afterEach(() => {
    delete process.env.CORTEX_ACL;
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('create label, assign to user1, create entity with required_labels: [hr]', () => {
    const labelId = randomUUID();
    db.createLabel(labelId, 'hr', 'HR team access');
    db.insertUser({ id: user1Id, name: 'User1', apiKeyHash: 'h1', role: 'member', createdAt: new Date().toISOString(), status: 'active' });
    db.insertUser({ id: user2Id, name: 'User2', apiKeyHash: 'h2', role: 'member', createdAt: new Date().toISOString(), status: 'active' });
    db.assignUserLabel(user1Id, labelId);

    const labels = db.getUserLabels(user1Id);
    expect(labels).toContain('hr');
    expect(db.getUserLabels(user2Id)).not.toContain('hr');
  });

  it('searchEntities with user1 ACL (has hr label) → entity with required_labels:[hr] found', () => {
    const labelId = randomUUID();
    db.createLabel(labelId, 'hr');
    db.insertUser({ id: user1Id, name: 'User1', apiKeyHash: 'h1', role: 'member', createdAt: new Date().toISOString(), status: 'active' });
    db.assignUserLabel(user1Id, labelId);

    const entity = makeEntity({ requiredLabels: ['hr'] });
    db.insertEntity(entity);

    const results = db.searchEntities('content label gate test', { acl: user1Ctx });
    expect(results.some(e => e.id === entity.id)).toBe(true);
  });

  it('searchEntities with user2 ACL (no hr label) → entity with required_labels:[hr] not found', () => {
    const labelId = randomUUID();
    db.createLabel(labelId, 'hr');
    db.insertUser({ id: user1Id, name: 'User1', apiKeyHash: 'h1', role: 'member', createdAt: new Date().toISOString(), status: 'active' });
    db.assignUserLabel(user1Id, labelId);

    const entity = makeEntity({ requiredLabels: ['hr'] });
    db.insertEntity(entity);

    const results = db.searchEntities('content label gate test', { acl: user2Ctx });
    expect(results.some(e => e.id === entity.id)).toBe(false);
  });

  it('getEntity with user2 ACL → returns null for label-gated entity', () => {
    const entity = makeEntity({ requiredLabels: ['hr'] });
    db.insertEntity(entity);

    const result = db.getEntity(entity.id, user2Ctx);
    expect(result).toBeNull();
  });

  it('getEntity with user1 ACL (has hr label) → returns entity', () => {
    const entity = makeEntity({ requiredLabels: ['hr'] });
    db.insertEntity(entity);

    const result = db.getEntity(entity.id, user1Ctx);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(entity.id);
  });

  it('OR logic: add user2 to acl_members → user2 can now read despite lacking hr label', () => {
    const entity = makeEntity({ requiredLabels: ['hr'], aclMembers: [user2Id] });
    db.insertEntity(entity);

    const ctxWithMembership: ACLContext = { userId: user2Id, userRole: 'member', userLabels: [] };
    const result = db.getEntity(entity.id, ctxWithMembership);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(entity.id);
  });

  it('OR logic: searchEntities finds entity for user2 when in acl_members', () => {
    const entity = makeEntity({ requiredLabels: ['hr'], aclMembers: [user2Id] });
    db.insertEntity(entity);

    const results = db.searchEntities('content label gate test', { acl: user2Ctx });
    expect(results.some(e => e.id === entity.id)).toBe(true);
  });

  it('revoking hr label from user1 → user1 can no longer read (unless in acl_members)', () => {
    const labelId = randomUUID();
    db.createLabel(labelId, 'hr');
    db.insertUser({ id: user1Id, name: 'User1', apiKeyHash: 'h1', role: 'member', createdAt: new Date().toISOString(), status: 'active' });
    db.assignUserLabel(user1Id, labelId);

    const entity = makeEntity({ requiredLabels: ['hr'] });
    db.insertEntity(entity);

    // Before revoke: user1 can read
    expect(db.getEntity(entity.id, user1Ctx)).not.toBeNull();

    // Revoke label
    db.revokeUserLabel(user1Id, labelId);

    // After revoke: user1 has no labels, cannot read
    const ctxAfterRevoke: ACLContext = { userId: user1Id, userRole: 'member', userLabels: [] };
    expect(db.getEntity(entity.id, ctxAfterRevoke)).toBeNull();
  });

  it('CORTEX_ACL=off: all entities visible regardless of required_labels', () => {
    delete process.env.CORTEX_ACL;

    const entity = makeEntity({ requiredLabels: ['hr'] });
    db.insertEntity(entity);

    // With ACL off, user2 (no hr label) should still see the entity
    const result = db.getEntity(entity.id, user2Ctx);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(entity.id);
  });
});

describe('Orphaned entity cleanup (TASK-ACL-16)', () => {
  let db: HiveDatabase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hive-orphan-test-'));
    db = new HiveDatabase(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertRevokedUser(id: string, revokedDaysAgo: number) {
    const revokedAt = new Date(Date.now() - revokedDaysAgo * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    db.insertUser({ id, name: `User ${id}`, apiKeyHash: `hash-${id}`, role: 'member', createdAt: now, status: 'revoked' });
    db.updateUserRevokedAt(id, revokedAt);
  }

  it('private entity owned by user revoked 91 days ago is archived', () => {
    const userId = randomUUID();
    insertRevokedUser(userId, 91);

    const entity = makeEntity({ visibility: 'private', ownerId: userId });
    db.insertEntity(entity);

    const result = db.cleanupOrphanedEntities(90);
    expect(result.archived).toBeGreaterThanOrEqual(1);

    const fetched = db.getEntity(entity.id);
    expect(fetched?.status).toBe('archived');
  });

  it('private entity owned by user revoked 89 days ago is NOT archived', () => {
    const userId = randomUUID();
    insertRevokedUser(userId, 89);

    const entity = makeEntity({ visibility: 'private', ownerId: userId });
    db.insertEntity(entity);

    db.cleanupOrphanedEntities(90);

    const fetched = db.getEntity(entity.id);
    expect(fetched?.status).toBe('active');
  });

  it('team entity owned by revoked user has owner_id cleared and remains searchable', () => {
    const userId = randomUUID();
    insertRevokedUser(userId, 91);

    const entity = makeEntity({ visibility: 'team', ownerId: userId });
    db.insertEntity(entity);

    const result = db.cleanupOrphanedEntities(90);
    expect(result.cleared).toBeGreaterThanOrEqual(1);

    const fetched = db.getEntity(entity.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.ownerId).toBeUndefined();
    expect(fetched?.status).toBe('active');
  });
});
