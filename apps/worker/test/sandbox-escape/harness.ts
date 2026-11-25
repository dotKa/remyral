import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { OwnedProcess } from '@remyral/agent-adapters';
import { expect } from 'vitest';

export const PROBE = fileURLToPath(new URL('./probe.mjs', import.meta.url));
export const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

export interface ProbeResult {
  probe: string;
  target: string;
  outcome: 'denied' | 'allowed';
  detail: string;
}

/** Collects the probe's JSON lines from a running sandboxed process. */
export function collect(proc: OwnedProcess): {
  results: ProbeResult[];
  lines: Record<string, unknown>[];
  waitFor: (key: string, ms?: number) => Promise<Record<string, unknown>>;
} {
  const results: ProbeResult[] = [];
  const lines: Record<string, unknown>[] = [];
  const waiters: { key: string; resolve: (v: Record<string, unknown>) => void }[] = [];
  let buf = '';
  proc.stdout.on('data', (c: Buffer) => {
    buf += c.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      lines.push(obj);
      if (typeof obj.probe === 'string') results.push(obj as unknown as ProbeResult);
      for (const w of waiters.filter((x) => x.key in obj)) w.resolve(obj);
    }
  });
  const waitFor = (key: string, ms = 60_000) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const hit = lines.find((l) => key in l);
      if (hit) {
        resolve(hit);
        return;
      }
      const t = setTimeout(() => {
        reject(new Error(`probe did not report ${key}; stderr: ${proc.stderrTail()}`));
      }, ms);
      waiters.push({
        key,
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
      });
    });
  return { results, lines, waitFor };
}

/** Asserts every result of `probe` (optionally for `target`) has `outcome`. */
export function expectOutcome(
  results: readonly ProbeResult[],
  probe: string,
  outcome: 'denied' | 'allowed',
  target?: string,
): void {
  const matching = results.filter((r) => r.probe === probe && (target === undefined || r.target === target));
  expect(matching.length, `no result for ${probe} ${target ?? ''}`).toBeGreaterThan(0);
  for (const r of matching) expect(r, `${r.probe} ${r.target}: ${r.detail}`).toMatchObject({ outcome });
}

export function dockerAvailable(): boolean {
  if (process.env.REMYRAL_SKIP_DOCKER_TESTS === '1') return false;
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'pipe', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

export function imageExists(ref: string): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', ref], { stdio: 'pipe', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/** Builds the images the suite needs if they are missing (infra/worker/images/build.mjs). */
export function ensureImages(names: readonly string[]): void {
  const tags: Record<string, string> = {
    base: 'remyral/runtime-base:0.1.0',
    'egress-proxy': 'remyral/egress-proxy:0.1.0',
    pi: 'remyral/runtime-pi:0.1.0',
  };
  const missing = names.filter((n) => !imageExists(tags[n] ?? n));
  if (missing.length === 0) return;
  execFileSync(process.execPath, [`${REPO}infra/worker/images/build.mjs`, '--only', missing.join(',')], {
    stdio: 'pipe',
    timeout: 20 * 60_000,
  });
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
