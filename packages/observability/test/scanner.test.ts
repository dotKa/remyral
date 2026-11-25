import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOW_MARKER, fingerprintOf, looksRandom, scanText, shannonEntropy } from '../src/index.js';
import { body, CANARY, CANARY_LINES } from './canaries.js';

describe('secret scanner (p7-secrets-scan)', () => {
  it('finds every vendor-format canary the redactor knows', () => {
    const found = scanText(CANARY_LINES.join('\n'), { highEntropy: false });
    const rules = new Set(found.map((f) => f.rule));
    for (const r of [
      'anthropic-key',
      'openai-key',
      'github-token',
      'github-pat',
      'gitlab-token',
      'aws-access-key-id',
      'google-api-key',
      'slack-token',
      'stripe-key',
      'huggingface-token',
      'npm-token',
      'jwt',
      'pem-private-key',
    ]) {
      expect(rules, r).toContain(r);
    }
  });

  it('never returns the secret itself: preview is 4 characters + length, fingerprint is a hash', () => {
    const [f] = scanText(`key = ${CANARY.ghp}`);
    expect(f?.preview).toBe(`${CANARY.ghp.slice(0, 4)}…(${String(CANARY.ghp.length)})`);
    expect(f?.fingerprint).toBe(fingerprintOf('github-token', CANARY.ghp));
    expect(JSON.stringify(f)).not.toContain(CANARY.ghp.slice(4));
    expect(f).toMatchObject({ line: 1, column: 7 });
  });

  it('context rules need a random-looking value (code and placeholders are not secrets)', () => {
    for (const code of [
      'password: z.string().min(1)',
      'const token = process.env.API_TOKEN;',
      'apiKey: "${API_KEY}"',
      'secret: "<your-secret-here>"',
      'password = "changeme-please-now"',
      'token: "xxxxxxxxxxxxxxxxxxxx"',
      'Authorization: Bearer ${token}',
    ]) {
      expect(scanText(code), code).toEqual([]);
    }
    const real = `client_secret: "${body(32, 99)}"`;
    expect(scanText(real).map((f) => f.rule)).toEqual(['secret-assignment']);
  });

  it('high-entropy literals without context are reported; hashes in lowercase hex are not', () => {
    expect(scanText(`const k = '${body(48, 7)}';`).map((f) => f.rule)).toEqual(['high-entropy-string']);
    expect(scanText(`const h = '${'0123456789abcdef'.repeat(4)}';`)).toEqual([]);
    expect(scanText(`const k = '${body(48, 7)}';`, { highEntropy: false })).toEqual([]);
  });

  it('the allow marker silences a line, but never a canary', () => {
    expect(scanText(`k = ${CANARY.npm} // ${ALLOW_MARKER}`)).toEqual([]);
    const canary = 'canary-0123456789abcdef';
    expect(scanText(`x ${canary} // ${ALLOW_MARKER}`, { canaries: [canary] }).map((f) => f.rule)).toEqual([
      'canary',
    ]);
  });

  it('entropy helpers', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBe(2);
    expect(looksRandom(body(24, 3))).toBe(true);
    expect(looksRandom('short1A')).toBe(false);
    expect(looksRandom('config.secrets.apiKey')).toBe(false);
  });
});

const CLI = fileURLToPath(new URL('../bin/scan-secrets.mjs', import.meta.url));
const built = existsSync(fileURLToPath(new URL('../dist/index.js', import.meta.url)));

describe.skipIf(!built)('scan-secrets CLI --bundle (needs the built package)', () => {
  it('fails on a canary, a server env name or process.env in build output; passes a clean bundle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rw-bundle-'));
    try {
      const env = { ...process.env, MY_CANARY: 'canary-5a7d2c9e1b3f4a6d' };
      const run = () =>
        spawnSync(process.execPath, [CLI, '--bundle', dir, '--canary-env', 'MY_CANARY', '--json'], {
          env,
          encoding: 'utf8',
        });
      writeFileSync(join(dir, 'index.js'), 'console.log("hello")');
      expect(run().status).toBe(0);
      writeFileSync(
        join(dir, 'leak.js'),
        'const a = "canary-5a7d2c9e1b3f4a6d"; const b = "DATABASE_URL"; process.env.X;',
      );
      const res = run();
      expect(res.status).toBe(1);
      const report = JSON.parse(res.stdout) as { findings: { rule: string }[] };
      expect(report.findings.map((f) => f.rule).sort()).toEqual([
        'canary',
        'process-env-reference',
        'server-env-name',
      ]);
      expect(res.stdout).not.toContain('5a7d2c9e1b3f4a6d');
      const missing = spawnSync(
        process.execPath,
        [CLI, '--bundle', dir, '--canary-env', 'NOT_SET_ANYWHERE'],
        {
          encoding: 'utf8',
        },
      );
      expect(missing.status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
