/**
 * p15-chat-vault (docs/design/p15-chat-vault.md): secrets pasted into the Sohbet composer, and the tokens that stand in
 * for them. Pure (no Node, no WebCrypto): the browser runs it before anything leaves the page, the master runs it again
 * over every user message it stores (defence in depth), and the assistant's system prompt names the token forms.
 *
 * Tokens (the only forms of a secret that reach the master, the transcript or a model):
 *  - `{{credential:NAME}}` — a vault credential (ADR-0016). NAME is the credential's name (a variable name such as
 *    OPENAI_API_KEY). The value is sealed in the browser to the chosen machines' vault keys; nobody else holds it.
 *  - `{{secret:pasted-N:provider}}` — a value the user pasted and has not saved (yet). Only the user's browser tab
 *    keeps it, in memory, so a later "bunu kasaya kaydet" card can seal it there. `provider` is a hint (openai …).
 *  - `{{secret:removed:rule}}` — a secret-looking value the master removed from a message (a client that did not
 *    replace it, or a typed value the browser did not recognise). Nothing can recover it.
 */

/** What a detected value most likely is — drives the suggested name, kind, hosts and header. */
export type SecretProvider =
  | 'openai'
  | 'anthropic'
  | 'openrouter'
  | 'github'
  | 'gitlab'
  | 'google'
  | 'slack'
  | 'stripe'
  | 'huggingface'
  | 'npm'
  | 'aws'
  | 'jwt'
  | 'private-key'
  | 'generic';

export interface ProviderFacts {
  /** The suggested credential name (an environment-variable style name). */
  readonly name: string;
  /** The vault kind for "API anahtarı" (the agent-runtime kind of that provider). */
  readonly apiKind: 'anthropic' | 'openai' | 'openrouter' | 'gemini' | 'github-token' | 'generic';
  /** Hosts an `http-auth` credential of this provider is usually sent to (empty: unknown). */
  readonly hosts: readonly string[];
  /** How the API takes it: `Authorization: Bearer`, or a named header. */
  readonly placement: { readonly type: 'bearer' } | { readonly type: 'header'; readonly name: string };
}

export const SECRET_PROVIDERS: Readonly<Record<SecretProvider, ProviderFacts>> = {
  openai: {
    name: 'OPENAI_API_KEY',
    apiKind: 'openai',
    hosts: ['api.openai.com'],
    placement: { type: 'bearer' },
  },
  anthropic: {
    name: 'ANTHROPIC_API_KEY',
    apiKind: 'anthropic',
    hosts: ['api.anthropic.com'],
    placement: { type: 'header', name: 'x-api-key' },
  },
  openrouter: {
    name: 'OPENROUTER_API_KEY',
    apiKind: 'openrouter',
    hosts: ['openrouter.ai'],
    placement: { type: 'bearer' },
  },
  github: {
    name: 'GITHUB_TOKEN',
    apiKind: 'github-token',
    hosts: ['api.github.com'],
    placement: { type: 'bearer' },
  },
  gitlab: {
    name: 'GITLAB_TOKEN',
    apiKind: 'generic',
    hosts: ['gitlab.com'],
    placement: { type: 'header', name: 'PRIVATE-TOKEN' },
  },
  google: {
    name: 'GEMINI_API_KEY',
    apiKind: 'gemini',
    hosts: ['generativelanguage.googleapis.com'],
    placement: { type: 'header', name: 'x-goog-api-key' },
  },
  slack: { name: 'SLACK_TOKEN', apiKind: 'generic', hosts: ['slack.com'], placement: { type: 'bearer' } },
  stripe: {
    name: 'STRIPE_SECRET_KEY',
    apiKind: 'generic',
    hosts: ['api.stripe.com'],
    placement: { type: 'bearer' },
  },
  huggingface: {
    name: 'HF_TOKEN',
    apiKind: 'generic',
    hosts: ['huggingface.co'],
    placement: { type: 'bearer' },
  },
  npm: {
    name: 'NPM_TOKEN',
    apiKind: 'generic',
    hosts: ['registry.npmjs.org'],
    placement: { type: 'bearer' },
  },
  aws: { name: 'AWS_ACCESS_KEY_ID', apiKind: 'generic', hosts: [], placement: { type: 'bearer' } },
  jwt: { name: 'API_TOKEN', apiKind: 'generic', hosts: [], placement: { type: 'bearer' } },
  'private-key': { name: 'PRIVATE_KEY', apiKind: 'generic', hosts: [], placement: { type: 'bearer' } },
  generic: { name: 'API_KEY', apiKind: 'generic', hosts: [], placement: { type: 'bearer' } },
};

export interface SecretFinding {
  readonly start: number;
  readonly end: number;
  readonly value: string;
  readonly provider: SecretProvider;
  /** A Claude subscription (OAuth) token: never saved (ADR-0014), only removed. */
  readonly subscription: boolean;
}

const TOKEN = '[A-Za-z0-9_-]';
const ALNUM = '[A-Za-z0-9]';
const LB = '(?<![A-Za-z0-9_-])';
const RA = '(?![A-Za-z0-9_-])';

interface Rule {
  readonly provider: SecretProvider;
  readonly re: RegExp;
  /** Capture group holding the value (default: the whole match). */
  readonly group?: number;
}

/** Vendor-prefixed formats first (they decide the provider), then context rules. Linear regexes only. */
const RULES: readonly Rule[] = [
  {
    provider: 'private-key',
    re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]{1,16384}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g,
  },
  { provider: 'anthropic', re: new RegExp(`${LB}sk-ant-${TOKEN}{16,}${RA}`, 'g') },
  { provider: 'openrouter', re: new RegExp(`${LB}sk-or-${TOKEN}{20,}${RA}`, 'g') },
  { provider: 'openai', re: new RegExp(`${LB}sk-(?!ant-|or-)(?=${TOKEN}*[0-9])${TOKEN}{20,}${RA}`, 'g') },
  {
    provider: 'github',
    re: new RegExp(`${LB}(?:gh[pousr]_${ALNUM}{30,}|github_pat_[A-Za-z0-9_]{22,})${RA}`, 'g'),
  },
  { provider: 'gitlab', re: new RegExp(`${LB}glpat-${TOKEN}{20,}${RA}`, 'g') },
  { provider: 'google', re: new RegExp(`${LB}AIza[A-Za-z0-9_-]{35}${RA}`, 'g') },
  { provider: 'slack', re: /(?<![A-Za-z0-9_-])xox[abposr]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9_-])/g },
  { provider: 'stripe', re: new RegExp(`${LB}(?:sk|rk)_(?:live|test)_${ALNUM}{16,}${RA}`, 'g') },
  { provider: 'huggingface', re: new RegExp(`${LB}hf_${ALNUM}{30,}${RA}`, 'g') },
  { provider: 'npm', re: new RegExp(`${LB}npm_${ALNUM}{36,}${RA}`, 'g') },
  { provider: 'aws', re: /(?<![A-Z0-9])(?:AKIA|ASIA|ABIA|ACCA|AIDA|AROA)[A-Z0-9]{16}(?![A-Z0-9])/g },
  { provider: 'jwt', re: new RegExp(`${LB}eyJ${TOKEN}{5,}\\.eyJ${TOKEN}{5,}\\.${TOKEN}*`, 'g') },
  {
    provider: 'generic',
    re: /\bbearer\s{1,16}(?!\{\{)([A-Za-z0-9._~+/-]{16,}=*)/gi,
    group: 1,
  },
  {
    provider: 'generic',
    re: /(?<![A-Za-z0-9])[A-Za-z0-9_.-]{0,64}?(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s{0,16}[:=]\s{0,16}["']?(?!\{\{)([^\s"'&,;{}]{8,})/gi,
    group: 1,
  },
];

/**
 * A pasted value that is one bare token (no spaces) and looks random enough to be a key: ≥ 24 characters of a token
 * alphabet with upper case, lower case and digits. Hex strings (commit ids, hashes) and UUIDs stay text.
 */
function bareToken(text: string): boolean {
  const t = text.trim();
  if (t.length < 24 || t.length > 512 || /\s/.test(t)) return false;
  if (!/^[A-Za-z0-9_\-.~+/=]+$/.test(t)) return false;
  if (/^[0-9a-f-]+$/i.test(t)) return false;
  return /[a-z]/.test(t) && /[A-Z]/.test(t) && /[0-9]/.test(t);
}

/** Inside one of our own tokens (never detected again). */
function insideToken(text: string, start: number, end: number): boolean {
  for (const m of text.matchAll(ANY_TOKEN)) {
    if (start < m.index + m[0].length && end > m.index) return true;
  }
  return false;
}

/**
 * Secret-looking values in `text`, left to right, not overlapping (the first rule that claims a range wins).
 * `pasted`: the text is one paste — a single bare random token counts as a secret too.
 */
export function detectSecrets(text: string, opts: { readonly pasted?: boolean } = {}): SecretFinding[] {
  const found: SecretFinding[] = [];
  const overlaps = (s: number, e: number): boolean => found.some((f) => s < f.end && e > f.start);
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const value = rule.group === undefined ? m[0] : (m[rule.group] ?? '');
      if (value === '') continue;
      const start = rule.group === undefined ? m.index : m.index + m[0].lastIndexOf(value);
      const end = start + value.length;
      if (overlaps(start, end) || insideToken(text, start, end)) continue;
      found.push({
        start,
        end,
        value,
        provider: rule.provider,
        subscription: rule.provider === 'anthropic' && /^sk-ant-oat/i.test(value),
      });
    }
  }
  if (found.length === 0 && opts.pasted === true && bareToken(text)) {
    const value = text.trim();
    const start = text.indexOf(value);
    found.push({ start, end: start + value.length, value, provider: 'generic', subscription: false });
  }
  return found.sort((a, b) => a.start - b.start);
}

/** `text` with every finding replaced by `token(finding, index)`. */
export function replaceFindings(
  text: string,
  findings: readonly SecretFinding[],
  token: (f: SecretFinding, i: number) => string,
): string {
  let out = '';
  let pos = 0;
  findings.forEach((f, i) => {
    out += text.slice(pos, f.start) + token(f, i);
    pos = f.end;
  });
  return out + text.slice(pos);
}

// ------------------------------------------------------------------------------------------------ tokens

/** A credential name usable in a token and as an environment variable: letters, digits, `_`, ≤ 64. */
export const CREDENTIAL_TOKEN_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const CREDENTIAL_TOKEN = /\{\{credential:([A-Za-z_][A-Za-z0-9_]{0,63})\}\}/g;
export const SECRET_TOKEN = /\{\{secret:(pasted-[0-9]{1,4}|removed)(?::([a-z0-9-]{1,32}))?\}\}/g;
const ANY_TOKEN =
  /\{\{(?:credential:[A-Za-z_][A-Za-z0-9_]{0,63}|secret:(?:pasted-[0-9]{1,4}|removed)(?::[a-z0-9-]{1,32})?)\}\}/g;

export function credentialToken(name: string): string {
  return `{{credential:${name}}}`;
}

export function pastedSecretToken(handle: string, provider: SecretProvider): string {
  return `{{secret:${handle}:${provider}}}`;
}

export function removedSecretToken(rule: string): string {
  const r = rule
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 32);
  return `{{secret:removed${r === '' ? '' : `:${r}`}}}`;
}

/** The credential names a text refers to by token (deduplicated, in order). */
export function credentialTokenNames(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CREDENTIAL_TOKEN)) {
    const n = m[1] ?? '';
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

export type TokenSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'credential'; readonly text: string; readonly name: string }
  | {
      readonly kind: 'secret';
      readonly text: string;
      /** `pasted-N` or `removed`. */
      readonly handle: string;
      readonly hint: string | null;
    };

/** The text cut into plain runs and credential / secret tokens (for rendering chips; never parsed as markup). */
export function segmentSecretTokens(text: string): TokenSegment[] {
  const out: TokenSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(ANY_TOKEN)) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    const raw = m[0];
    const cred = /^\{\{credential:([^}]+)\}\}$/.exec(raw);
    if (cred !== null) out.push({ kind: 'credential', text: raw, name: cred[1] ?? '' });
    else {
      const s = /^\{\{secret:([^:}]+)(?::([^}]+))?\}\}$/.exec(raw);
      out.push({ kind: 'secret', text: raw, handle: s?.[1] ?? 'removed', hint: s?.[2] ?? null });
    }
    last = m.index + raw.length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/**
 * A free name for a new credential: the provider's name, then `_2`, `_3` …; a generic value gets `API_KEY_<n>`.
 * `taken` is compared case-insensitively.
 */
export function suggestCredentialName(provider: SecretProvider, taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.toUpperCase()));
  const base = SECRET_PROVIDERS[provider].name;
  if (provider === 'generic') {
    for (let n = 1; n < 1000; n += 1) {
      const c = `${base}_${String(n)}`;
      if (!used.has(c)) return c;
    }
  }
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const c = `${base}_${String(n)}`;
    if (!used.has(c)) return c;
  }
  return `${base}_${String(Date.now() % 100000)}`;
}

/** The vault id of a credential named `name` (`OPENAI_API_KEY` → `openai-api-key`), ≤ 48 characters. */
export function credentialIdFor(name: string): string {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return /^[a-z0-9]/.test(id) ? id : `c-${id}`.slice(0, 48);
}
