import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WEB_CHAT_OPTIONS,
  getWebChatOptions,
  normalizeWebChatOptions,
  saveWebChatOptions,
} from '../core/chat/web-chat-options';
import { decodeDeepSeekRuntimePayload } from '../core/messaging/deepseek-runtime-request-codec';

/**
 * Minimal storage stub whose reads resolve on the next microtask, which is what
 * exposes a lost update between two overlapping read-merge-writes.
 */
function stubStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async () => ({ ...data })),
        set: vi.fn(async (patch: Record<string, unknown>) => {
          Object.assign(data, patch);
        }),
        remove: vi.fn(async (key: string) => {
          delete data[key];
        }),
      },
    },
  });
  return data;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sidepanel web chat options', () => {
  it('defaults both toggles to the released disabled behavior', () => {
    expect(DEFAULT_WEB_CHAT_OPTIONS).toEqual({ thinkingEnabled: false, searchEnabled: false });
    expect(normalizeWebChatOptions(undefined)).toEqual(DEFAULT_WEB_CHAT_OPTIONS);
    expect(normalizeWebChatOptions(null)).toEqual(DEFAULT_WEB_CHAT_OPTIONS);
    expect(normalizeWebChatOptions('nope')).toEqual(DEFAULT_WEB_CHAT_OPTIONS);
    expect(normalizeWebChatOptions([])).toEqual(DEFAULT_WEB_CHAT_OPTIONS);
  });

  it('reads only strict booleans and drops unknown fields', () => {
    expect(normalizeWebChatOptions({ thinkingEnabled: true, searchEnabled: true }))
      .toEqual({ thinkingEnabled: true, searchEnabled: true });
    // Truthy non-booleans must not silently enable a mode.
    expect(normalizeWebChatOptions({ thinkingEnabled: 1, searchEnabled: 'yes' }))
      .toEqual(DEFAULT_WEB_CHAT_OPTIONS);
    expect(normalizeWebChatOptions({ thinkingEnabled: true, future: 'x' }))
      .toEqual({ thinkingEnabled: true, searchEnabled: false });
  });
});

describe('sidepanel web chat option persistence', () => {
  it('keeps both toggles when two saves overlap', async () => {
    // Regression: a read-merge-write without a store-local queue loses the
    // first toggle when the second click reads the same preimage.
    const data = stubStorage();

    await Promise.all([
      saveWebChatOptions({ thinkingEnabled: true }),
      saveWebChatOptions({ searchEnabled: true }),
    ]);

    expect(data.deepseek_pp_web_chat_options).toEqual({
      thinkingEnabled: true,
      searchEnabled: true,
    });
  });

  it('merges a patch onto the newest stored value, not a stale one', async () => {
    stubStorage({ deepseek_pp_web_chat_options: { thinkingEnabled: true, searchEnabled: false } });

    await expect(saveWebChatOptions({ searchEnabled: true })).resolves.toEqual({
      thinkingEnabled: true,
      searchEnabled: true,
    });
  });

  it('reads through the same queue so an in-flight save is never observed half-applied', async () => {
    stubStorage({ deepseek_pp_web_chat_options: { thinkingEnabled: true, searchEnabled: false } });

    const [, read] = await Promise.all([
      saveWebChatOptions({ searchEnabled: true }),
      getWebChatOptions(),
    ]);

    // The read is ordered after the queued save, so it must already see it.
    expect(read).toEqual({ thinkingEnabled: true, searchEnabled: true });
  });
});

describe('CHAT_SUBMIT_PROMPT mode flags', () => {
  it('keeps decoding a released payload that omits the new flags', () => {
    const decoded = decodeDeepSeekRuntimePayload('CHAT_SUBMIT_PROMPT', {
      text: 'hello',
      refFileIds: ['f1'],
    });

    expect(decoded).toMatchObject({ text: 'hello', refFileIds: ['f1'] });
    // Absent means "use the persisted setting", so the keys must not appear.
    expect(decoded).not.toHaveProperty('thinkingEnabled');
    expect(decoded).not.toHaveProperty('searchEnabled');
  });

  it('carries explicit booleans through when a surface sends them', () => {
    expect(decodeDeepSeekRuntimePayload('CHAT_SUBMIT_PROMPT', {
      text: 'hello',
      thinkingEnabled: true,
      searchEnabled: true,
    })).toMatchObject({ thinkingEnabled: true, searchEnabled: true });

    expect(decodeDeepSeekRuntimePayload('CHAT_SUBMIT_PROMPT', {
      text: 'hello',
      thinkingEnabled: false,
    })).toMatchObject({ thinkingEnabled: false });
  });

  it('rejects a non-boolean flag instead of coercing it', () => {
    expect(() => decodeDeepSeekRuntimePayload('CHAT_SUBMIT_PROMPT', {
      text: 'hello',
      thinkingEnabled: 'true',
    })).toThrow(/thinkingEnabled must be a boolean/);

    expect(() => decodeDeepSeekRuntimePayload('CHAT_SUBMIT_PROMPT', {
      text: 'hello',
      searchEnabled: 1,
    })).toThrow(/searchEnabled must be a boolean/);
  });
});
