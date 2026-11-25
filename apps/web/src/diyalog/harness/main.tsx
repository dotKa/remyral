import { type ReactNode, StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { App } from '../../App';
import { type AuthState, AuthProvider } from '../../auth/AuthProvider';
import { StepUpProvider, useStepUp } from '../../stepup/StepUpProvider';
import { DyStepUpDialog } from '../DyStepUpDialog';
import { Chip } from '../Chip';
import { CodeBlock } from '../CodeBlock';
import { Countdown } from '../Countdown';
import { KeyValue } from '../KeyValue';
import { CardButton, LiveCard } from '../LiveCard';
import { Message } from '../Message';
import { ChipStrip, Rail, RailSection } from '../Rail';
import { RuntimeMark } from '../RuntimeMark';
import { StateBadge } from '../StateBadge';
import { Thread } from '../Thread';
import { installFixtureApi } from './fixtures';
import '../../fonts.css';
import '../../index.css';

/**
 * p12-diyalog visual harness (dev server only: `pnpm --filter @remyral/web dev`, then /diyalog-harness.html).
 *   ?view=shell       the whole signed-in app on the Diyalog shell over a fixture API (default)
 *   ?view=primitives  every primitive in its states
 *   ?theme=light|dark forces the scheme of the primitives view (the shell follows the browser scheme)
 *   &auth=checking|signedOut|totp|recovery|enroll|codes|password  a sign-in step (p12-diyalog-w4; path /login)
 *   &stepup=1         opens the step-up confirmation on load (inside the shell)
 *   ?path=/nope       "Sayfa bulunamadı"; ?path=/sso/continue?flow=coolify%26r=… the Coolify sign-on screen
 *   &delay=800        every fixture answer 800 ms late (loading states, skeleton → data layout shift)
 */

const q = new URLSearchParams(window.location.search);
const view = q.get('view') ?? 'shell';
const theme = q.get('theme');

const later = (min: number): string => new Date(Date.now() + min * 60_000).toISOString();
const earlier = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();

const SAMPLE = [
  { key: 's', kind: 'system' },
  { key: 'me', kind: 'me' },
  { key: 'a', kind: 'assistant' },
  { key: 'card', kind: 'card' },
  { key: 'agent', kind: 'agent' },
  { key: 'resolved', kind: 'resolved' },
  { key: 'warn', kind: 'warn' },
] as const;

function Sample(props: { readonly kind: (typeof SAMPLE)[number]['kind'] }): ReactNode {
  switch (props.kind) {
    case 'system':
      return (
        <Message role="system" at={earlier(70)} atText="Bugün, Pazartesi 19 Ekim">
          {' '}
        </Message>
      );
    case 'me':
      return (
        <Message role="me" at={earlier(70)} atText="12:58" author="Alex K.">
          Günaydın. Öğlene kadar ne birikti, kısaca söyle.
        </Message>
      );
    case 'assistant':
      return (
        <Message role="assistant" meta="operasyon asistanı" at={earlier(60)} atText="13:24">
          <p className="m-0 mb-2.5">
            Sabahtan beri <strong>37 iş</strong> bitti, 31’i başarılı. Şu an 5 iş çalışıyor, 4’ü kuyrukta. 23
            slotun 9’u dolu. ridge-lnx-03 2 saattir kapalı.
          </p>
          <p className="m-0">
            Senden <strong>5 karar</strong> bekliyor. Önem sırasına koydum; ilki 42 dakika içinde
            kendiliğinden duraklayacak.
          </p>
        </Message>
      );
    case 'card':
      return (
        <LiveCard
          kind={{ label: 'Onay, yüksek risk', icon: 'shield', tone: 'amber' }}
          meta="Bayat, 18 dk bekliyor"
          aside="1 / 5"
          title="Vitest 5’e geç ve deprecation uyarılarını temizle"
          sub={
            <>
              <span>mobil-app</span>
              <RuntimeMark runtime="claude-code" />
              <span>kestrel-mac, slot 3/4</span>
            </>
          }
          actions={
            <>
              <CardButton variant="warn" icon="check">
                Onayla
              </CardButton>
              <CardButton>Reddet</CardButton>
              <CardButton variant="ghost">Ajana sor</CardButton>
            </>
          }
          hint="Onay kod ister"
        >
          <div className="rounded-[10px] bg-dy-sunk px-3.5 py-2.5">
            <small className="mb-0.5 block text-[0.78125rem] font-bold text-dy-muted">Ajan diyor ki</small>
            Kilit dosyası eski vite 5 sürümünü sabitliyor; node_modules ve pnpm store önbelleğini silip
            yeniden kurmam gerekiyor.
          </div>
          <CodeBlock
            className="mt-2.5"
            code="rm -rf node_modules ~/Library/pnpm/store/v3 && pnpm install --no-frozen-lockfile"
          />
          <KeyValue
            className="mt-3"
            rows={[
              { k: 'Siler', v: 'mobil-app/node_modules', mono: true },
              { k: 'Dal', v: 'int/7c1e09ab', mono: true },
            ]}
          />
          <Countdown className="mt-3" label="Duraklamaya" until={later(41.6)} from={earlier(18)} />
        </LiveCard>
      );
    case 'agent':
      return (
        <Message
          role="agent"
          runtime="codex"
          author="Codex"
          meta="mobil-app · atlas-win-01"
          at={earlier(5)}
          atText="13:31"
        >
          Login testindeki yarış koşulunu buldum; bekleme yerine olay dinleyicisi kullanıyorum.
        </Message>
      );
    case 'resolved':
      return (
        <LiveCard
          kind={{ label: 'Deploy', icon: 'rocket', tone: 'teal' }}
          state={<StateBadge state="done" />}
          title="vitrin-web production"
          resolved={<span className="text-dy-muted">Alex onayladı, 12:40 · 2 dk 14 sn</span>}
        >
          <KeyValue rows={[{ k: 'Sürüm', v: 'v2.18.0', mono: true }]} />
        </LiveCard>
      );
    case 'warn':
      return (
        <Message role="system" tone="warn" icon="xc" at={earlier(3)} atText="13:33">
          ridge-lnx-03 bağlantısı koptu
        </Message>
      );
  }
}

function Primitives(): ReactNode {
  return (
    <div
      data-ui="diyalog"
      {...(theme === 'light' || theme === 'dark' ? { 'data-theme': theme } : {})}
      className="dy-surface min-h-dvh bg-dy-bg"
    >
      <ChipStrip
        label="Bağlam özeti"
        chips={[
          { key: 'n', text: 'karar', value: '5', icon: 'shield', hot: true, to: '#' },
          { key: 'o', text: 'Onay', value: '41:36', icon: 'clock', to: '#' },
          { key: 'c', text: 'Claude', value: '%72', icon: 'gauge', to: '#' },
          { key: 's', text: 'Slot', value: '9/23', icon: 'cpu', to: '#' },
        ]}
      />
      <div className="grid grid-cols-1 min-[900px]:grid-cols-[minmax(0,1fr)_312px]">
        <main className="bg-dy-thread px-3 py-4 sm:px-6">
          <div className="mx-auto flex max-w-[780px] flex-col gap-[18px]">
            <div className="flex flex-wrap gap-3">
              {(
                ['running', 'queued', 'needs', 'paused', 'stale', 'failed', 'done', 'cancelled'] as const
              ).map((s) => (
                <StateBadge key={s} state={s} />
              ))}
            </div>
            <div className="flex flex-wrap gap-3">
              {['claude-code', 'codex', 'pi', 'opencode'].map((r) => (
                <RuntimeMark key={r} runtime={r} />
              ))}
              <Chip value="3" hot>
                karar
              </Chip>
              <Chip icon="cpu" value="9/23">
                Slot
              </Chip>
            </div>
            <Thread
              label="Örnek dizi"
              items={SAMPLE}
              itemKey={(s) => s.key}
              renderItem={(s) => <Sample kind={s.kind} />}
            />
          </div>
        </main>
        <Rail label="Bağlam" className="!flex">
          <RailSection title="Slotlar" count="9/23">
            <p className="m-0 text-[0.8125rem] text-dy-muted">Makine satırları burada.</p>
          </RailSection>
          <RailSection title="Limit pencereleri">
            <Countdown
              label="Claude Code 5 saat sıfırlanma"
              until={later(56)}
              from={earlier(244)}
              tone="violet"
            />
          </RailSection>
        </Rail>
      </div>
    </div>
  );
}

// p12-diyalog-w4: the sign-in steps (the auth stage machine starts at the given step; no session probe).
const HARNESS_USER = { id: 'u1', username: 'alex', role: 'owner' };
const QR =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" shape-rendering="crispEdges"><rect width="21" height="21" fill="#fff"/><path d="M0 0h7v7H0zM14 0h7v7h-7zM0 14h7v7H0zM9 2h2v2H9zM9 6h3v2H9zM2 9h4v2H2zM9 9h3v3H9zM14 9h2v2h-2zM18 10h3v2h-3zM10 14h2v3h-2zM14 14h3v3h-3zM18 18h3v3h-3zM9 19h3v2H9z" fill="#000"/><path d="M2 2h3v3H2zM16 2h3v3h-3zM2 16h3v3H2z" fill="#fff"/></svg>';
function authState(step: string | null): AuthState {
  switch (step) {
    case 'checking':
      return { kind: 'checking' };
    case 'signedOut':
      return { kind: 'signedOut', notice: 'Your session has ended. Sign in again.' };
    case 'totp':
      return { kind: 'secondFactor', method: 'totp' };
    case 'recovery':
      return { kind: 'secondFactor', method: 'recovery' };
    case 'enroll':
      return {
        kind: 'enrollment',
        setup: {
          otpauthUri: 'otpauth://totp/Remyral:alex?secret=JBSWY3DPEHPK3PXP',
          secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
          qrSvg: QR,
        },
        setupError: null,
      };
    case 'codes':
      return {
        kind: 'recoveryCodes',
        user: HARNESS_USER,
        codes: Array.from({ length: 10 }, (_, i) => `k7qm-4x2p-${String(1000 + i * 137)}`),
        passwordChangeRequired: false,
      };
    case 'password':
      return { kind: 'passwordChange', user: HARNESS_USER, remainingRecoveryCodes: 10 };
    default:
      return { kind: 'signedIn', user: HARNESS_USER, session: null, remainingRecoveryCodes: null };
  }
}

/** `&stepup=1`: asks for a step-up once the shell is up. */
function OpenStepUp(): ReactNode {
  const stepUp = useStepUp();
  useEffect(() => {
    void stepUp.confirm('Taslağı onaylamak taze bir authenticator kodu ister.');
  }, [stepUp]);
  return null;
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

if (view === 'primitives') {
  createRoot(root).render(
    <StrictMode>
      <MemoryRouter>
        <Primitives />
      </MemoryRouter>
    </StrictMode>,
  );
} else {
  installFixtureApi();
  // The sign-in options the steps read (Remember me, Trust this device).
  const fixtureFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (new URL(raw, window.location.origin).pathname === '/api/auth/options')
      return Promise.resolve(
        new Response(
          JSON.stringify({ rememberMe: { idleDays: 7, absoluteDays: 30 }, trustedDevice: { days: 30 } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    return fixtureFetch(input, init);
  };
  // p12-diyalog-default (visual tour): `&delay=<ms>` answers every fixture request late, so loading states and the
  // layout shift between skeleton and data can be seen and measured.
  const delay = Number(q.get('delay') ?? '0');
  if (Number.isFinite(delay) && delay > 0) {
    const immediate = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      new Promise((resolve) => setTimeout(resolve, delay)).then(() => immediate(input, init));
  }
  const step = q.get('auth');
  createRoot(root).render(
    <StrictMode>
      <MemoryRouter initialEntries={[step === null ? (q.get('path') ?? '/') : '/login']}>
        <AuthProvider initialState={authState(step)}>
          <App />
          {q.get('stepup') === '1' ? (
            // Its own provider with the Diyalog dialog (the shell's provider is not reachable from here).
            <div data-ui="diyalog">
              <StepUpProvider dialog={DyStepUpDialog}>
                <OpenStepUp />
              </StepUpProvider>
            </div>
          ) : null}
        </AuthProvider>
      </MemoryRouter>
    </StrictMode>,
  );
}
