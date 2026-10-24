import { describe, expect, it } from 'vitest';
import { getConversationMessages, getGroupMessages, mergeConversationMessages, mergeGroupMessages, type ConversationMessage } from './master-chat-utils';

type TestMessage = ConversationMessage & { body: string };

const message = (id: string, sender_id: string, recipient_id: string, created_at: string): TestMessage => ({
  id, sender_id, recipient_id, created_at, body: id,
});

describe('Master Chat conversation isolation', () => {
  const user = 'user-1';
  const contactA = 'contact-a';
  const contactB = 'contact-b';

  it('shows only messages exchanged with the selected contact, in either direction', () => {
    const messages = [
      message('a1', user, contactA, '2026-01-01T10:00:00Z'),
      message('b1', contactB, user, '2026-01-01T10:01:00Z'),
      message('a2', contactA, user, '2026-01-01T10:02:00Z'),
    ];

    expect(getConversationMessages(messages, user, contactA).map(item => item.id)).toEqual(['a1', 'a2']);
    expect(getConversationMessages(messages, user, contactB).map(item => item.id)).toEqual(['b1']);
    expect(getConversationMessages(messages, user, '')).toEqual([]);
  });

  it('discards previous-contact state while preserving current-conversation realtime events', () => {
    const current = [
      message('old-a', user, contactA, '2026-01-01T10:00:00Z'),
      message('b-live', contactB, user, '2026-01-01T10:03:00Z'),
    ];
    const fetched = [
      message('b-late', user, contactB, '2026-01-01T10:02:00Z'),
      message('b-live', contactB, user, '2026-01-01T10:03:00Z'),
      message('wrong-peer', user, contactA, '2026-01-01T10:04:00Z'),
    ];

    expect(mergeConversationMessages(current, fetched, user, contactB).map(item => item.id)).toEqual(['b-late', 'b-live']);
  });

  it('deduplicates by message id and keeps chronological order', () => {
    const current = [message('same', user, contactB, '2026-01-01T10:02:00Z')];
    const fetched = [
      message('later', contactB, user, '2026-01-01T10:03:00Z'),
      message('same', user, contactB, '2026-01-01T10:02:00Z'),
      message('earlier', user, contactB, '2026-01-01T10:01:00Z'),
    ];

    expect(mergeConversationMessages(current, fetched, user, contactB).map(item => item.id)).toEqual(['earlier', 'same', 'later']);
  });
});


describe('Master Chat group conversation isolation', () => {
  const groupA = 'group-a';
  const groupB = 'group-b';
  const memberMessage = (id: string, group_id: string, created_at: string): ConversationMessage & { body: string } => ({
    id, group_id, sender_id: 'user-1', recipient_id: null, created_at, body: id,
  });

  it('keeps group messages isolated from other groups and direct messages', () => {
    const messages = [
      memberMessage('a1', groupA, '2026-01-01T10:00:00Z'),
      memberMessage('b1', groupB, '2026-01-01T10:01:00Z'),
      { id: 'direct', sender_id: 'user-1', recipient_id: 'user-2', created_at: '2026-01-01T10:02:00Z', body: 'direct' },
    ];
    expect(getGroupMessages(messages, groupA).map(item => item.id)).toEqual(['a1']);
    expect(getGroupMessages(messages, groupB).map(item => item.id)).toEqual(['b1']);
  });

  it('merges group history and realtime messages without duplicates', () => {
    const current = [memberMessage('old', groupA, '2026-01-01T10:00:00Z'), memberMessage('live', groupB, '2026-01-01T10:03:00Z')];
    const fetched = [memberMessage('later', groupB, '2026-01-01T10:04:00Z'), memberMessage('live', groupB, '2026-01-01T10:03:00Z')];
    expect(mergeGroupMessages(current, fetched, groupB).map(item => item.id)).toEqual(['live', 'later']);
  });
});
