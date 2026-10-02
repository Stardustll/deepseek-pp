export type PromptTextInsertionResult =
  | { ok: true; insertedLength: number }
  | { ok: false; error: 'empty_prompt_text' | 'prompt_input_not_found' };

/**
 * Placeholders seen on the live composer. The page dropped the historical
 * `#chat-input` id, so the placeholder is now the only page-owned signal that
 * separates the real composer from any other textarea the page might mount.
 */
const DEEPSEEK_COMPOSER_PLACEHOLDERS = [
  '给 DeepSeek 发送消息',
  'Send a message to DeepSeek',
  'Message DeepSeek',
];

/**
 * Resolves the DeepSeek composer.
 *
 * `#chat-input` is the historical id and is still preferred when present, but
 * the live composer no longer carries it, so the remaining candidates are the
 * page's own placeholder text first and any single textarea last. Matching on
 * page-owned signals (rather than a bare `textarea` query) keeps the selection
 * from latching onto an extension-owned or plugin textarea when more than one
 * exists on the page.
 */
export function findPromptTextarea(root: ParentNode = document): HTMLTextAreaElement | null {
  const byId = root.querySelector<HTMLTextAreaElement>('textarea#chat-input');
  if (byId?.tagName === 'TEXTAREA') return byId;

  for (const textarea of root.querySelectorAll<HTMLTextAreaElement>('textarea')) {
    const placeholder = textarea.getAttribute('placeholder') ?? '';
    if (DEEPSEEK_COMPOSER_PLACEHOLDERS.some((candidate) => placeholder.includes(candidate))) {
      return textarea;
    }
  }

  const textareas = root.querySelectorAll<HTMLTextAreaElement>('textarea');
  return textareas.length === 1 && textareas[0].tagName === 'TEXTAREA' ? textareas[0] : null;
}

export function insertTextIntoPromptTextarea(
  text: string,
  textarea: HTMLTextAreaElement | null = findPromptTextarea(),
): PromptTextInsertionResult {
  if (text.length === 0) return { ok: false, error: 'empty_prompt_text' };
  if (!textarea) return { ok: false, error: 'prompt_input_not_found' };

  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const nextValue = `${textarea.value.slice(0, start)}${text}${textarea.value.slice(end)}`;

  setTextareaValue(textarea, nextValue);
  const caret = start + text.length;
  textarea.selectionStart = textarea.selectionEnd = caret;
  textarea.dispatchEvent(createPromptInputEvent(text));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
  textarea.focus();

  return { ok: true, insertedLength: text.length };
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter) {
    setter.call(textarea, value);
    return;
  }
  textarea.value = value;
}

function createPromptInputEvent(text: string): Event {
  if (typeof InputEvent === 'function') {
    return new InputEvent('input', {
      bubbles: true,
      inputType: 'insertFromPaste',
      data: text,
    });
  }
  return new Event('input', { bubbles: true });
}
