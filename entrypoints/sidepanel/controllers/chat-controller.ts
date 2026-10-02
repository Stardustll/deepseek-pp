import {
  DEFAULT_OFFICIAL_API_CHAT_CONFIG,
  normalizeOfficialApiChatConfig,
  type OfficialApiChatConfig,
} from '../../../core/chat/official-api-config';
import type { DeepSeekUploadedFile } from '../../../core/deepseek/contracts';
import type {
  DeepSeekConversationMessage,
  DeepSeekConversationSummary,
} from '../../../core/messaging/deepseek-runtime-contracts';
import type { ModelType } from '../../../core/types';
import {
  DEFAULT_VOICE_SETTINGS,
  normalizeVoiceSettings,
  type VoiceSettings,
} from '../../../core/voice/settings';
import {
  sidepanelRuntimeClient,
  type SidepanelRuntimeClient,
} from '../runtime-client';

export type ChatProvider = 'official-api' | 'deepseek-web' | null;

export interface ChatAuthStatus {
  available: boolean;
  provider: ChatProvider;
  hasApiKey: boolean;
  hasToken: boolean;
}

export interface ChatRuntimeSnapshot {
  authStatus: ChatAuthStatus;
  chatConfig: OfficialApiChatConfig;
  webModelType: ModelType;
  voiceSettings: VoiceSettings;
  loadErrors: readonly unknown[];
}

export interface ChatProviderCapabilities {
  apiControlsEnabled: boolean;
  webControlsEnabled: boolean;
  visionAttachmentsEnabled: boolean;
}

export interface ChatController {
  load(): Promise<ChatRuntimeSnapshot>;
  saveConfig(config: OfficialApiChatConfig): Promise<OfficialApiChatConfig>;
  submitPrompt(options: {
    text: string;
    authStatus: ChatAuthStatus | null;
    config: OfficialApiChatConfig;
    refFileIds: string[];
    /** Per-turn web-chat mode intent; omitted means "use the persisted setting". */
    thinkingEnabled?: boolean;
    searchEnabled?: boolean;
  }): Promise<void>;
  newSession(): Promise<void>;
  /** One bounded page of the signed-in account's conversations (references only). */
  listConversations(): Promise<DeepSeekConversationSummary[]>;
  /** Read one conversation's messages so the sidepanel can render real history. */
  loadConversationMessages(conversationId: string): Promise<DeepSeekConversationMessage[]>;
  setWebModelType(modelType: ModelType): Promise<void>;
  uploadImage(payload: {
    dataUrl: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }): Promise<DeepSeekUploadedFile>;
}

export function createChatController(
  runtimeClient: SidepanelRuntimeClient = sidepanelRuntimeClient,
): ChatController {
  const controller: ChatController = {
    async load() {
      const loadErrors: unknown[] = [];
      const [authStatus, chatConfig, webModelType, voiceSettings] = await Promise.all([
        loadOrReport(
          runtimeClient.request(
            { type: 'GET_AUTH_STATUS' },
            { decode: normalizeChatAuthStatus },
          ),
          { available: false, provider: null, hasApiKey: false, hasToken: false },
          loadErrors,
        ),
        loadOrReport(
          runtimeClient.request(
            { type: 'GET_OFFICIAL_API_CHAT_CONFIG' },
            { decode: normalizeOfficialApiChatConfig },
          ),
          DEFAULT_OFFICIAL_API_CHAT_CONFIG,
          loadErrors,
        ),
        loadOrReport(
          runtimeClient.request(
            { type: 'GET_MODEL_TYPE' },
            { decode: normalizeChatWebModelType },
          ),
          null,
          loadErrors,
        ),
        loadOrReport(
          runtimeClient.request(
            { type: 'GET_VOICE_SETTINGS' },
            { decode: normalizeVoiceSettings },
          ),
          DEFAULT_VOICE_SETTINGS,
          loadErrors,
        ),
      ]);
      return { authStatus, chatConfig, webModelType, voiceSettings, loadErrors };
    },
    saveConfig: (config) => runtimeClient.request(
      { type: 'SAVE_OFFICIAL_API_CHAT_CONFIG', payload: config },
      { decode: normalizeOfficialApiChatConfig },
    ),
    async submitPrompt({ text, authStatus, config, refFileIds, thinkingEnabled, searchEnabled }) {
      const capabilities = getChatProviderCapabilities(authStatus, null);
      await runtimeClient.request(
        {
          type: 'CHAT_SUBMIT_PROMPT',
          payload: {
            text,
            ...(capabilities.apiControlsEnabled ? { config } : {}),
            ...(capabilities.webControlsEnabled && refFileIds.length > 0 ? { refFileIds } : {}),
            // Only the web path consumes these; the codec accepts them as
            // optional so this stays additive.
            ...(capabilities.webControlsEnabled && thinkingEnabled !== undefined
              ? { thinkingEnabled }
              : {}),
            ...(capabilities.webControlsEnabled && searchEnabled !== undefined
              ? { searchEnabled }
              : {}),
          },
        },
        { decode: decodeAck },
      );
    },
    async newSession() {
      await runtimeClient.request(
        { type: 'CHAT_NEW_SESSION' },
        { decode: decodeAck },
      );
    },
    listConversations: () => runtimeClient.request(
      { type: 'LIST_DEEPSEEK_CONVERSATIONS' },
      { decode: decodeConversationListResponse },
    ),
    loadConversationMessages: (conversationId) => runtimeClient.request(
      { type: 'GET_DEEPSEEK_CONVERSATION_MESSAGES', payload: { conversationId } },
      { decode: decodeConversationMessagesResponse },
    ),
    async setWebModelType(modelType) {
      await runtimeClient.request(
        { type: 'SET_MODEL_TYPE', payload: modelType },
        { decode: decodeAck },
      );
    },
    uploadImage: (payload) => runtimeClient.request(
      { type: 'UPLOAD_DEEPSEEK_IMAGE', payload },
      { decode: decodeImageUploadResponse },
    ),
  };
  return Object.freeze(controller);
}

export const chatController = createChatController();

async function loadOrReport<T>(
  operation: Promise<T>,
  fallback: T,
  errors: unknown[],
): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    errors.push(error);
    return fallback;
  }
}

export function normalizeChatAuthStatus(value: unknown): ChatAuthStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid GET_AUTH_STATUS response.');
  }
  const response = value as Record<string, unknown>;
  const provider = response.provider;
  if (provider !== undefined
    && provider !== null
    && provider !== 'official-api'
    && provider !== 'deepseek-web') {
    throw new Error('GET_AUTH_STATUS response.provider is invalid.');
  }
  const hasToken = response.hasToken === true;
  return {
    available: typeof response.available === 'boolean' ? response.available : hasToken,
    provider: provider === 'official-api' || provider === 'deepseek-web'
      ? provider
      : hasToken ? 'deepseek-web' : null,
    hasApiKey: response.hasApiKey === true,
    hasToken,
  };
}

export function normalizeChatWebModelType(value: unknown): ModelType {
  return value === 'expert' || value === 'vision' ? value : null;
}

export function getChatProviderCapabilities(
  authStatus: ChatAuthStatus | null,
  modelType: ModelType = null,
): ChatProviderCapabilities {
  const apiControlsEnabled = authStatus?.provider === 'official-api';
  const webControlsEnabled = authStatus?.provider === 'deepseek-web';
  return {
    apiControlsEnabled,
    webControlsEnabled,
    // The page merged its fast/expert/image modes into one model that always
    // understands images, and references ride on `ref_file_ids` for every request, so
    // attachment support now follows the web provider itself instead of a
    // (no longer selectable) `vision` mode.
    visionAttachmentsEnabled: webControlsEnabled,
  };
}

function decodeConversationListResponse(value: unknown): DeepSeekConversationSummary[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid LIST_DEEPSEEK_CONVERSATIONS response.');
  }
  const response = value as Record<string, unknown>;
  if (response.ok !== true) {
    throw new Error(
      typeof response.error === 'string' && response.error
        ? response.error
        : 'Invalid LIST_DEEPSEEK_CONVERSATIONS response.',
    );
  }
  if (!Array.isArray(response.conversations)) {
    throw new Error('LIST_DEEPSEEK_CONVERSATIONS response.conversations is missing.');
  }
  return response.conversations.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`LIST_DEEPSEEK_CONVERSATIONS response.conversations[${index}] is invalid.`);
    }
    const conversation = entry as Record<string, unknown>;
    if (typeof conversation.id !== 'string' || !conversation.id) {
      throw new Error(`LIST_DEEPSEEK_CONVERSATIONS response.conversations[${index}].id is missing.`);
    }
    return {
      id: conversation.id,
      title: typeof conversation.title === 'string' ? conversation.title : '',
      pinned: conversation.pinned === true,
      updatedAt: typeof conversation.updatedAt === 'string' ? conversation.updatedAt : null,
    };
  });
}

function decodeConversationMessagesResponse(value: unknown): DeepSeekConversationMessage[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid GET_DEEPSEEK_CONVERSATION_MESSAGES response.');
  }
  const response = value as Record<string, unknown>;
  if (response.ok !== true) {
    throw new Error(
      typeof response.error === 'string' && response.error
        ? response.error
        : 'Invalid GET_DEEPSEEK_CONVERSATION_MESSAGES response.',
    );
  }
  if (!Array.isArray(response.messages)) {
    throw new Error('GET_DEEPSEEK_CONVERSATION_MESSAGES response.messages is missing.');
  }
  return response.messages.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`GET_DEEPSEEK_CONVERSATION_MESSAGES response.messages[${index}] is invalid.`);
    }
    const message = entry as Record<string, unknown>;
    if (message.role !== 'user' && message.role !== 'assistant') {
      throw new Error(`GET_DEEPSEEK_CONVERSATION_MESSAGES response.messages[${index}].role is invalid.`);
    }
    return {
      role: message.role,
      text: typeof message.text === 'string' ? message.text : '',
      reasoning: typeof message.reasoning === 'string' && message.reasoning ? message.reasoning : null,
    };
  });
}

function decodeAck(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (value as { ok?: unknown }).ok !== true) {
    throw new Error('Invalid chat runtime acknowledgement.');
  }
}

function decodeImageUploadResponse(value: unknown): DeepSeekUploadedFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid UPLOAD_DEEPSEEK_IMAGE response.');
  }
  const response = value as Record<string, unknown>;
  if (response.ok !== true || !response.file || typeof response.file !== 'object') {
    throw new Error('Invalid UPLOAD_DEEPSEEK_IMAGE response.');
  }
  const file = response.file as Record<string, unknown>;
  if (typeof file.id !== 'string' || file.id.length === 0) {
    throw new Error('UPLOAD_DEEPSEEK_IMAGE response.file.id is missing.');
  }
  return response.file as DeepSeekUploadedFile;
}
