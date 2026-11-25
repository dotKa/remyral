import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, Redactor, SecretSet, SecretTooShortError, redactDeep } from '../src/index.js';
import { CANARY, CANARY_LINES, body } from './canaries.js';

const r = new Redactor();

describe('pattern redaction', () => {
  const cases: [name: string, text: string, secret: string, rule: string][] = [
    ['anthropic api key', `ANTHROPIC key ${CANARY.anthropic} used`, CANARY.anthropic, 'anthropic-key'],
    ['anthropic oauth', `token=${CANARY.anthropicOauth}`, CANARY.anthropicOauth, 'anthropic-key'],
    ['openai project key', `"${CANARY.openai}"`, CANARY.openai, 'openai-key'],
    ['openai legacy key', `key: ${CANARY.openaiLegacy}`, CANARY.openaiLegacy, 'openai-key'],
    ['openrouter key', `${CANARY.openrouter} `, CANARY.openrouter, 'openai-key'],
    ['github ghp', `push with ${CANARY.ghp}`, CANARY.ghp, 'github-token'],
    ['github gho', `(${CANARY.gho})`, CANARY.gho, 'github-token'],
    ['github ghs', CANARY.ghs, CANARY.ghs, 'github-token'],
    ['github fine-grained', `x ${CANARY.githubPat} y`, CANARY.githubPat, 'github-pat'],
    ['gitlab', CANARY.glpat, CANARY.glpat, 'gitlab-token'],
    ['aws key id', `aws ${CANARY.awsKeyId}.`, CANARY.awsKeyId, 'aws-access-key-id'],
    [
      'aws secret (context)',
      `aws_secret_access_key = ${CANARY.awsSecret}`,
      CANARY.awsSecret,
      'secret-assignment',
    ],
    ['google', `key=${CANARY.googleKey}&x=1`, CANARY.googleKey, 'google-api-key'],
    ['slack', CANARY.slack, CANARY.slack, 'slack-token'],
    ['stripe', CANARY.stripe, CANARY.stripe, 'stripe-key'],
    ['huggingface', CANARY.hf, CANARY.hf, 'huggingface-token'],
    ['npm', `//registry.npmjs.org/:_authToken=${CANARY.npm}`, CANARY.npm, 'npm-token'],
    ['jwt', `cookie: ${CANARY.jwt}`, CANARY.jwt, 'jwt'],
    ['pem', `key:\n${CANARY.pem}\ndone`, CANARY.pem, 'pem-private-key'],
    [
      'url credentials',
      `fetching https://deploy:${CANARY.urlPassword}@git.example.com/repo.git`,
      CANARY.urlPassword,
      'url-credentials',
    ],
    ['authorization bearer', `Authorization: Bearer ${CANARY.bearer}`, CANARY.bearer, 'authorization-header'],
    [
      'authorization basic',
      `authorization: Basic ${Buffer.from('user:pw-value-1').toString('base64')}`,
      Buffer.from('user:pw-value-1').toString('base64'),
      'authorization-header',
    ],
    ['standalone bearer', `curl -H "bearer ${CANARY.bearer}"`, CANARY.bearer, 'bearer-token'],
    ['env assignment', `OPENAI_API_KEY=${CANARY.bearer}`, CANARY.bearer, 'secret-assignment'],
    ['json password', `{"password": "${CANARY.bearer}"}`, CANARY.bearer, 'secret-assignment'],
  ];

  it.each(cases)('%s', (_name, text, secret, rule) => {
    const out = r.redact(text);
    expect(out).not.toContain(secret);
    expect(out).toContain(`[REDACTED:${rule}]`);
  });

  it('keeps context readable for header and URL rules', () => {
    expect(r.redact(`Authorization: Bearer ${CANARY.bearer}`)).toBe(
      'Authorization: Bearer [REDACTED:authorization-header]',
    );
    expect(r.redact(`https://deploy:${CANARY.urlPassword}@host/x`)).toBe(
      'https://deploy:[REDACTED:url-credentials]@host/x',
    );
  });

  it('redacts a PEM block without END (truncated output) to the end of the text', () => {
    const truncated = CANARY.pem.slice(0, 80);
    expect(r.redact(`before ${truncated}`)).toBe('before [REDACTED:pem-private-key]');
  });

  it('is idempotent', () => {
    const text = CANARY_LINES.join(' | ');
    const once = r.redact(text);
    expect(r.redact(once)).toBe(once);
    for (const value of Object.values(CANARY)) expect(once).not.toContain(value);
  });

  // Low false-positive rate: ordinary developer output must pass unchanged.
  const benign = [
    'npm install sk-learn-tutorial-chapter-one',
    'git checkout -b feature/sk-ant',
    'Running tests: 42 passed, 0 failed',
    'commit 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39',
    'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    'uuid 123e4567-e89b-12d3-a456-426614174000',
    'https://github.com/remyral/agent-cluster/pull/12',
    'http://localhost:8080/health',
    'max_tokens: 4096, tokens used: 1234',
    'The authorization flow requires approval',
    'Basic configuration loaded from /etc/remyral-worker/config.json',
    'password reset email sent',
    'token count = 15',
    'AKIA is the prefix of AWS access key ids',
    'eyJhbGciOiJIUzI1NiJ9 alone is a header, not a token',
    'base64: SGVsbG8gV29ybGQ=',
    'PATH=/usr/local/bin:/usr/bin',
  ];
  it.each(benign)('leaves benign text alone: %s', (text) => {
    expect(r.redact(text)).toBe(text);
  });

  it('every default rule has a unique id', () => {
    const ids = DEFAULT_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('handles pathological input in linear-ish time', () => {
    const evil = `${'sk-'.repeat(20_000)}${'a'.repeat(50_000)}${'Authorization: '.repeat(5000)}`;
    const started = performance.now();
    r.redact(evil);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('exact-value redaction', () => {
  it('redacts registered secrets that match no pattern, including encoded forms', () => {
    const secrets = new SecretSet();
    const value = 'correct horse/battery+staple"\\';
    secrets.add(value, 'DB_PASSWORD');
    const red = new Redactor({ secrets, rules: [] });
    const text = [
      `raw ${value}`,
      `url ${encodeURIComponent(value)}`,
      `json ${JSON.stringify({ v: value })}`,
      `b64 ${Buffer.from(value).toString('base64')}`,
      `b64url ${Buffer.from(value).toString('base64url')}`,
    ].join('\n');
    const out = red.redact(text);
    expect(out).not.toContain(value);
    expect(out).not.toContain(encodeURIComponent(value));
    expect(out).not.toContain(Buffer.from(value).toString('base64').replace(/=+$/, ''));
    expect(out.match(/\[REDACTED:DB_PASSWORD\]/g)?.length).toBe(5);
  });

  it('accepts revealable handles and refuses too-short secrets', () => {
    const secrets = new SecretSet();
    secrets.add({ reveal: () => 'handle-secret-1' });
    expect(new Redactor({ secrets }).redact('x handle-secret-1 y')).toBe('x [REDACTED:secret] y');
    expect(() => {
      secrets.add('abc');
    }).toThrow(SecretTooShortError);
  });

  it('merges overlapping exact and pattern matches', () => {
    const secrets = new SecretSet();
    secrets.add(CANARY.anthropic.slice(10, 30));
    const out = new Redactor({ secrets }).redact(`k=${CANARY.anthropic}`);
    expect(out).not.toContain(CANARY.anthropic.slice(30));
    expect(out.match(/REDACTED/g)?.length).toBe(1);
  });

  it('never exposes values via JSON or inspect', () => {
    const secrets = new SecretSet();
    secrets.add('super-secret-value');
    expect(JSON.stringify({ secrets })).not.toContain('super-secret-value');
    expect(secrets.toJSON()).toMatch(/size=/);
  });

  it('can forget secrets', () => {
    const secrets = new SecretSet();
    secrets.add('rotate-me-please');
    const red = new Redactor({ secrets, rules: [] });
    expect(red.redact('rotate-me-please')).toBe('[REDACTED:secret]');
    secrets.delete('rotate-me-please');
    expect(red.redact('rotate-me-please')).toBe('rotate-me-please');
  });
});

describe('redactDeep', () => {
  it('redacts strings and keys in nested values, by key name and by content', () => {
    const secrets = new SecretSet();
    secrets.add('canary-in-a-key-1');
    const red = new Redactor({ secrets });
    const out = JSON.stringify(
      redactDeep(
        {
          apiKey: 'harmless-looking',
          maxTokens: 5,
          nested: [{ deep: `x ${CANARY.ghp}` }],
          'canary-in-a-key-1': 1,
          bin: Buffer.from(CANARY.ghp),
          big: 10n,
          map: new Map([['k', CANARY.npm]]),
        },
        red,
      ),
    );
    expect(out).not.toContain('harmless-looking');
    expect(out).not.toContain(CANARY.ghp);
    expect(out).not.toContain(CANARY.npm);
    expect(out).not.toContain('canary-in-a-key-1');
    expect(out).toContain('"maxTokens":5');
    expect(out).toContain('[binary');
  });

  it('bounds cycles, depth, entries and string length', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    const red = new Redactor();
    expect(redactDeep(cyclic, red)).toEqual({ a: 1, self: '[Circular]' });
    let deep: unknown = 'leaf';
    for (let i = 0; i < 20; i++) deep = { d: deep };
    expect(JSON.stringify(redactDeep(deep, red, { maxDepth: 3 }))).toContain('[MaxDepth]');
    const arr = redactDeep(
      Array.from({ length: 500 }, (_, i) => i),
      red,
      { maxEntries: 10 },
    ) as unknown[];
    expect(arr).toHaveLength(11);
    const long = redactDeep(body(100_000), red, { maxStringLength: 100 }) as string;
    expect(long.length).toBeLessThan(200);
  });

  it('redacts error messages, stacks and causes', () => {
    const red = new Redactor();
    const err = new Error(`failed with ${CANARY.ghp}`, { cause: new Error(`inner ${CANARY.npm}`) });
    const out = JSON.stringify(redactDeep(err, red));
    expect(out).not.toContain(CANARY.ghp);
    expect(out).not.toContain(CANARY.npm);
    expect(out).toContain('"stack"');
    expect(JSON.stringify(redactDeep(err, red, { stacks: 'omit' }))).not.toContain('"stack"');
  });
});
