import type { RuntimeMessageContext } from '../../core/messaging/runtime-boundary';
import type {
  NormalizedConversationExportCommand,
} from '../../core/messaging/deepseek-runtime-contracts';
import type { RuntimeCommandHandler } from '../../core/messaging/runtime-command-registry';
import type {
  ConversationExport,
  ConversationExportArtifact,
  ConversationExportProgress,
  ConversationExportResult,
} from '../../core/export/types';
import type {
  ConversationExportTransport,
  RunConversationExportInput,
} from '../../core/export/service';
import { defineDeepSeekPayloadRuntimeCommandHandler } from './runtime-handler';
import { definePayloadlessRuntimeCommandHandler } from '../../core/messaging/runtime-command-registry';
import { normalizeDeepSeekHistory } from '../../core/export/normalize';
import { isInlineAgentContinuationStructure } from '../../core/inline-agent/prompt';
import { stripToolCallsFromHistory } from '../../core/interceptor/history-cleanup';
import { BROWSER_CONTROL_TOOL_NAMES } from '../../core/browser-control/types';
import type { ToolDescriptor } from '../../core/tool/types';
import type { DeepSeekConversationMessage } from '../../core/messaging/deepseek-runtime-contracts';

/**
 * How many conversations the sidepanel picker asks for in one page. Bounded so
 * opening the picker never walks an entire account history.
 */
const CONVERSATION_LIST_PAGE_SIZE = 30;

interface ActiveConversationExport {
  ownerDocumentSessionId: string;
  excludeTabId?: number;
  controller: AbortController;
  state: 'running' | 'cancelling' | 'failed' | 'completed';
  progressTail: Promise<void>;
  terminalNotification?: Promise<void>;
}

export interface ConversationExportRuntimeHandlerDependencies {
  baseUrl: string;
  getExtensionVersion(): string;
  createExportId(): string;
  loadClientHeaders(preferredTabId?: number): Promise<Record<string, string> | null>;
  /** Model-facing catalog, used to strip injected tool XML from restored history. */
  getToolDescriptors(): Promise<ToolDescriptor[]>;
  createTransport(input: {
    baseUrl: string;
    clientHeaders: Record<string, string>;
  }): ConversationExportTransport;
  runExport(input: RunConversationExportInput): Promise<ConversationExport>;
  buildArtifacts(
    exportData: ConversationExport,
    signal: AbortSignal,
  ): Promise<ConversationExportArtifact[]>;
  broadcastProgress(
    progress: ConversationExportProgress,
    excludeTabId?: number,
  ): Promise<void>;
  missingAuthMessage(): string;
  generatingMessage(): string;
  cancelledMessage(): string;
  emptyHistoryMessage(): string;
}

export function createConversationExportRuntimeHandlers(
  dependencies: ConversationExportRuntimeHandlerDependencies,
): readonly RuntimeCommandHandler[] {
  const activeExports = new Map<string, ActiveConversationExport>();

  const publishProgress = (
    entry: ActiveConversationExport,
    progress: ConversationExportProgress,
    requiredState: ActiveConversationExport['state'] = 'running',
  ): Promise<void> => {
    const operation = entry.progressTail.then(async () => {
      if (entry.state !== requiredState) {
        throw new DOMException('Conversation export is no longer active.', 'AbortError');
      }
      await dependencies.broadcastProgress(progress, entry.excludeTabId);
    });
    // `operation` is returned to the caller, which observes its failure. The
    // private tail must settle so a later terminal notification can still run.
    entry.progressTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  const notifyCancelled = async (
    exportId: string,
    entry: ActiveConversationExport,
  ): Promise<void> => {
    entry.terminalNotification ??= publishProgress(entry, {
        exportId,
        phase: 'cancelled',
        status: 'cancelled',
        current: 0,
        total: 0,
        message: dependencies.cancelledMessage(),
      }, 'cancelling');
    await entry.terminalNotification;
  };

  const runExport = async (
    payload: NormalizedConversationExportCommand,
    context: RuntimeMessageContext,
  ): Promise<ConversationExportResult | { ok: false; exportId: string; error: string }> => {
    const exportId = payload.exportId ?? dependencies.createExportId();
    if (activeExports.has(exportId)) {
      return { ok: false, exportId, error: 'export_already_running' };
    }

    const entry: ActiveConversationExport = {
      ownerDocumentSessionId: context.documentSessionId,
      excludeTabId: context.tabId,
      controller: new AbortController(),
      state: 'running',
      progressTail: Promise.resolve(),
    };
    activeExports.set(exportId, entry);

    try {
      const headers = await dependencies.loadClientHeaders(context.tabId);
      assertExportActive(entry);
      if (!headers) {
        return { ok: false, exportId, error: dependencies.missingAuthMessage() };
      }

      const exportData = await dependencies.runExport({
        exportId,
        request: payload.request,
        baseUrl: dependencies.baseUrl,
        extensionVersion: dependencies.getExtensionVersion(),
        signal: entry.controller.signal,
        transport: dependencies.createTransport({
          baseUrl: dependencies.baseUrl,
          clientHeaders: headers,
        }),
        onProgress: async (progress) => {
          assertExportActive(entry);
          await publishProgress(entry, progress);
          assertExportActive(entry);
        },
      });

      // An explicit current-session export that returns zero messages means the
      // server history was empty (or transiently unavailable) while the page is
      // showing messages. Fail visibly instead of emitting a silent empty
      // artifact; bulk list-based exports may legitimately contain empty
      // sessions and are unaffected.
      if (payload.request.sessionIds?.length && exportData.stats.messageCount === 0) {
        const message = dependencies.emptyHistoryMessage();
        entry.state = 'failed';
        entry.terminalNotification = publishProgress(entry, {
          exportId,
          phase: 'failed',
          status: 'failed',
          current: 0,
          total: 0,
          message,
        }, 'failed');
        await entry.terminalNotification;
        return { ok: false, exportId, error: message };
      }

      assertExportActive(entry);
      await publishProgress(entry, {
        exportId,
        phase: 'formatting',
        status: 'running',
        current: 0,
        total: payload.request.formats.length,
        message: dependencies.generatingMessage(),
      });
      assertExportActive(entry);

      const artifacts = await dependencies.buildArtifacts(exportData, entry.controller.signal);
      assertExportActive(entry);
      entry.state = 'completed';
      return {
        ok: true,
        exportId,
        summary: exportData.stats,
        artifacts,
      };
    } catch (error) {
      if (entry.controller.signal.aborted || entry.state === 'cancelling') {
        entry.state = 'cancelling';
        await notifyCancelled(exportId, entry);
        return { ok: false, exportId, error: dependencies.cancelledMessage() };
      }

      const message = error instanceof Error ? error.message : String(error);
      entry.state = 'failed';
      entry.terminalNotification = publishProgress(entry, {
        exportId,
        phase: 'failed',
        status: 'failed',
        current: 0,
        total: 0,
        message,
      }, 'failed');
      await entry.terminalNotification;
      return { ok: false, exportId, error: message };
    } finally {
      if (activeExports.get(exportId) === entry) activeExports.delete(exportId);
    }
  };

  return Object.freeze([
    defineDeepSeekPayloadRuntimeCommandHandler(
      'EXPORT_DEEPSEEK_CONVERSATIONS',
      runExport,
    ),
    defineDeepSeekPayloadRuntimeCommandHandler('CANCEL_DEEPSEEK_EXPORT', async (payload, context) => {
      if (!payload.exportId) return { ok: false as const, error: 'missing_export_id' };
      const entry = activeExports.get(payload.exportId);
      if (!entry || entry.ownerDocumentSessionId !== context.documentSessionId) {
        return { ok: false as const, error: 'export_not_running' };
      }
      if (entry.state === 'cancelling') {
        await notifyCancelled(payload.exportId, entry);
        return { ok: true as const };
      }
      if (entry.state !== 'running') {
        return { ok: false as const, error: 'export_not_running' };
      }

      entry.state = 'cancelling';
      entry.controller.abort(new DOMException('Conversation export was cancelled.', 'AbortError'));
      await notifyCancelled(payload.exportId, entry);
      return { ok: true as const };
    }),
    defineDeepSeekPayloadRuntimeCommandHandler('GET_DEEPSEEK_CONVERSATION_MESSAGES', async (payload) => {
      const headers = await dependencies.loadClientHeaders();
      if (!headers) {
        return { ok: false as const, error: dependencies.missingAuthMessage() };
      }
      const transport = dependencies.createTransport({
        baseUrl: dependencies.baseUrl,
        clientHeaders: headers,
      });
      // The history endpoint is addressed by session id alone; the summary is
      // only a carrier, and the response's own `chat_session` fills the rest in.
      const summary = {
        id: payload.conversationId,
        title: '',
        pinned: false,
        titleType: null,
        modelType: null,
        createdAt: null,
        updatedAt: null,
      };
      const rawHistory = await transport.fetchHistory({ session: summary, includeRaw: false });
      // The stored history still contains the tool-call XML the extension
      // injected into its own turns; the page strips it on the way in, so a
      // restored transcript has to strip it too or it would show raw
      // `<memory_save>` scaffolding as assistant text. Reuses the same cleaner
      // the live fetch hook uses.
      stripToolCallsFromHistory(rawHistory, {
        toolDescriptors: buildHistoryStripCatalog(await dependencies.getToolDescriptors()),
        onToolCallsRestored: () => {},
      });
      const session = normalizeDeepSeekHistory(summary, rawHistory, { includeRaw: false });
      return { ok: true as const, messages: toRenderableMessages(session.messages) };
    }),
    definePayloadlessRuntimeCommandHandler('LIST_DEEPSEEK_CONVERSATIONS', async () => {
      const headers = await dependencies.loadClientHeaders();
      if (!headers) {
        return { ok: false as const, error: dependencies.missingAuthMessage() };
      }
      const transport = dependencies.createTransport({
        baseUrl: dependencies.baseUrl,
        clientHeaders: headers,
      });
      const sessions = await transport.listSessions({
        // One bounded page: the sidepanel shows a picker, not a full archive.
        pageSize: CONVERSATION_LIST_PAGE_SIZE,
        sessionLimit: CONVERSATION_LIST_PAGE_SIZE,
        includeRaw: false,
      });
      return {
        ok: true as const,
        conversations: sessions.map((session) => ({
          id: session.id,
          title: session.title,
          pinned: session.pinned,
          updatedAt: session.updatedAt,
        })),
      };
    }),
  ]);
}

function assertExportActive(entry: ActiveConversationExport): void {
  if (!entry.controller.signal.aborted) return;
  if (entry.controller.signal.reason instanceof Error) throw entry.controller.signal.reason;
  throw new DOMException('Conversation export was cancelled.', 'AbortError');
}

/**
 * Flattens normalized history into the two roles the sidepanel renders.
 *
 * DeepSeek history carries THINK fragments alongside RESPONSE fragments; they
 * are folded back into the assistant message's `reasoning` so a restored
 * transcript shows the same thinking block the page shows. System/tool rows and
 * role-less rows are dropped rather than guessed at.
 *
 * Inline-agent continuation turns are dropped too: those are the extension's own
 * tool-loop rounds, which the DeepSeek page hides from the conversation
 * (entrypoints/content.ts hides the same messages in the live DOM). Rendering
 * them would surface raw `[TOOL_RESULTS]` scaffolding as if the user typed it.
 * The structural detector is shared with that live-DOM hider so the two cannot
 * drift apart.
 */
function toRenderableMessages(
  messages: readonly { role: string; content: string; contentFragments: readonly { kind: string; text: string }[] }[],
): DeepSeekConversationMessage[] {
  const rendered: DeepSeekConversationMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (isInlineAgentContinuationStructure(message.content)) continue;
    const reasoning = message.contentFragments
      .filter((fragment) => fragment.kind === 'reasoning')
      .map((fragment) => fragment.text)
      .join('\n\n')
      .trim();
    // `content` is every fragment joined, reasoning included, so taking it
    // verbatim would repeat the thinking text inside the answer. The answer is
    // the non-reasoning fragments; a message with no fragments at all (plain
    // text) falls back to `content`.
    const answerFragments = message.contentFragments.filter((fragment) => fragment.kind !== 'reasoning');
    const text = (answerFragments.length > 0
      ? answerFragments.map((fragment) => fragment.text).filter(Boolean).join('\n\n')
      : message.content
    ).trim();
    // A reasoning-only assistant turn is real (the page shows it), but an
    // entirely empty row is not.
    if (!text && !reasoning) continue;
    rendered.push({
      role: message.role,
      text,
      reasoning: reasoning || null,
    });
  }
  return rendered;
}

/**
 * Tool catalog used to strip injected tool XML from restored history.
 *
 * `getToolDescriptors()` is the live MODEL-FACING catalog, which intentionally
 * omits capabilities that are currently disabled — browser control, for one.
 * A stored conversation can still contain those calls from when they were
 * enabled, and leaving them in would show raw `<browser_evaluate_script>` XML as
 * assistant text. The known names are therefore always included so cleanup
 * covers every capability the extension can ever have injected. The execution
 * flags are inert here: this list is only used to recognize and remove tags,
 * never to run anything.
 */
function buildHistoryStripCatalog(liveDescriptors: readonly ToolDescriptor[]): ToolDescriptor[] {
  const known = new Set(liveDescriptors.map((descriptor) => descriptor.name));
  const synthetic: ToolDescriptor[] = BROWSER_CONTROL_TOOL_NAMES
    .filter((name) => !known.has(name))
    .map((name) => ({
      id: `history-cleanup:${name}`,
      provider: { kind: 'local', id: 'history-cleanup', displayName: 'History cleanup', transport: 'in_process' },
      name,
      invocationName: name,
      title: name,
      description: '',
      inputSchema: { type: 'object' },
      execution: { mode: 'auto', enabled: false, risk: 'low' },
    }));
  return synthetic.length > 0 ? [...liveDescriptors, ...synthetic] : [...liveDescriptors];
}
