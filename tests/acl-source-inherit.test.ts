import { describe, it, expect } from 'vitest';
import { deriveACLFromSource, deriveACLFromSources } from '../src/acl/source-inherit.js';

// ── deriveACLFromSource tests ──────────────────────────────────────────────────

describe('deriveACLFromSource — Slack', () => {
  it('Slack DM (isDM: true) → visibility dm, aclMembers populated', () => {
    const result = deriveACLFromSource({
      connector: 'slack',
      isDM: true,
      participants: ['user1', 'user2'],
      author: 'user1',
    });
    expect(result.visibility).toBe('dm');
    expect(result.aclMembers).toEqual(['user1', 'user2']);
    expect(result.ownerId).toBe('user1');
  });

  it('Slack group DM (isMPIM: true) → visibility dm, aclMembers populated', () => {
    const result = deriveACLFromSource({
      connector: 'slack',
      isMPIM: true,
      participants: ['user1', 'user2', 'user3'],
      author: 'user2',
    });
    expect(result.visibility).toBe('dm');
    expect(result.aclMembers).toEqual(['user1', 'user2', 'user3']);
    expect(result.ownerId).toBe('user2');
  });

  it('Slack private channel (isPrivate: true) → visibility private', () => {
    const result = deriveACLFromSource({
      connector: 'slack',
      isPrivate: true,
      channelMembers: ['user1', 'user2'],
      author: 'user1',
    });
    expect(result.visibility).toBe('private');
    expect(result.aclMembers).toEqual(['user1', 'user2']);
  });

  it('Slack public channel → visibility team', () => {
    const result = deriveACLFromSource({
      connector: 'slack',
      isPrivate: false,
      author: 'user1',
    });
    expect(result.visibility).toBe('team');
    expect(result.ownerId).toBe('user1');
  });

  it('Slack DM with empty participants → aclMembers is empty array', () => {
    const result = deriveACLFromSource({
      connector: 'slack',
      isDM: true,
    });
    expect(result.visibility).toBe('dm');
    expect(result.aclMembers).toEqual([]);
  });
});

describe('deriveACLFromSource — GitHub', () => {
  it('GitHub private repo → visibility private', () => {
    const result = deriveACLFromSource({
      connector: 'github',
      isPrivate: true,
      author: 'dev1',
    });
    expect(result.visibility).toBe('private');
    expect(result.ownerId).toBe('dev1');
  });

  it('GitHub public repo → visibility team', () => {
    const result = deriveACLFromSource({
      connector: 'github',
      isPrivate: false,
      author: 'dev1',
    });
    expect(result.visibility).toBe('team');
  });
});

describe('deriveACLFromSource — Google Calendar', () => {
  it('Calendar private event (isDM/isPrivate via google-calendar connector) → visibility private', () => {
    const result = deriveACLFromSource({
      connector: 'google-calendar',
      isPrivate: true,
      author: 'user1',
    });
    expect(result.visibility).toBe('private');
  });

  it('Calendar public event → visibility team', () => {
    const result = deriveACLFromSource({
      connector: 'google-calendar',
      author: 'user1',
    });
    expect(result.visibility).toBe('team');
  });
});

describe('deriveACLFromSource — unknown connector', () => {
  it('Unknown connector defaults to team visibility', () => {
    const result = deriveACLFromSource({
      connector: 'notion',
      author: 'user1',
    });
    expect(result.visibility).toBe('team');
    expect(result.ownerId).toBe('user1');
  });
});

// ── deriveACLFromSources tests ────────────────────────────────────────────────

describe('deriveACLFromSources', () => {
  it('mixed visibilities: most restrictive wins (dm > team)', () => {
    const result = deriveACLFromSources([
      { visibility: 'dm', aclMembers: ['u1', 'u2'] },
      { visibility: 'team' },
    ]);
    expect(result.visibility).toBe('dm');
  });

  it('mixed visibilities: private beats team', () => {
    const result = deriveACLFromSources([
      { visibility: 'team' },
      { visibility: 'private' },
    ]);
    expect(result.visibility).toBe('private');
  });

  it('all team → visibility team', () => {
    const result = deriveACLFromSources([
      { visibility: 'team' },
      { visibility: 'team' },
    ]);
    expect(result.visibility).toBe('team');
  });

  it('requiredLabels: union of all source labels', () => {
    const result = deriveACLFromSources([
      { visibility: 'team', requiredLabels: ['hr'] },
      { visibility: 'team', requiredLabels: ['legal'] },
    ]);
    expect(result.requiredLabels).toContain('hr');
    expect(result.requiredLabels).toContain('legal');
    expect(result.requiredLabels?.length).toBe(2);
  });

  it('requiredLabels: deduplication', () => {
    const result = deriveACLFromSources([
      { visibility: 'team', requiredLabels: ['hr', 'legal'] },
      { visibility: 'team', requiredLabels: ['hr'] },
    ]);
    const labels = result.requiredLabels ?? [];
    expect(labels.filter(l => l === 'hr').length).toBe(1);
  });

  it('aclMembers: intersection of overlapping member lists', () => {
    const result = deriveACLFromSources([
      { visibility: 'private', aclMembers: ['u1', 'u2', 'u3'] },
      { visibility: 'private', aclMembers: ['u2', 'u3', 'u4'] },
    ]);
    expect(result.aclMembers).toEqual(['u2', 'u3']);
  });

  it('aclMembers: no overlap → empty intersection', () => {
    const result = deriveACLFromSources([
      { visibility: 'private', aclMembers: ['u1'] },
      { visibility: 'private', aclMembers: ['u2'] },
    ]);
    expect(result.aclMembers).toEqual([]);
  });

  it('no requiredLabels → requiredLabels undefined', () => {
    const result = deriveACLFromSources([
      { visibility: 'team' },
      { visibility: 'private' },
    ]);
    expect(result.requiredLabels).toBeUndefined();
  });

  it('single source preserves its aclMembers', () => {
    const result = deriveACLFromSources([
      { visibility: 'dm', aclMembers: ['u1', 'u2'] },
    ]);
    expect(result.aclMembers).toEqual(['u1', 'u2']);
  });

  it('empty sources array → public visibility (least restrictive default)', () => {
    const result = deriveACLFromSources([]);
    expect(result.visibility).toBe('public');
  });

  it('org visibility: less restrictive than private', () => {
    const result = deriveACLFromSources([
      { visibility: 'org' },
      { visibility: 'public' },
    ]);
    expect(result.visibility).toBe('org');
  });
});
