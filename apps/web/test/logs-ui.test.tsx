import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatClock, formatElapsed } from '../src/components/LogLines';
import { measureServerClock } from '../src/lib/serverClock';
import { workerLogRows } from '../src/screens/fleet/workerLogLines';

/** p6-logs-ui: timestamp gutter, stream badges, attempt separators, toggles; header server clock. */

/** Local wall-clock instants, so the expected HH:MM:SS.mmm does not depend on the test machine's zone. */
const T0 = new Date(2026, 9, 16, 14, 3, 21, 123).getTime();

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('log formatting', () => {
  it('clock and elapsed formats', () => {
    expect(formatClock(T0)).toBe('14:03:21.123');
    expect(formatElapsed(0)).toBe('+0.0s');
    expect(formatElapsed(12_345)).toBe('+12.3s');
    expect(formatElapsed(245_000)).toBe('+4m05s');
    expect(formatElapsed(3_720_000)).toBe('+1h02m');
    expect(formatElapsed(-500)).toBe('+0.0s');
  });
});

describe('worker log rows', () => {
  it('JSON records: time and level in the gutter, msg then the remaining fields; other lines verbatim', () => {
    const ts = new Date(T0).toISOString();
    const rows = workerLogRows([
      JSON.stringify({ ts, level: 'info', msg: 'worker daemon starting', version: '1.0.24' }),
      JSON.stringify({ ts: new Date(T0 + 2000).toISOString(), level: 'error', msg: 'lease lost' }),
      'plain text <b>not markup</b>',
      '{"event":"fatal","version":"1.0.22","stage":"module-load"}',
    ]);
    expect(rows.map((r) => r.badge?.label ?? null)).toEqual(['inf', 'err', null, null]);
    expect(rows.map((r) => r.tone)).toEqual(['default', 'danger', 'default', 'default']);
    expect(rows[0]?.tsMs).toBe(T0);
    expect(rows[1]?.startMs).toBe(T0);
    expect(rows[0]?.segments.map((s) => s.text).join('')).toBe('worker daemon starting {"version":"1.0.24"}');
    expect(rows[2]?.segments).toEqual([{ text: 'plain text <b>not markup</b>', cls: '' }]);
    expect(rows[3]?.segments[0]?.text).toBe('{"event":"fatal","version":"1.0.22","stage":"module-load"}');
    expect(rows[3]?.tsMs).toBeNull();
  });
});

// --------------------------------------------------------------------------------------- header clock

function timeResponse(serverMs: number): Response {
  return new Response(JSON.stringify({ now: new Date(serverMs).toISOString() }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('header server clock (p6-logs-ui)', () => {
  const START = Date.UTC(2026, 9, 16, 14, 3, 21, 0);

  it('measures the offset against the request midpoint', async () => {
    let t = START;
    const now = () => t;
    const f = vi.fn(() => {
      t += 200; // 200 ms round trip; the server answers at its midpoint
      return Promise.resolve(timeResponse(START + 100 + 5000));
    });
    const s = await measureServerClock(f, now);
    expect(f).toHaveBeenCalledWith('/api/time', expect.objectContaining({ method: 'GET' }));
    expect(s).toEqual({ offsetMs: 5000, rttMs: 200, precise: true });
  });

  it('falls back to the Date header of an older master (404)', async () => {
    const f = vi.fn(() =>
      Promise.resolve(
        new Response('{}', { status: 404, headers: { date: new Date(START + 3000).toUTCString() } }),
      ),
    );
    const s = await measureServerClock(f, () => START);
    expect(s).toEqual({ offsetMs: 3500, rttMs: 0, precise: false });
  });
});
