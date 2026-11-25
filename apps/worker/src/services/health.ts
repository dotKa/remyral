import { request } from 'node:http';
import { connect } from 'node:net';
import type { ServiceHealth } from '@remyral/protocol';
import { osProcessTable, type ProcRow, treeRssBytes } from '../jobs/memory.js';
import { runProcess, type RunFn } from '../remote-ops/process.js';
import { processTree } from '../previews/ports.js';

/**
 * p15-services: health probes and process-tree figures of a service. Probes go to 127.0.0.1 only (the service's own
 * localhost port); no proxy, no redirects, the body is not read beyond the status line.
 */

export type HealthProbe = (
  health: ServiceHealth,
  port: number | null,
) => Promise<{ ok: boolean; detail: string }>;

export const defaultHealthProbe: HealthProbe = async (health, port) => {
  if (health.kind === 'none') return { ok: true, detail: 'no probe' };
  if (port === null) return { ok: false, detail: 'no port' };
  const timeoutMs = health.timeoutSec * 1000;
  if (health.kind === 'tcp') {
    return new Promise((resolve) => {
      const s = connect({ host: '127.0.0.1', port });
      const done = (ok: boolean, detail: string) => {
        s.destroy();
        resolve({ ok, detail });
      };
      s.setTimeout(timeoutMs, () => {
        done(false, `no TCP answer on 127.0.0.1:${String(port)} within ${String(health.timeoutSec)} s`);
      });
      s.once('connect', () => {
        done(true, 'tcp ok');
      });
      s.once('error', () => {
        done(false, `nothing listens on 127.0.0.1:${String(port)}`);
      });
    });
  }
  return new Promise((resolve) => {
    const req = request(
      { host: '127.0.0.1', port, path: health.path, method: 'GET', timeout: timeoutMs, agent: false },
      (res) => {
        const code = res.statusCode ?? 0;
        res.resume();
        res.destroy();
        const ok = code >= health.expectStatus.min && code <= health.expectStatus.max;
        resolve({ ok, detail: ok ? `HTTP ${String(code)}` : `HTTP ${String(code)} on ${health.path}` });
      },
    );
    req.once('timeout', () => {
      req.destroy();
      resolve({ ok: false, detail: `no HTTP answer within ${String(health.timeoutSec)} s` });
    });
    req.once('error', () => {
      resolve({ ok: false, detail: `nothing answers HTTP on 127.0.0.1:${String(port)}` });
    });
    req.end();
  });
};

export interface TreeSample {
  readonly memoryBytes?: number;
  readonly cpuPercent?: number;
}

export type TreeSampler = (rootPid: number) => Promise<TreeSample>;

/** `ps -A -o pid= -o ppid= -o rss= -o pcpu=` (macOS / Linux). */
export function parsePsCpu(stdout: string): (ProcRow & { cpu: number })[] {
  const out: (ProcRow & { cpu: number })[] = [];
  for (const line of stdout.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length !== 4) continue;
    const [pid, ppid, kib, cpu] = [Number(f[0]), Number(f[1]), Number(f[2]), Number(f[3])];
    if (![pid, ppid, kib].every((n) => Number.isSafeInteger(n) && n >= 0) || !Number.isFinite(cpu)) continue;
    out.push({ pid, ppid, rssBytes: kib * 1024, cpu });
  }
  return out;
}

/** Memory (every OS) and CPU (POSIX `ps` %CPU, summed over the tree) of a service's process tree. */
export function osTreeSampler(
  platform: NodeJS.Platform = process.platform,
  run: RunFn = runProcess,
): TreeSampler {
  if (platform === 'win32') {
    const table = osProcessTable(platform, run);
    return async (root) => {
      const rows = await table().catch(() => null);
      const mem = rows === null ? null : treeRssBytes(rows, [root]);
      return mem === null ? {} : { memoryBytes: mem };
    };
  }
  return async (root) => {
    const r = await run('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'rss=', '-o', 'pcpu='], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' },
      cwd: '/',
      timeoutMs: 10_000,
      maxBytes: 4 * 1024 * 1024,
    }).catch(() => null);
    if (r === null || r.exitCode !== 0) return {};
    const rows = parsePsCpu(r.stdout);
    const tree = processTree(rows, [root]);
    if (tree.size === 0) return {};
    let mem = 0;
    let cpu = 0;
    for (const row of rows) {
      if (!tree.has(row.pid)) continue;
      mem += row.rssBytes;
      cpu += row.cpu;
    }
    return { memoryBytes: mem, cpuPercent: Math.round(cpu * 10) / 10 };
  };
}
