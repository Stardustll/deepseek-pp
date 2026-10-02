import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_CHAT_RECORD_STATE,
  getChatRecordState,
  normalizeChatRecordState,
  saveChatRecord,
} from '../core/chat/session-records';

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

describe('chat record retention', () => {
  it('round trips a transcript and marks it as the most recent target', async () => {
    const data = stubStorage();

    const state = await saveChatRecord({
      targetId: 'conv-1',
      title: 'Architecture',
      messages: [
        { role: 'user', text: 'hi' },
        { role: 'assistant', text: 'hello', reasoningText: 'thinking' },
      ],
      updatedAt: 10,
    });

    expect(state.lastTargetId).toBe('conv-1');
    expect(state.records['conv-1']).toEqual({
      targetId: 'conv-1',
      title: 'Architecture',
      messages: [
        { role: 'user', text: 'hi' },
        { role: 'assistant', text: 'hello', reasoningText: 'thinking' },
      ],
      updatedAt: 10,
    });
    // Persisted, not just returned.
    expect((data.deepseek_pp_chat_records as { records: unknown }).records)
      .toHaveProperty('conv-1');
  });

  it('removes the record when the transcript becomes empty', async () => {
    stubStorage();
    await saveChatRecord({ targetId: 'conv-1', title: null, messages: [{ role: 'user', text: 'x' }], updatedAt: 1 });

    const state = await saveChatRecord({ targetId: 'conv-1', title: null, messages: [], updatedAt: 2 });

    expect(state.records).not.toHaveProperty('conv-1');
    expect(state.lastTargetId).toBeNull();
  });

  it('keeps separate targets apart and points at the newest write', async () => {
    stubStorage();
    await saveChatRecord({ targetId: 'local-1', title: null, messages: [{ role: 'user', text: 'a' }], updatedAt: 5 });
    const state = await saveChatRecord({ targetId: 'conv-9', title: 'Bound', messages: [{ role: 'user', text: 'b' }], updatedAt: 6 });

    expect(Object.keys(state.records).sort()).toEqual(['conv-9', 'local-1']);
    expect(state.lastTargetId).toBe('conv-9');
  });

  it('rejects a blank target id instead of writing an unaddressable record', async () => {
    stubStorage();
    await expect(saveChatRecord({ targetId: '   ', title: null, messages: [{ role: 'user', text: 'x' }], updatedAt: 1 }))
      .rejects.toThrow(/target id is required/);
  });

  it('keeps both records when two saves overlap', async () => {
    const data = stubStorage();

    await Promise.all([
      saveChatRecord({ targetId: 'conv-1', title: null, messages: [{ role: 'user', text: 'a' }], updatedAt: 1 }),
      saveChatRecord({ targetId: 'conv-2', title: null, messages: [{ role: 'user', text: 'b' }], updatedAt: 2 }),
    ]);

    const stored = data.deepseek_pp_chat_records as { records: Record<string, unknown> };
    expect(Object.keys(stored.records).sort()).toEqual(['conv-1', 'conv-2']);
  });

  it('reads back what it wrote', async () => {
    stubStorage();
    await saveChatRecord({ targetId: 'conv-1', title: 'T', messages: [{ role: 'user', text: 'hello' }], updatedAt: 3 });

    await expect(getChatRecordState()).resolves.toMatchObject({
      lastTargetId: 'conv-1',
      records: { 'conv-1': { title: 'T', messages: [{ role: 'user', text: 'hello' }] } },
    });
  });
});

describe('chat record decoding', () => {
  it('treats anything without the written schema version as empty', () => {
    for (const value of [
      undefined, null, 'x', [], {},
      { schemaVersion: 2, records: {} },
      { schemaVersion: 1 },
      { schemaVersion: 1, records: [] },
    ]) {
      expect(normalizeChatRecordState(value)).toEqual(EMPTY_CHAT_RECORD_STATE);
    }
  });

  it('drops malformed records and messages rather than guessing', () => {
    const state = normalizeChatRecordState({
      schemaVersion: 1,
      lastTargetId: 'conv-1',
      records: {
        'conv-1': {
          targetId: 'conv-1',
          title: 'Keep',
          updatedAt: 5,
          messages: [
            { role: 'user', text: 'kept' },
            { role: 'system', text: 'dropped role' },
            { role: 'assistant' },
            'not-an-object',
          ],
        },
        // targetId must match its key, so this record is unusable.
        'conv-2': { targetId: 'other', messages: [{ role: 'user', text: 'x' }] },
        'conv-3': { targetId: 'conv-3', messages: [] },
      },
    });

    expect(Object.keys(state.records)).toEqual(['conv-1']);
    expect(state.records['conv-1'].messages).toEqual([{ role: 'user', text: 'kept' }]);
  });

  it('falls back to the newest record when the pointer is stale', () => {
    const state = normalizeChatRecordState({
      schemaVersion: 1,
      lastTargetId: 'gone',
      records: {
        'conv-1': { targetId: 'conv-1', messages: [{ role: 'user', text: 'a' }], updatedAt: 1 },
        'conv-2': { targetId: 'conv-2', messages: [{ role: 'user', text: 'b' }], updatedAt: 9 },
      },
    });

    expect(state.lastTargetId).toBe('conv-2');
  });

  it('bounds how many targets are retained, keeping the newest', () => {
    const records: Record<string, unknown> = {};
    for (let index = 0; index < 40; index += 1) {
      records[`conv-${index}`] = {
        targetId: `conv-${index}`,
        messages: [{ role: 'user', text: `m${index}` }],
        updatedAt: index,
      };
    }

    const state = normalizeChatRecordState({ schemaVersion: 1, records, lastTargetId: 'conv-39' });

    expect(Object.keys(state.records)).toHaveLength(30);
    expect(state.records).toHaveProperty('conv-39');
    expect(state.records).not.toHaveProperty('conv-0');
  });

  it('truncates oversized message text instead of refusing the record', () => {
    const state = normalizeChatRecordState({
      schemaVersion: 1,
      records: {
        'conv-1': {
          targetId: 'conv-1',
          messages: [{ role: 'assistant', text: 'x'.repeat(300_000) }],
          updatedAt: 1,
        },
      },
    });

    expect(state.records['conv-1'].messages[0].text).toHaveLength(200_000);
  });
});
