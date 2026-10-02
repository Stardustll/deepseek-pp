import { describe, expect, it, vi } from 'vitest';
import {
  findPromptTextarea,
  insertTextIntoPromptTextarea,
} from '../core/ui/prompt-text-insertion';

describe('prompt text insertion', () => {
  it('returns an explicit failure when the prompt textarea is missing', () => {
    document.body.innerHTML = '<main></main>';

    expect(insertTextIntoPromptTextarea('Prompt')).toEqual({
      ok: false,
      error: 'prompt_input_not_found',
    });
  });

  it('inserts text at the selection and dispatches input/change events', () => {
    document.body.innerHTML = '<textarea id="chat-input">Hello world</textarea>';
    const textarea = findPromptTextarea();
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    textarea!.selectionStart = 6;
    textarea!.selectionEnd = 11;
    const inputListener = vi.fn();
    const changeListener = vi.fn();
    textarea!.addEventListener('input', inputListener);
    textarea!.addEventListener('change', changeListener);

    const result = insertTextIntoPromptTextarea('DeepSeek', textarea);

    expect(result).toEqual({ ok: true, insertedLength: 8 });
    expect(textarea!.value).toBe('Hello DeepSeek');
    expect(textarea!.selectionStart).toBe(14);
    expect(textarea!.selectionEnd).toBe(14);
    expect(inputListener).toHaveBeenCalledTimes(1);
    expect(changeListener).toHaveBeenCalledTimes(1);
  });

  // The live page dropped the historical `#chat-input` id; the composer is now
  // only identifiable by its placeholder, and a bare `textarea` query would
  // latch onto the wrong field once any other textarea exists.
  it('finds the composer by placeholder when the page no longer sets #chat-input', () => {
    document.body.innerHTML = [
      '<textarea placeholder="Search this page"></textarea>',
      '<textarea placeholder="给 DeepSeek 发送消息 " rows="2"></textarea>',
    ].join('');

    expect(findPromptTextarea()?.placeholder).toBe('给 DeepSeek 发送消息 ');
  });

  it('finds the English composer placeholder too', () => {
    document.body.innerHTML = '<textarea placeholder="Send a message to DeepSeek"></textarea>';

    expect(findPromptTextarea()).toBeInstanceOf(HTMLTextAreaElement);
  });

  it('does not guess when multiple non-composer textareas exist without an id', () => {
    document.body.innerHTML = [
      '<textarea placeholder="First"></textarea>',
      '<textarea placeholder="Second"></textarea>',
    ].join('');

    expect(findPromptTextarea()).toBeNull();
  });

  it('still accepts a single unidentified textarea as the last resort', () => {
    document.body.innerHTML = '<textarea></textarea>';

    expect(findPromptTextarea()).toBeInstanceOf(HTMLTextAreaElement);
  });
});
