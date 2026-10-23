import { describe, expect, it } from 'vitest';
import { getConversationMessages, mergeConversationMessages, type ConversationMessage } from './master-chat-utils';

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
