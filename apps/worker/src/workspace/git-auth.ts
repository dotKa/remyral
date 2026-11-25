import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Redactor, Revealable } from '@remyral/observability';
import { type GitCall, isGitAuthFailure } from './git.js';

/**
 * p15-git-central (docs/design/p15-git-central.md §1–§2, §4): the credential a repository job's network git command
 * uses is fetched **on demand, right before that command** — never once at job start and reused later.
 *
 * Live finding 2026-10-22: a job on the Windows worker failed with `git push failed (exit 128): remote: Invalid
 * username or token. Password authentication is not supported` for a GitHub repository. The worker had minted one
 * GitHub App installation token (valid 1 hour) before the checkout and pushed with that same token after the agent
 * run; a run longer than the token's lifetime pushes with an expired token, which GitHub answers exactly like that.
 * (No token at all would have failed differently — the worker's git ignores the machine's credential helpers and
 * never prompts: "could not read Username … terminal prompts disabled".)
 */

/** One credential for one network git command. Values are only ever handed to git through env or a 0600 temp file. */
export type GitAuthMaterial =
  | {
      readonly kind: 'token';
      readonly token: Revealable;
      /** Default `x-access-token` (GitHub App installation tokens). */
      readonly username?: string;
    }
  | {
      /** A project deploy key (vault credential) for an `ssh://` remote, with its pinned known_hosts lines. */
      readonly kind: 'ssh-key';
      readonly privateKey: Revealable;
      readonly knownHosts: string;
    };

export type GitAuthPurpose = 'fetch' | 'push';

/**
 * Supplies a fresh credential right before each network command. `retry` is true for the one retry after the remote
 * refused the previous credential (the source must not hand back a cached one then). `null`: no credential (public
 * repositories) — git then runs without any helper.
 */
export type GitAuthSource = (req: {
  readonly purpose: GitAuthPurpose;
  readonly retry: boolean;
}) => Promise<GitAuthMaterial | null>;

type AuthFields = Pick<GitCall, 'token' | 'tokenUsername' | 'ssh' | 'redactor'>;

/**
 * Runs one network git command with a fresh credential and, when the remote refuses it (expired / revoked token,
 * refused key), once more with a newly requested one. SSH key material lives in a per-command directory under
 * `credDir` (0700, key 0600) that is removed after the command, whatever happens.
 */
export async function withGitAuth<T>(
  source: GitAuthSource | undefined,
  opts: {
    readonly purpose: GitAuthPurpose;
    readonly credDir: string;
    readonly redactor?: Redactor | undefined;
    readonly onRetry?: (reason: string) => void;
  },
  run: (fields: AuthFields) => Promise<T>,
): Promise<T> {
  const base: AuthFields = opts.redactor === undefined ? {} : { redactor: opts.redactor };
  if (source === undefined) return run(base);
  for (const retry of [false, true]) {
    const material = await source({ purpose: opts.purpose, retry });
    const prepared = await materialize(material, opts.credDir);
    try {
      return await run({ ...base, ...prepared.fields });
    } catch (err) {
      if (!retry && isGitAuthFailure(err)) {
        opts.onRetry?.('auth_refused');
        continue;
      }
      throw err;
    } finally {
      await prepared.cleanup();
    }
  }
  /* c8 ignore next */
  throw new Error('unreachable');
}

async function materialize(
  material: GitAuthMaterial | null,
  credDir: string,
): Promise<{ fields: AuthFields; cleanup: () => Promise<void> }> {
  const none = async (): Promise<void> => {
    /* nothing to remove */
  };
  if (material === null) return { fields: {}, cleanup: none };
  if (material.kind === 'token') {
    return {
      fields: {
        token: material.token,
        ...(material.username === undefined ? {} : { tokenUsername: material.username }),
      },
      cleanup: none,
    };
  }
  await mkdir(credDir, { recursive: true, mode: 0o700 });
  const dir = join(credDir, randomUUID());
  await mkdir(dir, { mode: 0o700 });
  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  };
  try {
    const keyFile = join(dir, 'key');
    const knownHostsFile = join(dir, 'known_hosts');
    const key = material.privateKey.reveal();
    await writeFile(keyFile, key.endsWith('\n') ? key : `${key}\n`, { mode: 0o600, flag: 'wx' });
    await writeFile(knownHostsFile, `${material.knownHosts.trim()}\n`, { mode: 0o600, flag: 'wx' });
    return { fields: { ssh: { keyFile, knownHostsFile } }, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** A static token (older callers, tests): the same value for every command, no retry source. */
export function staticGitAuth(token: Revealable | undefined, username?: string): GitAuthSource | undefined {
  if (token === undefined) return undefined;
  return () =>
    Promise.resolve({ kind: 'token', token, ...(username === undefined ? {} : { username }) } as const);
}
