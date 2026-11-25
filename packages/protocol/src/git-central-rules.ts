/**
 * p15-git-central: the pure, dependency-free rules shared by master, worker and the console (no zod, no Node): git
 * versions, pinned known_hosts lines and SSH deploy key values. Schemas live in git-central.ts.
 */

/**
 * `GIT_CONFIG_GLOBAL` (which the worker uses to keep the machine's global config away from every git it runs) exists
 * since git 2.32.0; an older git silently reads `~/.gitconfig` instead. Older versions are reported as blocking.
 */
export const MIN_GIT_VERSION = '2.32.0';

/** True when `version` (`2.45.1`, `2.47.1.windows.2`, `git version 2.39.5 (Apple Git-154)`) is at least {@link MIN_GIT_VERSION}. */
export function gitVersionSupported(version: string): boolean {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (m === null) return false;
  const [maj, min, patch] = [Number(m[1]), Number(m[2]), Number(m[3] ?? '0')];
  const [rMaj, rMin, rPatch] = MIN_GIT_VERSION.split('.').map(Number) as [number, number, number];
  if (maj !== rMaj) return maj > rMaj;
  if (min !== rMin) return min > rMin;
  return patch >= rPatch;
}

export const MAX_KNOWN_HOSTS_LINES = 16;
export const MAX_KNOWN_HOSTS_BYTES = 16 * 1024;

const KEY_TYPES = new Set([
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
]);

export type KnownHostsProblem = 'empty' | 'too_long' | 'too_many_lines' | 'bad_line';

/**
 * Pinned known_hosts lines for an SSH repository (as `ssh-keyscan` prints them, verified by the admin out of band).
 * Each line: `host[,host…] <key type> <base64 key> [comment]`, hosts plain (`git.example.com`, `[host]:2222`) or
 * hashed (`|1|salt|hash`). Markers (`@cert-authority`, `@revoked`), wildcards and negations are refused, so a pinned
 * entry names exactly the hosts it is for.
 */
export function knownHostsProblem(text: string): KnownHostsProblem | null {
  if (text.length > MAX_KNOWN_HOSTS_BYTES) return 'too_long';
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  if (lines.length === 0) return 'empty';
  if (lines.length > MAX_KNOWN_HOSTS_LINES) return 'too_many_lines';
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 3) return 'bad_line';
    const [hosts, type, key] = parts as [string, string, string];
    if (!KEY_TYPES.has(type)) return 'bad_line';
    if (!/^[A-Za-z0-9+/]{32,}={0,2}$/.test(key)) return 'bad_line';
    for (const h of hosts.split(',')) {
      const plain = /^(?:\[[A-Za-z0-9.-]{1,253}\]:\d{1,5}|[A-Za-z0-9.-]{1,253})$/.test(h);
      const hashed = /^\|1\|[A-Za-z0-9+/=]{20,64}\|[A-Za-z0-9+/=]{20,64}$/.test(h);
      if (!plain && !hashed) return 'bad_line';
    }
  }
  return null;
}

/** Does a value look like an unencrypted private key the worker can hand to ssh (checked in the browser and on the worker)? */
export function sshPrivateKeyProblem(value: string): 'not_a_private_key' | 'encrypted' | null {
  const v = value.trim();
  if (
    !/^-----BEGIN (OPENSSH|RSA|EC) PRIVATE KEY-----\r?\n[\s\S]+\r?\n-----END \1 PRIVATE KEY-----$/.test(v)
  ) {
    return 'not_a_private_key';
  }
  if (/Proc-Type: 4,ENCRYPTED/.test(v)) return 'encrypted';
  return null;
}
