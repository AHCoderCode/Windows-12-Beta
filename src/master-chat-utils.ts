export type ConversationMessage = {
  id: string;
  sender_id: string;
  recipient_id: string;
  created_at: string;
};

export function isConversationMessage<T extends ConversationMessage>(
  message: T,
  userId: string,
  peerId: string,
): boolean {
  return Boolean(userId && peerId && (
    (message.sender_id === userId && message.recipient_id === peerId)
    || (message.sender_id === peerId && message.recipient_id === userId)
  ));
}

export function getConversationMessages<T extends ConversationMessage>(
  messages: readonly T[],
  userId: string,
  peerId: string,
): T[] {
  if (!userId || !peerId) return [];
  return messages.filter(message => isConversationMessage(message, userId, peerId));
}

/**
 * Merge a server snapshot with live updates without carrying messages from
 * a previously selected contact into the currently active conversation.
 */
export function mergeConversationMessages<T extends ConversationMessage>(
  current: readonly T[],
  fetched: readonly T[],
  userId: string,
  peerId: string,
): T[] {
  const byId = new Map<string, T>();
  for (const message of getConversationMessages(current, userId, peerId)) {
    byId.set(message.id, message);
  }
  for (const message of getConversationMessages(fetched, userId, peerId)) {
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
}
