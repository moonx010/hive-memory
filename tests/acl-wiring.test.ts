import { describe, it, expect } from 'vitest';
import { SlackConnector } from '../src/connectors/slack.js';
import type { RawDocument } from '../src/connectors/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeSlackMessageDoc(overrides: Partial<Record<string, unknown>> = {}): RawDocument {
  return {
    externalId: 'slack:msg:C123:1234567890.000100',
    source: 'slack',
    content: 'This is a significant decision: we will migrate to PostgreSQL for better performance.',
    author: 'U111',
    timestamp: '2024-01-01T00:00:00.000Z',
    metadata: {
      channelId: 'C123',
      ts: '1234567890.000100',
      threadTs: undefined,
      replyCount: 0,
      reactionCount: 5,
      isDecision: true,
      isThread: false,
      replyAuthors: [],
      reactions: ['thumbsup'],
      isPrivate: false,
      isDM: false,
      isMPIM: false,
      channelMembers: undefined,
      ...overrides,
    },
  };
}

// ── SlackConnector.transform() ACL wiring tests ────────────────────────────────

describe('SlackConnector transform() — ACL inheritance', () => {
  const connector = new SlackConnector();

  it('public channel message → visibility team', () => {
    const doc = makeSlackMessageDoc({ isPrivate: false, isDM: false, isMPIM: false });
    const drafts = connector.transform(doc);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].visibility).toBe('team');
  });

  it('private channel message → visibility private', () => {
    const doc = makeSlackMessageDoc({
      isPrivate: true,
      isDM: false,
      isMPIM: false,
      channelMembers: ['U111', 'U222'],
    });
    const drafts = connector.transform(doc);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].visibility).toBe('private');
  });

  it('DM message → visibility dm, aclMembers from channelMembers', () => {
    const doc = makeSlackMessageDoc({
      isPrivate: false,
      isDM: true,
      isMPIM: false,
      channelMembers: ['U111', 'U222'],
    });
    const drafts = connector.transform(doc);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].visibility).toBe('dm');
    expect(drafts[0].aclMembers).toEqual(['U111', 'U222']);
  });

  it('MPIM (group DM) message → visibility dm', () => {
    const doc = makeSlackMessageDoc({
      isPrivate: false,
      isDM: false,
      isMPIM: true,
      channelMembers: ['U111', 'U222', 'U333'],
    });
    const drafts = connector.transform(doc);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].visibility).toBe('dm');
  });

  it('owner_id set from message author', () => {
    const doc = makeSlackMessageDoc({ isPrivate: false, isDM: false, isMPIM: false });
    const drafts = connector.transform(doc);
    expect(drafts[0].ownerId).toBe('U111');
  });

  it('owner_id undefined when no message author', () => {
    const doc: RawDocument = {
      ...makeSlackMessageDoc({ isPrivate: false, isDM: false, isMPIM: false }),
      author: undefined,
    };
    const drafts = connector.transform(doc);
    // ownerId should be undefined when no author
    expect(drafts[0].ownerId).toBeUndefined();
  });

  it('entity type is decision for decision messages', () => {
    const doc = makeSlackMessageDoc({ isDecision: true, isPrivate: false, isDM: false, isMPIM: false });
    const drafts = connector.transform(doc);
    expect(drafts[0].entityType).toBe('decision');
  });

  it('entity type is conversation for non-decision messages', () => {
    const doc = makeSlackMessageDoc({ isDecision: false, isPrivate: false, isDM: false, isMPIM: false });
    const drafts = connector.transform(doc);
    expect(drafts[0].entityType).toBe('conversation');
  });
});
