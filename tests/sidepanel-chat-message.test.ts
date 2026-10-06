import React, { lazy, Suspense } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChatMessage, {
  RichMessageErrorBoundary,
} from '../entrypoints/sidepanel/components/ChatMessage';

let container: HTMLDivElement;
let root: Root | null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('ChatMessage rich rendering boundary', () => {
  it('keeps user markdown literal', async () => {
    await act(async () => {
      root?.render(React.createElement(ChatMessage, {
        message: { role: 'user', text: '**literal**' },
      }));
    });

    expect(container.textContent).toBe('**literal**');
    expect(container.querySelector('strong')).toBeNull();
  });

  it('renders assistant markdown after the lazy renderer loads', async () => {
    const onRichContentRendered = vi.fn();
    await act(async () => {
      root?.render(React.createElement(ChatMessage, {
        message: { role: 'assistant', text: 'Hello **world**' },
        onRichContentRendered,
      }));
    });

    await vi.waitFor(() => {
      expect(container.querySelector('strong')?.textContent).toBe('world');
    });
    expect(container.textContent).toContain('Hello world');
    expect(onRichContentRendered).toHaveBeenCalled();
  });

  it('renders GFM tables, strikethrough and task lists', async () => {
    // Plain CommonMark would leave these as literal punctuation, which is what
    // models actually emit most of the time.
    const text = [
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '~~gone~~',
      '',
      '- [x] done',
      '- [ ] todo',
    ].join('\n');

    await act(async () => {
      root?.render(React.createElement(ChatMessage, {
        message: { role: 'assistant', text },
      }));
    });

    await vi.waitFor(() => {
      expect(container.querySelector('table')).toBeTruthy();
    });
    expect(container.querySelectorAll('th')).toHaveLength(2);
    expect(container.querySelectorAll('td')).toHaveLength(2);
    expect(container.querySelector('del')?.textContent).toBe('gone');
    // Task list items render real checkboxes, the first one checked.
    const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0].checked).toBe(true);
    expect(checkboxes[1].checked).toBe(false);
  });

  it('renders fenced code, headings and links as real elements', async () => {
    const text = [
      '## Heading',
      '',
      '```ts',
      'const a = 1;',
      '```',
      '',
      'see [docs](https://example.test/x)',
      '',
      '`inline`',
    ].join('\n');

    await act(async () => {
      root?.render(React.createElement(ChatMessage, {
        message: { role: 'assistant', text },
      }));
    });

    await vi.waitFor(() => {
      expect(container.querySelector('pre code')).toBeTruthy();
    });
    expect(container.querySelector('h2')?.textContent).toBe('Heading');
    expect(container.querySelector('pre code')?.textContent).toContain('const a = 1;');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.test/x');
    // Inline code must not be wrapped in a block.
    const inline = Array.from(container.querySelectorAll('code'))
      .find((el) => el.textContent === 'inline');
    expect(inline?.closest('pre')).toBeNull();
  });

  it('scopes markdown styling to .ds-chat-markdown', async () => {
    // The wrapper is what the stylesheet targets; without it the rules would not
    // apply even though the elements exist.
    await act(async () => {
      root?.render(React.createElement(ChatMessage, {
        message: { role: 'assistant', text: 'text' },
      }));
    });

    await vi.waitFor(() => {
      expect(container.querySelector('.ds-chat-markdown')).toBeTruthy();
    });
    expect(container.querySelector('.ds-chat-markdown')?.querySelector('p')?.textContent).toBe('text');
  });

  it('contains a rejected lazy renderer and keeps the surrounding route mounted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const RejectingRenderer = lazy(() => Promise.reject(new Error('chunk load failed')));

    await act(async () => {
      root?.render(
        React.createElement(
          'div',
          { 'data-testid': 'chat-route' },
          React.createElement(
            RichMessageErrorBoundary,
            {
              text: 'Plain fallback',
              children: React.createElement(
                Suspense,
                { fallback: React.createElement('span', null, 'Loading') },
                React.createElement(RejectingRenderer),
              ),
            },
          ),
          React.createElement('span', { 'data-testid': 'route-sibling' }, 'Composer'),
        ),
      );
    });

    await vi.waitFor(() => {
      expect(container.querySelector('[data-rich-message-fallback="plain-text"]')?.textContent)
        .toBe('Plain fallback');
    });
    expect(container.querySelector('[data-testid="chat-route"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="route-sibling"]')?.textContent).toBe('Composer');
  });

  it('preserves reasoning and streaming state around the lazy renderer', async () => {
    await act(async () => {
      root?.render(React.createElement(ChatMessage, {
        message: { role: 'assistant', text: '', reasoningText: 'Thinking' },
        isStreaming: true,
      }));
    });

    expect(container.querySelector('details')?.open).toBe(true);
    expect(container.textContent).toContain('Thinking');
    expect(container.querySelector('.ds-chat-caret')).not.toBeNull();
  });
});
