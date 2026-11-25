import { statfs } from 'node:fs/promises';
import { freemem, release, totalmem, uptime } from 'node:os';
import type { Redactor } from '@remyral/observability';
import { Diagnostics } from '@remyral/protocol';
import { MIN_NODE_MAJOR } from '../runtimes/pins.js';
import type { ServiceInfo } from './service-control.js';

/** On-demand diagnostics (p5-remote-ops §4): host, disk, Node, sandbox readiness, runtimes, service. */

export interface DiagnosticsInput {
  readonly workerVersion: string;
  readonly dataDir: string;
  readonly workspaceRoot: string;
  readonly installsRoot: string;
  readonly service: ServiceInfo;
  /** Service-manager view (state, restarts), when it can be queried. */
  readonly serviceState?: () => Promise<{ state?: string; restarts?: number | null } | null>;
  readonly sandbox: () => Promise<Diagnostics['sandbox']>;
  readonly runtimes: () => Promise<Diagnostics['runtimes']>;
  readonly redactor: Pick<Redactor, 'redact'>;
  readonly clock?: () => Date;
  readonly nodeVersion?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

async function disk(path: string): Promise<{ freeBytes: number | null; totalBytes: number | null }> {
  try {
    const s = await statfs(path);
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return { freeBytes: null, totalBytes: null };
  }
}

export async function collectDiagnostics(i: DiagnosticsInput): Promise<Diagnostics> {
  const nodeVersion = i.nodeVersion ?? process.versions.node;
  const nodeOk = Number(nodeVersion.split('.')[0]) >= MIN_NODE_MAJOR;
  const problems: Diagnostics['problems'] = [];
  const disks: Diagnostics['disk'] = [
    { name: 'dataDir', ...(await disk(i.dataDir)) },
    { name: 'workspaceRoot', ...(await disk(i.workspaceRoot)) },
    { name: 'runtimes', ...(await disk(i.installsRoot)) },
  ];
  for (const d of disks) {
    if (d.freeBytes !== null && d.freeBytes < 2 * 1024 * 1024 * 1024) {
      problems.push({
        code: 'disk.low',
        severity: d.freeBytes < 512 * 1024 * 1024 ? 'error' : 'warning',
        message: `${d.name}: ${String(Math.round(d.freeBytes / 1024 / 1024))} MiB free`,
      });
    }
  }
  if (!nodeOk) {
    problems.push({
      code: 'node.version',
      severity: 'error',
      message: `Node ${nodeVersion} is older than ${String(MIN_NODE_MAJOR)}`,
    });
  }
  const sandbox = await i.sandbox().catch(() => [] as Diagnostics['sandbox']);
  if (sandbox.length > 0 && !sandbox.some((s) => s.ready)) {
    problems.push({ code: 'sandbox.none_ready', severity: 'error', message: 'no sandbox profile is ready' });
  }
  const runtimes = await i.runtimes().catch(() => [] as Diagnostics['runtimes']);
  for (const r of runtimes) {
    if (r.integrity === 'modified') {
      problems.push({
        code: 'runtime.install_modified',
        severity: 'error',
        message: `${r.runtime}: the managed install was modified and is not used; reinstall it`,
      });
    }
    if (r.enabled && r.source === 'none') {
      problems.push({
        code: 'runtime.not_installed',
        severity: 'warning',
        message: `${r.runtime} is enabled but not installed`,
      });
    }
  }
  if (!i.service.restartable) {
    problems.push({
      code: 'service.not_managed',
      severity: 'info',
      message: 'not running under the service manager: remote restart is unavailable',
    });
  }
  const svc = await i.serviceState?.().catch(() => null);
  const clean = (s: string, max: number) => i.redactor.redact(s).slice(0, max);
  const out: Diagnostics = {
    collectedAt: (i.clock?.() ?? new Date()).toISOString(),
    workerVersion: i.workerVersion,
    node: { version: nodeVersion, ok: nodeOk, requiredMajor: MIN_NODE_MAJOR },
    os: {
      platform: i.platform ?? process.platform,
      release: release().slice(0, 128),
      arch: i.arch ?? process.arch,
    },
    uptimeSec: Math.round(uptime()),
    memory: { freeBytes: freemem(), totalBytes: totalmem() },
    disk: disks,
    sandbox: sandbox.map((s) => ({
      ...s,
      ...(s.reason === undefined ? {} : { reason: clean(s.reason, 300) }),
    })),
    runtimes: runtimes.map((r) => ({
      ...r,
      ...(r.problem === undefined ? {} : { problem: clean(r.problem, 300) }),
    })),
    service: {
      manager: i.service.manager,
      ...(svc?.state === undefined ? {} : { state: svc.state.slice(0, 32) }),
      ...(svc?.restarts === undefined ? {} : { restarts: svc.restarts }),
    },
    problems: problems.map((p) => ({ ...p, message: clean(p.message, 300) })).slice(0, 32),
  };
  return Diagnostics.parse(out);
}
