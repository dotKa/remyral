/**
 * Pattern rules for well-known secret formats (ADR-0006 §4, second pass).
 *
 * Design constraints, so the streaming redactor stays correct:
 *  - Every regex is linear (single character classes, no nested quantifiers).
 *  - Every rule is *prefix-closed* within the stream lookbehind: if a token starts
 *    more than `STREAM_MIN_LOOKBEHIND` characters before the end of the buffer, the
 *    regex already matches it there. Token bodies therefore use `{n,}` quantifiers
 *    with `n` far below the lookbehind, and context rules cap their bodies.
 *  - A match that touches the end of the buffer may still continue; the stream
 *    redactor holds it back (see stream.ts). `continuation` tells it which
 *    characters to keep swallowing if it has to force-close an overly long token.
 *
 * False positives are kept low by anchoring on vendor prefixes and token
 * alphabets, and by redacting only the value part of context rules
 * (`Authorization: Bearer <value>` keeps the scheme visible).
 */

/** Result of feeding the start of a new chunk to a force-closed token. */
export interface ContinuationResult {
  /** Number of leading characters that still belong to the secret. */
  consumed: number;
  /** True when the secret has definitely ended inside this input. */
  done: boolean;
}

export type Continuation = (input: string) => ContinuationResult;

export interface PatternRule {
  readonly kind: 'pattern';
  readonly id: string;
  readonly description: string;
  /** Must carry the `g` and `d` flags. */
  readonly regex: RegExp;
  /** When set, only this capture group is replaced (the context stays readable). */
  readonly group?: number;
  readonly continuation: Continuation;
}

/** A multi-line block (PEM). If `begin` is seen without `end`, everything after `begin` is secret. */
export interface BlockRule {
  readonly kind: 'block';
  readonly id: string;
  readonly description: string;
  /** Must carry the `g` flag. */
  readonly begin: RegExp;
  /** Must carry the `g` flag. */
  readonly end: RegExp;
  readonly continuation: Continuation;
}

export type RedactionRule = PatternRule | BlockRule;

/** Swallow characters from `charClass` (a single-character regex source like `[A-Za-z0-9]`). */
export function charClassContinuation(charClass: string): Continuation {
  const re = new RegExp(`^(?:${charClass})*`);
  return (input) => {
    const consumed = re.exec(input)?.[0].length ?? 0;
    return { consumed, done: consumed < input.length };
  };
}

/** Swallow everything up to and including the first match of `end`. */
export function untilContinuation(end: RegExp): Continuation {
  const re = new RegExp(end.source, end.flags.replace('g', '').replace('y', ''));
  return (input) => {
    const m = re.exec(input);
    if (!m) return { consumed: input.length, done: false };
    return { consumed: m.index + m[0].length, done: true };
  };
}

const TOKEN = '[A-Za-z0-9_-]';
const ALNUM = '[A-Za-z0-9]';
/** Left boundary: the token must not be glued to a preceding token character. */
const LB = '(?<![A-Za-z0-9_-])';

function pattern(
  id: string,
  description: string,
  source: string,
  continuationClass: string,
  options: { group?: number; ignoreCase?: boolean } = {},
): PatternRule {
  return {
    kind: 'pattern',
    id,
    description,
    regex: new RegExp(source, options.ignoreCase === true ? 'gdi' : 'gd'),
    ...(options.group === undefined ? {} : { group: options.group }),
    continuation: charClassContinuation(continuationClass),
  };
}

const PEM_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;

export const DEFAULT_RULES: readonly RedactionRule[] = [
  {
    kind: 'block',
    id: 'pem-private-key',
    description: 'PEM private key block (RSA, EC, OPENSSH, PKCS#8, encrypted)',
    begin: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/g,
    end: PEM_END,
    continuation: untilContinuation(PEM_END),
  },
  pattern('anthropic-key', 'Anthropic API / OAuth token (sk-ant-…)', `${LB}sk-ant-${TOKEN}{16,}`, TOKEN),
  pattern(
    'openai-key',
    'OpenAI-style secret key (sk-…, sk-proj-…, sk-or-…); must contain a digit',
    // The digit look-ahead keeps words like "sk-learn-tutorial-chapter" out.
    `${LB}sk-(?!ant-)(?=${TOKEN}*[0-9])${TOKEN}{20,}`,
    TOKEN,
  ),
  pattern('github-token', 'GitHub token (ghp_/gho_/ghu_/ghs_/ghr_)', `${LB}gh[pousr]_${ALNUM}{30,}`, ALNUM),
  pattern(
    'github-pat',
    'GitHub fine-grained PAT (github_pat_…)',
    `${LB}github_pat_[A-Za-z0-9_]{22,}`,
    '[A-Za-z0-9_]',
  ),
  pattern('gitlab-token', 'GitLab personal access token (glpat-…)', `${LB}glpat-${TOKEN}{20,}`, TOKEN),
  pattern(
    'aws-access-key-id',
    'AWS access key id (AKIA/ASIA/…)',
    '(?<![A-Z0-9])(?:AKIA|ASIA|ABIA|ACCA|AIDA|AROA)[A-Z0-9]{16}(?![A-Z0-9])',
    '[A-Z0-9]',
  ),
  pattern('google-api-key', 'Google API key (AIza…)', `${LB}AIza[A-Za-z0-9_-]{35}`, TOKEN),
  pattern('slack-token', 'Slack token (xoxb-/xoxp-/…)', `${LB}xox[abposr]-[A-Za-z0-9-]{10,}`, '[A-Za-z0-9-]'),
  pattern('stripe-key', 'Stripe secret/restricted key', `${LB}(?:sk|rk)_(?:live|test)_${ALNUM}{16,}`, ALNUM),
  pattern('huggingface-token', 'Hugging Face token (hf_…)', `${LB}hf_${ALNUM}{30,}`, ALNUM),
  pattern('npm-token', 'npm access token (npm_…)', `${LB}npm_${ALNUM}{36,}`, ALNUM),
  pattern(
    'jwt',
    'JSON Web Token (three base64url segments, header and payload start with eyJ)',
    `${LB}eyJ${TOKEN}{5,}\\.eyJ${TOKEN}{5,}\\.${TOKEN}*`,
    TOKEN,
  ),
  pattern(
    'url-credentials',
    'Password in a URL userinfo (scheme://user:password@host)',
    '\\b[A-Za-z][A-Za-z0-9+.-]{0,19}://[^\\s/?#@:]{0,128}:([^\\s/?#@]{1,512})@',
    '[^\\s/?#@]',
    { group: 1 },
  ),
  pattern(
    'authorization-header',
    'Value of an Authorization / Proxy-Authorization header',
    '\\b(?:proxy-)?authorization["\']?\\s{0,16}[:=]\\s{0,16}["\']?(?:(?:bearer|basic|token|digest|negotiate)\\s{1,16})?(?!\\[REDACTED)(?!(?:bearer|basic|token|digest|negotiate)\\b)([^\\s"\',]{6,})',
    '[^\\s"\',]',
    { group: 1, ignoreCase: true },
  ),
  pattern(
    'bearer-token',
    'Bearer token outside an Authorization header (≥ 16 chars)',
    '\\bbearer\\s{1,16}(?!\\[REDACTED)([A-Za-z0-9._~+/-]{16,}=*)',
    '[A-Za-z0-9._~+/=-]',
    { group: 1, ignoreCase: true },
  ),
  pattern(
    'secret-assignment',
    'Value assigned to a secret-looking key (PASSWORD=…, "api_key": "…", client_secret: …)',
    '(?<![A-Za-z0-9])[A-Za-z0-9_.-]{0,64}?(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)["\']?\\s{0,16}[:=]\\s{0,16}["\']?(?!\\[REDACTED)([^\\s"\'&,;]{8,})',
    '[^\\s"\'&,;]',
    { group: 1, ignoreCase: true },
  ),
];

/**
 * Minimum stream lookbehind. Must exceed the longest bounded context match
 * (`url-credentials`: 20 + 3 + 128 + 1 + 512 + 1 characters).
 */
export const STREAM_MIN_LOOKBEHIND = 1024;
