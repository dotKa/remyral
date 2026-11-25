import type { Redactor } from '@remyral/observability';
import {
  type DiskHygieneRun,
  type DoctorFinding,
  type DoctorSeverity,
  MAX_WORKER_FINDINGS,
  sortFindings,
  summarizeFindings,
  WORKER_DOCTOR_SCHEMA_VERSION,
  WorkerDoctorReport,
} from '@remyral/protocol';
import type { HelperReadiness } from '../machine-admin/report.js';
import type { ProbeReport } from '../probe/report.js';
import { MIN_NODE_MAJOR } from '../runtimes/pins.js';

/**
 * p16-doctor (docs/design/p16-doctor.md §3): the machine's own doctor — `remyral-worker doctor` and the remote op
 * `doctor.run`. It needs nothing from the master: every check runs on the machine with injectable probes (tests use
 * fixtures for an offline master, a name that does not resolve, a wrong clock).
 *
 * Checks: config (readable, valid; read-only — nothing is created), master connectivity (DNS → TCP / TLS with the
 * certificate's expiry → HTTPS `GET /api/status`), the clock against the master's `Date` header, the OS service, the
 * data directory (exists, writable, not world-writable), free disk (data dir, workspace root), Node and npm, git, the
 * runtimes (installed, version against the pin, signed in — never an identity or a token), the sandbox profiles. All
 * strings are redacted; the report is bounded.
 */

export interface DoctorConfigView {
  /** The config file used (null: none found). */
  readonly path: string | null;
  /** Why it could not be used (null: valid). */
  readonly error: string | null;
  readonly masterUrl: string | null;
  readonly dataDir: string | null;
  readonly workspaceRoot: string | null;
  readonly allowedRuntimes: readonly string[];
}

export interface TlsResult {
  /** Certificate end (null: no TLS, or not read). */
  readonly validTo: Date | null;
  /** A closed error code (ECONNREFUSED, ETIMEDOUT, CERT_HAS_EXPIRED, UNABLE_TO_VERIFY_LEAF_SIGNATURE …) or null. */
  readonly error: string | null;
}

export interface HttpResult {
  readonly status: number | null;
  /** The response's Date header. */
  readonly date: string | null;
  readonly error: string | null;
}

export interface ServiceView {
  readonly manager: string;
  readonly installed: boolean | null;
  readonly state: string;
  /** live / stale / stopped / missing (the daemon's status file). */
  readonly freshness: string | null;
  readonly error: string | null;
}

export interface WorkerDoctorDeps {
  readonly mode: 'local' | 'remote';
  readonly workerVersion: string;
  readonly host: {
    readonly platform: string;
    readonly release: string;
    readonly arch: string;
    readonly node: string;
  };
  readonly now: () => Date;
  readonly config: () => Promise<DoctorConfigView>;
  readonly lookup: (host: string) => Promise<readonly string[]>;
  /** TLS handshake (wss) or a TCP connect (ws) to host:port. */
  readonly connect: (host: string, port: number, tls: boolean) => Promise<TlsResult>;
  readonly http: (url: string) => Promise<HttpResult>;
  readonly service: () => Promise<ServiceView | null>;
  /** `ok`, `missing`, `not_writable`, `world_writable` (or another closed code). */
  readonly directory: (path: string) => Promise<string>;
  readonly disk: (
    path: string,
  ) => Promise<{ readonly freeBytes: number; readonly totalBytes: number } | null>;
  readonly probe: () => Promise<ProbeReport | null>;
  readonly npmVersion: () => Promise<string | null>;
  /**
   * p17-disk-selfclean: the worker's own last disk cleanup (`<dataDir>/disk-hygiene.json`; absent / null: none known) —
   * shown next to a low-disk finding.
   */
  readonly diskHygiene?: (dataDir: string) => Promise<DiskHygieneRun | null>;
  /** p17-worker-1-1-1: the root/SYSTEM helper readiness probe (absent: the check is skipped). */
  readonly machineAdminHelper?: () => Promise<HelperReadiness>;
  readonly redactor: Pick<Redactor, 'redact'>;
  /** Per-step timeout (default 8 s). */
  readonly timeoutMs?: number;
}

export const CLOCK_WARN_MS = 60_000;
export const CLOCK_ERROR_MS = 120_000;
const GIB = 1024 * 1024 * 1024;
const GUIDE = 'docs/guide/tr/tanilama.md';

function f(
  check: string,
  code: string,
  severity: DoctorSeverity,
  message: string,
  extra: { fix?: string; docs?: string; params?: DoctorFinding['params']; subject?: string } = {},
): DoctorFinding {
  return {
    check,
    code,
    severity,
    message: message.slice(0, 500),
    ...(extra.fix === undefined ? {} : { fix: extra.fix.slice(0, 500) }),
    ...(extra.docs === undefined ? {} : { docs: extra.docs }),
    ...(extra.params === undefined ? {} : { params: extra.params }),
    ...(extra.subject === undefined ? {} : { subject: extra.subject.slice(0, 120) }),
  };
}

async function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const codeOf = (e: unknown): string => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' && /^[A-Z0-9_]{2,40}$/.test(c) ? c : 'error';
};

const mib = (b: number): string => `${String(Math.round(b / 1024 / 1024))} MiB`;

/** scheme://host:port of the master URL, null when it does not parse. */
export function masterOrigin(
  url: string | null,
): { origin: string; host: string; port: number; tls: boolean } | null {
  if (url === null) return null;
  try {
    const u = new URL(url);
    const tls = u.protocol === 'wss:' || u.protocol === 'https:';
    if (!tls && u.protocol !== 'ws:' && u.protocol !== 'http:') return null;
    const port = u.port === '' ? (tls ? 443 : 80) : Number(u.port);
    return {
      origin: `${tls ? 'https' : 'http'}://${u.host}`,
      host: u.hostname.replace(/^\[|\]$/g, ''),
      port,
      tls,
    };
  } catch {
    return null;
  }
}

export async function runWorkerDoctor(d: WorkerDoctorDeps): Promise<WorkerDoctorReport> {
  const ms = d.timeoutMs ?? 8_000;
  const out: DoctorFinding[] = [];
  const cfg = await d.config().catch((e: unknown) => ({
    path: null,
    error: `config could not be read (${codeOf(e)})`,
    masterUrl: null,
    dataDir: null,
    workspaceRoot: null,
    allowedRuntimes: [] as string[],
  }));

  // ---------------------------------------------------------------- config
  if (cfg.error !== null)
    out.push(
      f('config', 'invalid', 'error', `The worker config cannot be used: ${cfg.error}`, {
        fix: 'Fix the file (REMYRAL_WORKER_CONFIG or the OS location) — `remyral-worker service status` shows which one is read.',
        docs: `${GUIDE}#makine-doktoru`,
        params: { path: cfg.path ?? '' },
      }),
    );
  else
    out.push(
      f('config', 'ok', 'ok', `Config ${cfg.path ?? ''} is valid`, { params: { path: cfg.path ?? '' } }),
    );

  // ---------------------------------------------------------------- master connectivity + clock
  const m = masterOrigin(cfg.masterUrl);
  if (m === null) {
    if (cfg.error === null)
      out.push(
        f('master.url', 'invalid', 'error', 'masterUrl is not a ws:// or wss:// URL', {
          docs: `${GUIDE}#makine-doktoru`,
        }),
      );
  } else {
    let reachable = false;
    let addresses: readonly string[] = [];
    try {
      addresses = await within(d.lookup(m.host), ms);
      out.push(
        f('master.dns', 'ok', 'ok', `${m.host} resolves (${addresses.slice(0, 3).join(', ')})`, {
          params: { host: m.host },
        }),
      );
    } catch (e) {
      out.push(
        f('master.dns', 'dns_failed', 'error', `${m.host} does not resolve (${codeOf(e)})`, {
          fix: 'Check the machine’s DNS / internet connection and the masterUrl host name in the worker config.',
          docs: `${GUIDE}#makine-doktoru`,
          params: { host: m.host, code: codeOf(e) },
        }),
      );
    }
    if (addresses.length > 0) {
      const c = await within(d.connect(m.host, m.port, m.tls), ms).catch((e: unknown): TlsResult => ({
        validTo: null,
        error: codeOf(e),
      }));
      if (c.error !== null) {
        const cert = /CERT|SELF_SIGNED|UNABLE_TO|HOSTNAME|ALTNAME/.test(c.error);
        out.push(
          f(
            'master.connect',
            cert ? 'tls_failed' : 'unreachable',
            'error',
            `${m.host}:${String(m.port)} ${cert ? 'has a certificate this machine does not trust' : 'cannot be reached'} (${c.error})`,
            {
              fix: cert
                ? 'Check the machine’s date and its CA store; a corporate proxy that intercepts TLS needs its CA trusted.'
                : 'Check the firewall / proxy between this machine and the master (outbound HTTPS 443) and that the master is up.',
              docs: `${GUIDE}#makine-doktoru`,
              params: { host: m.host, port: m.port, code: c.error },
            },
          ),
        );
      } else {
        reachable = true;
        if (!m.tls)
          out.push(
            f('master.connect', 'plain', 'warning', `${m.host} is reached without TLS (ws://)`, {
              fix: 'Use wss:// for every master that is not on this machine.',
              params: { host: m.host },
            }),
          );
        else if (c.validTo !== null) {
          const days = Math.floor((c.validTo.getTime() - d.now().getTime()) / 86_400_000);
          out.push(
            days < 14
              ? f(
                  'master.connect',
                  'cert_expiring',
                  days < 3 ? 'error' : 'warning',
                  `The master certificate expires in ${String(days)} day(s)`,
                  {
                    fix: 'Renew the master certificate (Coolify / the proxy renews Let’s Encrypt automatically — check it).',
                    params: { days },
                  },
                )
              : f(
                  'master.connect',
                  'ok',
                  'ok',
                  `TLS to ${m.host} is fine (certificate valid for ${String(days)} days)`,
                  { params: { days } },
                ),
          );
        } else out.push(f('master.connect', 'ok', 'ok', `${m.host}:${String(m.port)} answers`));
      }
    }
    let skewChecked = false;
    if (reachable) {
      const h = await within(d.http(`${m.origin}/api/status`), ms).catch((e: unknown): HttpResult => ({
        status: null,
        date: null,
        error: codeOf(e),
      }));
      if (h.status === 200) out.push(f('master.http', 'ok', 'ok', 'The master answers its status probe'));
      else if (h.status === 503)
        out.push(
          f(
            'master.http',
            'master_unavailable',
            'error',
            'The master is up but not ready (its database or Redis is down)',
            {
              fix: 'The owner checks Ayarlar → Sistem durumu or the master containers in Coolify.',
              docs: `${GUIDE}#makine-doktoru`,
            },
          ),
        );
      else
        out.push(
          f(
            'master.http',
            h.status === null ? 'http_failed' : 'http_unexpected',
            'warning',
            h.status === null
              ? `The master status probe failed (${h.error ?? 'error'})`
              : `The master status probe answered HTTP ${String(h.status)}`,
            {
              fix: 'A proxy in between may block or rewrite requests; the worker needs plain outbound HTTPS and WebSocket to the master.',
              params: { status: h.status ?? 0 },
            },
          ),
        );
      if (h.date !== null) {
        const masterAt = Date.parse(h.date);
        if (Number.isFinite(masterAt)) {
          skewChecked = true;
          const skew = d.now().getTime() - masterAt;
          const sec = Math.round(skew / 1000);
          const abs = Math.abs(skew);
          // The Date header has one-second resolution: ±2 s is noise.
          out.push(
            abs >= CLOCK_WARN_MS
              ? f(
                  'clock',
                  'skew',
                  abs >= CLOCK_ERROR_MS ? 'error' : 'warning',
                  `This machine's clock is ${String(Math.abs(sec))} s ${sec > 0 ? 'ahead of' : 'behind'} the master`,
                  {
                    fix: 'Turn on automatic time sync (NTP / Windows Time): signed commands, leases and logins depend on the clock.',
                    docs: `${GUIDE}#saat`,
                    params: { seconds: sec },
                  },
                )
              : f('clock', 'ok', 'ok', `The clock agrees with the master (${String(sec)} s)`, {
                  params: { seconds: sec },
                }),
          );
        }
      }
    }
    if (!skewChecked)
      out.push(
        f('clock', 'not_checked', 'info', 'The clock could not be compared (the master did not answer)', {
          params: { now: d.now().toISOString() },
        }),
      );
  }

  // ---------------------------------------------------------------- service
  const svc = await within(d.service(), ms).catch(() => null);
  if (svc === null) out.push(f('service', 'unknown', 'info', 'The service manager could not be queried'));
  else if (svc.installed === false)
    out.push(
      f(
        'service',
        'not_installed',
        d.mode === 'remote' ? 'info' : 'warning',
        `The worker is not installed as a ${svc.manager} service`,
        {
          fix: 'Install the service with the installer from Makineler → Makine ekle, so the worker starts at boot and can be restarted remotely.',
          docs: `${GUIDE}#makine-doktoru`,
        },
      ),
    );
  else if (svc.state !== 'running' && d.mode === 'local')
    out.push(
      f('service', 'not_running', 'error', `The worker service is ${svc.state}`, {
        fix: 'Start it (systemctl start remyral-worker / launchctl kickstart / Start-Service RemyralWorker) and read its log (boot.log, worker.log in the data directory).',
        docs: `${GUIDE}#makine-doktoru`,
        params: { state: svc.state },
      }),
    );
  else if (svc.freshness === 'stale')
    out.push(
      f(
        'service',
        'stale',
        'warning',
        'The service runs but the daemon’s status file is stale (it may hang)',
        { fix: 'Restart the worker service.' },
      ),
    );
  else
    out.push(
      f('service', 'ok', 'ok', `The ${svc.manager} service is ${svc.state}`, {
        params: { state: svc.state },
      }),
    );

  // ---------------------------------------------------------------- data directory, disk
  for (const [id, path] of [
    ['dataDir', cfg.dataDir],
    ['workspaceRoot', cfg.workspaceRoot],
  ] as const) {
    if (path === null) continue;
    const st = await within(d.directory(path), ms).catch((e: unknown) => codeOf(e));
    if (st !== 'ok')
      out.push(
        f(
          'directories',
          st,
          st === 'world_writable' || st === 'missing' || st === 'not_writable' ? 'error' : 'warning',
          `${id} ${path}: ${st.replace(/_/g, ' ')}`,
          {
            fix:
              st === 'world_writable'
                ? 'Remove write access for other users (chmod o-w / icacls): the worker refuses to run otherwise.'
                : 'Create it and give the worker account write access (the installer does this).',
            docs: `${GUIDE}#makine-doktoru`,
            params: { dir: id, path },
            subject: id,
          },
        ),
      );
    const disk = await within(d.disk(path), ms).catch(() => null);
    if (disk !== null && disk.freeBytes < 2 * GIB)
      out.push(
        f(
          'disk',
          'low',
          disk.freeBytes < 512 * 1024 * 1024 ? 'error' : 'warning',
          `${id}: only ${mib(disk.freeBytes)} free`,
          {
            fix: 'Free disk space (kept working directories, old runtime versions, Docker images) or move the directory to a larger disk.',
            docs: `${GUIDE}#disk`,
            params: { dir: id, freeBytes: disk.freeBytes },
            subject: id,
          },
        ),
      );
  }
  // p17-disk-selfclean: with a low disk, what the worker's own cleanup did last.
  if (out.some((x) => x.check === 'disk') && cfg.dataDir !== null && d.diskHygiene !== undefined) {
    const run = await within(d.diskHygiene(cfg.dataDir), ms).catch(() => null);
    if (run !== null)
      out.push(
        f(
          'disk',
          'last_cleanup',
          'info',
          `The worker's own cleanup last ran at ${run.finishedAt} (${run.trigger}) and freed ${mib(run.freedBytes)}${run.stillLow ? '; free space stayed below its target' : ''}`,
          {
            fix: 'It runs by itself when the disk gets low and once a day; the machine page has "Clean now" and shows what uses the space.',
            docs: `${GUIDE}#disk`,
            params: {
              at: run.finishedAt,
              trigger: run.trigger,
              freedMiB: Math.round(run.freedBytes / 1024 / 1024),
              stillLow: run.stillLow,
            },
          },
        ),
      );
  }
  if (!out.some((x) => x.check === 'directories'))
    out.push(f('directories', 'ok', 'ok', 'The data directory and the workspace root are usable'));
  if (!out.some((x) => x.check === 'disk')) out.push(f('disk', 'ok', 'ok', 'Enough free disk'));

  // ---------------------------------------------------------------- Node / npm, git, runtimes, sandbox (the probe)
  const nodeMajor = Number(d.host.node.replace(/^v/, '').split('.')[0]);
  out.push(
    nodeMajor >= MIN_NODE_MAJOR
      ? f('node', 'ok', 'ok', `Node ${d.host.node}`, { params: { version: d.host.node } })
      : f('node', 'too_old', 'error', `Node ${d.host.node} is older than ${String(MIN_NODE_MAJOR)}`, {
          fix: `Install Node ${String(MIN_NODE_MAJOR)} (the installer bundles it).`,
          params: { version: d.host.node, required: MIN_NODE_MAJOR },
        }),
  );
  const npm = await within(d.npmVersion(), ms).catch(() => null);
  out.push(
    npm === null
      ? f(
          'node.npm',
          'missing',
          'info',
          'npm is not found next to Node: runtime versions outside the release pin cannot be installed here',
        )
      : f('node.npm', 'ok', 'ok', `npm ${npm}`, { params: { version: npm } }),
  );
  const probe = await within(d.probe(), Math.max(ms, 60_000)).catch(() => null);
  if (probe === null)
    out.push(f('runtimes', 'probe_failed', 'warning', 'The runtime / tool probe did not finish'));
  else {
    const git = probe.tools.find((t) => t.name === 'git');
    out.push(
      git?.found === true
        ? f('git', 'ok', 'ok', `git ${git.version ?? ''}`.trim(), { params: { version: git.version ?? '' } })
        : f('git', 'missing', 'error', 'git is not installed: repository jobs cannot run here', {
            fix: 'Install git (on Windows the console installs MinGit: Makineler → <makine> → Araçlar) or set gitBinary in the config.',
          }),
    );
    const allowed = new Set(cfg.allowedRuntimes);
    for (const r of probe.runtimes) {
      const enabled = allowed.size === 0 || allowed.has(r.runtime);
      const c = r.capabilities;
      if (!c.installed) {
        if (enabled && allowed.size > 0)
          out.push(
            f('runtimes', 'not_installed', 'warning', `${r.runtime} is allowed but not installed`, {
              fix: 'Install it from Makineler → <makine> → Çalıştırıcılar.',
              params: { runtime: r.runtime },
              subject: r.runtime,
            }),
          );
        continue;
      }
      if (c.authenticated === 'no')
        out.push(
          f(
            'runtimes',
            'not_signed_in',
            'warning',
            `${r.runtime} ${c.version} is installed but not signed in`,
            {
              fix: 'Sign it in from the console (Giriş yap) or give it an API key credential.',
              params: { runtime: r.runtime },
              subject: r.runtime,
            },
          ),
        );
      else if (r.pinStatus === 'mismatch')
        out.push(
          f(
            'runtimes',
            'pin_mismatch',
            'info',
            `${r.runtime} ${c.version} differs from the release pin ${r.pin}`,
            { params: { runtime: r.runtime, version: c.version, pin: r.pin }, subject: r.runtime },
          ),
        );
      else
        out.push(
          f(
            'runtimes',
            'ok',
            'ok',
            `${r.runtime} ${c.version} (${c.authenticated === 'yes' ? 'signed in' : 'sign-in state unknown'})`,
            { params: { runtime: r.runtime, version: c.version }, subject: r.runtime },
          ),
        );
    }
    const ready = probe.sandboxProfiles.filter((p) => p.ready);
    if (probe.sandboxProfiles.length > 0 && ready.length === 0)
      out.push(
        f('sandbox', 'none_ready', 'error', 'No sandbox profile is ready on this machine', {
          fix: 'Run "Hazırla" in Makineler → <makine> → Sandbox & policy (it installs what is missing).',
          params: {
            notes: probe.sandboxProfiles
              .flatMap((p) => p.notes)
              .slice(0, 3)
              .join('; ')
              .slice(0, 200),
          },
        }),
      );
    else
      out.push(
        f(
          'sandbox',
          'ok',
          'ok',
          `Ready sandbox profiles: ${ready.map((p) => p.profile).join(', ') || 'none probed'}`,
        ),
      );
    for (const p of probe.problems.filter((x) => x.severity === 'error').slice(0, 8))
      out.push(f('probe', p.code.replace(/[^a-z0-9_]/g, '_').slice(0, 64), 'warning', p.message));
  }

  // p17-worker-1-1-1: can the root/SYSTEM helper really start machine-administration sessions?
  if (d.machineAdminHelper !== undefined) {
    const h = await within(d.machineAdminHelper(), ms).catch((): HelperReadiness => ({
      available: 'unknown',
      reason: 'probe_failed',
    }));
    out.push(machineAdminFinding(h));
  }

  const clean = sortFindings(
    out.slice(0, MAX_WORKER_FINDINGS).map((x) => ({
      ...x,
      message: d.redactor.redact(x.message).slice(0, 500),
      ...(x.fix === undefined ? {} : { fix: d.redactor.redact(x.fix).slice(0, 500) }),
      ...(x.params === undefined
        ? {}
        : {
            params: Object.fromEntries(
              Object.entries(x.params).map(([k, v]) => [
                k,
                typeof v === 'string' ? d.redactor.redact(v).slice(0, 200) : v,
              ]),
            ),
          }),
    })),
  );
  return WorkerDoctorReport.parse({
    schemaVersion: WORKER_DOCTOR_SCHEMA_VERSION,
    collectedAt: d.now().toISOString(),
    mode: d.mode,
    workerVersion: d.workerVersion.slice(0, 64),
    host: {
      platform: d.host.platform.slice(0, 32),
      release: d.host.release.slice(0, 128),
      arch: d.host.arch.slice(0, 16),
      node: d.host.node.slice(0, 32),
    },
    master: m?.origin ?? null,
    summary: summarizeFindings(clean),
    findings: clean,
  });
}

/** A readable report for the terminal (worst first). */
/** The `machine_admin` finding of a readiness probe result (code = the reason, `ok` when available). */
export function machineAdminFinding(h: HelperReadiness): DoctorFinding {
  if (h.available === 'available')
    return f('machine_admin', 'ok', 'ok', 'The root/SYSTEM helper can start machine administration sessions');
  const code = h.reason ?? (h.available === 'missing' ? 'helper_missing' : 'probe_failed');
  // No helper at all (installed without the signed updater): machine administration is simply not offered here.
  const severity: DoctorSeverity =
    code === 'helper_missing' || code === 'install_dir_unknown' || h.available === 'unknown'
      ? 'info'
      : 'warning';
  return f(
    'machine_admin',
    code,
    severity,
    `Machine administration is unavailable on this machine: ${h.detail ?? code}`,
    {
      ...(code === 'probe_failed' || code === 'admin_task_unreadable'
        ? {}
        : { fix: 'Re-run the installer kit of this release once, as root / Administrator.' }),
      docs: 'docs/guide/tr/tanilama.md',
    },
  );
}

export function formatDoctorReport(r: WorkerDoctorReport): string {
  const mark: Record<DoctorSeverity, string> = {
    error: 'ERROR',
    warning: 'WARN ',
    info: 'info ',
    ok: 'ok   ',
  };
  const lines = [
    `remyral-worker doctor — ${r.collectedAt}`,
    `worker ${r.workerVersion} · ${r.host.platform} ${r.host.release} ${r.host.arch} · Node ${r.host.node}`,
    `master ${r.master ?? '(not configured)'}`,
    '',
  ];
  for (const x of r.findings) {
    lines.push(`${mark[x.severity]}  ${x.check.padEnd(16)} ${x.message}`);
    if (x.fix !== undefined && x.severity !== 'ok') lines.push(`       ${''.padEnd(16)} → ${x.fix}`);
  }
  const s = r.summary;
  lines.push(
    '',
    `${String(s.error)} error(s), ${String(s.warning)} warning(s), ${String(s.info)} note(s), ${String(s.ok)} ok`,
    '',
  );
  return lines.join('\n');
}
