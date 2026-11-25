import { randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  ASSISTANT_LOOPBACK_PORTS_ENV,
  type ConfinedSpawn,
  type ProcessConfiner,
  type SpawnPlan,
} from '@remyral/agent-adapters';
import type { AssistantReport, AssistantRuntime } from '@remyral/protocol';
import {
  startEgressProxy,
  type EgressDecision,
  type EgressProxy,
  type Lookup,
} from '../sandbox/egress/proxy.js';
import { SandboxRequestError } from '../sandbox/errors.js';
import { posixLimitsPrelude, windowsJobObjectKiller } from '../sandbox/host/limits.js';
import { reapingTreeKiller, SANDBOX_TOKEN_ENV } from '../sandbox/host/reaper.js';
import { PROTECTED_HOME_PATHS, SANDBOX_EXEC } from '../sandbox/host/seatbelt.js';
import {
  assertJobRunnerIntact,
  jobRunnerArgs,
  jobRunnerSpec,
  powershellExe,
  restrictAttemptAcl,
  runFile,
  type JobRunnerState,
  type RunFile,
} from '../sandbox/host/windows-jobrun.js';
import { parseEgressTarget } from '../sandbox/network.js';
import type { ResourceLimits } from '../sandbox/types.js';

/**
 * The **assistant sandbox profile** (p5-ops-chat-next, ADR-0025): least privilege for the ops-chat runtime
 * process (Claude Code, Codex, OpenCode or Pi started by an assistant engine) and its whole tree. The assistant
 * needs nothing but its model API and the platform tool bridge (stdio, or OpenCode's loopback endpoint); it never
 * needs a repository, a workspace or the worker's secrets. So:
 *
 *  - **writes** only below the session directory (`<dataDir>/assistant/s-…`: `work` = cwd, `state` = the runtime's
 *    private config) — plus, for a `local-login` runtime, that runtime's own login store in the worker user's home
 *    (token refresh), nothing else;
 *  - **reads**: not the worker data dir (device key, vault, secrets — except the worker-managed runtime installs
 *    it executes from and its own session), not the workspace root (no repository, worktree or mirror), not the
 *    protected home paths (SSH/cloud/browser credentials, keychains unless `allowKeychain`) and not the login
 *    stores of the other runtimes;
 *  - **network**: only HTTPS tunnels to the model API hosts (`sandbox.egressAllow`) through a per-session egress
 *    proxy; OpenCode additionally reaches its own loopback tool endpoint and serves its API on loopback;
 *  - **limits**: rlimits (POSIX) or a Job Object (Windows) like host jobs; the tree is killed with the session.
 *
 * Enforcement per OS (reported in CAPABILITIES.assistant.sandbox):
 *  - macOS: Seatbelt (`sandbox-exec`) enforces filesystem *and* network (`egress: enforced`);
 *  - Linux: bubblewrap (when user namespaces work) enforces the filesystem view; egress is the proxy
 *    environment only (`proxy-env`: the runtime shares the host network namespace so it can reach the loopback
 *    proxy) — the residual risk of host-native Linux execution, as for host jobs;
 *  - Windows: the verified job runner's Job Object (limits, kill-on-close) and a protected DACL on the session
 *    dir; no read confinement, egress `proxy-env`.
 *  `mode: required` refuses assistant turns where no filesystem confinement exists; `auto` (default) runs with
 *  the strongest available; `off` (diagnosis only) runs host-native.
 */

export type AssistantSandboxMode = 'auto' | 'required' | 'off';

/** Login stores of each runtime below the worker user's HOME (local-login only; never copied, never read here). */
export const RUNTIME_LOGIN_PATHS: Readonly<
  Record<AssistantRuntime, { readonly dirs: readonly string[]; readonly prefixes: readonly string[] }>
> = {
  // ~/.claude.json is rewritten through sibling temp files (~/.claude.json.tmp…, .backup): a prefix rule.
  'claude-code': { dirs: ['.claude'], prefixes: ['.claude.json'] },
  codex: { dirs: ['.codex'], prefixes: [] },
  opencode: { dirs: ['.local/share/opencode'], prefixes: [] },
  pi: { dirs: ['.pi/agent'], prefixes: [] },
};

/**
 * Hosts each runtime's assistant needs on top of the worker's `sandbox.egressAllow` (model APIs), verified in
 * the pinned binaries (strings, 2026-10-16): Claude Code 2.1.296 talks to `api.anthropic.com` (API, and the
 * subscription's profile / roles calls) and refreshes a subscription login at
 * `https://platform.claude.com/v1/oauth/token`; Codex 0.162.1 with a ChatGPT login uses
 * `chatgpt.com/backend-api/…` and refreshes at `auth.openai.com`. OpenCode and Pi reach whatever provider the
 * worker configured for them — those hosts belong in `sandbox.egressAllow`.
 */
export const ASSISTANT_RUNTIME_EGRESS: Readonly<
  Record<AssistantRuntime, { readonly always: readonly string[]; readonly localLogin: readonly string[] }>
> = {
  'claude-code': { always: ['api.anthropic.com'], localLogin: ['platform.claude.com'] },
  codex: { always: ['api.openai.com'], localLogin: ['chatgpt.com', 'auth.openai.com'] },
  opencode: { always: [], localLogin: [] },
  pi: { always: [], localLogin: [] },
};

/** The allowlist of one session: the worker's model hosts plus what the runtime and its auth mode need. */
export function assistantEgress(
  runtime: AssistantRuntime,
  authMode: 'secret-ref' | 'local-login',
  egressAllow: readonly string[],
): string[] {
  const extra = ASSISTANT_RUNTIME_EGRESS[runtime];
  return [
    ...new Set([...egressAllow, ...extra.always, ...(authMode === 'local-login' ? extra.localLogin : [])]),
  ];
}

/** Non-secret env of OpenCode's assistant engine naming its loopback tool endpoint port(s). */
export { ASSISTANT_LOOPBACK_PORTS_ENV };

/** Runtimes whose engine talks to a server the runtime itself starts on loopback. */
const LISTENS: ReadonlySet<AssistantRuntime> = new Set(['opencode']);

export interface AssistantSandboxOptions {
  readonly mode: AssistantSandboxMode;
  readonly platform?: NodeJS.Platform;
  /** Worker data dir (device key, vault, secrets): never readable except the carve-outs below. */
  readonly workerDataDir: string;
  /** Workspace root (repositories, worktrees, mirrors, job sandboxes): never readable. */
  readonly workspaceRoot: string;
  /** Data-dir subtrees the runtime may read (worker-managed runtime installs). */
  readonly readableInDataDir: readonly string[];
  /** Homes whose protected paths are denied (the worker user's HOME is always added). */
  readonly protectedHomes: readonly string[];
  readonly workerHome: string | undefined;
  /** macOS local-login: the Keychain stays readable (Claude Code keeps its login there). */
  readonly allowKeychain: boolean;
  /** Model API hosts (`host[:port]`, the worker's `sandbox.egressAllow`). */
  readonly egressAllow: readonly string[];
  readonly limits: ResourceLimits;
  /** macOS: `sandbox-exec` usable (factory check). */
  readonly seatbeltAvailable?: () => boolean;
  /** Linux: bubblewrap path and whether namespaces work (`checkBwrapNamespaces`). */
  readonly bwrap?: () => { readonly path: string | null; readonly usable: boolean | null };
  /** Windows: the located, self-tested job runner. */
  readonly windowsJobRunner?: () => JobRunnerState | undefined;
  readonly windowsSid?: string | null;
  readonly runFile?: RunFile;
  readonly onEgressDecision?: (d: EgressDecision & { session: string }) => void;
  /** Tests only: loopback ports every session may reach (scripted model providers). Never from config. */
  readonly testLoopbackPorts?: readonly number[];
  /** Tests only. */
  readonly proxyIsForbidden?: (address: string) => boolean;
  readonly proxyLookup?: Lookup;
}

type SandboxReport = NonNullable<AssistantReport['sandbox']>;

export class AssistantSandbox {
  readonly #o: AssistantSandboxOptions;
  readonly #platform: NodeJS.Platform;

  constructor(options: AssistantSandboxOptions) {
    this.#o = options;
    this.#platform = options.platform ?? process.platform;
    for (const [field, p] of [
      ['workerDataDir', options.workerDataDir],
      ['workspaceRoot', options.workspaceRoot],
    ] as const) {
      if (!isAbsolute(p)) throw new SandboxRequestError(field, 'must be an absolute path');
    }
  }

  /** What the profile enforces on this machine right now. */
  report(): SandboxReport {
    const mode = this.#o.mode;
    if (mode === 'off') {
      return {
        mode,
        filesystem: 'none',
        limits: 'none',
        egress: 'none',
        detail: 'assistant sandbox off (local config)',
      };
    }
    if (this.#platform === 'darwin') {
      const sb = this.#o.seatbeltAvailable?.() ?? true;
      return sb
        ? { mode, filesystem: 'seatbelt', limits: 'rlimits', egress: 'enforced' }
        : {
            mode,
            filesystem: 'none',
            limits: 'rlimits',
            egress: 'proxy-env',
            detail: 'sandbox-exec is not usable on this Mac',
          };
    }
    if (this.#platform === 'win32') {
      const jr = this.#o.windowsJobRunner?.();
      return {
        mode,
        filesystem: 'none',
        limits: jr?.verified === true ? 'job-object' : 'none',
        egress: 'proxy-env',
        detail:
          jr?.verified === true
            ? 'Windows: Job Object limits and a protected session directory; no read confinement'
            : 'Windows: the job runner is not verified (Machines > <machine> > Sandbox & policy > Prepare)',
      };
    }
    const bw = this.#o.bwrap?.() ?? { path: null, usable: null };
    return bw.path !== null && bw.usable === true
      ? { mode, filesystem: 'bwrap', limits: 'rlimits', egress: 'proxy-env' }
      : {
          mode,
          filesystem: 'none',
          limits: 'rlimits',
          egress: 'proxy-env',
          detail:
            bw.path === null
              ? 'bubblewrap (bwrap) is not installed'
              : 'bubblewrap cannot create namespaces on this host',
        };
  }

  /** `required` without filesystem confinement refuses assistant turns (engines report not ready). */
  ready(): { ok: true } | { ok: false; reason: string } {
    const r = this.report();
    if (this.#o.mode === 'required' && r.filesystem === 'none') {
      return {
        ok: false,
        reason: `the assistant sandbox is required but unavailable here (${r.detail ?? 'no filesystem confinement'})`,
      };
    }
    return { ok: true };
  }

  /** The confiner of one session (each `confine()` starts its own egress proxy, closed on dispose). */
  forSession(input: {
    readonly runtime: AssistantRuntime;
    readonly authMode: 'secret-ref' | 'local-login';
    readonly sessionDir: string;
    /** p13-runtime-accounts: an added subscription account's folder in the data dir (its login store). */
    readonly loginFolder?: string;
  }): { confiner?: ProcessConfiner } {
    if (this.#o.mode === 'off') return {};
    const ready = this.ready();
    if (!ready.ok) throw new SandboxRequestError('assistant.sandbox', ready.reason);
    const report = this.report();
    return {
      confiner: {
        kind: `assistant:${report.filesystem === 'none' ? report.limits : report.filesystem}`,
        confine: (plan) => this.#confine(input, report, plan),
      },
    };
  }

  async #confine(
    input: {
      runtime: AssistantRuntime;
      authMode: 'secret-ref' | 'local-login';
      sessionDir: string;
      loginFolder?: string;
    },
    report: SandboxReport,
    plan: SpawnPlan,
  ): Promise<ConfinedSpawn> {
    const session = await realpath(input.sessionDir);
    const tmp = join(session, 'tmp');
    const home = join(session, 'home');
    await mkdir(tmp, { recursive: true, mode: 0o700 });
    let proxy: EgressProxy | undefined;
    const dispose = async (): Promise<void> => {
      await proxy?.close();
      proxy = undefined;
    };
    try {
      const token = randomBytes(16).toString('hex');
      const env: Record<string, string> = {
        ...plan.env,
        TMPDIR: tmp,
        TMP: tmp,
        TEMP: tmp,
        [SANDBOX_TOKEN_ENV]: token,
      };
      // API-key runs get a private HOME; a local login lives in the worker user's own HOME.
      if (input.authMode === 'secret-ref') {
        await mkdir(home, { recursive: true, mode: 0o700 });
        env.HOME = home;
        env.USERPROFILE = home;
      }
      const targets = assistantEgress(input.runtime, input.authMode, this.#o.egressAllow).map(
        parseEgressTarget,
      );
      if (targets.length > 0) {
        const onDecision = this.#o.onEgressDecision;
        proxy = await startEgressProxy({
          allow: targets,
          host: '127.0.0.1',
          port: 0,
          ...(onDecision
            ? {
                onDecision: (d: EgressDecision) => {
                  onDecision({ ...d, session });
                },
              }
            : {}),
          ...(this.#o.proxyIsForbidden ? { isForbidden: this.#o.proxyIsForbidden } : {}),
          ...(this.#o.proxyLookup ? { lookup: this.#o.proxyLookup } : {}),
        });
        Object.assign(env, {
          HTTPS_PROXY: proxy.url,
          https_proxy: proxy.url,
          HTTP_PROXY: proxy.url,
          http_proxy: proxy.url,
          // OpenCode's tool endpoint and its own API are on loopback; the proxy refuses loopback anyway.
          NO_PROXY: '127.0.0.1,localhost,::1',
          no_proxy: '127.0.0.1,localhost,::1',
          NODE_USE_ENV_PROXY: '1',
        });
      }
      const cwd = plan.cwd;

      if (this.#platform === 'win32') {
        const runner = this.#o.windowsJobRunner?.();
        // No verified job runner (Sandbox → Prepare not run): `auto` still runs, with the proxy environment
        // only — the same as before this profile existed, never a broken chat.
        if (runner === undefined || !runner.verified) {
          return { command: plan.command, args: plan.args, cwd, env, dispose };
        }
        const script = await assertJobRunnerIntact(runner, this.#o.workerDataDir);
        const sid = this.#o.windowsSid;
        if (sid !== undefined && sid !== null) {
          await restrictAttemptAcl([session], sid, this.#o.runFile ?? runFile);
        }
        const specFile = join(tmp, `jobrun-${token}.json`);
        await writeFile(
          specFile,
          JSON.stringify(jobRunnerSpec([plan.command, ...plan.args], cwd, this.#o.limits)),
          { mode: 0o600 },
        );
        return {
          command: powershellExe(),
          args: jobRunnerArgs(script, specFile),
          cwd,
          env,
          treeKiller: windowsJobObjectKiller(),
          dispose,
        };
      }

      const homes = new Set<string>();
      for (const h of [
        ...this.#o.protectedHomes,
        ...(this.#o.workerHome === undefined ? [] : [this.#o.workerHome]),
      ]) {
        homes.add(await realOrSelf(h));
      }
      const workerHome = this.#o.workerHome === undefined ? undefined : await realOrSelf(this.#o.workerHome);
      // p13-runtime-accounts: an added account's login lives in its own folder (in the data dir), not in the home.
      const accountFolder =
        input.authMode === 'local-login' && input.loginFolder !== undefined
          ? await realOrSelf(input.loginFolder)
          : undefined;
      const login =
        accountFolder !== undefined
          ? { dirs: [accountFolder], prefixes: [] }
          : input.authMode === 'local-login' && workerHome !== undefined
            ? loginPaths(input.runtime, workerHome, plan.env)
            : { dirs: [], prefixes: [] };
      const otherLogins = otherRuntimeLoginDirs(input.runtime, input.authMode, [...homes]);
      const spec: AssistantFsSpec = {
        session,
        workerDataDir: await realOrSelf(this.#o.workerDataDir),
        readableInDataDir: [
          ...(await Promise.all(this.#o.readableInDataDir.map(realOrSelf))),
          ...(accountFolder === undefined ? [] : [accountFolder]),
        ],
        workspaceRoot: await realOrSelf(this.#o.workspaceRoot),
        homes: [...homes],
        // Claude Code keeps its subscription login in the macOS Keychain: a local login needs it readable.
        allowKeychain:
          input.authMode === 'local-login' && (this.#o.allowKeychain || input.runtime === 'claude-code'),
        writableDirs: login.dirs,
        writablePrefixes: login.prefixes,
        denyRead: otherLogins,
      };
      const prelude = posixLimitsPrelude(this.#o.limits, this.#platform);
      let argv = [...prelude, plan.command, ...plan.args];
      if (report.filesystem === 'seatbelt') {
        const sb = buildAssistantSeatbeltProfile({
          ...spec,
          proxyPort: proxy?.port,
          allowListen: LISTENS.has(input.runtime),
          loopbackPorts: [
            ...(LISTENS.has(input.runtime) ? loopbackPorts(plan.env) : []),
            ...(this.#o.testLoopbackPorts ?? []),
          ],
        });
        argv = [...sb.argv, ...argv];
      } else if (report.filesystem === 'bwrap') {
        const bw = this.#o.bwrap?.();
        if (bw?.path == null) throw new SandboxRequestError('bwrap', 'bubblewrap is not available');
        argv = [
          ...prelude,
          bw.path,
          ...(await buildAssistantBwrapArgs(spec, cwd)),
          '--',
          plan.command,
          ...plan.args,
        ];
      }
      const [command, ...args] = argv;
      const treeKiller = reapingTreeKiller({
        token,
        startedAtMs: Date.now(),
        orphans: () => 'in-dirs',
        dirs: [session],
        deps: { platform: this.#platform, uid: process.getuid?.() ?? -1, selfPid: process.pid },
      });
      return { command: command ?? '/bin/sh', args, cwd, env, treeKiller, dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
  }
}

/** Filesystem view of one assistant session (real paths). */
export interface AssistantFsSpec {
  readonly session: string;
  readonly workerDataDir: string;
  readonly readableInDataDir: readonly string[];
  readonly workspaceRoot: string;
  readonly homes: readonly string[];
  readonly allowKeychain: boolean;
  /** local-login: the runtime's login store (writable). */
  readonly writableDirs: readonly string[];
  readonly writablePrefixes: readonly string[];
  /** Login stores of the other runtimes (never readable). */
  readonly denyRead: readonly string[];
}

function loginPaths(
  runtime: AssistantRuntime,
  home: string,
  env: Readonly<Record<string, string>>,
): { dirs: string[]; prefixes: string[] } {
  const spec = RUNTIME_LOGIN_PATHS[runtime];
  const dirs = spec.dirs.map((d) => join(home, d));
  // A runtime pointed at another login store by the worker's env (CODEX_HOME, PI_CODING_AGENT_DIR) keeps it.
  const own = runtime === 'codex' ? env.CODEX_HOME : runtime === 'pi' ? env.PI_CODING_AGENT_DIR : undefined;
  if (own !== undefined && isAbsolute(own)) dirs.push(own);
  return { dirs, prefixes: spec.prefixes.map((p) => join(home, p)) };
}

function otherRuntimeLoginDirs(
  runtime: AssistantRuntime,
  authMode: 'secret-ref' | 'local-login',
  homes: readonly string[],
): string[] {
  const out: string[] = [];
  for (const [r, spec] of Object.entries(RUNTIME_LOGIN_PATHS) as [
    AssistantRuntime,
    (typeof RUNTIME_LOGIN_PATHS)[AssistantRuntime],
  ][]) {
    if (r === runtime && authMode === 'local-login') continue;
    for (const h of homes) for (const d of spec.dirs) out.push(join(h, d));
  }
  return out;
}

function loopbackPorts(env: Readonly<Record<string, string>>): number[] {
  const raw = env[ASSISTANT_LOOPBACK_PORTS_ENV];
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((p) => Number(p.trim()))
    .filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535);
}

function checkPath(field: string, p: string): string {
  if (!isAbsolute(p) || p.includes('\0') || p.includes('\n')) {
    throw new SandboxRequestError(field, `must be an absolute path (${JSON.stringify(p)})`);
  }
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/** Directories from `root` (inclusive) down to the parent of `target`, when `target` lies below `root`. */
function ancestorsBelow(root: string, target: string): string[] {
  if (!target.startsWith(`${root}/`)) return [];
  const out = [root];
  let cur = root;
  for (const seg of target
    .slice(root.length + 1)
    .split('/')
    .slice(0, -1)) {
    cur = `${cur}/${seg}`;
    out.push(cur);
  }
  return out;
}

/**
 * macOS Seatbelt profile of an assistant session. Same conventions as the host-job profile (seatbelt.ts):
 * `allow default`, then denials; the last matching rule wins; every path is a `-D` parameter.
 */
export function buildAssistantSeatbeltProfile(
  spec: AssistantFsSpec & {
    readonly proxyPort?: number | undefined;
    readonly allowListen?: boolean;
    readonly loopbackPorts?: readonly number[];
  },
): { profile: string; params: Record<string, string>; argv: string[] } {
  const params: Record<string, string> = {};
  const lines: string[] = ['(version 1)', '(allow default)'];
  let n = 0;
  const param = (field: string, value: string): string => {
    const key = `P${String(n++)}`;
    params[key] = checkPath(field, value);
    return `(param "${key}")`;
  };

  // Writes: the session dir (+ a local login's own store), the usual devices.
  lines.push('(deny file-write*)');
  const writable = [
    `(subpath ${param('session', spec.session)})`,
    ...spec.writableDirs.map((d) => `(subpath ${param('writableDirs', d)})`),
    ...spec.writablePrefixes.map((d) => `(prefix ${param('writablePrefixes', d)})`),
  ];
  lines.push(
    `(allow file-write* ${writable.join(' ')} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))`,
  );

  // Reads (1): the worker data dir, except the runtime installs, the session and the directories leading to
  // it (metadata only: getcwd(3) needs them; their listings are denied).
  const data = spec.workerDataDir;
  const keep = [
    ...spec.readableInDataDir.map((p) => `(require-not (subpath ${param('readableInDataDir', p)}))`),
    `(require-not (subpath ${param('session', spec.session)}))`,
  ];
  const ancestors = ancestorsBelow(data, spec.session);
  for (const a of ancestors) keep.push(`(require-not (literal ${param('ancestor', a)}))`);
  lines.push(`(deny file-read* (require-all (subpath ${param('workerDataDir', data)}) ${keep.join(' ')}))`);
  for (const a of ancestors)
    lines.push(`(deny file-read-data file-read-xattr (literal ${param('ancestor', a)}))`);
  // Reads (2): nothing of the workspace root (repositories, worktrees, mirrors, job sandboxes).
  lines.push(`(deny file-read* (subpath ${param('workspaceRoot', spec.workspaceRoot)}))`);
  // Reads (3): protected home paths and the other runtimes' login stores.
  const deny: string[] = [];
  for (const home of spec.homes) {
    for (const rel of PROTECTED_HOME_PATHS) {
      if (rel === 'Library/Keychains' && spec.allowKeychain) continue;
      deny.push(`(subpath ${param('homes', join(home, rel))})`);
    }
  }
  for (const p of spec.denyRead) deny.push(`(subpath ${param('denyRead', p)})`);
  if (deny.length > 0) lines.push(`(deny file-read* ${deny.join(' ')})`);

  // Network: nothing but the session's egress proxy (and OpenCode's loopback API / tool endpoint).
  lines.push('(deny network*)');
  if (spec.allowListen === true) {
    lines.push('(allow network-bind (local ip "localhost:*"))');
    lines.push('(allow network-inbound (local ip "localhost:*"))');
  }
  const ports = [...(spec.proxyPort === undefined ? [] : [spec.proxyPort]), ...(spec.loopbackPorts ?? [])];
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SandboxRequestError('port', String(port));
    }
    lines.push(`(allow network-outbound (remote ip "localhost:${String(port)}"))`);
  }
  const profile = lines.join('\n');
  const argv: string[] = [SANDBOX_EXEC, '-p', profile];
  for (const [k, v] of Object.entries(params)) argv.push('-D', `${k}=${v}`);
  return { profile, params, argv };
}

/**
 * Linux bubblewrap arguments of an assistant session: a read-only view of the host with the workspace root and
 * the worker data dir replaced by empty tmpfs (runtime installs and the session bound back), protected home
 * paths and other runtimes' login stores masked, a private /tmp, writes only to the session (and a local
 * login's own store). Network stays shared (the loopback egress proxy; egress is `proxy-env` on Linux).
 */
export async function buildAssistantBwrapArgs(spec: AssistantFsSpec, cwd: string): Promise<string[]> {
  const args = [
    '--die-with-parent',
    '--unshare-ipc',
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
  ];
  const mask = async (p: string): Promise<void> => {
    const st = await lstat(p).catch(() => null);
    if (st === null) return;
    if (st.isDirectory()) args.push('--tmpfs', checkPath('mask', p));
    else args.push('--ro-bind', '/dev/null', checkPath('mask', p));
  };
  await mask(spec.workspaceRoot);
  await mask(spec.workerDataDir);
  for (const p of spec.readableInDataDir) {
    if ((await lstat(p).catch(() => null)) !== null) args.push('--ro-bind', checkPath('readable', p), p);
  }
  for (const home of spec.homes) {
    for (const rel of PROTECTED_HOME_PATHS) await mask(join(home, rel));
  }
  for (const p of spec.denyRead) await mask(p);
  for (const d of spec.writableDirs) {
    if ((await lstat(d).catch(() => null)) !== null) args.push('--bind', checkPath('writable', d), d);
  }
  // Local-login files rewritten in place (e.g. ~/.claude.json): bind the existing file itself.
  for (const p of spec.writablePrefixes) {
    if ((await lstat(p).catch(() => null))?.isFile() === true)
      args.push('--bind', checkPath('writable', p), p);
  }
  args.push('--bind', checkPath('session', spec.session), spec.session);
  args.push('--chdir', checkPath('cwd', cwd));
  return args;
}

async function realOrSelf(p: string): Promise<string> {
  return realpath(p).catch(() => p);
}
