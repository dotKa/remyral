import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type GitIdentityValue, GIT_JOB_CONFIG_ENV } from '@remyral/protocol';
import { hasControlChars } from './repo-url.js';

/**
 * p15-git-central §2 (docs/design/p15-git-central.md): the job-local git configuration of a repository job's agent.
 *
 * The worker's own git (fetch, commit, push) already ignores the machine's system and global config
 * (workspace/git.ts). The agent's `git` / `gh` used to inherit them: Git Credential Manager or a stale keychain
 * login, `url.*.insteadOf` rewrites, a personal `user.email`, `core.autocrlf`, a `gh auth` login of the machine's
 * user. Now every repository job's runtime gets
 *
 *  - `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=<attempt state dir>/git/config`, a file written here with only safe
 *    settings: `credential.helper` reset (no helper at all — the agent never holds a git credential; the worker
 *    fetches and pushes, T-INJ-2), the project's identity, `core.autocrlf=false`, `safe.directory` for exactly the
 *    attempt's worktree and git view (per-job Windows accounts and containers own neither), no fsmonitor, no `ext::`;
 *  - `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never` (a Git Credential Manager found some other way never prompts);
 *  - `GH_CONFIG_DIR=<attempt state dir>/gh` (empty: the machine's `gh` login is not used) and `GH_PROMPT_DISABLED=1`.
 *
 * The state dir is the attempt's private runtime dir (inside the sandbox, mounted at the same path in containers),
 * removed with the attempt.
 */
export interface JobGitConfig {
  readonly path: string;
  readonly env: Readonly<Record<(typeof GIT_JOB_CONFIG_ENV)[number], string>>;
}

export async function writeJobGitConfig(
  stateDir: string,
  opts: {
    readonly identity: GitIdentityValue;
    /** Worktree, git view and their container paths (safe.directory entries). */
    readonly safeDirectories: readonly string[];
    readonly platform?: NodeJS.Platform;
  },
): Promise<JobGitConfig> {
  const gitDir = join(stateDir, 'git');
  const ghDir = join(stateDir, 'gh');
  await mkdir(gitDir, { recursive: true, mode: 0o700 });
  await mkdir(ghDir, { recursive: true, mode: 0o700 });
  const path = join(gitDir, 'config');
  await writeFile(path, renderJobGitConfig(opts), { mode: 0o600 });
  return {
    path,
    env: {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GH_CONFIG_DIR: ghDir,
      GH_PROMPT_DISABLED: '1',
    },
  };
}

/** The config text (exported for tests). Values are quoted git-config strings; control characters are refused. */
export function renderJobGitConfig(opts: {
  readonly identity: GitIdentityValue;
  readonly safeDirectories: readonly string[];
  readonly platform?: NodeJS.Platform;
}): string {
  const platform = opts.platform ?? process.platform;
  const lines = [
    '# Remyral job-local git configuration (p15-git-central). The machine\u2019s system and global git',
    '# configuration, credential helpers and gh logins are not used by this job.',
    '[credential]',
    '\thelper =',
    '\tinteractive = never',
    '[core]',
    '\tautocrlf = false',
    '\tfsmonitor = false',
    '\taskPass =',
    '[user]',
    `\tname = ${quote(opts.identity.name)}`,
    `\temail = ${quote(opts.identity.email)}`,
    '[init]',
    '\tdefaultBranch = main',
    '[commit]',
    '\tgpgSign = false',
    '[tag]',
    '\tgpgSign = false',
    '[protocol "ext"]',
    '\tallow = never',
    '[safe]',
    ...[...new Set(opts.safeDirectories)].map(
      (d) => `\tdirectory = ${quote(platform === 'win32' ? d.split('\\').join('/') : d)}`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

function quote(value: string): string {
  if (hasControlChars(value)) throw new Error('git config value contains control characters');
  return `"${value.split('\\').join('\\\\').split('"').join('\\"')}"`;
}
