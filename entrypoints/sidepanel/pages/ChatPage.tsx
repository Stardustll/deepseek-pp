import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import {
  DEFAULT_OFFICIAL_API_CHAT_CONFIG,
  normalizeOfficialApiChatConfig,
  type OfficialApiChatConfig,
  type OfficialDeepSeekModel,
  type OfficialDeepSeekReasoningEffort,
  type OfficialDeepSeekThinkingMode,
} from '../../../core/chat/official-api-config';
import {
  DEFAULT_VOICE_SETTINGS,
  detectVoiceCapabilities,
  normalizeVoiceSettings,
  type VoiceSettings,
} from '../../../core/voice/settings';
import {
  FALLBACK_DEEPSEEK_UPLOAD_LIMITS,
  buildUploadAcceptAttribute,
  effectiveUploadMaxBytes,
  isUploadExtensionAccepted,
  resolveUploadFilename,
  type ResolvedDeepSeekUploadLimits,
} from '../../../core/deepseek/upload-limits';
import { readDeepSeekUploadLimits } from '../../../core/deepseek/upload-limits-storage';
import { parseAtTrigger } from '../../../core/trusted-directory/at-panel';
import { normalizeImageMimeType } from '../../../core/trusted-directory/scan';
import {
  DEFAULT_WEB_CHAT_OPTIONS,
  getWebChatOptions,
  normalizeWebChatOptions,
  saveWebChatOptions,
  type WebChatOptions,
} from '../../../core/chat/web-chat-options';
import {
  clearChatRecords,
  deleteChatRecord,
  getChatRecordState,
  saveChatRecord,
  type ChatRecordState,
  type StoredChatMessage,
} from '../../../core/chat/session-records';
import type { ChatMessage as ChatMessageType, ModelType } from '../../../core/types';
import AtFilePanel, { type AtAttachmentStatus } from '../components/AtFilePanel';
import ChatMessage from '../components/ChatMessage';
import { StatusMessage, useConfirm } from '../components/settings/feedback-primitives';
import { createRequestGenerationFence } from '../async-state';
import { shouldSubmitChatComposer } from '../chat-composer';
import {
  chatController,
  getChatProviderCapabilities,
  normalizeChatAuthStatus,
  type ChatAuthStatus,
  type ChatProvider,
} from '../controllers/chat-controller';
import { consumePendingText, onPendingText } from '../pending-text';
import { useI18n } from '../i18n';
import { getTrustedDirectorySession, type TrustedDirectorySession, type TrustedDirectorySessionFile } from '../trusted-directory';
import { getRuntimeErrorMessage } from '../runtime-response';

interface ChatStreamMessage extends Partial<ChatAuthStatus> {
  type: string;
  text?: string;
  reasoningText?: string;
  voiceSettings?: VoiceSettings;
  phase?: 'reasoning' | 'answer';
  done?: boolean;
  error?: string;
}

type VisionImageUploadStatus = 'uploading' | 'ready' | 'error';

interface VisionImageAttachment {
  id: string;
  fileId: string | null;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Object URL for image previews; null for non-image files. */
  previewUrl: string | null;
  status: VisionImageUploadStatus;
  error: string | null;
  /** Trusted-directory root-relative path when added via the @ panel. */
  sourcePath: string | null;
}

const MAX_VISION_IMAGE_ATTACHMENTS = 4;

/**
 * Chat target for a sidepanel-owned session (no bound conversation). Kept in
 * sessionStorage so a reload lands on the same local record, while a brand new
 * sidepanel instance starts a fresh transcript.
 */
const LOCAL_CHAT_TARGET_STORAGE_KEY = 'deepseek-pp.local-chat-target';

function resolveLocalChatTargetId(): string {
  try {
    const existing = window.sessionStorage.getItem(LOCAL_CHAT_TARGET_STORAGE_KEY);
    if (existing) return existing;
    const created = `local-${crypto.randomUUID?.() ?? String(Date.now())}`;
    window.sessionStorage.setItem(LOCAL_CHAT_TARGET_STORAGE_KEY, created);
    return created;
  } catch {
    return `local-${String(Date.now())}`;
  }
}

/**
 * Conservative limits in effect until the page's own config resolves. Using the
 * released image-only values keeps the picker usable immediately and makes a
 * slow or failed config read fall back rather than block uploads outright.
 */
const FALLBACK_RESOLVED_UPLOAD_LIMITS: ResolvedDeepSeekUploadLimits = {
  limits: FALLBACK_DEEPSEEK_UPLOAD_LIMITS,
  source: 'fallback',
  fallbackReason: 'page limits not read yet',
};

const MODEL_OPTIONS: Array<{ value: OfficialDeepSeekModel; labelKey: 'sidepanel.chatPage.modelFlash' | 'sidepanel.chatPage.modelPro' }> = [
  { value: 'deepseek-v4-flash', labelKey: 'sidepanel.chatPage.modelFlash' },
  { value: 'deepseek-v4-pro', labelKey: 'sidepanel.chatPage.modelPro' },
];

const EFFORT_OPTIONS: Array<{ value: OfficialDeepSeekReasoningEffort; labelKey: 'sidepanel.chatPage.effortHigh' | 'sidepanel.chatPage.effortMax' }> = [
  { value: 'high', labelKey: 'sidepanel.chatPage.effortHigh' },
  { value: 'max', labelKey: 'sidepanel.chatPage.effortMax' },
];

export default function ChatPage() {
  const { t } = useI18n();
  const [messages, setMessages] = useState<ChatMessageType[]>([]);
  const [inputText, setInputText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [authStatus, setAuthStatus] = useState<ChatAuthStatus | null>(null);
  const [chatConfig, setChatConfig] = useState<OfficialApiChatConfig>(DEFAULT_OFFICIAL_API_CHAT_CONFIG);
  const [error, setError] = useState<string | null>(null);
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>(DEFAULT_VOICE_SETTINGS);
  const [isListening, setIsListening] = useState(false);
  const [imageAttachments, setImageAttachments] = useState<VisionImageAttachment[]>([]);
  const [trustedSession] = useState<TrustedDirectorySession | null>(() => getTrustedDirectorySession());
  const [atTrigger, setAtTrigger] = useState<{ active: boolean; query: string }>({ active: false, query: '' });
  const [msgSeq, setMsgSeq] = useState(0);
  const [uploadLimits, setUploadLimits] = useState<ResolvedDeepSeekUploadLimits>(FALLBACK_RESOLVED_UPLOAD_LIMITS);
  const [webChatOptions, setWebChatOptions] = useState<WebChatOptions>(DEFAULT_WEB_CHAT_OPTIONS);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const modeMenuRef = useRef<HTMLDivElement | null>(null);
  const [restoringTranscript, setRestoringTranscript] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRecords, setHistoryRecords] = useState<ChatRecordState['records']>({});
  const [historyError, setHistoryError] = useState<string | null>(null);
  // The target the transcript currently on screen belongs to. Needed so the
  // history panel can tell "this is the open one" from "a different one".
  const localTargetIdRef = useRef<string>(resolveLocalChatTargetId());
  const recordStartedAtRef = useRef<number>(Date.now());
  const [activeTargetId, setActiveTargetId] = useState<string>(() => localTargetIdRef.current);
  const { confirm, node: confirmNode } = useConfirm();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<ChatMessageType[]>([]);
  const imageAttachmentsRef = useRef<VisionImageAttachment[]>([]);
  const uploadLimitsRef = useRef<ResolvedDeepSeekUploadLimits>(FALLBACK_RESOLVED_UPLOAD_LIMITS);
  const webChatOptionsRef = useRef<WebChatOptions>(DEFAULT_WEB_CHAT_OPTIONS);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceSettingsRef = useRef<VoiceSettings>(DEFAULT_VOICE_SETTINGS);
  const requestFence = useRef(createRequestGenerationFence());
  const voiceCapabilities = detectVoiceCapabilities(window);

  const {
    apiControlsEnabled,
    webControlsEnabled,
    visionAttachmentsEnabled,
  } = getChatProviderCapabilities(authStatus);
  const hasUploadingImageAttachment = imageAttachments.some((item) => item.status === 'uploading');
  const hasFailedImageAttachment = imageAttachments.some((item) => item.status === 'error');
  const readyImageFileIds = visionAttachmentsEnabled
    ? imageAttachments
      .filter((item) => item.status === 'ready' && item.fileId)
      .map((item) => item.fileId as string)
    : [];
  const atStatusByPath = useMemo(() => {
    const map = new Map<string, AtAttachmentStatus>();
    for (const attachment of imageAttachments) {
      if (attachment.sourcePath) map.set(attachment.sourcePath, attachment.status);
    }
    return map;
  }, [imageAttachments]);
  const uploadAcceptAttribute = buildUploadAcceptAttribute(uploadLimits.limits);
  // Newest conversation first, ordered by when each one started.
  const historyEntries = useMemo(
    () => Object.values(historyRecords).sort((a, b) => b.createdAt - a.createdAt),
    [historyRecords],
  );
  const canSendMessage = !isStreaming && !hasUploadingImageAttachment && !hasFailedImageAttachment && !!inputText.trim();

  const scrollMessagesToBottom = useCallback(() => {
    const messageList = listRef.current;
    if (messageList) messageList.scrollTop = messageList.scrollHeight;
  }, []);

  function updateLastAssistant(update: (message: ChatMessageType) => ChatMessageType) {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant') {
        const next = [...prev.slice(0, -1), update(last)];
        messagesRef.current = next;
        return next;
      }
      const next = [...prev, update({ role: 'assistant', text: '' })];
      messagesRef.current = next;
      return next;
    });
  }

  function appendAssistantText(text: string) {
    updateLastAssistant((message) => ({
      ...message,
      text: message.text + text,
    }));
  }

  function appendAssistantReasoning(reasoningText: string) {
    updateLastAssistant((message) => ({
      ...message,
      reasoningText: `${message.reasoningText ?? ''}${reasoningText}`,
    }));
  }

  useEffect(() => {
    const text = consumePendingText();
    if (text) {
      setInputText(text);
      inputRef.current?.focus();
    }
    return onPendingText((pendingText) => {
      setInputText(pendingText);
      inputRef.current?.focus();
    });
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    imageAttachmentsRef.current = imageAttachments;
  }, [imageAttachments]);

  useEffect(() => {
    uploadLimitsRef.current = uploadLimits;
  }, [uploadLimits]);

  useEffect(() => {
    webChatOptionsRef.current = webChatOptions;
  }, [webChatOptions]);

  useEffect(() => {
    // Shared with the background (which reads the same key when a turn omits the
    // per-turn flags), and mirrored across sidepanel instances by storage events.
    let cancelled = false;
    void getWebChatOptions().then((options) => {
      if (!cancelled) setWebChatOptions(options);
    }).catch((loadError) => {
      if (!cancelled) setError(getRuntimeErrorMessage(loadError));
    });
    const handler = (changes: Record<string, chrome.storage.StorageChange>) => {
      if ('deepseek_pp_web_chat_options' in changes) {
        setWebChatOptions(normalizeWebChatOptions(changes.deepseek_pp_web_chat_options.newValue));
      }
    };
    chrome.storage.onChanged.addListener(handler);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(handler);
    };
  }, []);

  useEffect(() => {
    // The page's own limits arrive through the extension cache, refreshed on the
    // same tab round trip as client headers. Until they resolve, the picker uses
    // the conservative fallback accept list and uploads are blocked.
    let cancelled = false;
    void readDeepSeekUploadLimits().then((resolved) => {
      if (cancelled) return;
      setUploadLimits(resolved);
      if (resolved.source === 'fallback' && resolved.fallbackReason) {
        console.warn('[DeepSeek++] using fallback upload limits:', resolved.fallbackReason);
      }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => () => {
    imageAttachmentsRef.current.forEach(revokeVisionAttachmentPreview);
  }, []);

  useEffect(() => {
    voiceSettingsRef.current = voiceSettings;
  }, [voiceSettings]);

  useEffect(() => {
    const generation = requestFence.current.begin();
    void chatController.load()
      .then((snapshot) => {
        if (!requestFence.current.isCurrent(generation)) return;
        setAuthStatus(snapshot.authStatus);
        setChatConfig(snapshot.chatConfig);
        setVoiceSettings(snapshot.voiceSettings);
        if (snapshot.loadErrors.length > 0) {
          setError(snapshot.loadErrors.map(getRuntimeErrorMessage).join('; '));
        }
      })
      .catch((loadError) => {
        if (requestFence.current.isCurrent(generation)) {
          setError(getRuntimeErrorMessage(loadError));
        }
      });
    return () => requestFence.current.invalidate();
  }, []);

  useEffect(() => {
    const handler = (msg: ChatStreamMessage) => {
      if (msg.type === 'CHAT_SET_INPUT_TEXT' && typeof msg.text === 'string') {
        updateInputText(msg.text);
        inputRef.current?.focus();
        return;
      }

      if (msg.type === 'AUTH_STATUS_CHANGED') {
        const nextAuthStatus = normalizeChatAuthStatus(msg);
        setAuthStatus(nextAuthStatus);
        if (nextAuthStatus.provider !== 'deepseek-web') clearImageAttachments();
        return;
      }


      if (msg.type === 'VOICE_SETTINGS_UPDATED') {
        setVoiceSettings(normalizeVoiceSettings(msg.voiceSettings));
        return;
      }

      if (msg.type !== 'CHAT_STREAM_CHUNK') return;

      if (msg.error) {
        setError(msg.error);
        setIsStreaming(false);
        // Retain the turn even though it failed: the user's message is already
        // in the transcript, and dropping it on reload would lose what they
        // typed along with the error context.
        persistTranscript(messagesRef.current);
        return;
      }

      if (msg.done) {
        setIsStreaming(false);
        clearImageAttachments();
        // Retain the finished turn locally so a reload does not lose it.
        persistTranscript(messagesRef.current);
        const currentVoiceSettings = voiceSettingsRef.current;
        if (currentVoiceSettings.readAloudEnabled && voiceCapabilities.speechSynthesis) {
          setTimeout(() => speakLatestAssistant(messagesRef.current, currentVoiceSettings), 0);
        }
        return;
      }

      if (msg.reasoningText) {
        appendAssistantReasoning(msg.reasoningText);
      }

      if (msg.text) {
        appendAssistantText(msg.text);
      }
    };

    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  useEffect(() => {
    scrollMessagesToBottom();
  }, [messages, scrollMessagesToBottom]);

  /**
   * Dismisses the mode popover on an outside pointer press or Escape.
   *
   * Listeners only exist while the menu is open, and pointerdown (not click) is
   * used so the menu closes on press without also swallowing the press that a
   * following click would need.
   */
  useEffect(() => {
    if (!modeMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && modeMenuRef.current?.contains(target)) return;
      setModeMenuOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setModeMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [modeMenuOpen]);

  /**
   * Restores the locally retained transcript for this sidepanel's own session.
   *
   * Nothing is read from the DeepSeek account: the sidepanel only ever replays
   * what it stored itself, so no account conversation is ever driven on the
   * user's behalf.
   */
  useEffect(() => {
    if (!authStatus) return;
    let cancelled = false;

    // A restore that lands after the user already started typing or sent a turn
    // must not replace what is on screen.
    const superseded = () => cancelled || messagesRef.current.length > 0;

    const run = async () => {
      setRestoringTranscript(true);
      try {
        const state = await getChatRecordState();
        if (superseded()) return;
        // `sessionStorage` is cleared when the sidepanel document is destroyed,
        // so a close-then-reopen would otherwise land on a fresh local target and
        // silently drop the transcript that is still on disk.
        const stored = resolveRestorableLocalTarget(state, localTargetIdRef.current);
        const resolvedTarget = stored ?? localTargetIdRef.current;
        const record = state.records[resolvedTarget];
        if (superseded()) return;
        // Adopting the stored target means later writes and deletes address the
        // conversation actually on screen.
        localTargetIdRef.current = resolvedTarget;
        recordStartedAtRef.current = Date.now();
        setActiveTargetId(resolvedTarget);
        const restored: ChatMessageType[] = (record?.messages ?? []).map((message) => ({
          role: message.role,
          text: message.text,
          ...(message.reasoningText ? { reasoningText: message.reasoningText } : {}),
        }));
        messagesRef.current = restored;
        setMessages(restored);
      } catch (restoreError) {
        if (!cancelled) setError(getRuntimeErrorMessage(restoreError));
      } finally {
        if (!cancelled) setRestoringTranscript(false);
      }
    };

    void run();
    return () => { cancelled = true; };
  }, [authStatus]);

  // Best-effort retention for a reload that happens mid-conversation.
  useEffect(() => () => {
    persistTranscript(messagesRef.current);
  }, []);

  const saveChatConfig = async (patch: Partial<OfficialApiChatConfig>) => {
    const next = normalizeOfficialApiChatConfig({ ...chatConfig, ...patch });
    setChatConfig(next);
    try {
      setChatConfig(await chatController.saveConfig(next));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const sendMessage = () => {
    const text = inputText.trim();
    if (!text || !canSendMessage) return;
    const refFileIds = readyImageFileIds;
    setAtTrigger({ active: false, query: '' });

    setMessages((prev) => {
      const next = [...prev, { role: 'user' as const, text }];
      messagesRef.current = next;
      return next;
    });
    setMsgSeq((n) => n + 1);
    setInputText('');
    setIsStreaming(true);
    setError(null);

    void chatController.submitPrompt({
      text,
      authStatus,
      config: chatConfig,
      refFileIds,
      thinkingEnabled: webChatOptionsRef.current.thinkingEnabled,
      searchEnabled: webChatOptionsRef.current.searchEnabled,
    }).catch((submitError) => {
      setError(getRuntimeErrorMessage(submitError) || t('sidepanel.chatPage.sendFailed'));
      setIsStreaming(false);
    });
  };

  const newSession = async () => {
    // Confirm before discarding an in-progress conversation.
    if (messages.length > 0) {
      const ok = await confirm({
        title: t('sidepanel.chatPage.newSessionTitle'),
        message: t('sidepanel.chatPage.newSessionConfirm'),
        confirmLabel: t('sidepanel.chatPage.newSession'),
        cancelLabel: t('common.cancel'),
      });
      if (!ok) return;
    }
    // Retain the transcript we are leaving behind under its own target.
    persistTranscript(messagesRef.current);
    try {
      await chatController.newSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    // A fresh local target so the new conversation gets its own record.
    localTargetIdRef.current = `local-${crypto.randomUUID?.() ?? String(Date.now())}`;
    try {
      window.sessionStorage.setItem(LOCAL_CHAT_TARGET_STORAGE_KEY, localTargetIdRef.current);
    } catch {}
    resetLocalConversation();
  };

  /**
   * Clears the sidepanel transcript without touching the background session.
   * Switching the conversation target discards the transcript on purpose: those
   * messages belong to the previous target, and keeping them would misrepresent
   * what the next send continues from.
   */
  function resetLocalConversation() {
    messagesRef.current = [];
    setMessages([]);
    setError(null);
    setIsStreaming(false);
    setInputText('');
    setAtTrigger({ active: false, query: '' });
    clearImageAttachments();
    stopVoiceInput();
    inputRef.current?.focus();
  }

  const retryLast = () => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    updateInputText(lastUser.text);
    inputRef.current?.focus();
  };

  const handleModelChange = (model: OfficialDeepSeekModel) => {
    if (!apiControlsEnabled || isStreaming) return;
    void saveChatConfig({ model });
  };

  const handleThinkingChange = (thinking: OfficialDeepSeekThinkingMode) => {
    if (!apiControlsEnabled || isStreaming) return;
    void saveChatConfig({ thinking });
  };

  const handleEffortChange = (reasoningEffort: OfficialDeepSeekReasoningEffort) => {
    if (!apiControlsEnabled || isStreaming || chatConfig.thinking !== 'enabled') return;
    void saveChatConfig({ reasoningEffort });
  };

  /**
   * Which record the current transcript belongs to: the bound DeepSeek
   * conversation, or this sidepanel instance's own local session.
   */
  const currentTargetId = () => localTargetIdRef.current;

  const refreshHistoryRecords = async () => {
    setHistoryError(null);
    try {
      const state = await getChatRecordState();
      setHistoryRecords(state.records);
    } catch (historyLoadError) {
      setHistoryRecords({});
      setHistoryError(getRuntimeErrorMessage(historyLoadError));
    }
  };

  const toggleHistory = async () => {
    if (isStreaming) return;
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    setHistoryOpen(true);
    await refreshHistoryRecords();
  };

  /**
   * Switches the sidepanel to a retained conversation.
   *
   * The outgoing transcript is written first, then the target is swapped and the
   * restore effect (re-run via the target key) loads the selected one.
   */
  const openHistoryRecord = async (targetId: string) => {
    if (isStreaming) return;
    if (targetId === localTargetIdRef.current) {
      setHistoryOpen(false);
      return;
    }
    persistTranscript(messagesRef.current);
    localTargetIdRef.current = targetId;
    recordStartedAtRef.current = Date.now();
    try {
      window.sessionStorage.setItem(LOCAL_CHAT_TARGET_STORAGE_KEY, targetId);
    } catch {}
    setActiveTargetId(targetId);
    messagesRef.current = [];
    setMessages([]);
    setHistoryOpen(false);
  };

  const removeHistoryRecord = async (targetId: string) => {
    const ok = await confirm({
      title: t('sidepanel.chatPage.historyDeleteTitle'),
      message: t('sidepanel.chatPage.historyDeleteConfirm'),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    try {
      const state = await deleteChatRecord(targetId);
      setHistoryRecords(state.records);
    } catch (deleteError) {
      setHistoryError(getRuntimeErrorMessage(deleteError));
      return;
    }
    // Deleting the open conversation leaves nothing to show, so start a fresh
    // local target rather than keeping a transcript that no longer exists.
    if (targetId === localTargetIdRef.current) {
      localTargetIdRef.current = `local-${crypto.randomUUID?.() ?? String(Date.now())}`;
      try {
        window.sessionStorage.setItem(LOCAL_CHAT_TARGET_STORAGE_KEY, localTargetIdRef.current);
      } catch {}
      setActiveTargetId(localTargetIdRef.current);
      messagesRef.current = [];
      setMessages([]);
    }
  };

  const removeAllHistoryRecords = async () => {
    const ok = await confirm({
      title: t('sidepanel.chatPage.historyClearTitle'),
      message: t('sidepanel.chatPage.historyClearConfirm'),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    try {
      await clearChatRecords();
      setHistoryRecords({});
    } catch (clearError) {
      setHistoryError(getRuntimeErrorMessage(clearError));
      return;
    }
    localTargetIdRef.current = `local-${crypto.randomUUID?.() ?? String(Date.now())}`;
    try {
      window.sessionStorage.setItem(LOCAL_CHAT_TARGET_STORAGE_KEY, localTargetIdRef.current);
    } catch {}
    setActiveTargetId(localTargetIdRef.current);
    messagesRef.current = [];
    setMessages([]);
    setHistoryOpen(false);
  };

  const persistTranscript = (messagesToStore: readonly ChatMessageType[]) => {
    const stored: StoredChatMessage[] = messagesToStore
      .filter((message) => message.text || message.reasoningText)
      .map((message) => ({
        role: message.role,
        text: message.text,
        ...(message.reasoningText ? { reasoningText: message.reasoningText } : {}),
      }));
    void saveChatRecord({
      targetId: currentTargetId(),
      // Derived from the transcript so the history list has a label without a
      // second storage write.
      title: deriveRecordTitle(messagesToStore),
      messages: stored,
      createdAt: recordStartedAtRef.current,
      updatedAt: Date.now(),
    }).catch((storeError) => {
      console.error('[DeepSeek++] chat record save failed', storeError);
    });
  };

  const handleWebChatOptionChange = async (patch: Partial<WebChatOptions>) => {
    if (!webControlsEnabled || isStreaming) return;
    const previous = webChatOptionsRef.current;
    const optimistic = normalizeWebChatOptions({ ...previous, ...patch });
    setWebChatOptions(optimistic);
    try {
      setWebChatOptions(await saveWebChatOptions(patch));
    } catch (err) {
      setWebChatOptions(previous);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const chooseImageFile = () => {
    if (!visionAttachmentsEnabled || isStreaming) return;
    fileInputRef.current?.click();
  };

  const handleImageFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    void uploadImageFiles(files);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!visionAttachmentsEnabled || isStreaming) return;
    const files = collectClipboardFiles(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    void uploadImageFiles(files);
  };

  const uploadImageFiles = async (files: File[]) => {
    if (!visionAttachmentsEnabled || files.length === 0) return;
    const maxAttachments = Math.min(
      uploadLimitsRef.current.limits.maxFileCount,
      MAX_VISION_IMAGE_ATTACHMENTS,
    );
    const availableSlots = maxAttachments - imageAttachmentsRef.current.length;
    if (availableSlots <= 0) {
      setError(t('sidepanel.chatPage.imageUploadMax', { count: maxAttachments }));
      return;
    }

    const selectedFiles = files.slice(0, availableSlots);
    if (files.length > availableSlots) {
      setError(t('sidepanel.chatPage.imageUploadMax', { count: maxAttachments }));
    } else {
      setError(null);
    }

    for (const file of selectedFiles) {
      await uploadImageFile(file);
    }
  };

  const uploadImageFile = async (file: File, sourcePath: string | null = null) => {
    const activeLimits = uploadLimitsRef.current;
    // The OS picker reports an empty type for some images, so recover the MIME
    // from the extension before validating or sending it.
    const mimeType = normalizeImageMimeType(file.name, file.type);
    const validationError = validateAttachmentFile(file, activeLimits, t);
    if (validationError) {
      setError(validationError);
      return;
    }

    const attachmentId = createVisionAttachmentId();
    // Only images get a thumbnail; other file types render as a name row.
    const previewUrl = mimeType.startsWith('image/') ? URL.createObjectURL(file) : null;
    const baseAttachment: VisionImageAttachment = {
      id: attachmentId,
      fileId: null,
      name: file.name,
      mimeType,
      sizeBytes: file.size,
      previewUrl,
      status: 'uploading',
      error: null,
      sourcePath,
    };

    setImageAttachments((prev) => [...prev, baseAttachment]);

    try {
      const dataUrl = await readFileAsDataUrl(file);
      const uploaded = await chatController.uploadImage({
        dataUrl,
        name: resolveUploadFilename(file.name, mimeType),
        mimeType,
        sizeBytes: file.size,
      });
      const fileId = uploaded.id;

      setImageAttachments((prev) => prev.map((item) => (
        item.id === attachmentId
          ? {
            ...item,
            fileId,
            status: 'ready',
            error: null,
          }
          : item
      )));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setImageAttachments((prev) => prev.map((item) => (
        item.id === attachmentId
          ? { ...item, status: 'error', error: message }
          : item
      )));
      if (imageAttachmentsRef.current.some((item) => item.id === attachmentId)) {
        setError(message);
      }
    }
  };

  const toggleAtFile = (file: TrustedDirectorySessionFile) => {
    if (!visionAttachmentsEnabled || isStreaming || file.kind !== 'image') return;
    const existing = atStatusByPath.get(file.relativePath);
    if (existing) {
      const attachment = imageAttachmentsRef.current.find((item) => item.sourcePath === file.relativePath);
      if (attachment) removeImageAttachment(attachment.id);
      return;
    }
    if (imageAttachmentsRef.current.length >= uploadLimitsRef.current.limits.maxFileCount) {
      setError(t('sidepanel.chatPage.imageUploadMax', {
        count: uploadLimitsRef.current.limits.maxFileCount,
      }));
      return;
    }
    void uploadImageFile(file.file, file.relativePath);
  };

  const removeImageAttachment = (attachmentId: string) => {
    setImageAttachments((prev) => {
      const removed = prev.find((item) => item.id === attachmentId);
      if (removed) revokeVisionAttachmentPreview(removed);
      return prev.filter((item) => item.id !== attachmentId);
    });
  };

  const clearImageAttachments = () => {
    setImageAttachments((prev) => {
      prev.forEach(revokeVisionAttachmentPreview);
      return [];
    });
  };

  const startVoiceInput = () => {
    const Recognition = getSpeechRecognitionConstructor();
    if (!Recognition || isListening) return;

    const recognition = new Recognition();
    recognition.lang = navigator.language || 'zh-CN';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results as ArrayLike<SpeechRecognitionResultLike>)
        .map((result) => result[0]?.transcript ?? '')
        .join('')
        .trim();
      if (transcript) updateInputText(transcript);
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setIsListening(false);
    };
    recognition.onerror = () => {
      recognitionRef.current = null;
      setIsListening(false);
    };
    recognitionRef.current = recognition;
    setIsListening(true);
    recognition.start();
  };

  const stopVoiceInput = () => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setIsListening(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' && atTrigger.active) {
      e.preventDefault();
      setAtTrigger({ active: false, query: '' });
      return;
    }
    // Escape also dismisses an open mode popover. The composer keeps focus while
    // the popover is open (the trigger is a sibling button), so this is where the
    // key actually lands in that flow.
    if (e.key === 'Escape' && modeMenuOpen) {
      e.preventDefault();
      setModeMenuOpen(false);
      return;
    }
    if (shouldSubmitChatComposer({
      key: e.key,
      shiftKey: e.shiftKey,
      isComposing: e.nativeEvent.isComposing,
      keyCode: e.keyCode,
    })) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleInputChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInputText(value);
    setAtTrigger(parseAtTrigger(value));
  };

  const updateInputText = (value: string) => {
    setInputText(value);
    setAtTrigger(parseAtTrigger(value));
  };

  if (authStatus?.available === false) {
    return (
      <div className="ds-chat-auth-empty">
        <p className="text-sm mb-3" style={{ color: 'var(--ds-text-secondary)' }}>
          {t('sidepanel.chatPage.authRequired')}
        </p>
        <p className="text-xs" style={{ color: 'var(--ds-text-tertiary)' }}>
          {t('sidepanel.chatPage.authHint')}
        </p>
      </div>
    );
  }

  return (
    <div className="ds-chat-page">
      <header className="ds-chat-header">
        <div className="ds-chat-header-top">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold" style={{ color: 'var(--ds-text)' }}>
                {t('sidepanel.chatPage.title')}
              </span>
              <ProviderBadge provider={authStatus?.provider ?? null} />
            </div>
            <p className="ds-chat-subtitle">
              {apiControlsEnabled
                ? t('sidepanel.chatPage.apiDescription')
                : t('sidepanel.chatPage.webDescription')}
            </p>
          </div>

          <div className="ds-chat-header-actions">
            {voiceSettings.readAloudEnabled && voiceCapabilities.speechSynthesis && (
              <button
                type="button"
                onClick={() => speakLatestAssistant(messagesRef.current, voiceSettings)}
                className="ds-chat-text-button"
                title={t('sidepanel.chatPage.readLatest')}
              >
                {t('sidepanel.chatPage.read')}
              </button>
            )}
            <button
              type="button"
              onClick={newSession}
              className="ds-chat-icon-button"
              title={t('sidepanel.chatPage.newSessionTitle')}
              aria-label={t('sidepanel.chatPage.newSessionTitle')}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
        </div>

        {apiControlsEnabled && (
          <div className="ds-chat-config-panel">
            <div className="ds-chat-control-group" aria-label={t('sidepanel.chatPage.modelLabel')}>
              {MODEL_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  disabled={isStreaming}
                  onClick={() => handleModelChange(option.value)}
                  className={`ds-chat-segment${chatConfig.model === option.value ? ' ds-chat-segment-active' : ''}`}
                >
                  {t(option.labelKey)}
                </button>
              ))}
            </div>

            <div className="ds-chat-control-row">
              <div className="ds-chat-control-group" aria-label={t('sidepanel.chatPage.thinkingLabel')}>
                <button
                  type="button"
                  disabled={isStreaming}
                  onClick={() => handleThinkingChange('disabled')}
                  className={`ds-chat-segment${chatConfig.thinking === 'disabled' ? ' ds-chat-segment-active' : ''}`}
                >
                  {t('sidepanel.chatPage.thinkingOff')}
                </button>
                <button
                  type="button"
                  disabled={isStreaming}
                  onClick={() => handleThinkingChange('enabled')}
                  className={`ds-chat-segment${chatConfig.thinking === 'enabled' ? ' ds-chat-segment-active' : ''}`}
                >
                  {t('sidepanel.chatPage.thinkingOn')}
                </button>
              </div>

              <select
                value={chatConfig.reasoningEffort}
                disabled={isStreaming || chatConfig.thinking !== 'enabled'}
                onChange={(e) => handleEffortChange(e.target.value as OfficialDeepSeekReasoningEffort)}
                className="ds-chat-effort-select"
                title={t('sidepanel.chatPage.effortLabel')}
                aria-label={t('sidepanel.chatPage.effortLabel')}
              >
                {EFFORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

      </header>

      <div ref={listRef} className="ds-chat-messages">
        {confirmNode}

        {restoringTranscript && messages.length === 0 && (
          <div className="ds-chat-restoring">{t('common.loading')}</div>
        )}

        {messages.length === 0 && !isStreaming && !restoringTranscript && (
          <div className="ds-chat-empty">
            <div className="ds-empty-state-icon">
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
            </div>
            <div className="ds-empty-state-title">{t('sidepanel.chatPage.empty')}</div>
            <div className="ds-empty-state-description">{t('sidepanel.chatPage.emptyHelp')}</div>
          </div>
        )}

        {messages.map((msg, index) => (
          <ChatMessage
            key={`${msg.role}-${index}-${msgSeq}`}
            message={msg}
            isStreaming={isStreaming && index === messages.length - 1 && msg.role === 'assistant'}
            onRichContentRendered={scrollMessagesToBottom}
          />
        ))}

        {error && (
          <div className="ds-chat-error-wrap">
            <StatusMessage tone="error">
              {error}
              <button
                type="button"
                onClick={retryLast}
                className="ml-2 underline opacity-80 hover:opacity-100"
              >
                {t('common.retry')}
              </button>
            </StatusMessage>
          </div>
        )}
      </div>

      <footer className="ds-chat-composer-wrap">
        <div className="ds-chat-composer">
          <input
            ref={fileInputRef}
            type="file"
            accept={uploadAcceptAttribute}
            multiple
            className="ds-chat-file-input"
            onChange={handleImageFileChange}
          />
          <AtFilePanel
            open={atTrigger.active && visionAttachmentsEnabled}
            query={atTrigger.query}
            session={trustedSession}
            statusByPath={atStatusByPath}
            onToggleFile={toggleAtFile}
            onClose={() => setAtTrigger({ active: false, query: '' })}
          />
          <textarea
            ref={inputRef}
            value={inputText}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={t('sidepanel.chatPage.inputPlaceholder')}
            rows={1}
            className="ds-chat-input"
          />
          {imageAttachments.length > 0 && (
            <div className="ds-chat-attachments" aria-label={t('sidepanel.chatPage.imageAttachments')}>
              {imageAttachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className={`ds-chat-attachment ds-chat-attachment-${attachment.status}`}
                >
                  {attachment.previewUrl
                    ? <img src={attachment.previewUrl} alt="" className="ds-chat-attachment-thumb" />
                    : <span className="ds-chat-attachment-thumb ds-chat-attachment-thumb-file" aria-hidden="true" />}
                  <div className="ds-chat-attachment-body">
                    <div className="ds-chat-attachment-name" title={attachment.name}>
                      {attachment.name}
                    </div>
                    <div className="ds-chat-attachment-status">
                      {attachment.error ?? getImageAttachmentStatusLabel(attachment.status, t)}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="ds-chat-attachment-remove"
                    onClick={() => removeImageAttachment(attachment.id)}
                    title={t('sidepanel.chatPage.removeImageAttachment', { name: attachment.name })}
                    aria-label={t('sidepanel.chatPage.removeImageAttachment', { name: attachment.name })}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="ds-chat-composer-actions">
            <div className="ds-chat-composer-lead">
              {webControlsEnabled && (
                <div className="ds-chat-mode-control" ref={modeMenuRef}>
                  <button
                    type="button"
                    disabled={isStreaming}
                    aria-expanded={modeMenuOpen}
                    aria-haspopup="true"
                    onClick={() => setModeMenuOpen((open) => !open)}
                    className={`ds-chat-mode-trigger${modeMenuOpen ? ' ds-chat-mode-trigger-open' : ''}`}
                    title={t('sidepanel.chatPage.webModeLabel')}
                    aria-label={t('sidepanel.chatPage.webModeLabel')}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10.34 4.32c.43-1.76 2.9-1.76 3.32 0a1.72 1.72 0 0 0 2.57 1.07c1.54-.94 3.31.83 2.37 2.37a1.72 1.72 0 0 0 1.07 2.57c1.76.43 1.76 2.9 0 3.32a1.72 1.72 0 0 0-1.07 2.57c.94 1.54-.83 3.31-2.37 2.37a1.72 1.72 0 0 0-2.57 1.07c-.43 1.76-2.9 1.76-3.32 0a1.72 1.72 0 0 0-2.57-1.07c-1.54.94-3.31-.83-2.37-2.37a1.72 1.72 0 0 0-1.07-2.57c-1.76-.43-1.76-2.9 0-3.32a1.72 1.72 0 0 0 1.07-2.57c-.94-1.54.83-3.31 2.37-2.37.99.6 2.29.07 2.57-1.07z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" />
                    </svg>
                  </button>
                  {modeMenuOpen && (
                    <div className="ds-chat-mode-menu" role="group" aria-label={t('sidepanel.chatPage.webModeLabel')}>
                      <button
                        type="button"
                        disabled={isStreaming}
                        aria-pressed={webChatOptions.thinkingEnabled}
                        onClick={() => void handleWebChatOptionChange({ thinkingEnabled: !webChatOptions.thinkingEnabled })}
                        className={`ds-toggle-button${webChatOptions.thinkingEnabled ? ' ds-toggle-button--selected' : ''}`}
                        title={t('sidepanel.chatPage.webThinkingHint')}
                      >
                        <span className="ds-toggle-button__icon">
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M8 1.6a4.4 4.4 0 0 0-2.6 7.95V11h5.2V9.55A4.4 4.4 0 0 0 8 1.6z" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6.2 13.2h3.6M7 14.8h2" />
                          </svg>
                        </span>
                        <span className="ds-toggle-button__label">{t('sidepanel.chatPage.thinkingOn')}</span>
                      </button>
                      <button
                        type="button"
                        disabled={isStreaming}
                        aria-pressed={webChatOptions.searchEnabled}
                        onClick={() => void handleWebChatOptionChange({ searchEnabled: !webChatOptions.searchEnabled })}
                        className={`ds-toggle-button${webChatOptions.searchEnabled ? ' ds-toggle-button--selected' : ''}`}
                        title={t('sidepanel.chatPage.webSearchHint')}
                      >
                        <span className="ds-toggle-button__icon">
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true">
                            <circle cx="8" cy="8" r="6.2" />
                            <path strokeLinecap="round" d="M1.8 8h12.4M8 1.8c1.6 1.7 2.4 3.9 2.4 6.2S9.6 12.5 8 14.2C6.4 12.5 5.6 10.3 5.6 8S6.4 3.5 8 1.8z" />
                          </svg>
                        </span>
                        <span className="ds-toggle-button__label">{t('sidepanel.chatPage.webSearchOn')}</span>
                      </button>
                    </div>
                  )}
                </div>
              )}
              <div className="ds-chat-history-control">
                <button
                  type="button"
                  disabled={isStreaming}
                  aria-expanded={historyOpen}
                  onClick={() => void toggleHistory()}
                  className={`ds-chat-mode-trigger${historyOpen ? ' ds-chat-mode-trigger-open' : ''}`}
                  title={t('sidepanel.chatPage.historyLabel')}
                  aria-label={t('sidepanel.chatPage.historyLabel')}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 7v5l3 2" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.05 11a9 9 0 1 0 2.4-6.1M3 4v4h4" />
                  </svg>
                </button>
                {historyOpen && (
                  <div className="ds-chat-history-panel" role="group" aria-label={t('sidepanel.chatPage.historyLabel')}>
                    {historyError && (
                      <div className="ds-chat-history-empty">
                        {t('sidepanel.chatPage.historyFailed', { error: historyError })}
                      </div>
                    )}
                    {!historyError && historyEntries.length === 0 && (
                      <>
                        <div className="ds-chat-history-empty">
                          {t('sidepanel.chatPage.historyEmpty')}
                        </div>
                        <div className="ds-chat-history-help">
                          {t('sidepanel.chatPage.historyEmptyHelp')}
                        </div>
                      </>
                    )}
                    {!historyError && historyEntries.length > 0 && (
                      <>
                        <div className="ds-chat-history-list">
                          {historyEntries.map((record) => {
                            const current = record.targetId === activeTargetId;
                            return (
                              <div
                                key={record.targetId}
                                className={`ds-chat-history-item${current ? ' ds-chat-history-item-current' : ''}`}
                              >
                                <button
                                  type="button"
                                  disabled={isStreaming}
                                  onClick={() => void openHistoryRecord(record.targetId)}
                                  className="ds-chat-history-open"
                                  title={record.title ?? record.targetId}
                                >
                                  <span className="ds-chat-history-title">
                                    {record.title ?? record.targetId}
                                  </span>
                                  <span className="ds-chat-history-meta">
                                    {t('sidepanel.chatPage.historyMessageCount', { count: record.messages.length })}
                                    {current ? ` · ${t('sidepanel.chatPage.historyCurrentBadge')}` : ''}
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void removeHistoryRecord(record.targetId)}
                                  className="ds-chat-history-delete"
                                  title={t('sidepanel.chatPage.historyDelete', { title: record.title ?? record.targetId })}
                                  aria-label={t('sidepanel.chatPage.historyDelete', { title: record.title ?? record.targetId })}
                                >
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 7h12M9 7V5h6v2M8 7l1 12h6l1-12" />
                                  </svg>
                                </button>
                              </div>
                            );
                          })}
                        </div>
                        <button
                          type="button"
                          onClick={() => void removeAllHistoryRecords()}
                          className="ds-chat-history-clear"
                        >
                          {t('sidepanel.chatPage.historyClear')}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
              <span className="ds-chat-current-config">
                {apiControlsEnabled
                  ? getConfigLabel(chatConfig, t)
                  : webControlsEnabled
                    ? getWebModelLabel(t)
                    : t('sidepanel.chatPage.webProvider')}
              </span>
            </div>
            <div className="ds-chat-composer-buttons">
              {visionAttachmentsEnabled && (
                <button
                  type="button"
                  onClick={chooseImageFile}
                  disabled={isStreaming || imageAttachments.length >= uploadLimits.limits.maxFileCount}
                  className="ds-chat-attachment-button"
                  title={t('sidepanel.chatPage.uploadImage')}
                  aria-label={t('sidepanel.chatPage.uploadImage')}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 7a3 3 0 013-3h10a3 3 0 013 3v10a3 3 0 01-3 3H7a3 3 0 01-3-3V7z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 14l2.3-2.3a1 1 0 011.4 0L15 15m-1-1 1.3-1.3a1 1 0 011.4 0L20 16M9 8.5h.01" />
                  </svg>
                </button>
              )}
              {voiceSettings.inputEnabled && voiceCapabilities.speechRecognition && (
                <button
                  type="button"
                  onClick={isListening ? stopVoiceInput : startVoiceInput}
                  className={`ds-chat-mic-button${isListening ? ' ds-chat-mic-button-active' : ''}`}
                  title={isListening ? t('sidepanel.chatPage.stopListening') : t('sidepanel.chatPage.voiceInput')}
                  aria-label={isListening ? t('sidepanel.chatPage.stopListening') : t('sidepanel.chatPage.voiceInput')}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4a3 3 0 00-3 3v5a3 3 0 006 0V7a3 3 0 00-3-3z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 11a7 7 0 0014 0M12 18v3m-4 0h8" />
                  </svg>
                </button>
              )}
              <button
                type="button"
                onClick={sendMessage}
                disabled={!canSendMessage}
                className="ds-chat-send-button"
                title={t('sidepanel.chatPage.send')}
                aria-label={t('sidepanel.chatPage.send')}
              >
                {isStreaming ? (
                  <span className="ds-chat-send-dots" aria-hidden="true">...</span>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5m0 0-6 6m6-6 6 6" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

function ProviderBadge({ provider }: { provider: ChatProvider }) {
  const { t } = useI18n();
  if (!provider) return null;
  const label = provider === 'official-api'
    ? t('sidepanel.chatPage.apiProvider')
    : t('sidepanel.chatPage.webProvider');
  return <span className="ds-chat-provider-badge">{label}</span>;
}

/**
 * Picks the local target to restore for an unbound sidepanel.
 *
 * Only a sidepanel-owned target qualifies: a record filed under a DeepSeek
 * conversation id belongs to a binding, and silently adopting it would show one
 * conversation's transcript while the sidepanel is actually posting to a new
 * one. Returns null when the stored pointer is not usable, in which case the
 * caller keeps its own fresh local target.
 */
function resolveRestorableLocalTarget(
  state: { records: Record<string, { messages: unknown[] }>; lastTargetId: string | null },
  currentTargetId: string,
): string | null {
  const lastTargetId = state.lastTargetId;
  if (!lastTargetId || lastTargetId === currentTargetId) return null;
  if (!lastTargetId.startsWith('local-')) return null;
  return state.records[lastTargetId] ? lastTargetId : null;
}

/**
 * A short label for a retained transcript: the first user message, trimmed.
 *
 * The history list needs something human-readable, and the first user turn is
 * the best available proxy for "what was this conversation about".
 */
function deriveRecordTitle(messages: readonly ChatMessageType[]): string | null {
  const firstUser = messages.find((message) => message.role === 'user' && message.text.trim());
  if (!firstUser) return null;
  const text = firstUser.text.replace(/\s+/g, ' ').trim();
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function getWebModelLabel(
  t: ReturnType<typeof useI18n>['t'],
): string {
  return t('sidepanel.settings.modelDefault');
}

function getConfigLabel(
  config: OfficialApiChatConfig,
  t: ReturnType<typeof useI18n>['t'],
): string {
  const model = config.model === 'deepseek-v4-pro'
    ? t('sidepanel.chatPage.modelPro')
    : t('sidepanel.chatPage.modelFlash');
  if (config.thinking !== 'enabled') {
    return `${model} · ${t('sidepanel.chatPage.thinkingOff')}`;
  }
  const effort = config.reasoningEffort === 'max'
    ? t('sidepanel.chatPage.effortMax')
    : t('sidepanel.chatPage.effortHigh');
  return `${model} · ${t('sidepanel.chatPage.thinkingOn')} · ${effort}`;
}

function getImageAttachmentStatusLabel(
  status: VisionImageUploadStatus,
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (status === 'uploading') return t('sidepanel.chatPage.imageUploading');
  if (status === 'ready') return t('sidepanel.chatPage.imageReady');
  return t('sidepanel.chatPage.imageUploadFailed');
}

function validateAttachmentFile(
  file: File,
  limits: ResolvedDeepSeekUploadLimits,
  t: ReturnType<typeof useI18n>['t'],
): string | null {
  if (file.size <= 0) {
    return t('sidepanel.chatPage.imageEmpty');
  }
  const maxBytes = effectiveUploadMaxBytes(limits.limits);
  if (file.size > maxBytes) {
    return t('sidepanel.chatPage.imageTooLarge', {
      limit: formatImageUploadBytes(maxBytes),
    });
  }
  if (!isUploadExtensionAccepted(resolveUploadFilename(file.name, file.type), limits.limits)) {
    return t('sidepanel.chatPage.imageOnly');
  }
  return null;
}

/** Clipboard entries are files the user copied; the page decides what to take. */
function collectClipboardFiles(data: DataTransfer): File[] {
  const files = Array.from(data.files);
  if (files.length > 0) return files;
  return Array.from(data.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }
      reject(new Error('FileReader did not return a data URL.'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image file.'));
    reader.readAsDataURL(file);
  });
}

function revokeVisionAttachmentPreview(attachment: VisionImageAttachment) {
  if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
}

function createVisionAttachmentId(): string {
  return crypto.randomUUID?.() ?? `vision-image-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatImageUploadBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

type SpeechRecognitionResultLike = {
  readonly 0: { transcript?: string };
};

type SpeechRecognitionEventLike = {
  results: Iterable<SpeechRecognitionResultLike> | ArrayLike<SpeechRecognitionResultLike>;
};

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  const value = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return value.SpeechRecognition ?? value.webkitSpeechRecognition ?? null;
}

function speakLatestAssistant(messages: ChatMessageType[], settings: VoiceSettings) {
  if (!('speechSynthesis' in window)) return;
  const text = [...messages].reverse().find((message) => message.role === 'assistant')?.text.trim();
  if (!text) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = settings.rate;
  utterance.pitch = settings.pitch;
  window.speechSynthesis.speak(utterance);
}
