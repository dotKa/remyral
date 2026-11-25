import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base64UrlToBytes, enablePush, isIos, pushSupport, syncPush } from '../src/pwa/push';
import {
  applyUpdate,
  handleWorkerMessage,
  MSG_SKIP_WAITING,
  PUSH_EVENT,
  registerServiceWorker,
  resetServiceWorkerState,
  setNavigateHandler,
  UPDATE_FALLBACK_MS,
} from '../src/pwa/serviceWorker';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuthState } from '../src/auth/AuthProvider';
import { fakeFetch, type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

const SIGNED_IN: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };

/**
 * p8-pwa (docs/design/p8-pwa.md): update flow, worker messages, push subscription handling (fake
 * PushManager), the Devices page "This device" / "Push devices" cards and the Push column in settings.
 */
const KEY = 'BOrXY5vAQVSHJW7VR1rthd1IzXBYS5ve0mplPITSyM5aBYtgNrdbFzkq0cP0yo63uJR76uaYeR8ZLK_nIwnX5c4';
const SUB = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) },
};
const CSRF = '__Host-ras-csrf=csrf-from-cookie';

class FakeTarget {
  private readonly l = new Map<string, ((e: unknown) => void)[]>();
  addEventListener(t: string, fn: (e: unknown) => void): void {
    this.l.set(t, [...(this.l.get(t) ?? []), fn]);
  }
  fire(t: string, e: unknown = {}): void {
    for (const fn of this.l.get(t) ?? []) fn(e);
  }
}

class FakeWorker extends FakeTarget {
  state = 'installing';
  readonly posted: unknown[] = [];
  postMessage(m: unknown): void {
    this.posted.push(m);
  }
}

class FakeSubscription {
  unsubscribed = false;
  constructor(
    readonly endpoint: string,
    readonly key: Uint8Array,
  ) {}
  get options(): { applicationServerKey: ArrayBuffer } {
    return { applicationServerKey: this.key.slice().buffer };
  }
  toJSON(): unknown {
    return { endpoint: this.endpoint, keys: SUB.keys };
  }
  unsubscribe(): Promise<boolean> {
    this.unsubscribed = true;
    return Promise.resolve(true);
  }
}

function fakePushManager(existing: FakeSubscription | null) {
  const pm = {
    current: existing,
    subscribeCalls: [] as unknown[],
    getSubscription: () => Promise.resolve(pm.current),
    subscribe: (opts: { applicationServerKey: Uint8Array }) => {
      pm.subscribeCalls.push(opts);
      pm.current = new FakeSubscription(SUB.endpoint, opts.applicationServerKey);
      return Promise.resolve(pm.current);
    },
  };
  return pm;
}

function pushEnv(pm: ReturnType<typeof fakePushManager>, permission: NotificationPermission = 'granted') {
  vi.stubGlobal('Notification', { permission, requestPermission: vi.fn(() => Promise.resolve(permission)) });
  vi.stubGlobal('PushManager', function PushManager() {});
  const reg = { pushManager: pm };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: () => Promise.resolve(reg), addEventListener: () => undefined },
  });
  return { win: window, nav: navigator };
}

afterEach(() => {
  resetServiceWorkerState();
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

describe('service worker update flow', () => {
  it('Reload still reloads when the waiting worker never takes over, or is already redundant', async () => {
    const container = new FakeTarget() as FakeTarget & {
      controller: unknown;
      register: (url: string, o: unknown) => Promise<unknown>;
    };
    const reg = new FakeTarget() as FakeTarget & {
      waiting: FakeWorker | null;
      installing: FakeWorker | null;
      update: () => Promise<void>;
    };
    reg.waiting = null;
    reg.installing = null;
    reg.update = vi.fn(() => Promise.resolve());
    container.controller = { id: 'old' };
    container.register = vi.fn(() => Promise.resolve(reg));
    await registerServiceWorker({
      container: container as unknown as ServiceWorkerContainer,
      doc: document,
      reload: vi.fn(),
      setInterval: () => 0,
    });
    const w = new FakeWorker();
    reg.installing = w;
    reg.fire('updatefound');
    w.state = 'installed';
    w.fire('statechange');

    vi.useFakeTimers();
    try {
      const reload = vi.fn();
      applyUpdate({ reload });
      expect(w.posted).toEqual([{ type: MSG_SKIP_WAITING }]);
      expect(reload).not.toHaveBeenCalled();
      vi.advanceTimersByTime(UPDATE_FALLBACK_MS);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }

    w.state = 'redundant';
    const reload2 = vi.fn();
    applyUpdate({ reload: reload2 });
    expect(reload2).toHaveBeenCalledTimes(1);
  });

  it('without service worker support registration is a no-op', async () => {
    expect(
      await registerServiceWorker({
        container: undefined,
        doc: document,
        reload: vi.fn(),
        setInterval: () => 0,
      }),
    ).toBeNull();
    const reload = vi.fn();
    applyUpdate({ reload });
    expect(reload).toHaveBeenCalled();
  });

  it('worker messages: push refreshes the bell, navigate routes only to console paths', () => {
    const onPush = vi.fn();
    window.addEventListener(PUSH_EVENT, onPush);
    handleWorkerMessage({ type: 'remyral:push' });
    expect(onPush).toHaveBeenCalledTimes(1);
    window.removeEventListener(PUSH_EVENT, onPush);
    const nav = vi.fn();
    setNavigateHandler(nav);
    handleWorkerMessage({ type: 'remyral:navigate', link: '/approvals/1' });
    handleWorkerMessage({ type: 'remyral:navigate', link: '//evil.example' });
    handleWorkerMessage({ type: 'remyral:navigate', link: 'https://evil.example' });
    handleWorkerMessage('garbage');
    expect(nav.mock.calls).toEqual([['/approvals/1']]);
  });
});

describe('push subscription (browser side)', () => {
  beforeEach(() => {
    stubCookies(CSRF);
  });

  it('detects iOS (incl. iPadOS) and reports that push needs the installed app there', () => {
    expect(
      isIos({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', maxTouchPoints: 5 }),
    ).toBe(true);
    expect(isIos({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 })).toBe(
      true,
    );
    expect(isIos({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 })).toBe(
      false,
    );
    const iphoneTab = {
      win: { matchMedia: () => ({ matches: false }) } as unknown as Window,
      nav: {
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
        maxTouchPoints: 5,
      } as Navigator,
    };
    expect(pushSupport(iphoneTab)).toBe('ios-needs-install');
    const desktopNoPush = {
      win: { matchMedia: () => ({ matches: false }) } as unknown as Window,
      nav: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', maxTouchPoints: 0 } as Navigator,
    };
    expect(pushSupport(desktopNoPush)).toBe('unsupported');
  });

  it('decodes the VAPID key', () => {
    expect(base64UrlToBytes(KEY)).toHaveLength(65);
    expect(base64UrlToBytes(KEY)[0]).toBe(4);
  });

  it('enable: asks permission, subscribes with the VAPID key, registers; replaces a subscription of an old key', async () => {
    const old = new FakeSubscription(SUB.endpoint, new Uint8Array([4, 1, 2]));
    const pm = fakePushManager(old);
    const e = pushEnv(pm);
    const register = vi.fn(() => Promise.resolve());
    await enablePush(KEY, register, e);
    expect(old.unsubscribed).toBe(true);
    expect(pm.subscribeCalls).toHaveLength(1);
    expect(pm.subscribeCalls[0]).toMatchObject({ userVisibleOnly: true });
    expect(register).toHaveBeenCalledWith({ endpoint: SUB.endpoint, keys: SUB.keys });
  });

  it('enable: a denied permission is reported, nothing is subscribed', async () => {
    const pm = fakePushManager(null);
    const e = pushEnv(pm, 'denied');
    await expect(enablePush(KEY, vi.fn(), e)).rejects.toThrow('blocked');
    expect(pm.subscribeCalls).toHaveLength(0);
  });

  it('sync: refreshes a known subscription; drops it when the master no longer knows it', async () => {
    const sub = new FakeSubscription(SUB.endpoint, base64UrlToBytes(KEY));
    const e = pushEnv(fakePushManager(sub));
    const ok = fakeFetch({
      'POST /api/notifications/push/subscriptions': () => ({
        status: 200,
        body: {
          created: false,
          device: {
            id: 'd1',
            label: 'Chrome on Android',
            service: 'fcm.googleapis.com',
            createdAt: 'x',
            lastSeenAt: 'x',
            lastSuccessAt: null,
          },
        },
      }),
    });
    vi.stubGlobal('fetch', ok.fetch);
    expect(await syncPush(KEY, e)).toBe('on');
    expect(ok.requests[0]?.body).toEqual({ endpoint: SUB.endpoint, keys: SUB.keys });
    expect(sub.unsubscribed).toBe(false);

    const gone = fakeFetch({
      'POST /api/notifications/push/subscriptions': () => ({
        status: 403,
        body: { error: 'step_up_required', message: 'Confirm with a current authenticator code.' },
      }),
    });
    vi.stubGlobal('fetch', gone.fetch);
    expect(await syncPush(KEY, e)).toBe('off');
    expect(sub.unsubscribed).toBe(true);
  });
});

// p15-classic-removal: the classic Devices card test, on the Diyalog Ayarlar → Cihazlar page.
describe('Ayarlar → Cihazlar: this device and push devices', () => {
  const DEVICE = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    label: 'Safari on iOS',
    service: 'web.push.apple.com',
    createdAt: '2026-10-16T08:00:00.000Z',
    lastSeenAt: '2026-10-16T09:00:00.000Z',
    lastSuccessAt: null,
  };
  const base: Record<string, Handler> = {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/auth/devices': () => ({ status: 200, body: { devices: [] } }),
  };

  it('says when push is not configured on the master', async () => {
    renderApp({
      path: '/settings/devices',
      initialState: SIGNED_IN,
      routes: {
        ...base,
        'GET /api/notifications/push': () => ({
          status: 200,
          body: { available: false, publicKey: null, devices: [] },
        }),
      },
    });
    expect(await screen.findByText('Bu kurulumda push bildirimleri ayarlı değil.')).toBeTruthy();
    expect(screen.queryByTestId('dy-push-devices')).toBeNull();
  });

  it('turns push on with a step-up, enables the recommended kinds once, lists and revokes devices', async () => {
    stubCookies(CSRF);
    const pm = fakePushManager(null);
    pushEnv(pm, 'default');
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: vi.fn(() => Promise.resolve('granted')),
    });
    const user = userEvent.setup();
    let devices: (typeof DEVICE)[] = [];
    let stepped = false;
    const kinds = ['approval.requested', 'job.failed', 'budget.threshold'].map((kind) => ({
      kind,
      label: kind,
      description: kind,
      email: false,
      webhook: false,
      push: false,
    }));
    const prefs = () => ({
      status: 200,
      body: {
        kinds,
        channels: {
          email: { available: false, address: null },
          webhook: { available: false, url: null },
          push: { available: true, devices: devices.length },
        },
      },
    });
    const { requests } = renderApp({
      path: '/settings/devices',
      initialState: SIGNED_IN,
      routes: {
        ...base,
        'GET /api/notifications/push': () => ({
          status: 200,
          body: { available: true, publicKey: KEY, devices },
        }),
        'POST /api/notifications/push/subscriptions': () => {
          if (!stepped) return { status: 403, body: { error: 'step_up_required', message: 'Confirm.' } };
          devices = [DEVICE];
          return { status: 200, body: { device: DEVICE, created: true } };
        },
        'POST /api/auth/step-up': () => {
          stepped = true;
          return { status: 200, body: { stepUpValidUntil: '2026-10-16T10:00:00.000Z' } };
        },
        'GET /api/notifications/preferences': prefs,
        'PUT /api/notifications/preferences': prefs,
        [`DELETE /api/notifications/push/subscriptions/${DEVICE.id}`]: () => {
          devices = [];
          return { status: 200, body: { status: 'revoked' } };
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Push bildirimlerini aç' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sen olduğunu onayla' });
    fireEvent.change(within(dialog).getByLabelText('6 haneli kod'), { target: { value: '123456' } });
    expect(await screen.findByText(/Bu cihazda push açık: onaylar/)).toBeTruthy();
    const put = requests.find((r) => r.method === 'PUT' && r.url === '/api/notifications/preferences');
    expect(put?.body).toEqual({
      kinds: [
        { kind: 'approval.requested', push: true },
        { kind: 'job.failed', push: true },
      ],
    });
    const list = await screen.findByTestId('dy-push-devices');
    expect(await within(list).findByText('Safari on iOS')).toBeTruthy();
    await user.click(within(list).getByTestId(`push-revoke-${DEVICE.id}`));
    await user.click(within(list).getByTestId(`push-revoke-${DEVICE.id}-confirm`));
    expect(await screen.findByText('Safari on iOS artık push bildirimi almıyor.')).toBeTruthy();
    expect(requests.some((r) => r.method === 'DELETE')).toBe(true);
  });
});
