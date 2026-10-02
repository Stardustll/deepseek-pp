import { describe, expect, it } from 'vitest';
import {
  UNBOUND_CONVERSATION,
  normalizeBoundConversation,
} from '../core/chat/conversation-binding';

describe('bound conversation reference', () => {
  it('treats every malformed shape as unbound', () => {
    for (const value of [undefined, null, 'x', 42, [], {}, { conversationId: '' }, { conversationId: '   ' }, { conversationId: 7 }]) {
      expect(normalizeBoundConversation(value)).toEqual(UNBOUND_CONVERSATION);
    }
  });

  it('drops boundAt when the id is unusable so a corrupt value cannot bind', () => {
    expect(normalizeBoundConversation({ conversationId: null, boundAt: 123 })).toEqual(UNBOUND_CONVERSATION);
  });

  it('keeps the id and title, trimming both', () => {
    expect(normalizeBoundConversation({
      conversationId: '  conv-1  ',
      title: '  Architecture notes  ',
      boundAt: 1700000000000,
    })).toEqual({
      conversationId: 'conv-1',
      title: 'Architecture notes',
      boundAt: 1700000000000,
    });
  });

  it('allows a binding without a title or a timestamp', () => {
    expect(normalizeBoundConversation({ conversationId: 'conv-1' })).toEqual({
      conversationId: 'conv-1',
      title: null,
      boundAt: null,
    });
    // A non-finite timestamp must not survive as a usable value.
    expect(normalizeBoundConversation({ conversationId: 'conv-1', boundAt: Number.NaN }).boundAt).toBeNull();
  });

  it('does not carry message content — a reference is the whole record', () => {
    const normalized = normalizeBoundConversation({
      conversationId: 'conv-1',
      messages: [{ role: 'user', text: 'secret' }],
      raw: { huge: true },
    });
    expect(Object.keys(normalized).sort()).toEqual(['boundAt', 'conversationId', 'title']);
  });
});
