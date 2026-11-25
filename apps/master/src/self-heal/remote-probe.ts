import { execFile } from 'node:child_process';
import { isTargetBranch, parseRepoUrl } from '../gitflow/refs.js';
import { checkGitRemote, type HostResolver } from '../ops/git-egress.js';

/**
 * p22-git-preflight (docs/design/p22-git-preflight.md §1–§2): what an ANONYMOUS reader sees of a repository — exactly
 * what a worker sees when the platform hands it no credential (the worker's git ignores the machine's credential
 * helpers and never prompts). One `git ls-remote --symref <url> HEAD refs/heads/*` (no clone, no checkout, nothing
 * written: the control plane never checks out user repositories, AGENTS.md rule 1), hardened like the lost-attempt
 * inspector (no system / global config, no credential helper, no prompts, https only, bounded time and output).
 *
 * - `readable`: the repository's branches (name → sha) and its default branch (the remote `HEAD`), `empty` when it has
 *   no branch at all;
 * - `denied`: the remote wants credentials ("could not read Username", 401/403, "Repository not found") — a private
 *   repository (or one that does not exist) that a job without a credential can never read;
 * - `unknown`: anything else (network, timeout, output limit, not https, a host that resolves to a non-public
 *   address — checked before git runs, see `ops/git-egress.ts`) — never a reason to fail a job.
 *
 * Results are cached per repository (readable 10 min, denied 2 min, unknown 1 min) and concurrent probes of the same
 * repository share one `git` process: dispatch asks for every queued job on every tick.
 */

export type RemoteProbeResult =
  | {
      readonly kind: 'readable';
      readonly heads: ReadonlyMap<string, string>;
      /** Tag names (a base ref may name a tag: the worker resolves `refs/tags/<ref>` too). */
      readonly tags: ReadonlySet<string>;
      readonly defaultBranch: string | null;
      readonly empty: boolean;
    }
  | { readonly kind: 'denied' }
  | { readonly kind: 'unknown'; readonly why: string };

/** Runs git with the given arguments and environment: exit code (null: killed), stdout, stderr. */
export type ProbeExec = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>;

const TTL_MS = { readable: 10 * 60_000, denied: 2 * 60_000, unknown: 60_000 } as const;

const DENIED =
  /could not read (?:Username|Password)|terminal prompts disabled|Authentication failed|Invalid username or (?:password|token)|returned error: 40[13]|HTTP Basic: Access denied|Repository not found/i;

export class RemoteProbe {
  readonly #exec: ProbeExec;
  readonly #clock: () => number;
  readonly #cache = new Map<string, { readonly until: number; readonly result: RemoteProbeResult }>();
  readonly #inflight = new Map<string, Promise<RemoteProbeResult>>();
  readonly #resolve: HostResolver | undefined;
  #internalOrigins: ReadonlySet<string> | undefined;

  constructor(
    opts: {
      readonly gitBinary?: string;
      readonly timeoutMs?: number;
      readonly exec?: ProbeExec;
      readonly clock?: () => number;
      /** Tests: host name resolution (default: the system resolver). */
      readonly resolve?: HostResolver;
      readonly internalOrigins?: ReadonlySet<string>;
    } = {},
  ) {
    this.#exec = opts.exec ?? defaultExec(opts.gitBinary ?? 'git', opts.timeoutMs ?? 15_000);
    this.#clock = opts.clock ?? (() => Date.now());
    this.#resolve = opts.resolve;
    this.#internalOrigins = opts.internalOrigins;
  }

  /** The operator's internal origins (a live set from the panel settings), allowed on a private address. */
  useInternalOrigins(origins: ReadonlySet<string>): void {
    this.#internalOrigins = origins;
  }

  async probe(repositoryUrl: string): Promise<RemoteProbeResult> {
    const parsed = parseRepoUrl(repositoryUrl);
    if (parsed === null || parsed.protocol !== 'https') return { kind: 'unknown', why: 'not an https url' };
    const key = parsed.key.toLowerCase();
    const now = this.#clock();
    const cached = this.#cache.get(key);
    if (cached !== undefined && cached.until > now) return cached.result;
    const running = this.#inflight.get(key);
    if (running !== undefined) return running;
    const run = this.#run(`https://${parsed.host}/${parsed.path}.git`).finally(() =>
      this.#inflight.delete(key),
    );
    this.#inflight.set(key, run);
    const result = await run;
    if (this.#cache.size > 2_000) this.#cache.clear();
    this.#cache.set(key, { until: this.#clock() + TTL_MS[result.kind], result });
    return result;
  }

  /** Forgets a repository (a user just fixed its access: the next dispatch asks again). */
  forget(repositoryUrl: string): void {
    const parsed = parseRepoUrl(repositoryUrl);
    if (parsed !== null) this.#cache.delete(parsed.key.toLowerCase());
  }

  async #run(url: string): Promise<RemoteProbeResult> {
    const egress = await checkGitRemote(new URL(url), {
      ...(this.#internalOrigins === undefined ? {} : { internalOrigins: this.#internalOrigins }),
      ...(this.#resolve === undefined ? {} : { resolve: this.#resolve }),
    });
    if (!egress.ok) return { kind: 'unknown', why: egress.why };
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: '/nonexistent',
      LC_ALL: 'C',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
    };
    const args = [
      '-c',
      'protocol.allow=never',
      '-c',
      'protocol.https.allow=always',
      '-c',
      'credential.helper=',
      '-c',
      'core.askPass=',
      ...egress.gitConfig,
      'ls-remote',
      '--symref',
      '--end-of-options',
      url,
      'HEAD',
      'refs/heads/*',
      'refs/tags/*',
    ];
    let out: Awaited<ReturnType<ProbeExec>>;
    try {
      out = await this.#exec(args, env);
    } catch {
      return { kind: 'unknown', why: 'git could not run' };
    }
    if (out.code === 0) return parseLsRemote(out.stdout);
    if (out.code !== null && DENIED.test(out.stderr)) return { kind: 'denied' };
    return { kind: 'unknown', why: out.code === null ? 'timed out' : `exit ${String(out.code)}` };
  }
}

/** `ls-remote --symref … HEAD refs/heads/* refs/tags/*` output → branches, tags, the default branch (exported for tests). */
export function parseLsRemote(stdout: string): RemoteProbeResult {
  const heads = new Map<string, string>();
  const tags = new Set<string>();
  let defaultBranch: string | null = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    const sym = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line);
    if (sym?.[1] !== undefined) {
      if (isTargetBranch(sym[1])) defaultBranch = sym[1];
      continue;
    }
    const m = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\trefs\/(heads|tags)\/(\S+?)(\^\{\})?$/.exec(line);
    if (m?.[1] === undefined || m[3] === undefined) continue;
    if (m[2] === 'heads') heads.set(m[3], m[1]);
    else tags.add(m[3]);
  }
  return { kind: 'readable', heads, tags, defaultBranch, empty: heads.size === 0 && tags.size === 0 };
}

function defaultExec(binary: string, timeoutMs: number): ProbeExec {
  return (args, env) =>
    new Promise((resolve) => {
      execFile(
        binary,
        [...args],
        { env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (err === null) {
            resolve({ code: 0, stdout, stderr });
            return;
          }
          const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
          resolve({
            code: e.killed === true || typeof e.code !== 'number' ? null : e.code,
            stdout: '',
            stderr: typeof stderr === 'string' ? stderr.slice(0, 4096) : '',
          });
        },
      );
    });
}
