// Sidepanel web-chat mode toggles.
//
// The DeepSeek page merged its fast/expert/image modes into one model and moved
// the mode intent onto two composer toggles (DeepThink / Web search). The sidepanel
// runs its own web conversation, so these mirrors control what the EXTENSION
// sends on its own requests only: the page's `localStorage.thinkingEnabled` /
// `searchEnabled` and its toggle buttons are never written or clicked.
//
// Storage shape follows the released settings convention (see
// core/prompt/settings.ts and core/skill/auto-activation-settings.ts):
// chrome.storage.local, default-merged on read, unknown fields dropped, invalid
// values falling back to the default, storage errors rejecting visibly.
//
// Both defaults are `false` to preserve the previously hardcoded sidepanel
// behavior (see entrypoints/background/chat-runtime-service.ts).

import { createSerialOperationQueue } from '../persistence/serial-operation-queue';

const STORAGE_KEY = 'deepseek_pp_web_chat_options';

/**
 * One FIFO for this key's reads and writes.
 *
 * `saveWebChatOptions` is a read-merge-write of a whole-key value, so two
 * overlapping toggles (a fast double click, or two sidepanel surfaces) would
 * otherwise both read the same preimage and the later write would silently drop
 * the earlier toggle. Reads share the queue so an in-flight save can never be
 * observed half-applied against a newer preimage.
 */
const webChatOptionsQueue = createSerialOperationQueue();

export interface WebChatOptions {
  thinkingEnabled: boolean;
  searchEnabled: boolean;
}

export const DEFAULT_WEB_CHAT_OPTIONS: WebChatOptions = {
  thinkingEnabled: false,
  searchEnabled: false,
};

export async function getWebChatOptions(): Promise<WebChatOptions> {
  return webChatOptionsQueue.run(async () => {
    const data = await chrome.storage.local.get(STORAGE_KEY) as Record<string, unknown>;
    return normalizeWebChatOptions(data[STORAGE_KEY]);
  });
}

export async function saveWebChatOptions(patch: Partial<WebChatOptions>): Promise<WebChatOptions> {
  return webChatOptionsQueue.run(async () => {
    // Re-read inside the queue so the merge always applies to the newest value.
    const data = await chrome.storage.local.get(STORAGE_KEY) as Record<string, unknown>;
    const normalized = normalizeWebChatOptions({ ...normalizeWebChatOptions(data[STORAGE_KEY]), ...patch });
    await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
    return normalized;
  });
}

export function normalizeWebChatOptions(value: unknown): WebChatOptions {
  const object = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<WebChatOptions>
    : null;
  if (!object) return { ...DEFAULT_WEB_CHAT_OPTIONS };
  return {
    thinkingEnabled: object.thinkingEnabled === true,
    searchEnabled: object.searchEnabled === true,
  };
}
