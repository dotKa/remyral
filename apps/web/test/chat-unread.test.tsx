// p9-chat-unread: unread conversations in the list (bold + count, phone drawer dot), "Mark all as read", marking
// the open conversation read (Page Visibility API), the Chat nav badge and the tab title.
import { configure, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { titleWithUnread, useUnreadTitle } from '../src/shell/navBadges';
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

configure({ asyncUtilTimeout: 5_000 });

let visibility: DocumentVisibilityState = 'visible';
let focused = true;

beforeEach(() => {
  visibility = 'visible';
  focused = true;
  FakeEventSource.last = null;
  vi.stubGlobal('EventSource', FakeEventSource);
  stubCookies('__Host-ras-csrf=csrf-from-cookie');
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.title = '';
});

describe('Tab title (p9-chat-unread)', () => {
  it('adds, replaces and removes the unread prefix', () => {
    expect(titleWithUnread('Chat · Remyral', 3)).toBe('(3) Chat · Remyral');
    expect(titleWithUnread('(3) Chat · Remyral', 5)).toBe('(5) Chat · Remyral');
    expect(titleWithUnread('(99+) Jobs', 0)).toBe('Jobs');
    expect(titleWithUnread('Jobs', 250)).toBe('(99+) Jobs');
  });

  it('keeps the prefix when a page sets its own title later and drops it on unmount', async () => {
    document.title = 'Jobs · Remyral';
    function Probe(props: { readonly n: number }) {
      useUnreadTitle(props.n);
      return null;
    }
    const { rerender, unmount } = render(<Probe n={2} />);
    expect(document.title).toBe('(2) Jobs · Remyral');
    document.title = 'Machines · Remyral';
    await waitFor(() => {
      expect(document.title).toBe('(2) Machines · Remyral');
    });
    rerender(<Probe n={0} />);
    expect(document.title).toBe('Machines · Remyral');
    rerender(<Probe n={1} />);
    expect(document.title).toBe('(1) Machines · Remyral');
    unmount();
    expect(document.title).toBe('Machines · Remyral');
  });
});
