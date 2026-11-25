import { execFile } from 'node:child_process';
import { checkGitRemote, type HostResolver } from '../ops/git-egress.js';

export type RemoteBranchState = 'present' | 'absent' | 'unknown';

/**
 * Answers "did this attempt push its branch?" for reconciliation after a lost lease (ADR-0004 §3/§5:
 * the attempt branch `rac/<jobId>/<attemptId>` is the platform's only external side effect today).
 * `unknown` must be treated as "a side effect may exist" (never a blind rerun).
 */
export interface RemoteBranchInspector {
  inspect(repositoryUrl: string, branch: string): Promise<RemoteBranchState>;
}

const BRANCH = /^rac\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/**
 * `git ls-remote` against the repository — no clone, no checkout, nothing written (the control plane
 * never checks out user repositories, AGENTS.md rule 1). Hardened like the worker's GitRunner: no
 * system/global config, no prompts, only https/ssh transports, batch-mode ssh, bounded time and output.
 * No credentials are used: a private repository answers `unknown` (fail closed) until p4-git-flow passes
 * an installation token through a credential helper. The host must resolve to public addresses (or be an
 * operator-listed internal origin) before git runs; for https the checked address is pinned (`ops/git-egress.ts`).
 */
export class GitLsRemoteInspector implements RemoteBranchInspector {
  constructor(
    private readonly opts: {
      readonly gitBinary?: string;
      readonly timeoutMs?: number;
      readonly internalOrigins?: ReadonlySet<string>;
      /** Tests: host name resolution (default: the system resolver). */
      readonly resolve?: HostResolver;
    } = {},
  ) {}

  async inspect(repositoryUrl: string, branch: string): Promise<RemoteBranchState> {
    let url: URL;
    try {
      url = new URL(repositoryUrl);
    } catch {
      return 'unknown';
    }
    if (
      (url.protocol !== 'https:' && url.protocol !== 'ssh:') ||
      url.password !== '' ||
      !BRANCH.test(branch)
    ) {
      return 'unknown';
    }
    const egress = await checkGitRemote(url, {
      ...(this.opts.internalOrigins === undefined ? {} : { internalOrigins: this.opts.internalOrigins }),
      ...(this.opts.resolve === undefined ? {} : { resolve: this.opts.resolve }),
    });
    if (!egress.ok) return 'unknown';
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: '/nonexistent',
      LC_ALL: 'C',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes',
    };
    const args = [
      '-c',
      'protocol.allow=never',
      '-c',
      'protocol.https.allow=always',
      '-c',
      'protocol.ssh.allow=always',
      '-c',
      'credential.helper=',
      ...egress.gitConfig,
      'ls-remote',
      '--heads',
      '--end-of-options',
      repositoryUrl,
      `refs/heads/${branch}`,
    ];
    return new Promise((resolve) => {
      execFile(
        this.opts.gitBinary ?? 'git',
        args,
        { env, timeout: this.opts.timeoutMs ?? 15_000, maxBuffer: 64 * 1024, windowsHide: true },
        (err, stdout) => {
          if (err) {
            resolve('unknown');
            return;
          }
          resolve(
            stdout.split('\n').some((l) => l.endsWith(`\trefs/heads/${branch}`)) ? 'present' : 'absent',
          );
        },
      );
    });
  }
}
