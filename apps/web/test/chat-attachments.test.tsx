import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseInput } from '../src/api/chat';
import { checkFile, kindOf, safeName } from '../src/screens/chat/attachment-files';
import { activeQuery, mentionHref, metaMentions } from '../src/screens/chat/MentionPicker';
import { metaAttachments } from '../src/screens/chat/Attachments';
import { type Handler, type RecordedRequest, renderApp, sessionBody, stubCookies } from './helpers';

/** p8-chat-attachments-mentions: images / files and `@` mentions in the ops chat composer and history. */

const T2 = '00000000-0000-4000-8000-0000000000c2';
const A1 = '00000000-0000-4000-8000-0000000000a1';
const JOB = '00000000-0000-4000-8000-0000000000e1';
configure({ asyncUtilTimeout: 5_000 });

class SilentEventSource {
  static readonly CLOSED = 2;
  readyState = 1;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {
    this.readyState = 2;
  }
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function png(name = 'shot.png'): File {
  return new File([PNG], name, { type: 'image/png' });
}

beforeEach(() => {
  vi.stubGlobal('EventSource', SilentEventSource);
  stubCookies('__Host-ras-csrf=csrf-from-cookie');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// p15-classic-removal: the composer behaviours of the removed classic chat, on the Diyalog Sohbet composer (the same
// shared `useAttachments` and tray).
const T1 = '00000000-0000-4000-8000-0000000000c1';
const A2 = '00000000-0000-4000-8000-0000000000a2';
const NOW = '2026-10-16T10:00:00.000Z';
const SUPPORTED = { images: 'supported', pdf: true, mentions: true, reason: null };

function status(input: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    enabled: true,
    available: true,
    code: null,
    message: null,
    worker: { id: 'w1', name: 'mac-1', online: true },
    runtime: 'claude-code',
    model: null,
    limits: { turnsPerUserPer10Min: 30, userDailyTokens: null },
    ...(input === undefined ? {} : { input }),
  };
}

function attachment(id: string, name: string): Record<string, unknown> {
  return {
    id,
    threadId: T1,
    messageId: null,
    kind: 'image',
    name,
    mediaType: 'image/png',
    sizeBytes: PNG.length,
    sha256: 'a'.repeat(64),
    scrubbed: ['exif'],
    createdAt: NOW,
    url: `/api/chat/attachments/${id}/content`,
  };
}

function setup(opts: {
  input?: Record<string, unknown>;
  messages?: unknown[];
  extra?: Record<string, Handler>;
}): { requests: RecordedRequest[] } {
  let uploads = 0;
  const thread = { id: T1, title: 'Screens', archived: false, createdAt: NOW, updatedAt: NOW };
  return renderApp({
    path: `/chat/${T1}`,
    initialState: {
      kind: 'signedIn',
      user: { id: '00000000-0000-4000-8000-000000000001', username: 'alex', role: 'owner' },
      session: null,
      remainingRecoveryCodes: null,
    },
    routes: {
      'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
      'GET /api/chat/status': () => ({ status: 200, body: status(opts.input) }),
      'GET /api/chat/threads': () => ({ status: 200, body: { items: [thread], nextCursor: null } }),
      [`GET /api/chat/threads/${T1}`]: () => ({
        status: 200,
        body: { thread, messages: opts.messages ?? [], drafts: [], turn: null, watches: [], starred: [] },
      }),
      [`POST /api/chat/threads/${T1}/attachments`]: (req) => {
        uploads += 1;
        const name = (req.body as { name: string }).name;
        return { status: 201, body: attachment(uploads === 1 ? A1 : A2, name) };
      },
      [`DELETE /api/chat/attachments/${A1}`]: () => ({ status: 204 }),
      [`POST /api/chat/threads/${T1}/messages`]: () => ({
        status: 202,
        body: {
          message: { id: 'm9', seq: 9, role: 'user', content: 'x', meta: null, turnId: null, createdAt: NOW },
          turnId: '00000000-0000-4000-8000-0000000000f1',
          dropped: [],
        },
      }),
      ...opts.extra,
    },
  });
}

async function textbox(): Promise<HTMLTextAreaElement> {
  return screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Mesaj' });
}

describe(
  'Sohbet attachments (p8-chat-attachments-mentions, on the Diyalog composer)',
  { timeout: 30_000 },
  () => {
    it('pastes an image, uploads it, shows it in the tray and sends it with the message', async () => {
      const { requests } = setup({ input: SUPPORTED });
      const box = await textbox();
      fireEvent.paste(box, { clipboardData: { files: [png('image.png')], types: ['Files'] } });
      const tray = await screen.findByTestId('attachment-tray');
      await waitFor(() => {
        expect(within(tray).getByRole('listitem').getAttribute('data-state')).toBe('ready');
      });
      const up = requests.find((r) => r.method === 'POST' && r.url.endsWith('/attachments'));
      const body = up?.body as { name: string; contentBase64: string };
      // A pasted image gets a safe generated name; the bytes go as base64.
      expect(body.name).toMatch(/^pasted-[0-9-]+\.png$/);
      expect(Buffer.from(body.contentBase64, 'base64')).toEqual(Buffer.from(PNG));
      expect(up?.headers['x-csrf-token']).toBe('csrf-from-cookie');
      // Only attachments, no text: Send is allowed.
      await userEvent.click(screen.getByRole('button', { name: 'Gönder' }));
      await waitFor(() => {
        expect(requests.some((r) => r.method === 'POST' && r.url.endsWith('/messages'))).toBe(true);
      });
      const sent = requests.find((r) => r.method === 'POST' && r.url.endsWith('/messages'));
      expect(sent?.body).toMatchObject({ text: '', attachments: [A1] });
      await waitFor(() => {
        expect(screen.queryByTestId('attachment-tray')).toBeNull();
      });
    });

    it('takes files from the picker and drag-and-drop, and removes an unsent one (DELETE /chat/attachments/:id)', async () => {
      const { requests } = setup({ input: SUPPORTED });
      await textbox();
      await userEvent.upload(screen.getByTestId('dy-file-input'), png('one.png'));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Kaldır: one.png' })).toBeTruthy();
      });
      const form = screen.getByRole('form', { name: 'Remyral’a yaz' });
      fireEvent.dragOver(form, { dataTransfer: { types: ['Files'], files: [], dropEffect: 'none' } });
      expect(screen.getByTestId('dy-drop-overlay')).toBeTruthy();
      fireEvent.drop(form, {
        dataTransfer: { types: ['Files'], files: [new File(['# notes'], 'notes.md')] },
      });
      expect(screen.queryByTestId('dy-drop-overlay')).toBeNull();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Kaldır: notes.md' })).toBeTruthy();
      });
      await waitFor(() => {
        expect(
          within(screen.getByTestId('attachment-tray'))
            .getAllByRole('listitem')
            .every((li) => li.getAttribute('data-state') === 'ready'),
        ).toBe(true);
      });
      await userEvent.click(screen.getByRole('button', { name: 'Kaldır: one.png' }));
      await waitFor(() => {
        expect(requests.some((r) => r.method === 'DELETE' && r.url === `/api/chat/attachments/${A1}`)).toBe(
          true,
        );
      });
      expect(screen.queryByRole('button', { name: 'Kaldır: one.png' })).toBeNull();
    });

    it('enforces the limits in the browser before any upload', async () => {
      const { requests } = setup({ input: SUPPORTED });
      const box = await textbox();
      fireEvent.paste(box, {
        clipboardData: { files: [new File(['x'.repeat(300 * 1024)], 'big.txt')], types: ['Files'] },
      });
      expect(await screen.findByTestId('attachment-errors')).toBeTruthy();
      fireEvent.paste(box, { clipboardData: { files: [new File(['MZ'], 'tool.exe')], types: ['Files'] } });
      const five = Array.from({ length: 5 }, (_, i) => png(`p${String(i)}.png`));
      fireEvent.paste(box, { clipboardData: { files: five, types: ['Files'] } });
      // Four uploads only (the fifth, the large text and the executable were refused before any request).
      await waitFor(() => {
        expect(requests.filter((r) => r.url.endsWith('/attachments')).length).toBe(4);
      });
      expect(screen.getByTestId('attachment-errors').querySelectorAll('li').length).toBeGreaterThanOrEqual(1);
    });

    it('shows thumbnails of sent images and file chips for other files; ids that are not ids are dropped', async () => {
      setup({
        input: SUPPORTED,
        messages: [
          {
            id: 'm1',
            seq: 1,
            role: 'user',
            content: 'What is wrong here?',
            meta: {
              attachments: [
                { id: A1, kind: 'image', name: 'error.png', mediaType: 'image/png', sizeBytes: 2048 },
                { id: A2, kind: 'pdf', name: 'report.pdf', mediaType: 'application/pdf', sizeBytes: 4096 },
                { id: '../../etc', kind: 'image', name: 'evil', mediaType: 'image/png', sizeBytes: 1 },
              ],
            },
            turnId: null,
            createdAt: NOW,
          },
        ],
      });
      const thumb = await screen.findByTestId<HTMLImageElement>('attachment-thumb');
      expect(thumb.getAttribute('src')).toBe(`/api/chat/attachments/${A1}/content`);
      expect(screen.getAllByTestId('attachment-thumb')).toHaveLength(1);
      const file = screen.getByTestId('attachment-file');
      expect(file.getAttribute('href')).toBe(`/api/chat/attachments/${A2}/content`);
      expect(file.textContent).toContain('report.pdf');
    });
  },
);

describe('helpers', () => {
  it('finds the @query at the caret', () => {
    expect(activeQuery('hi @pro', 7)).toEqual({ start: 3, query: 'pro' });
    expect(activeQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(activeQuery('mail a@b', 8)).toBeNull();
    expect(activeQuery('hi @pro x', 9)).toBeNull();
  });

  it('builds console links only from valid ids', () => {
    expect(mentionHref({ type: 'thread', id: T2 })).toBe(`/chat/${T2}`);
    expect(mentionHref({ type: 'job', id: JOB })).toBe(`/jobs/${JOB}`);
    expect(mentionHref({ type: 'worker', id: 'wrk_abc' })).toBe('/machines/wrk_abc');
    expect(mentionHref({ type: 'thread', id: '//evil.example' })).toBeNull();
    expect(mentionHref({ type: 'project', id: '../x' })).toBeNull();
    expect(mentionHref({ type: 'output', id: 'a b' })).toBeNull();
  });

  it('type-checks message meta', () => {
    expect(metaAttachments({ attachments: 'x' })).toEqual([]);
    expect(metaAttachments({ attachments: [{ id: A1, kind: 'exe', name: 'x' }] })).toEqual([]);
    expect(metaMentions({ mentions: [{ type: 'project', id: 7 }] })).toEqual([]);
    expect(parseInput(undefined)).toBeNull();
    expect(parseInput({ images: 'maybe' })).toBeNull();
    expect(parseInput({ images: 'model-dependent', pdf: 'yes' })).toEqual({
      images: 'model-dependent',
      pdf: false,
      mentions: false,
      reason: null,
    });
  });

  it('classifies and names files like the master', () => {
    expect(kindOf({ name: 'a.JPG', type: '' })).toBe('image');
    expect(kindOf({ name: 'r.pdf', type: 'application/pdf' })).toBe('pdf');
    expect(kindOf({ name: 'data.csv', type: 'text/csv' })).toBe('text');
    expect(kindOf({ name: 'x.svg', type: 'image/svg+xml' })).toBeNull();
    expect(safeName('my photo (1).jpeg', 'image/jpeg')).toBe('my photo (1).jpeg');
    expect(safeName('../../etc/passwd.txt', '')).toBe('etc_passwd.txt');
    expect(safeName('IMG_1.HEIC.png', 'image/webp')).toBe('IMG_1.HEIC.webp');
    const allow = { images: true, pdf: false };
    expect(
      checkFile({ name: 'a.pdf', type: 'application/pdf', size: 10 }, { count: 0, bytes: 0 }, allow),
    ).toContain('cannot read PDF');
    expect(checkFile(png(), { count: 0, bytes: 0 }, allow)).toBeNull();
  });
});
