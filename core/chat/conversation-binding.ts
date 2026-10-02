/**
 * Sidepanel conversation-target binding.
 *
 * By default the sidepanel runs its own web conversation: the first message
 * calls `chat_session/create` and the sidepanel owns that session. Binding an
 * existing DeepSeek conversation instead makes the sidepanel post into that
 * conversation, so a chat started on the page can be continued from the
 * sidepanel (and shows up on the page again on reload).
 *
 * This stores a REFERENCE only — the conversation id the user picked. Message
 * content is never mirrored here; the page and the DeepSeek account remain the
 * single source of truth for conversation history. That keeps this feature
 * inside the released "no silent conversation archive" boundary and out of the
 * sync payloads.
 *
 * Storage follows the released settings convention (core/prompt/settings.ts):
 * default-merged on read, unknown fields dropped, invalid values falling back
 * to "unbound", storage errors rejecting visibly.
 */

import { createSerialOperationQueue } from '../persistence/serial-operation-queue';

const STORAGE_KEY = 'deepseek_pp_bound_conversation';

/**
 * One FIFO for this key's reads, bind, and clear. Bind and clear are whole-key
 * operations, so overlapping them from two sidepanel surfaces could otherwise
 * interleave a read against a half-applied write.
 */
const bindingQueue = createSerialOperationQueue();

export interface BoundConversation {
  /** DeepSeek conversation id, or null when the sidepanel owns its own session. */
  conversationId: string | null;
  /** Title captured at bind time, for display only; never used for identity. */
  title: string | null;
  boundAt: number | null;
}

export const UNBOUND_CONVERSATION: BoundConversation = {
  conversationId: null,
  title: null,
  boundAt: null,
};

export async function getBoundConversation(): Promise<BoundConversation> {
  return bindingQueue.run(async () => {
    const data = await chrome.storage.local.get(STORAGE_KEY) as Record<string, unknown>;
    return normalizeBoundConversation(data[STORAGE_KEY]);
  });
}

export async function bindConversation(conversationId: string, title: string | null): Promise<BoundConversation> {
  const normalized = normalizeBoundConversation({
    conversationId,
    title,
    boundAt: Date.now(),
  });
  if (!normalized.conversationId) {
    throw new Error('A DeepSeek conversation id is required to bind a conversation.');
  }
  return bindingQueue.run(async () => {
    await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
    return normalized;
  });
}

export async function clearBoundConversation(): Promise<void> {
  return bindingQueue.run(async () => {
    await chrome.storage.local.remove(STORAGE_KEY);
  });
}

/**
 * `boundAt` is dropped on read when the id is absent or malformed, so a corrupt
 * value can never surface as a usable binding.
 */
export function normalizeBoundConversation(value: unknown): BoundConversation {
  const object = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<BoundConversation>
    : null;
  if (!object) return { ...UNBOUND_CONVERSATION };

  const conversationId = typeof object.conversationId === 'string' && object.conversationId.trim()
    ? object.conversationId.trim()
    : null;
  if (!conversationId) return { ...UNBOUND_CONVERSATION };

  return {
    conversationId,
    title: typeof object.title === 'string' && object.title.trim() ? object.title.trim() : null,
    boundAt: typeof object.boundAt === 'number' && Number.isFinite(object.boundAt) ? object.boundAt : null,
  };
}
