import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_PIN, type ProcessConfiner } from '../../../src/index.js';

export const FAKE_APP_SERVER = fileURLToPath(new URL('./fake-app-server.ts', import.meta.url));

/**
 * Per-test-file root for CODEX_HOME directories. Not under /tmp: on Linux the
 * adapter refuses that (Codex will not create its sandbox helpers there).
 */
export function codexTestStateDir(): string {
  const base = join(homedir(), '.cache', 'remyral-tests');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, 'codex-'));
}

/**
 * The pinned codex binary for real-binary tests: REMYRAL_CODEX_BIN or `codex` on PATH, if it is CODEX_PIN — or, for the
 * vendor's version-catalog contract run (scripts/release/catalog.mjs test, p17-update-channel), the candidate version
 * named by REMYRAL_CODEX_EXPECT_VERSION.
 */
export function pinnedCodexBinary(): string | undefined {
  const candidate = process.env.REMYRAL_CODEX_BIN ?? 'codex';
  const expected = process.env.REMYRAL_CODEX_EXPECT_VERSION ?? CODEX_PIN;
  try {
    const out = execFileSync(candidate, ['--version'], { encoding: 'utf8', timeout: 15_000 });
    return out.split(/\s+/).includes(expected) && out.includes('codex-cli') ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Seatbelt profile: everything allowed except outbound network to anything but localhost (and unix sockets).
 * Real-binary tests run the app-server under it so a missed override can never reach api.openai.com /
 * chatgpt.com — a request that does not go to the local fake fails instead (p6-codex-apikey-fix).
 */
const LOCALHOST_ONLY_PROFILE = [
  '(version 1)',
  '(allow default)',
  '(deny network-outbound)',
  '(allow network-outbound (remote ip "localhost:*"))',
  '(allow network-outbound (remote unix-socket))',
].join(' ');

/**
 * A test confiner that starts the process under `sandbox-exec` with {@link LOCALHOST_ONLY_PROFILE} (macOS only;
 * `undefined` elsewhere — callers skip the test rather than run it with network access).
 */
export function localhostOnlyConfiner(): ProcessConfiner | undefined {
  if (process.platform !== 'darwin') return undefined;
  return {
    kind: 'test:localhost-only',
    confine: (plan) =>
      Promise.resolve({
        command: '/usr/bin/sandbox-exec',
        args: ['-p', LOCALHOST_ONLY_PROFILE, plan.command, ...plan.args],
        cwd: plan.cwd,
        env: plan.env,
      }),
  };
}
