// p17-update-channel (ADR-0065): the vendor's catalog tool and the worker release feed — offline. The catalog tool's
// source templates must equal the protocol's (the worker builds every source from those), and what the tools sign
// must pass the worker's / master's own acceptance functions.
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkVersionCatalog,
  npmTarballUrl as protocolTarball,
  RUNTIME_PINS,
  toolAssetUrl as protocolUrl,
  verifyWorkerReleaseFeed,
} from '../../packages/protocol/src/index.ts';
import {
  catalogFromDraft,
  checkCatalog,
  emptyDraft,
  npmTarballUrl,
  PLATFORMS,
  promoteEntry,
  runtimePackageVersion,
  TOOLS,
  toolAssetUrl,
} from '../release/catalog-lib.mjs';
import { keyIdOf } from '../release/control-plane-lib.mjs';

const CATALOG = fileURLToPath(new URL('../release/catalog.mjs', import.meta.url));
const SIGN = fileURLToPath(new URL('../release/sign.mjs', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'remyral-catalog-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

const SAMPLES = {
  browser: ['1248', '156.0.8078.4'],
  git: ['2.56.0.3'],
  python: ['3.13.17'],
  ffmpeg: ['9.0.2'],
  cloudflared: ['2026.10.3'],
  uv: ['0.13.5'],
  node: ['24.22.1'],
};

const integ = (c) => `sha512-${c.repeat(86)}==`;
const codexPin = RUNTIME_PINS.codex.version;
const NEXT = codexPin.replace(/\d+$/, (n) => String(Number(n) + 3));
function draft({ verified = false, tested = true } = {}) {
  const d = emptyDraft('2026-10-26T08:00:00.000Z');
  d.runtimes.codex = [
    {
      version: NEXT,
      packageVersion: NEXT,
      integrity: integ('a'),
      verified,
      packages: [
        {
          path: 'node_modules/@openai/codex',
          name: '@openai/codex',
          version: NEXT,
          resolved: npmTarballUrl('@openai/codex', NEXT),
          integrity: integ('a'),
        },
      ],
      ...(tested ? { tests: { status: 'passed', at: '2026-10-26T08:10:00.000Z', detail: '12 passed' } } : {}),
      lock: { lockfileVersion: 3 },
    },
  ];
  d.tools.uv = [
    {
      version: '0.13.6',
      verified,
      hashed: true,
      assets: {
        'linux-x64': {
          url: toolAssetUrl('uv', 'linux-x64', '0.13.6'),
          sha256: 'c'.repeat(64),
          size: 10,
        },
      },
    },
  ];
  return d;
}

describe('catalog-lib mirrors the protocol', () => {
  it('builds exactly the protocol sources for every tool and platform', () => {
    for (const tool of TOOLS) {
      const [v, build] = SAMPLES[tool];
      for (const p of PLATFORMS) expect(toolAssetUrl(tool, p, v, build)).toBe(protocolUrl(tool, p, v, build));
    }
    expect(toolAssetUrl('uv', 'linux-x64', '../x')).toBeNull();
    expect(npmTarballUrl('@openai/codex', '1.0.0')).toBe(protocolTarball('@openai/codex', '1.0.0'));
    expect(
      runtimePackageVersion('claude-code', '2.1.312', { version: '2.1.310', packageVersion: '0.3.310' }),
    ).toBe('0.3.312');
    expect(
      runtimePackageVersion('claude-code', '2.2.0', { version: '2.1.310', packageVersion: '0.3.310' }),
    ).toBeNull();
  });

  it('promotion needs passed contract tests and canary evidence', () => {
    expect(() =>
      promoteEntry(draft({ tested: false }), `runtime:codex@${NEXT}`, { canary: 'ran', now: 'x' }),
    ).toThrow(/contract tests/);
    expect(() => promoteEntry(draft(), `runtime:codex@${NEXT}`, { canary: '', now: 'x' })).toThrow(/canary/);
    const d = promoteEntry(draft(), `runtime:codex@${NEXT}`, {
      canary: 'mac canary, 3 jobs',
      now: '2026-10-26T09:00:00.000Z',
    });
    expect(d.runtimes.codex[0]).toMatchObject({ verified: true, canary: { note: 'mac canary, 3 jobs' } });
    // Draft-only fields never reach the signed document.
    const c = catalogFromDraft(d, { sequence: 1, generatedAt: '2026-10-26T09:00:00.000Z' });
    expect(Object.keys(c.runtimes.codex[0])).not.toContain('tests');
    expect(Object.keys(c.runtimes.codex[0])).not.toContain('lock');
    expect(Object.keys(c.tools.uv[0])).not.toContain('hashed');
  });

  it('refuses foreign sources and verified downgrades before signing', () => {
    const bad = catalogFromDraft(draft(), { sequence: 2, generatedAt: 'x' });
    bad.tools.uv[0].assets['linux-x64'].url = 'https://evil.example/uv.tgz';
    expect(() => checkCatalog(bad)).toThrow(/is not https:\/\/github.com/);
    const prev = catalogFromDraft(promoteEntry(draft(), 'tool:uv@0.13.6', { canary: 'ok!', now: 'x' }), {
      sequence: 1,
      generatedAt: 'x',
    });
    const lower = catalogFromDraft(draft({ verified: true }), { sequence: 2, generatedAt: 'x' });
    lower.tools.uv[0].version = '0.13.5';
    lower.tools.uv[0].assets['linux-x64'].url = toolAssetUrl('uv', 'linux-x64', '0.13.5');
    expect(() => checkCatalog(lower, { previous: prev })).toThrow(/below the published/);
    expect(() => checkCatalog(lower, { previous: { ...prev, sequence: 3 } })).toThrow(/not above/);
  });
});

describe('catalog.mjs keygen / sign / verify / publish', () => {
  const keyDir = join(work, 'keys');
  const site = join(work, 'site');
  const dest = join(work, 'dest');
  let pub = '';

  it('keygen writes a 0600 key and refuses to overwrite it', () => {
    const r = run(CATALOG, ['keygen', '--out', keyDir]);
    expect(r.status).toBe(0);
    pub = readFileSync(join(keyDir, 'catalog-key.pub'), 'utf8').trim();
    expect(statSync(join(keyDir, 'catalog-key.pem')).mode & 0o777).toBe(0o600);
    expect(r.stdout).toContain(keyIdOf(pub));
    expect(run(CATALOG, ['keygen', '--out', keyDir]).status).toBe(1);
  });

  it('signs a promoted draft with the next sequence; the worker check accepts it', () => {
    const d = promoteEntry(draft(), `runtime:codex@${NEXT}`, {
      canary: 'canary ok',
      now: '2026-10-26T09:00:00.000Z',
    });
    const file = join(work, 'draft.json');
    writeFileSync(file, JSON.stringify(d));
    const r = run(CATALOG, [
      'sign',
      '--draft',
      file,
      '--key',
      join(keyDir, 'catalog-key.pem'),
      '--site',
      site,
    ]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const bytes = readFileSync(join(site, 'catalog', 'catalog.json'));
    const sig = JSON.parse(readFileSync(join(site, 'catalog', 'catalog.sig.json'), 'utf8'));
    const check = checkVersionCatalog(bytes, sig, {
      keys: [pub],
      previous: null,
      floor: { runtimes: { codex: { version: codexPin, scripts: [] } } },
      now: new Date(Date.now() + 60_000),
    });
    expect(check).toMatchObject({ ok: true });
    expect(check.catalog.sequence).toBe(1);
    expect(
      run(CATALOG, ['sign', '--draft', file, '--key', join(keyDir, 'catalog-key.pem'), '--site', site])
        .status,
    ).toBe(0);
    expect(JSON.parse(readFileSync(join(site, 'catalog', 'catalog.json'), 'utf8')).sequence).toBe(2);
  });

  it('verify refuses a foreign key and tampered bytes; publish copies only a verified, newer catalog', () => {
    const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x;
    expect(run(CATALOG, ['verify', '--site', site, `--public-key=${other}`]).status).toBe(1);
    expect(run(CATALOG, ['verify', '--site', site, `--public-key=${pub}`]).stdout).toContain(
      'OK version catalog 2',
    );
    expect(run(CATALOG, ['publish', '--site', site, '--to', dest, `--public-key=${pub}`]).status).toBe(0);
    expect(run(CATALOG, ['publish', '--site', site, '--to', dest, `--public-key=${pub}`]).status).toBe(1);
    const tampered = join(work, 'tampered');
    cpSync(site, tampered, { recursive: true });
    const p = join(tampered, 'catalog', 'catalog.json');
    writeFileSync(p, readFileSync(p, 'utf8').replace('"verified": true', '"verified": false'));
    expect(run(CATALOG, ['verify', '--site', tampered, `--public-key=${pub}`]).status).toBe(1);
  });
});

describe('sign.mjs feed (the worker release feed)', () => {
  it('lists verified releases with their bundle hash and the catalog keys; the master check accepts it', () => {
    const keys = join(work, 'release-keys');
    expect(run(SIGN, ['keygen', '--out', keys]).status).toBe(0);
    const pem = join(keys, 'release-key.pem');
    const rpub = readFileSync(join(keys, 'release-key.pub'), 'utf8').trim();
    const artifact = join(work, 'remyral-worker.mjs');
    writeFileSync(artifact, '// worker\n');
    for (const v of ['1.1.4', '1.1.5']) {
      const dir = join(work, 'rel', v);
      expect(
        run(SIGN, ['sign', '--artifact', artifact, '--version', v, '--key', pem, '--out', dir]).status,
      ).toBe(0);
      mkdirSync(join(work, 'feedsite', 'workers', v), { recursive: true });
      cpSync(join(dir, 'release.json'), join(work, 'feedsite', 'workers', v, 'release.json'));
    }
    const catalogPub = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x;
    const r = run(SIGN, [
      'feed',
      '--site',
      join(work, 'feedsite'),
      '--key',
      pem,
      '--catalog-key',
      catalogPub,
    ]);
    expect(r.stderr).toBe('');
    const bytes = readFileSync(join(work, 'feedsite', 'workers', 'feed.json'));
    const sig = JSON.parse(readFileSync(join(work, 'feedsite', 'workers', 'feed.sig.json'), 'utf8'));
    const v = verifyWorkerReleaseFeed(bytes, sig, [rpub]);
    expect(v.ok).toBe(true);
    expect(v.feed.releases.map((x) => x.version)).toEqual(['1.1.5', '1.1.4']);
    expect(v.feed.catalogKeys).toEqual([catalogPub]);
    const bundle = readFileSync(join(work, 'feedsite', 'workers', '1.1.5', 'release.json'));
    expect(v.feed.releases[0].bundle).toEqual({
      path: '1.1.5/release.json',
      sha256: createHash('sha256').update(bundle).digest('hex'),
      size: bundle.length,
    });
    // A release.json signed by another key is not listed: the feed refuses to be built.
    const foreign = join(work, 'foreign-keys');
    run(SIGN, ['keygen', '--out', foreign]);
    const fdir = join(work, 'rel', 'f');
    run(SIGN, [
      'sign',
      '--artifact',
      artifact,
      '--version',
      '1.1.6',
      '--key',
      join(foreign, 'release-key.pem'),
      '--out',
      fdir,
    ]);
    mkdirSync(join(work, 'feedsite', 'workers', '1.1.6'), { recursive: true });
    cpSync(join(fdir, 'release.json'), join(work, 'feedsite', 'workers', '1.1.6', 'release.json'));
    expect(run(SIGN, ['feed', '--site', join(work, 'feedsite'), '--key', pem]).status).toBe(1);
    // A catalog key list that is not keys is refused.
    expect(
      run(SIGN, ['feed', '--site', join(work, 'feedsite'), '--key', pem, '--catalog-key', 'nope']).status,
    ).toBe(1);
  });

  it('a signature of the feed is not a catalog signature (domain separation)', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubKey = publicKey.export({ format: 'jwk' }).x;
    const bytes = Buffer.from('{}');
    const s = {
      keyId: keyIdOf(pubKey),
      signature: sign(
        null,
        Buffer.concat([Buffer.from('remyral-worker-feed/v1\n'), bytes]),
        privateKey,
      ).toString('base64url'),
    };
    expect(
      checkVersionCatalog(bytes, s, {
        keys: [pubKey],
        previous: null,
        floor: { runtimes: {} },
        now: new Date(),
      }),
    ).toMatchObject({ ok: false, reason: 'bad_signature' });
  });
});
