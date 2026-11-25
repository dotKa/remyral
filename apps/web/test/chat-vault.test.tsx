// p15-chat-vault (docs/design/p15-chat-vault.md): a secret pasted into the Sohbet composer never leaves the page — the
// field gets a token, the warning offers "Kasaya kaydet", the value is sealed in this browser to the machines' vault
// keys (POST /vault/credentials carries ciphertext only) and the token becomes {{credential:NAME}}; @ mentions list
// vault credentials; sent messages render credential / secret tokens as chips.
import { webcrypto } from 'node:crypto';
import { openCredential, type SealedValue, vaultKeyId } from '@remyral/protocol/credential-seal';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatInput, SendExtras } from '../src/api/chat';
import { AuthProvider } from '../src/auth/AuthProvider';
import { MentionText, resetMentionFacts } from '../src/diyalog/chat/MentionBadge';
import { Composer } from '../src/diyalog/ops/Composer';
import { pastedSecret, resetPastedSecrets } from '../src/diyalog/vault/pastedSecrets';
import { StepUpProvider } from '../src/stepup/StepUpProvider';
import { fakeFetch, type Handler, type RecordedRequest, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const RAW = 'sk-proj-FAKE-test-only-not-a-real-key-89';
const W1 = 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const INPUT: ChatInput = { images: 'supported', pdf: true, mentions: true, reason: null };
type Key = Parameters<typeof openCredential>[1];

async function workerKey(): Promise<{ publicKey: string; privateKey: Key; keyId: string }> {
  const pair = (await webcrypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as unknown as {
    publicKey: Key;
    privateKey: Key;
  };
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
  const publicKey = Buffer.from(raw).toString('base64url');
  return { publicKey, privateKey: pair.privateKey, keyId: await vaultKeyId(publicKey) };
}

function mount(node: ReactNode, routes: Record<string, Handler>): RecordedRequest[] {
  stubCookies('__Host-ras-csrf=csrf-token');
  const f = fakeFetch(routes);
  vi.stubGlobal('fetch', f.fetch);
  render(
    <MemoryRouter>
      <AuthProvider
        initialState={{ kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null }}
      >
        <StepUpProvider>{node}</StepUpProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  return f.requests;
}

function paste(box: HTMLTextAreaElement, text: string): void {
  fireEvent.paste(box, { clipboardData: { files: [], getData: () => text } });
}

beforeEach(() => {
  resetPastedSecrets();
  resetMentionFacts();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a pasted secret in the composer', () => {
  it('the field gets a token, the warning names it, and sending never carries the value', async () => {
    const onSend = vi.fn((_t: string, _e?: SendExtras) => Promise.resolve());
    const requests = mount(<Composer onSend={onSend} input={INPUT} />, {});
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Mesaj' });
    await userEvent.type(box, 'anahtarım ');
    paste(box, RAW);
    await waitFor(() => {
      expect(box.value).toBe('anahtarım {{secret:pasted-1:openai}}');
    });
    const warning = screen.getByTestId('dy-secret-warning');
    expect(warning.textContent).toContain('OpenAI API anahtarı');
    expect(warning.textContent).toContain('Kasaya kaydet');
    expect(pastedSecret('pasted-1')?.value).toBe(RAW);
    await userEvent.type(box, '{Enter}');
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
    });
    expect(onSend.mock.calls[0]?.[0]).toBe('anahtarım {{secret:pasted-1:openai}}');
    for (const r of requests) expect(JSON.stringify(r)).not.toContain(RAW);
  });

  it('a typed secret is replaced on send too', async () => {
    const onSend = vi.fn((_t: string, _e?: SendExtras) => Promise.resolve());
    mount(<Composer onSend={onSend} input={INPUT} />, {});
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Mesaj' });
    fireEvent.change(box, { target: { value: `token=${RAW} kullan` } });
    await userEvent.type(box, '{Enter}');
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
    });
    const sent = String(onSend.mock.calls[0]?.[0]);
    expect(sent).not.toContain(RAW);
    expect(sent).toContain('{{secret:pasted-1:openai}}');
  });

  it('"Kasaya kaydet" seals in the browser, creates the credential and puts its badge token in the field', async () => {
    const k = await workerKey();
    const onSend = vi.fn((_t: string, _e?: SendExtras) => Promise.resolve());
    const requests = mount(<Composer onSend={onSend} input={INPUT} />, {
      'GET /api/vault/workers': () => ({
        status: 200,
        body: {
          items: [
            {
              workerId: W1,
              displayName: 'linux-1',
              state: 'online',
              connected: true,
              supported: true,
              functionSupported: true,
              key: {
                keyId: k.keyId,
                publicKey: k.publicKey,
                fingerprint: 'X25519:ABCD',
                createdAt: '2026-10-14T10:00:00.000Z',
                pinnedAt: '2026-10-14T10:00:00.000Z',
              },
              previousKeyId: null,
            },
          ],
        },
      }),
      'GET /api/vault/credentials': () => ({
        status: 200,
        body: { items: [], total: 0, offset: 0, limit: 500 },
      }),
      'POST /api/vault/credentials': (req) => ({
        status: 200,
        body: {
          id: (req.body as { id: string }).id,
          name: 'OPENAI_API_KEY',
          kind: 'http-auth',
          env: 'OPENAI_API_KEY',
          description: null,
          version: 1,
          state: 'active',
          createdAt: '2026-10-22T10:00:00.000Z',
          createdBy: USER.id,
          updatedAt: '2026-10-22T10:00:00.000Z',
          revokedAt: null,
          lastUsedAt: null,
          allowedHosts: ['api.openai.com'],
          workers: [],
        },
      }),
    });
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Mesaj' });
    paste(box, RAW);
    await userEvent.click(await screen.findByRole('button', { name: 'Kasaya kaydet' }));
    const panel = await screen.findByTestId('vault-save-panel');
    expect(screen.getByLabelText<HTMLInputElement>(/Ad \(değişken adı\)/).value).toBe('OPENAI_API_KEY');
    expect(screen.getByTestId<HTMLTextAreaElement>('vault-save-hosts').value).toBe('api.openai.com');
    await waitFor(() => {
      expect(panel.textContent).toContain('linux-1');
    });
    await userEvent.click(screen.getByRole('button', { name: 'Mühürle ve kaydet' }));
    await waitFor(() => {
      expect(box.value).toBe('{{credential:OPENAI_API_KEY}}');
    });
    const post = requests.find((r) => r.method === 'POST' && r.url === '/api/vault/credentials');
    const body = post?.body as {
      id: string;
      kind: string;
      env: string;
      allowedHosts: string[];
      workers: { workerId: string; keyId: string; sealed: SealedValue }[];
    };
    expect(body).toMatchObject({
      id: 'openai-api-key',
      kind: 'http-auth',
      env: 'OPENAI_API_KEY',
      allowedHosts: ['api.openai.com'],
    });
    for (const r of requests) expect(JSON.stringify(r)).not.toContain(RAW);
    const opened = await openCredential(
      body.workers[0]?.sealed as SealedValue,
      k.privateKey,
      k.publicKey,
      {
        workerId: W1,
        credentialId: 'openai-api-key',
        version: 1,
        keyId: k.keyId,
        kind: 'http-auth',
        env: 'OPENAI_API_KEY',
      },
      webcrypto.subtle as never,
    );
    expect(opened).toBe(RAW);
    // The tab forgot the value once it was sealed.
    expect(pastedSecret('pasted-1')).toBeUndefined();
  });
});

describe('credentials in mentions and messages', () => {
  it('@ autocomplete lists vault credentials with name and kind', async () => {
    const onSend = vi.fn((_t: string, _e?: SendExtras) => Promise.resolve());
    mount(<Composer onSend={onSend} input={INPUT} />, {
      'GET /api/chat/mentions?q=': () => ({
        status: 200,
        body: {
          items: [
            {
              type: 'credential',
              id: 'api-token',
              project: null,
              label: 'API_TOKEN',
              detail: 'http-auth · api.x.test',
            },
          ],
        },
      }),
    });
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Mesaj' });
    await userEvent.type(box, '@');
    const option = await screen.findByRole('option', { name: /API_TOKEN/ });
    expect(option.textContent).toContain('Kimlik bilgisi');
    expect(option.textContent).toContain('http-auth');
    await userEvent.keyboard('{Enter}');
    await userEvent.type(box, 'ile istek at{Enter}');
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
    });
    expect(onSend.mock.calls[0]?.[1]).toEqual({ mentions: [{ type: 'credential', id: 'api-token' }] });
  });

  it('a sent message shows credential and secret tokens as chips (never raw text)', () => {
    mount(
      <MentionText
        text="use {{credential:API_TOKEN}} not {{secret:pasted-1:openai}} or {{credential:GONE}}"
        meta={{
          credentials: [
            {
              name: 'API_TOKEN',
              id: 'api-token',
              kind: 'http-auth',
              allowedHosts: ['api.x.test'],
              machines: 2,
            },
            { name: 'GONE', id: null, kind: null, allowedHosts: null, machines: 0 },
          ],
        }}
      />,
      {},
    );
    const chips = screen.getAllByTestId('credential-chip');
    expect(chips).toHaveLength(2);
    expect(chips[0]?.getAttribute('href')).toBe('/settings/credentials#credential-api-token');
    expect(chips[0]?.getAttribute('aria-label')).toContain('2 makinede');
    expect(chips[1]?.getAttribute('data-missing')).toBe('');
    expect(screen.getByTestId('secret-chip').textContent).toContain('Kaydedilmemiş gizli değer');
    expect(screen.getByTestId('mention-text').textContent).not.toContain('{{');
  });
});
