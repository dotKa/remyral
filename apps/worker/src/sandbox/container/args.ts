import { isAbsolute } from 'node:path';
import { CONTAINER_GIT_DIR, CONTAINER_WORKSPACE } from '../attempt-git.js';
import { SandboxRequestError } from '../errors.js';
import type { ResourceLimits } from '../types.js';

/** Writable HOME inside the job container (tmpfs; nothing persists). */
export const CONTAINER_HOME = '/home/remyral';
/** Default non-root identity of the runtime images (infra/worker/images/base). */
export const CONTAINER_USER = '10001:10001';
export const EGRESS_PROXY_ALIAS = 'egress-proxy';
export const EGRESS_PROXY_PORT = 3128;

export interface BindMount {
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
}

export interface ContainerRunSpec {
  readonly name: string;
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
  /** `none` or the per-job internal network. */
  readonly network: string;
  readonly user: string;
  readonly limits: ResourceLimits;
  readonly mounts: readonly BindMount[];
  readonly workdir: string;
  /** Variable names forwarded from the client environment (`-e NAME`, value never in argv). */
  readonly envNames: readonly string[];
  readonly stdin: boolean;
  readonly command: string;
  readonly args: readonly string[];
}

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const ENV = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function mountArg(m: BindMount): string {
  for (const p of [m.source, m.target]) {
    if (!isAbsolute(p) || p.includes(',') || p.includes('\0') || p.includes('\n')) {
      throw new SandboxRequestError('mount', `unsafe mount path ${JSON.stringify(p)}`);
    }
  }
  // --mount (not -v): a missing source is an error instead of an auto-created root-owned dir.
  return `type=bind,source=${m.source},target=${m.target}${m.readOnly ? ',readonly' : ''}`;
}

/**
 * `docker run` argv for one job container (ADR-0007 `container`). Pure, so the
 * hardening is unit-tested independently of an engine:
 * non-root, read-only root fs, all capabilities dropped, no-new-privileges,
 * default seccomp (never `unconfined`), init for reaping, pids/memory/CPU/
 * nofile/fsize limits, no swap, tmpfs /tmp and HOME, no engine socket, no
 * published ports, no host namespaces, logs not persisted by the engine.
 */
export function buildRunArgs(spec: ContainerRunSpec): string[] {
  if (!NAME.test(spec.name)) throw new SandboxRequestError('name', `invalid container name ${spec.name}`);
  if (!NAME.test(spec.network) && spec.network !== 'none') {
    throw new SandboxRequestError('network', `invalid network ${spec.network}`);
  }
  if (spec.image.startsWith('-') || /\s/.test(spec.image) || spec.image === '') {
    throw new SandboxRequestError('image', `invalid image reference ${spec.image}`);
  }
  if (!/^\d{1,10}(:\d{1,10})?$/.test(spec.user) || /^0(:|$)/.test(spec.user)) {
    throw new SandboxRequestError(
      'user',
      `container user must be a non-root numeric uid[:gid] (got ${spec.user})`,
    );
  }
  const l = spec.limits;
  const mem = Math.floor(l.memoryBytes);
  const args: string[] = [
    'run',
    '--name',
    spec.name,
    '--pull',
    'never',
    '--init',
    '--network',
    spec.network,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    spec.user,
    '--pids-limit',
    String(Math.floor(l.pids)),
    '--memory',
    `${String(mem)}b`,
    '--memory-swap',
    `${String(mem)}b`,
    '--cpus',
    String(l.cpus),
    '--ulimit',
    `nofile=${String(l.openFiles)}:${String(l.openFiles)}`,
    '--ulimit',
    `fsize=${String(l.fileSizeBytes)}:${String(l.fileSizeBytes)}`,
    '--ulimit',
    'core=0:0',
    '--tmpfs',
    `/tmp:rw,nosuid,nodev,size=${String(Math.floor(l.tmpBytes))},mode=1777`,
    '--tmpfs',
    `${CONTAINER_HOME}:rw,nosuid,nodev,size=${String(Math.floor(l.tmpBytes))},mode=1777`,
    '--ipc',
    'private',
    '--log-driver',
    'none',
    '--no-healthcheck',
    '--hostname',
    'sandbox',
    '--workdir',
    spec.workdir,
  ];
  if (spec.stdin) args.push('--interactive');
  for (const [k, v] of Object.entries(spec.labels)) {
    if (!/^[a-z0-9.-]{1,64}$/.test(k) || /[\n\0]/.test(v)) throw new SandboxRequestError('label', k);
    args.push('--label', `${k}=${v}`);
  }
  for (const m of spec.mounts) args.push('--mount', mountArg(m));
  for (const n of spec.envNames) {
    if (!ENV.test(n)) throw new SandboxRequestError('env', `invalid variable name ${n}`);
    args.push('--env', n);
  }
  args.push('--', spec.image, spec.command, ...spec.args);
  return args;
}

/** Standard mounts of an attempt: the worktree (rw), and with a git view: its git dir + mirror objects. */
export function attemptMounts(opts: {
  workspacePath: string;
  git?: { gitDir: string; mirrorObjects: string; containerDotGit: string } | undefined;
}): BindMount[] {
  const mounts: BindMount[] = [{ source: opts.workspacePath, target: CONTAINER_WORKSPACE, readOnly: false }];
  if (opts.git) {
    mounts.push(
      { source: opts.git.containerDotGit, target: `${CONTAINER_WORKSPACE}/.git`, readOnly: true },
      { source: opts.git.gitDir, target: CONTAINER_GIT_DIR, readOnly: false },
      { source: opts.git.mirrorObjects, target: opts.git.mirrorObjects, readOnly: true },
    );
  }
  return mounts;
}
