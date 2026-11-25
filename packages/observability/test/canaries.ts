/**
 * Fake but format-correct tokens. Token bodies are generated at runtime, so the
 * source never contains a complete token and secret scanners (GitHub push
 * protection, p7-secrets-scan) do not flag this file.
 */
const ALPHABET = 'aB3dE5fG7hJ9kLmN2pQrS4tUvW6xYz8C';

export function body(length: number, seed = 1, alphabet = ALPHABET): string {
  let out = '';
  // xorshift32: deterministic, stays within 32-bit integers.
  let x = (seed * 0x9e3779b1) >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out += alphabet.charAt(x % alphabet.length);
  }
  return out;
}

const UPPER_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const CANARY = {
  anthropic: ['sk', 'ant', 'api03', body(40, 1)].join('-'),
  anthropicOauth: ['sk', 'ant', 'oat01', body(48, 2)].join('-'),
  openai: ['sk', 'proj', body(48, 3)].join('-'),
  openaiLegacy: `sk-${body(48, 4)}`,
  openrouter: ['sk', 'or', 'v1', body(64, 5, '0123456789abcdef')].join('-'),
  ghp: `ghp_${body(36, 6)}`,
  gho: `gho_${body(36, 7)}`,
  ghs: `ghs_${body(36, 8)}`,
  githubPat: `github_pat_${body(22, 9)}_${body(59, 10)}`,
  glpat: `glpat-${body(20, 11)}`,
  awsKeyId: `AKIA${body(16, 12, UPPER_DIGITS)}`,
  awsSecret: body(40, 13, 'abcdefghijKLMNOPQRST0123456789/+'),
  googleKey: `AIza${body(35, 14)}`,
  slack: ['xoxb', '1234567890', body(24, 15)].join('-'),
  stripe: ['sk', 'live', body(24, 16)].join('_'),
  hf: `hf_${body(34, 17)}`,
  npm: `npm_${body(36, 18)}`,
  jwt: ['eyJ' + body(20, 19), 'eyJ' + body(40, 20), body(43, 21)].join('.'),
  pem: [
    ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
    body(64, 22),
    body(64, 23),
    body(20, 24),
    ['-----END', 'PRIVATE KEY-----'].join(' '),
  ].join('\n'),
  urlPassword: body(24, 25),
  bearer: body(32, 26),
} as const;

/** Canaries that are only recognisable with context (no vendor prefix). */
const CONTEXT_ONLY = new Set<string>(['awsSecret', 'urlPassword', 'bearer']);

/** One line per canary, with the context its rule needs. */
export const CANARY_LINES: readonly string[] = Object.entries(CANARY).map(([name, value]) => {
  if (!CONTEXT_ONLY.has(name)) return `${name}: ${value}`;
  if (name === 'awsSecret') return `aws_secret_access_key=${value}`;
  if (name === 'urlPassword') return `remote https://bot:${value}@git.example.com/r.git`;
  return `Authorization: Bearer ${value}`;
});
