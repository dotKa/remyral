import { configure } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatDraft, ChatMessage } from '../src/api/chat';
import { buildRows } from '../src/screens/chat/rows';
import { stubCookies } from './helpers';

/**
 * p9-chat-card-order: a draft card stays where it was proposed in the conversation. Decided cards
 * (confirmed / dismissed) used to fall to the very bottom once the message that proposed them slid out of the
 * shown window, so every new message moved them again.
 */

const T1 = '00000000-0000-4000-8000-0000000000c1';
const D1 = '00000000-0000-4000-8000-0000000000d1';
const D2 = '00000000-0000-4000-8000-0000000000d2';
const BASE = Date.parse('2026-10-17T10:00:00Z');

const at = (seq: number): string => new Date(BASE + seq * 1000).toISOString();

function msg(
  seq: number,
  role: string,
  content: string,
  meta: Record<string, unknown> | null = null,
): ChatMessage {
  return { id: `m${String(seq)}`, seq, role, content, meta, turnId: null, createdAt: at(seq) } as ChatMessage;
}

function draft(id: string, title: string, seq: number, state = 'proposed'): ChatDraft {
  return {
    id,
    threadId: T1,
    kind: 'job',
    title,
    payload: {},
    project: 'alpha',
    state,
    result: null,
    createdAt: at(seq),
    expiresAt: at(seq + 3600),
    decidedAt: state === 'proposed' ? null : at(seq + 1),
  };
}

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
  emit(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: '{}' } as MessageEvent<string>);
  }
  close(): void {
    this.readyState = 2;
  }
}

configure({ asyncUtilTimeout: 5_000 });

beforeEach(() => {
  FakeEventSource.last = null;
  vi.stubGlobal('EventSource', FakeEventSource);
  stubCookies('__Host-ras-csrf=csrf-from-cookie');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('buildRows card anchors (p9-chat-card-order)', () => {
  const transcript = [
    msg(1, 'user', 'make a job'),
    msg(2, 'tool', 'draft_job: card', { draftId: D1 }),
    msg(3, 'assistant', 'Proposed.'),
    msg(4, 'user', 'thanks'),
    msg(5, 'assistant', 'Anything else?'),
  ];

  it('keeps a draft on its anchor whatever its state', () => {
    for (const state of ['proposed', 'confirmed', 'dismissed', 'expired']) {
      const { rows, leading } = buildRows(transcript, [draft(D1, 'Job', 2, state)]);
      expect(leading).toEqual([]);
      expect(rows.map((r) => r.drafts.map((d) => d.id))).toEqual([[], [D1], [], [], []]);
    }
  });

  it('hides a draft with its anchor behind "Show earlier" instead of moving it to the bottom', () => {
    const { rows, leading } = buildRows(transcript, [draft(D1, 'Job', 2, 'dismissed')], 3);
    expect(leading).toEqual([]);
    expect(rows.flatMap((r) => r.drafts)).toEqual([]);
  });

  it('places a draft whose anchor is not loaded by its creation time', () => {
    // Anchor outside the loaded transcript (server window), created between messages 3 and 4.
    const loose = { ...draft(D2, 'Loose', 3, 'confirmed'), createdAt: new Date(BASE + 3500).toISOString() };
    const { rows, leading } = buildRows(transcript, [loose]);
    expect(leading).toEqual([]);
    expect(rows.map((r) => r.drafts.map((d) => d.id))).toEqual([[], [], [D2], [], []]);
    // Older than every shown message: above them only when nothing earlier is hidden.
    const old = { ...loose, createdAt: new Date(BASE).toISOString() };
    expect(buildRows(transcript, [old]).leading.map((d) => d.id)).toEqual([D2]);
    expect(buildRows(transcript, [old], 1).leading).toEqual([]);
    // Newest (the tool line is not persisted yet): after the last message.
    const fresh = { ...loose, createdAt: new Date(BASE + 9000).toISOString() };
    expect(
      buildRows(transcript, [fresh])
        .rows.at(-1)
        ?.drafts.map((d) => d.id),
    ).toEqual([D2]);
  });
});
