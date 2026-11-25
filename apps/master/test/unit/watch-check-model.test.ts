import { messagesFor } from '@remyral/i18n/all';
import { describe, expect, it } from 'vitest';
import {
  checkJobSpec,
  conditionRef,
  conditionText,
  globToLike,
  httpCheckSpec,
  judgeHttp,
  nextDelaySec,
  probeCheckSpec,
  safeUrl,
  subjectOf,
  WatchCheckRefusal,
} from '../../src/chat/watch-check-model.js';

/**
 * p15-watches (Takipler): the pure rules of check watches — subjects the triggers notify, the polling backoff, the
 * function specs of remote checks (public hosts and the egress policy only; loopback only through probes), how an
 * HTTP answer is judged (status, body, JSONata) and how a condition reads in Turkish and English.
 */
const JOB = '6f1c0e3a-5b8d-4f7e-9a1b-2c3d4e5f6a7b';
const open = { mode: 'open' as const, hosts: [] };

describe('watch check model', () => {
  it('subjects: one per event condition, none for polled checks', () => {
    expect(subjectOf({ kind: 'job_state', jobId: JOB, states: ['finished'] })).toBe(`job:${JOB}`);
    expect(subjectOf({ kind: 'job_event', jobId: JOB, contains: 'x' })).toBe(`jobev:${JOB}`);
    expect(subjectOf({ kind: 'job_output', jobId: JOB })).toBe(`jobout:${JOB}`);
    expect(subjectOf({ kind: 'preview_up', jobId: JOB })).toBe(`pvjob:${JOB}`);
    expect(subjectOf({ kind: 'preview_up', project: 'alpha', name: 'web' })).toBe('pvname:alpha:web');
    expect(subjectOf({ kind: 'machine', workerId: 'wrk_x', state: 'online' })).toBe('worker:wrk_x');
    expect(subjectOf({ kind: 'http', project: 'alpha', url: 'https://a.example' })).toBeNull();
  });

  it('the same condition has the same ref whatever the key order', () => {
    expect(conditionRef({ kind: 'job_state', jobId: JOB, states: ['failed'] })).toBe(
      conditionRef({ states: ['failed'], jobId: JOB, kind: 'job_state' } as never),
    );
    expect(conditionRef({ kind: 'job_state', jobId: JOB, states: ['failed'] })).toMatch(/^chk_[0-9a-f]{16}$/);
  });

  it('backoff: ×1.5 per miss, never below 30 s, never above 15 min', () => {
    expect(nextDelaySec(60, 0)).toBe(60);
    expect(nextDelaySec(60, 1)).toBe(90);
    expect(nextDelaySec(60, 2)).toBe(135);
    expect(nextDelaySec(5, 0)).toBe(30);
    expect(nextDelaySec(60, 30)).toBe(900);
    expect(nextDelaySec(10_000, 0)).toBe(900);
  });

  it('globs become LIKE patterns with escaped wildcards', () => {
    expect(globToLike('*.apk')).toBe('%.apk');
    expect(globToLike('report_100%.pdf')).toBe('report\\_100\\%.pdf');
  });

  it('http checks: public hosts under the egress policy; loopback, LAN and metadata refused', () => {
    const s = httpCheckSpec({
      url: 'https://app.example.com/health#x',
      method: 'GET',
      key: 'k1',
      egress: open,
    });
    expect(s.request.url).toBe('https://app.example.com/health');
    expect(s.request.headers['User-Agent']).toBe('Remyral-Watch/1.0');
    for (const url of [
      'http://localhost:3000/',
      'http://127.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://printer.lan/',
      'http://2130706433/',
      'https://user:pw@app.example.com/',
    ])
      expect(() => httpCheckSpec({ url, method: 'GET', key: 'k', egress: open }), url).toThrow(
        WatchCheckRefusal,
      );
    expect(() =>
      httpCheckSpec({ url: 'https://app.example.com:9999/', method: 'GET', key: 'k', egress: open }),
    ).toThrow(/needs a app.example.com:9999 entry/);
    expect(() =>
      httpCheckSpec({
        url: 'https://other.example.com/',
        method: 'GET',
        key: 'k',
        egress: { mode: 'allowlist', hosts: ['app.example.com'] },
      }),
    ).toThrow(/allowlist/);
  });

  it('probe and job specs: pinned to the chosen machine, no agent, bounded', () => {
    const fn = probeCheckSpec({ type: 'http', port: 3000 }, 'k');
    expect(fn).toMatchObject({
      type: 'probe',
      probe: { kind: 'http', port: 3000, path: '/', method: 'GET' },
    });
    const spec = checkJobSpec({ project: 'alpha', watchId: JOB, fn, workerId: 'wrk_a' });
    expect(spec).toMatchObject({
      kind: 'function',
      projectId: 'alpha',
      sandboxProfile: 'container',
      requirements: { workers: ['wrk_a'] },
    });
    expect((spec.limits as { maxDurationSec: number }).maxDurationSec).toBeLessThanOrEqual(600);
  });

  it('judging answers: status default 2xx/3xx, body text, JSONata value captured', async () => {
    const never = () => Promise.resolve({ ok: false as const, code: 'expr_unavailable' });
    const a = { status: 200, headers: {}, body: { ok: true, url: 'https://x' }, durationMs: 5 };
    expect((await judgeHttp(undefined, a, never)).met).toBe(true);
    expect((await judgeHttp(undefined, { ...a, status: 503 }, never)).met).toBe(false);
    expect((await judgeHttp({ status: [503] }, { ...a, status: 503 }, never)).met).toBe(true);
    expect((await judgeHttp({ bodyContains: 'URL' }, a, never)).met).toBe(true);
    expect((await judgeHttp({ bodyContains: 'missing' }, a, never)).met).toBe(false);
    const ok = await judgeHttp({ jsonata: 'body.url' }, a, () =>
      Promise.resolve({ ok: true, value: 'https://x' }),
    );
    expect(ok).toMatchObject({ met: true, value: 'https://x' });
    const falsy = await judgeHttp({ jsonata: 'body.ok = false' }, a, () =>
      Promise.resolve({ ok: true, value: false }),
    );
    expect(falsy.met).toBe(false);
    const broken = await judgeHttp({ jsonata: '((' }, a, () =>
      Promise.resolve({ ok: false, code: 'expr_syntax' }),
    );
    expect(broken).toMatchObject({ met: false, refused: 'expr_syntax' });
  });

  it('reads in both languages', () => {
    const c = { kind: 'preview_up' as const, jobId: JOB, http: true };
    expect(conditionText(messagesFor('tr').watches, c)).toBe(
      'İş 6f1c0e3a önizleme bağlantısı ayakta ve adres cevap veriyor',
    );
    expect(conditionText(messagesFor('en').watches, c)).toBe(
      'Preview link of job 6f1c0e3a is up and its address answers',
    );
    expect(
      conditionText(
        messagesFor('tr').watches,
        { kind: 'worker_probe', project: 'a', workerId: 'wrk_x', probe: { type: 'http', port: 3000 } },
        { machine: 'mac-mini' },
      ),
    ).toBe('mac-mini makinesinde localhost:3000/ cevap veriyor');
  });

  it('only http(s) links without spaces or Markdown breakers are delivered', () => {
    expect(safeUrl('https://web-abc.example.com')).toBe('https://web-abc.example.com');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('https://x.example/a) [b](c')).toBeNull();
  });

  it('p21-service-exit: a service_url watch with exited names the end of the command', () => {
    expect(
      conditionText(messagesFor('tr').watches, { kind: 'service_url', serviceId: 'svc-1', exited: true }),
    ).toBe('Servis svc-1 komutu bitti');
    expect(conditionText(messagesFor('en').watches, { kind: 'service_url', serviceId: 'svc-1' })).toBe(
      'URL of service svc-1 is up',
    );
  });
});
