import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Plain git for building fixtures; isolated from the developer's global config. */
export function git(cwd: string, args: readonly string[], input?: string): string {
  return execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], {
    cwd,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim();
}

export interface Origin {
  /** Bare repository path. */
  bare: string;
  /** file:// URL of the bare repository. */
  url: string;
  /** A non-bare clone used to author upstream commits. */
  work: string;
  /** Sha of the initial commit on main. */
  initial: string;
}

/** A bare "origin" with one commit on `main` (files from `files`), plus a work clone. */
export async function createOrigin(
  dir: string,
  name = 'origin',
  files: Record<string, string> = { 'README.md': 'hello\n' },
): Promise<Origin> {
  const bare = join(dir, `${name}.git`);
  const work = join(dir, `${name}-work`);
  await mkdir(bare, { recursive: true });
  git(bare, ['init', '--bare', '-b', 'main']);
  await mkdir(work, { recursive: true });
  git(work, ['init', '-b', 'main']);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(work, path, '..'), { recursive: true });
    await writeFile(join(work, path), content);
  }
  git(work, ['add', '-A']);
  git(work, ['commit', '-m', 'initial']);
  git(work, ['remote', 'add', 'origin', bare]);
  git(work, ['push', 'origin', 'main']);
  return { bare, url: pathToFileURL(bare).href, work, initial: git(work, ['rev-parse', 'HEAD']) };
}

/** Commit `files` in the origin work clone and push `branch`. Returns the sha. */
export async function upstreamCommit(
  origin: Origin,
  files: Record<string, string>,
  message = 'upstream',
  branch = 'main',
): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(origin.work, path, '..'), { recursive: true });
    await writeFile(join(origin.work, path), content);
  }
  git(origin.work, ['add', '-A']);
  git(origin.work, ['commit', '-m', message]);
  git(origin.work, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
  return git(origin.work, ['rev-parse', 'HEAD']);
}

export function remoteSha(origin: Origin, ref: string): string | null {
  try {
    return git(origin.bare, ['rev-parse', '--verify', '--quiet', ref]);
  } catch {
    return null;
  }
}
