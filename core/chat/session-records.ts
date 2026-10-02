/**
 * Locally retained sidepanel chat transcripts.
 *
 * The sidepanel used to lose its transcript on every reload: messages lived only
 * in React state. This module keeps a bounded, per-target record so reopening
 * the sidepanel — or switching back to a conversation — restores what the user
 * saw.
 *
 * Keyed by "chat target": the DeepSeek conversation id when the sidepanel is
 * bound to one, or a locally generated id when the sidepanel owns its session.
 * That mirrors how the background resolves a session (see
 * core/chat/conversation-binding.ts), so a transcript is always filed under the
 * conversation it actually belongs to.
 *
 * What is stored is the SIDE PANEL's view of a turn (user text + assistant
 * answer + reasoning), not a mirror of DeepSeek's account history. The account
 * stays the single source of truth for web conversations; this is the local
 * record of what the extension itself sent and received.
 *
 * Storage follows the released settings convention: whole-key rewrite, unknown
 * fields dropped, invalid values rejected on read rather than coerced, and one
 * store-local FIFO so overlapping writes cannot interleave.
 */

import { createSerialOperationQueue } from '../persistence/serial-operation-queue';

const STORAGE_KEY = 'deepseek_pp_chat_records';

/** Only the schema this build writes; other versions fail closed. */
const SCHEMA_VERSION = 1;

/** Bounded so a long-lived install cannot grow the key without limit. */
const MAX_RECORDS = 30;
const MAX_MESSAGES_PER_RECORD = 400;
const MAX_TEXT_CHARS = 200_000;
const MAX_REASONING_CHARS = 200_000;

const recordsQueue = createSerialOperationQueue();

export interface StoredChatMessage {
  role: 'user' | 'assistant';
  text: string;
  reasoningText?: string;
}

export interface StoredChatRecord {
  /** Bound DeepSeek conversation id, or a local id when the sidepanel owns it. */
  targetId: string;
  /** Display-only; never used for identity. */
  title: string | null;
  messages: StoredChatMessage[];
  updatedAt: number;
}

export type ChatRecordStore = Record<string, StoredChatRecord>;

export interface ChatRecordState {
  records: ChatRecordStore;
  /**
   * Target of the most recent sidepanel turn. Restored on mount so reopening the
   * sidepanel returns to the conversation the user was last in.
   */
  lastTargetId: string | null;
}

export const EMPTY_CHAT_RECORD_STATE: ChatRecordState = {
  records: {},
  lastTargetId: null,
};

export async function getChatRecordState(): Promise<ChatRecordState> {
  return recordsQueue.run(async () => {
    const data = await chrome.storage.local.get(STORAGE_KEY) as Record<string, unknown>;
    return normalizeChatRecordState(data[STORAGE_KEY]);
  });
}

/**
 * Writes one target's transcript and marks it as the most recent target.
 *
 * An empty message list removes the record instead of storing an empty one, so
 * "new session" does not leave a stub behind.
 */
export async function saveChatRecord(input: {
  targetId: string;
  title: string | null;
  messages: readonly StoredChatMessage[];
  updatedAt: number;
}): Promise<ChatRecordState> {
  const targetId = typeof input.targetId === 'string' ? input.targetId.trim() : '';
  if (!targetId) {
    throw new Error('A chat record target id is required.');
  }

  return recordsQueue.run(async () => {
    const data = await chrome.storage.local.get(STORAGE_KEY) as Record<string, unknown>;
    const state = normalizeChatRecordState(data[STORAGE_KEY]);
    const records: ChatRecordStore = { ...state.records };

    const messages = input.messages
      .map(normalizeStoredMessage)
      .filter((message): message is StoredChatMessage => message !== null)
      .slice(-MAX_MESSAGES_PER_RECORD);

    if (messages.length === 0) {
      delete records[targetId];
    } else {
      records[targetId] = {
        targetId,
        title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : null,
        messages,
        updatedAt: Number.isFinite(input.updatedAt) ? input.updatedAt : 0,
      };
    }

    const trimmed = trimToNewest(records, MAX_RECORDS);
    const next: ChatRecordState = {
      records: trimmed,
      // Keep the pointer meaningful: if this target was dropped by trimming,
      // fall back to whatever is now newest.
      lastTargetId: trimmed[targetId] ? targetId : newestTargetId(trimmed),
    };
    await chrome.storage.local.set({ [STORAGE_KEY]: serialize(next) });
    return next;
  });
}

/**
 * Reads a stored value back into the state shape.
 *
 * A version this build does not write, or a malformed entry, is dropped rather
 * than reinterpreted — a transcript is display data, so the safe failure is an
 * empty record, never a guessed one.
 */
export function normalizeChatRecordState(value: unknown): ChatRecordState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { records: {}, lastTargetId: null };
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    return { records: {}, lastTargetId: null };
  }
  const rawRecords = raw.records;
  if (!rawRecords || typeof rawRecords !== 'object' || Array.isArray(rawRecords)) {
    return { records: {}, lastTargetId: null };
  }

  const records: ChatRecordStore = {};
  for (const [key, entry] of Object.entries(rawRecords as Record<string, unknown>)) {
    const record = normalizeStoredRecord(key, entry);
    if (record) records[key] = record;
  }

  const lastTargetId = typeof raw.lastTargetId === 'string' && records[raw.lastTargetId]
    ? raw.lastTargetId
    : newestTargetId(records);

  return { records: trimToNewest(records, MAX_RECORDS), lastTargetId };
}

function normalizeStoredRecord(key: string, value: unknown): StoredChatRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.targetId !== 'string' || raw.targetId.trim() !== key) return null;
  if (!Array.isArray(raw.messages)) return null;

  const messages = raw.messages
    .map(normalizeStoredMessage)
    .filter((message): message is StoredChatMessage => message !== null)
    .slice(-MAX_MESSAGES_PER_RECORD);
  if (messages.length === 0) return null;

  return {
    targetId: key,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : null,
    messages,
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
  };
}

function normalizeStoredMessage(value: unknown): StoredChatMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.role !== 'user' && raw.role !== 'assistant') return null;
  if (typeof raw.text !== 'string') return null;

  const message: StoredChatMessage = {
    role: raw.role,
    text: raw.text.slice(0, MAX_TEXT_CHARS),
  };
  if (typeof raw.reasoningText === 'string' && raw.reasoningText) {
    message.reasoningText = raw.reasoningText.slice(0, MAX_REASONING_CHARS);
  }
  return message;
}

function serialize(state: ChatRecordState): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    records: state.records,
    lastTargetId: state.lastTargetId,
  };
}

function newestTargetId(records: ChatRecordStore): string | null {
  let newest: StoredChatRecord | null = null;
  for (const record of Object.values(records)) {
    if (!newest || record.updatedAt > newest.updatedAt) newest = record;
  }
  return newest?.targetId ?? null;
}

function trimToNewest(records: ChatRecordStore, limit: number): ChatRecordStore {
  const entries = Object.entries(records);
  if (entries.length <= limit) return records;
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  return Object.fromEntries(entries.slice(0, limit));
}
