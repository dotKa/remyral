import { configure, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Markdown, safeHref } from '../src/screens/chat/markdown';
import { stubCookies } from './helpers';

class FakeEventSource {
  static readonly CLOSED = 2;
  static last: FakeEventSource | null = null;
  readonly listeners = new Map<string, ((m: MessageEvent<string>) => void)[]>();
  readyState = 1;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (m: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data: unknown): void {
    for (const fn of this.listeners.get(type) ?? [])
      fn({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
  close(): void {
    this.readyState = 2;
  }
}

// Full-page renders are slow on a loaded host; allow more than the 1 s default for findBy*.
configure({ asyncUtilTimeout: 5_000 });

beforeEach(() => {
  FakeEventSource.last = null;
  vi.stubGlobal('EventSource', FakeEventSource);
  stubCookies('__Host-ras-csrf=csrf-from-cookie');
  // jsdom has no layout; the conversation scrolls itself into view.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Markdown renderer', () => {
  it('renders formatting as elements and never raw HTML', () => {
    const { container } = render(
      <Markdown
        text={[
          '# Title',
          'Some **bold**, *italic* and `code`.',
          '<img src=x onerror="window.__pwned=1"><script>alert(1)</script>',
          '- one',
          '- two',
          '1. first',
          '```',
          '<b>not bold</b>',
          '```',
          '[good](https://example.com/x) and [bad](javascript:alert(1)) and [data](data:text/html,hi)',
        ].join('\n')}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('pre code')?.textContent).toBe('<b>not bold</b>');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('em')?.textContent).toBe('italic');
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
    expect(container.querySelectorAll('ol li')).toHaveLength(1);
    const links = [...container.querySelectorAll('a')];
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('https://example.com/x');
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.textContent).toContain('bad');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('//evil.example')).toBeNull();
  });
});
