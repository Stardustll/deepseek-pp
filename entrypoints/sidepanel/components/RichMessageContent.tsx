import { useLayoutEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface RichMessageContentProps {
  text: string;
  onRendered?: () => void;
}

/**
 * Renders an assistant answer as Markdown.
 *
 * `remark-gfm` is required, not optional: models routinely emit tables,
 * strikethrough, task lists, and autolinks, and plain CommonMark leaves those as
 * literal punctuation. Styling lives in `.ds-chat-markdown` (see
 * entrypoints/sidepanel/style.css) rather than a typography plugin, so the
 * palette stays on this project's own design tokens.
 */
export default function RichMessageContent({ text, onRendered }: RichMessageContentProps) {
  useLayoutEffect(() => {
    onRendered?.();
  }, [onRendered]);

  return (
    <div className="ds-chat-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
