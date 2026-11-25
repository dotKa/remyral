import { constants } from 'node:fs';
import { access, stat, statfs } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { Redactor } from '@remyral/observability';
import { resolveConfigPath } from '../config/load.js';
import type { PathHost } from '../config/paths.js';
import { workerConfigSchema } from '../config/schema.js';
import type { FileOps } from '../fs/ops.js';
import { fileHygieneState } from '../disk/index.js';
import { adminHelperAvailable } from '../machine-admin/report.js';
import { runProbe } from '../probe/probe.js';
import { defaultInstallDir } from '../sandbox/factory.js';
import { npmCliNextTo } from '../remote-ops/npm-resolve.js';
import { collectServiceStatus } from '../service/status.js';
import type { System } from '../system/types.js';
import { WORKER_VERSION } from '../version.js';
import type { DoctorConfigView, HttpResult, ServiceView, TlsResult, WorkerDoctorDeps } from './doctor.js';

/**
 * p16-doctor: the real host behind {@link runWorkerDoctor} — read-only. The config is parsed without creating or
 * repairing anything (unlike `run`), DNS / TLS / HTTPS use Node's own stack (the system CA store as the daemon), the
 * service view is `service status`, the probe is `probe` without self-tests.
 */

const codeOf = (e: unknown): string => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' && /^[A-Z0-9_]{2,40}$/.test(c) ? c : 'error';
};

export async function readDoctorConfig(
  ops: FileOps,
  host: PathHost,
  explicitPath: string | undefined,
): Promise<DoctorConfigView> {
  let path: string | null = null;
  let dataDir: string | null = null;
  try {
    const r = await resolveConfigPath(ops, host, { explicitPath });
    path = r.path;
    dataDir = r.defaultDataDir;
    const raw = await ops.readFile(r.path, 64 * 1024);
    if (raw === null)
      return {
        path,
        error: `${r.path} does not exist`,
        masterUrl: null,
        dataDir,
        workspaceRoot: null,
        allowedRuntimes: [],
      };
    const parsed = workerConfigSchema(host.platform).safeParse(
      JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')),
    );
    if (!parsed.success)
      return {
        path,
        error: `invalid: ${parsed.error.issues
          .map((i) => i.path.join('.') || '(root)')
          .slice(0, 6)
          .join(', ')}`,
        masterUrl: null,
        dataDir,
        workspaceRoot: null,
        allowedRuntimes: [],
      };
    return {
      path,
      error: null,
      masterUrl: parsed.data.masterUrl,
      dataDir: parsed.data.dataDir ?? dataDir,
      workspaceRoot: parsed.data.workspaceRoot,
      allowedRuntimes: parsed.data.allowedRuntimes,
    };
  } catch (e) {
    return {
      path,
      error:
        e instanceof SyntaxError
          ? 'not valid JSON'
          : (e instanceof Error ? (e.message.split('\n')[0] ?? 'error') : 'error').slice(0, 200),
      masterUrl: null,
      dataDir,
      workspaceRoot: null,
      allowedRuntimes: [],
    };
  }
}

function connect(host: string, port: number, secure: boolean, timeoutMs: number): Promise<TlsResult> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: TlsResult, s: net.Socket): void => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(r);
    };
    const socket = secure
      ? tls.connect({
          host,
          port,
          servername: net.isIP(host) === 0 ? host : undefined,
          minVersion: 'TLSv1.2',
        })
      : net.connect({ host, port });
    socket.setTimeout(timeoutMs, () => {
      finish({ validTo: null, error: 'ETIMEDOUT' }, socket);
    });
    socket.once('error', (e) => {
      finish({ validTo: null, error: codeOf(e) }, socket);
    });
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      if (!secure) {
        finish({ validTo: null, error: null }, socket);
        return;
      }
      const cert = (socket as tls.TLSSocket).getPeerCertificate();
      const to = typeof cert.valid_to === 'string' ? new Date(cert.valid_to) : null;
      finish({ validTo: to !== null && Number.isFinite(to.getTime()) ? to : null, error: null }, socket);
    });
  });
}

async function http(url: string, timeoutMs: number): Promise<HttpResult> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel().catch(() => undefined);
    return { status: res.status, date: res.headers.get('date'), error: null };
  } catch (e) {
    const cause = (e as { cause?: unknown }).cause;
    return { status: null, date: null, error: codeOf(cause ?? e) };
  }
}

async function directory(path: string, platform: string): Promise<string> {
  try {
    const s = await stat(path);
    if (!s.isDirectory()) return 'not_a_directory';
    if (platform !== 'win32' && (s.mode & 0o002) !== 0) return 'world_writable';
    await access(path, constants.W_OK);
    return 'ok';
  } catch (e) {
    const c = codeOf(e);
    return c === 'ENOENT' ? 'missing' : c === 'EACCES' || c === 'EPERM' ? 'not_writable' : c.toLowerCase();
  }
}

export function nodeDoctorDeps(input: {
  readonly sys: System;
  readonly ops: FileOps;
  readonly pathHost: PathHost;
  readonly configPath: string | undefined;
  readonly mode: 'local' | 'remote';
  readonly redactor?: Pick<Redactor, 'redact'>;
  readonly timeoutMs?: number;
  /** p17-worker-1-1-1: the install dir of the root/SYSTEM helper (default: the bundle's directory). */
  readonly installDir?: string;
}): WorkerDoctorDeps {
  const { sys, ops, pathHost } = input;
  const ms = input.timeoutMs ?? 8_000;
  return {
    mode: input.mode,
    workerVersion: WORKER_VERSION,
    host: { platform: sys.platform, release: sys.release(), arch: sys.arch, node: sys.nodeVersion },
    now: () => new Date(),
    config: () => readDoctorConfig(ops, pathHost, input.configPath),
    lookup: async (h) => (await lookup(h, { all: true })).map((a) => a.address),
    connect: (h, port, secure) => connect(h, port, secure, ms),
    http: (url) => http(url, ms),
    service: async (): Promise<ServiceView | null> => {
      const r = await collectServiceStatus(sys, ops, pathHost, { configPath: input.configPath });
      if ('error' in r) return null;
      return {
        manager: r.service.manager,
        installed: r.service.installed,
        state: r.service.state,
        freshness: r.worker.freshness,
        error: r.service.error,
      };
    },
    directory: (p) => directory(p, sys.platform),
    // p17-disk-selfclean: the last own cleanup, read from the data dir (the running worker writes it).
    diskHygiene: async (dataDir) => (await fileHygieneState(ops, dataDir).load())?.lastRun ?? null,
    disk: async (p) => {
      try {
        const s = await statfs(p);
        return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
      } catch {
        return null;
      }
    },
    probe: () => runProbe(sys, { selfTest: false, runtime: null }),
    npmVersion: async () => {
      const cli = npmCliNextTo(process.execPath, sys.platform as NodeJS.Platform);
      if (!(await sys.isFile(cli))) return null;
      const r = await sys.exec(process.execPath, [cli, '--version'], { timeoutMs: ms });
      const v = r.exitCode === 0 ? r.stdout.trim() : '';
      return /^\d+\.\d+\.\d+/.test(v) ? v.slice(0, 32) : null;
    },
    machineAdminHelper: () => adminHelperAvailable(input.installDir ?? defaultInstallDir()),
    redactor: input.redactor ?? new Redactor(),
    timeoutMs: ms,
  };
}
