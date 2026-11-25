import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// oss-sdk-external: the worker / updater bundles never contain the proprietary Claude Agent SDK, and they carry
// the licence texts of every third-party package they do contain (a trailing `//` comment block, appended by
// scripts/bundle.mjs before scripts/release/sign.mjs hashes and signs the bundle).

const run = promisify(execFile);
const WORKER_ROOT = new URL('..', import.meta.url);
const SCRIPT = new URL('scripts/bundle.mjs', WORKER_ROOT);

interface Pkg {
  name: string;
  version: string;
  license: string;
  dir: string;
  files: { file: string; text: string }[];
}
interface ThirdParty {
  forbiddenInputs(metafile: { inputs: Record<string, unknown> }): string[];
  bundledPackages(metafile: { inputs: Record<string, unknown> }, absWorkingDir: string): Pkg[];
  licenseNotice(bundleName: string, packages: Pkg[]): string;
}

const tp = (await import(new URL('scripts/third-party.mjs', WORKER_ROOT).href)) as ThirdParty;
const dir = mkdtempSync(join(tmpdir(), 'rw-third-party-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('third-party notice (unit)', () => {
  it('flags any @anthropic-ai input, in pnpm and npm layouts, on any separator', () => {
    const inputs = {
      'src/bin.ts': {},
      '../../node_modules/.pnpm/ws@8.22.0/node_modules/ws/lib/websocket.js': {},
      '../../node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.310/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs':
        {},
      'node_modules\\@anthropic-ai\\sdk\\index.js': {},
    };
    expect(tp.forbiddenInputs({ inputs })).toEqual([
      '../../node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.310/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
      'node_modules\\@anthropic-ai\\sdk\\index.js',
    ]);
  });

  it('lists each package once, from its innermost node_modules, with its LICENSE / NOTICE files', () => {
    const nm = join(dir, 'node_modules');
    for (const [name, files] of [
      ['@scope/a', { 'LICENSE.md': 'A licence', NOTICE: 'A notice', 'README.md': 'no' }],
      ['b', { LICENCE: 'B licence' }],
    ] as const) {
      mkdirSync(join(nm, name, 'lib'), { recursive: true });
      writeFileSync(
        join(nm, name, 'package.json'),
        JSON.stringify({ name, version: '1.0.0', license: 'MIT' }),
      );
      for (const [f, t] of Object.entries(files)) writeFileSync(join(nm, name, f), t);
    }
    const packages = tp.bundledPackages(
      {
        inputs: {
          'node_modules/b/lib/x.js': {},
          'node_modules/@scope/a/lib/x.js': {},
          'node_modules/@scope/a/index.js': {},
          'src/own.ts': {},
        },
      },
      dir,
    );
    expect(packages.map((p) => [p.name, p.files.map((f) => f.file)])).toEqual([
      ['@scope/a', ['LICENSE.md', 'NOTICE']],
      ['b', ['LICENCE']],
    ]);
  });

  it('a package without a licence file fails the build', () => {
    expect(() =>
      tp.licenseNotice('x.mjs', [{ name: 'c', version: '1.0.0', license: 'MIT', dir: '/c', files: [] }]),
    ).toThrow(/no LICENSE \/ NOTICE file in c@1\.0\.0/);
  });

  it('licence text cannot end the comment early or break the module', async () => {
    const hostile =
      'line one */ still a comment\r\nwindows line\rold mac line\u2028separator\u2029paragraph\nconsole.log("x")';
    const notice = tp.licenseNotice('m.mjs', [
      {
        name: 'evil',
        version: '1.0.0',
        license: 'MIT',
        dir: '/e',
        files: [{ file: 'LICENSE', text: hostile }],
      },
    ]);
    for (const line of notice.split('\n').filter((l) => l !== '')) expect(line.startsWith('//')).toBe(true);
    expect(notice).not.toMatch(/[\r\u2028\u2029]/);
    const file = join(dir, 'm.mjs');
    writeFileSync(file, `#!/usr/bin/env node\nexport const ok = 42;${notice}`);
    const m = (await import(pathToFileURL(file).href)) as { ok: number };
    expect(m.ok).toBe(42);
  });
});

describe('scripts/bundle.mjs (real bundles)', () => {
  const out = join(dir, 'dist');
  let worker = '';
  let updater = '';
  beforeAll(async () => {
    await run(process.execPath, [fileURLToPath(SCRIPT)], {
      cwd: dir,
      env: { ...process.env, REMYRAL_BUNDLE_OUTDIR: out, REMYRAL_BUILD_VERSION: '1.0.99' },
    });
    worker = readFileSync(join(out, 'remyral-worker.mjs'), 'utf8');
    updater = readFileSync(join(out, 'remyral-worker-updater.mjs'), 'utf8');
  }, 180_000);

  it('the worker bundle has no Claude Agent SDK code, only its external import', () => {
    expect(worker).not.toContain('CLAUDE_CODE_ENTRYPOINT');
    expect(worker).not.toContain('Anthropic PBC');
    expect(worker).toContain('import("@anthropic-ai/claude-agent-sdk")');
  });

  it('both bundles end with the licences of what they contain; the shebang stays first', () => {
    expect(worker.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(updater.startsWith('#!/usr/bin/env node\n')).toBe(true);
    const tail = worker.slice(worker.lastIndexOf('// Third-party software bundled in remyral-worker.mjs'));
    for (const p of ['ws@8.22.0 (MIT)', 'zod@', '@opentelemetry/api@']) expect(tail).toContain(p);
    expect(tail).toContain('Permission is hereby granted');
    expect(tail).toContain('Apache License');
    expect(tail.trimEnd().endsWith('=')).toBe(true);
    expect(updater).toContain('// Third-party software bundled in remyral-worker-updater.mjs');
  });

  it('the bundles still run (the updater reports the built version)', async () => {
    const r = await run(process.execPath, [join(out, 'remyral-worker-updater.mjs'), 'info']);
    expect(JSON.parse(r.stdout)).toMatchObject({ version: '1.0.99' });
    const v = await run(process.execPath, [join(out, 'remyral-worker.mjs'), '--version']);
    expect(v.stdout.trim()).toBe('1.0.99');
  });
});
