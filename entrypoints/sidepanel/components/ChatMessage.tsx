import {
  Component,
  lazy,
  Suspense,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import type { ChatMessage as ChatMessageType } from '../../../core/types';
import { useI18n } from '../i18n';

const RichMessageContent = lazy(() => import('./RichMessageContent'));

interface ChatMessageProps {
  message: ChatMessageType;
  isStreaming?: boolean;
  onRichContentRendered?: () => void;
}

interface RichMessageErrorBoundaryProps {
  children: ReactNode;
  text: string;
}

interface RichMessageErrorBoundaryState {
  failed: boolean;
}

export class RichMessageErrorBoundary extends Component<
  RichMessageErrorBoundaryProps,
  RichMessageErrorBoundaryState
> {
  state: RichMessageErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): RichMessageErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Rich message rendering failed; using plain text.', error, info);
  }

  render() {
    if (this.state.failed) {
      return <PlainTextMessageContent text={this.props.text} />;
    }
    return this.props.children;
  }
}

export default function ChatMessage({
  message,
  isStreaming,
  onRichContentRendered,
}: ChatMessageProps) {
  const { t } = useI18n();
  const isUser = message.role === 'user';

  return (
    <div className={`ds-chat-message-row ${isUser ? 'ds-chat-message-row-user' : 'ds-chat-message-row-assistant'}`}>
      <div
        className={`ds-chat-message ${
          isUser
            ? 'ds-chat-message-user'
            : 'ds-chat-message-assistant'
        }`}
      >
        {isUser ? (
          <span className="whitespace-pre-wrap">{message.text}</span>
        ) : (
          <>
            {message.reasoningText && (
              <details className="ds-chat-thinking" open={isStreaming && !message.text}>
                <summary>
                  {isStreaming && !message.text
                    ? t('sidepanel.chatPage.reasoningActive')
                    : t('sidepanel.chatPage.reasoningTitle')}
                </summary>
                <div className="whitespace-pre-wrap">{message.reasoningText}</div>
              </details>
            )}
            {message.text && (
              // Styling lives on .ds-chat-markdown inside RichMessageContent; the
              // previous `prose prose-sm` classes were inert because the Tailwind
              // typography plugin is not installed.
              <RichMessageErrorBoundary text={message.text}>
                <Suspense fallback={<PlainTextMessageContent text={message.text} />}>
                  <RichMessageContent
                    text={message.text}
                    onRendered={onRichContentRendered}
                  />
                </Suspense>
              </RichMessageErrorBoundary>
            )}
          </>
        )}
        {isStreaming && !isUser && (
          <span className="ds-chat-caret" />
        )}
      </div>
    </div>
  );
}

function PlainTextMessageContent({ text }: { text: string }) {
  return <span className="whitespace-pre-wrap" data-rich-message-fallback="plain-text">{text}</span>;
}
