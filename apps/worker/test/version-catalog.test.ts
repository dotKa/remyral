import { createHash, generateKeyPairSync, type KeyObject, randomUUID, sign } from 'node:crypto';
import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@remyral/observability';
import {
  CATALOG_CONTEXT,
  MasterToWorker,
  npmTarballUrl,
  type RuntimePolicyDelivery,
  releaseKeyId,
  RUNTIME_PINS,
  toolAssetUrl,
  type WorkerToMaster,
} from '@remyral/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  CatalogStore,
  catalogPins,
  catalogRecipes,
  mergeInstallManifest,
  releaseFloor,
  trustedCatalogKeys,
} from '../src/catalog/index.js';
import type { WorkerDaemon } from '../src/daemon/daemon.js';
import { runWorker } from '../src/daemon/run.js';
import { ManualSignals } from '../src/daemon/signals.js';
import { INSTALL_MANIFEST } from '../src/remote-ops/index.js';
import { RuntimeInstaller } from '../src/remote-ops/installer.js';
import { decideTarget } from '../src/remote-ops/manifest.js';
import { checkRuntimeForJob, effectivePin, policyPins } from '../src/runtime-policy/enforce.js';
import { ToolInstaller } from '../src/tools/installer.js';
import { PLAYWRIGHT_CFT_BUILD, RECIPES, recipeLayout } from '../src/tools/recipes.js';
import { MemoryTransport } from '../src/transport/memory.js';
import { nodeOps, pathHost, tempDir } from './helpers.js';

const logger = createLogger({ level: 'silent', sink: () => undefined });

function keyPair(): { pub: string; priv: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ format: 'jwk' }).x ?? '', priv: privateKey };
}
const ck = keyPair();
const integ = (c: string) => `sha512-${c.repeat(86)}==`;
const codexPin = RUNTIME_PINS.codex.version;
const bump = (v: string, n: number) => {
  const [a, b, c] = v.split('.').map(Number);
  return `${String(a)}.${String(b)}.${String((c ?? 0) + n)}`;
};
const NEXT = bump(codexPin, 3);
const LATER = bump(codexPin, 5);

function codexEntry(version: string, verified: boolean) {
  return {
    version,
    packageVersion: version,
    integrity: integ('a'),
    verified,
    packages: [
      {
        path: 'node_modules/@openai/codex',
        name: '@openai/codex',
        version,
        resolved: npmTarballUrl('@openai/codex', version),
        integrity: integ('a'),
      },
    ],
  };
}
const uvPin = RECIPES.find((r) => r.tool === 'uv' && !r.elevated)?.version ?? '';
const UV_NEXT = bump(uvPin, 1);
function catalog(sequence: number, over: Record<string, unknown> = {}) {
  return {
    schema: 1,
    name: 'remyral-version-catalog',
    sequence,
    generatedAt: '2026-10-26T08:00:00.000Z',
    runtimes: { codex: [codexEntry(NEXT, true), codexEntry(LATER, false)] },
    tools: {
      uv: [
        {
          version: UV_NEXT,
          verified: true,
          assets: {
            'linux-x64': {
              url: toolAssetUrl('uv', 'linux-x64', UV_NEXT) ?? '',
              sha256: 'c'.repeat(64),
              size: 123,
            },
            'darwin-arm64': {
              url: toolAssetUrl('uv', 'darwin-arm64', UV_NEXT) ?? '',
              sha256: 'd'.repeat(64),
              size: 124,
            },
          },
        },
      ],
    },
    ...over,
  };
}
function delivery(doc: unknown, signer = ck) {
  const bytes = Buffer.from(JSON.stringify(doc));
  return {
    sequence: (doc as { sequence: number }).sequence,
    catalog: bytes.toString('base64'),
    signature: {
      keyId: releaseKeyId(signer.pub),
      signature: sign(null, Buffer.concat([Buffer.from(CATALOG_CONTEXT), bytes]), signer.priv).toString(
        'base64url',
      ),
    },
  };
}
const floor = releaseFloor(INSTALL_MANIFEST, RECIPES);
const clock = () => new Date('2026-10-26T09:00:00.000Z');
const open = (dataDir: string, keys = [ck.pub], enabled = true) =>
  CatalogStore.open({ ops: nodeOps(), dataDir, keys, enabled, floor, logger, clock });

describe('built-in recipes come from the same templates as catalog entries', () => {
  it('every built-in source equals the protocol template and the layout function', () => {
    let checked = 0;
    for (const r of RECIPES) {
      if (r.elevated) continue;
      for (const [platform, step] of Object.entries(r.platforms)) {
        const p = platform as Parameters<typeof recipeLayout>[1];
        expect(
          toolAssetUrl(r.tool, p, r.version, r.tool === 'browser' ? PLAYWRIGHT_CFT_BUILD : undefined),
        ).toBe(step.url);
        const { url: _u, sha256: _s, size: _z, ...layout } = step;
        expect(recipeLayout(r.tool, p, r.version)).toEqual(layout);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(15);
  });
});

describe('CatalogStore (ADR-0065 §5)', () => {
  it('accepts, persists, reloads and answers a re-delivery as already current', async () => {
    const dir = await tempDir();
    const s = await open(dir);
    const changed = vi.fn();
    s.subscribe(changed);
    expect(await s.apply(delivery(catalog(3)))).toEqual({ sequence: 3, outcome: 'accepted' });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(s.report()).toMatchObject({ enabled: true, keys: 1, sequence: 3, keyId: releaseKeyId(ck.pub) });
    expect(await s.apply(delivery(catalog(3)))).toEqual({ sequence: 3, outcome: 'already_current' });
    const again = await open(dir);
    expect(again.sequence).toBe(3);
    expect(again.catalog?.runtimes.codex?.[0]?.version).toBe(NEXT);
  });

  it('refuses a foreign key, tampered bytes, an older sequence and a disabled store', async () => {
    const dir = await tempDir();
    const s = await open(dir);
    expect(await s.apply(delivery(catalog(3), keyPair()))).toMatchObject({
      outcome: 'refused',
      reason: 'unknown_key',
    });
    const d = delivery(catalog(3));
    const tampered = {
      ...d,
      catalog: Buffer.from(Buffer.from(d.catalog, 'base64').toString().replace(NEXT, LATER)).toString(
        'base64',
      ),
    };
    expect(await s.apply(tampered)).toMatchObject({ outcome: 'refused', reason: 'bad_signature' });
    await s.apply(delivery(catalog(4)));
    expect(await s.apply(delivery(catalog(3)))).toMatchObject({ outcome: 'refused', reason: 'not_newer' });
    expect(s.report().lastRefusal).toEqual({ sequence: 3, reason: 'not_newer' });
    const host = catalog(5);
    const uv = host.tools.uv[0];
    if (uv === undefined) throw new Error('fixture');
    uv.assets['linux-x64'].url = 'https://evil.example/uv.tgz';
    expect(await s.apply(delivery(host))).toMatchObject({ outcome: 'refused', reason: 'unknown_host' });
    const off = await open(await tempDir(), [ck.pub], false);
    expect(await off.apply(delivery(catalog(3)))).toMatchObject({
      outcome: 'refused',
      reason: 'catalog_disabled',
    });
    expect(off.report()).toMatchObject({ enabled: false, sequence: 0 });
  });

  it('drops a stored catalog whose key is no longer trusted (rotation) and starts over', async () => {
    const dir = await tempDir();
    const s = await open(dir);
    await s.apply(delivery(catalog(900)));
    const next = keyPair();
    const rotated = await open(dir, [next.pub]);
    expect(rotated.catalog).toBeNull();
    expect(await readdir(dir)).not.toContain('catalog');
    // The sequence starts over with the new key.
    expect(await rotated.apply(delivery(catalog(1), next))).toMatchObject({ outcome: 'accepted' });
  });

  it('keys: the root config replaces the compiled-in list', () => {
    expect(trustedCatalogKeys(['k1'], ['c1'])).toEqual(['k1']);
    expect(trustedCatalogKeys(undefined, ['c1'])).toEqual(['c1']);
    expect(trustedCatalogKeys([], [])).toEqual([]);
  });
});

describe('merging an accepted catalog', () => {
  it('a verified runtime version becomes the pin, the release pin the way back, unverified ones apart', async () => {
    const s = await open(await tempDir());
    await s.apply(delivery(catalog(3)));
    const merged = mergeInstallManifest(INSTALL_MANIFEST, s.catalog);
    const spec = merged.runtimes.codex;
    if (spec === undefined) throw new Error('codex spec');
    expect(spec.pinned).toBe(NEXT);
    expect(spec.releasePin).toBe(codexPin);
    expect(spec.catalogUnverified).toEqual([LATER]);
    expect(catalogPins(merged)).toEqual({ codex: NEXT });
    expect(decideTarget(spec, codexPin, NEXT)).toMatchObject({ ok: true, action: 'downgrade' });
    expect(decideTarget(spec, LATER, NEXT)).toMatchObject({ ok: true, action: 'upgrade' });
    expect(merged.runtimes.pi).toBe(INSTALL_MANIFEST.runtimes.pi);
    expect(mergeInstallManifest(INSTALL_MANIFEST, null)).toBe(INSTALL_MANIFEST);

    const r = catalogRecipes(RECIPES, s.catalog);
    expect(r.first.map((x) => `${x.tool}@${x.version}`)).toEqual([`uv@${UV_NEXT}`]);
    expect(r.first[0]?.platforms['linux-x64']).toMatchObject({
      sha256: 'c'.repeat(64),
      size: 123,
      format: 'tgz',
    });
    expect(r.meta.get(`uv@${UV_NEXT}`)).toEqual({ verified: true, sequence: 3 });
  });

  it('the installer reports the catalog pin, the release pin and the unverified versions apart', async () => {
    const s = await open(await tempDir());
    await s.apply(delivery(catalog(3)));
    const dataDir = await tempDir();
    const installer = await RuntimeInstaller.open({
      ops: nodeOps(),
      dataDir,
      manifest: INSTALL_MANIFEST,
      host: { os: 'darwin', arch: 'arm64', libc: null },
      nodePath: process.execPath,
      logger,
    });
    installer.setManifest(mergeInstallManifest(INSTALL_MANIFEST, s.catalog));
    const codex = (await installer.report()).find((r) => r.runtime === 'codex');
    expect(codex).toMatchObject({ pinned: NEXT, releasePin: codexPin, catalogUnverified: [LATER] });
    expect(codex?.available).toContain(NEXT);
    expect(codex?.available).not.toContain(LATER);
  });
});

describe('runtime policies follow the pin (ADR-0065 §8)', () => {
  const policy = (pin?: 'follow' | 'hold'): RuntimePolicyDelivery => ({
    name: 'default',
    version: 6,
    stage: 'active',
    documentHash: 'a'.repeat(64),
    document: {
      runtimes: {
        codex: {
          version: '0.162.1',
          ...(pin === undefined ? {} : { pin }),
          authModes: ['local-login'],
          allowUnpinned: false,
          modelProfiles: [],
          defaultProfile: null,
        },
      },
      projectProfiles: {},
    },
  });
  const job = (p: RuntimePolicyDelivery | null, installed: string, followPin: string | null) =>
    checkRuntimeForJob({
      policy: p,
      runtime: 'codex',
      installedVersion: installed,
      authMode: null,
      project: 'x',
      followPin,
    });

  it('a rule without pin (a stored v6) follows the release / catalog pin and keeps its saved version working', () => {
    expect(effectivePin(policy(), 'codex', null)).toEqual({ pin: codexPin, source: 'compiled' });
    expect(effectivePin(policy(), 'codex', NEXT)).toEqual({ pin: NEXT, source: 'catalog' });
    expect(job(policy(), codexPin, null)).toMatchObject({ ok: true, pinMatches: true });
    expect(job(policy(), NEXT, NEXT)).toMatchObject({ ok: true, pinMatches: true, pinSource: 'catalog' });
    // The release pin still runs while the catalog version is not installed yet.
    expect(job(policy(), codexPin, NEXT)).toMatchObject({
      ok: true,
      pinMatches: true,
      pinSource: 'compiled',
    });
    // The saved version keeps running until the machine is updated (no stop on upgrade).
    expect(job(policy(), '0.162.1', NEXT)).toMatchObject({ ok: true, pinMatches: true, pinSource: 'policy' });
    expect(job(policy(), '0.100.0', NEXT)).toMatchObject({ ok: false, code: 'runtime_pin_mismatch' });
    expect(policyPins(policy(), { codex: NEXT })).toEqual({ codex: NEXT });
    expect(policyPins(policy(), {})).toEqual({});
  });

  it('a hold keeps exactly its version, whatever the catalog says', () => {
    expect(effectivePin(policy('hold'), 'codex', NEXT)).toEqual({ pin: '0.162.1', source: 'policy' });
    expect(job(policy('hold'), NEXT, NEXT)).toMatchObject({ ok: false, code: 'runtime_pin_mismatch' });
    expect(policyPins(policy('hold'), { codex: NEXT })).toEqual({ codex: '0.162.1' });
    // An owner upgrade writes a hold at the upgraded version: a machine under the policy runs it (no allowUnpinned).
    expect(job(policy('hold'), '0.162.1', NEXT)).toMatchObject({
      ok: true,
      pinMatches: true,
      pinSource: 'policy',
    });
  });
});

describe('APPLY_VERSION_CATALOG in the running daemon', { timeout: 60_000 }, () => {
  it('answers VERSION_CATALOG_STATUS and re-sends CAPABILITIES with the catalog report', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'work'), { recursive: true });
    await chmod(join(dir, 'work'), 0o700);
    const configPath = join(dir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        masterUrl: 'ws://127.0.0.1:3000/v1/worker',
        workspaceRoot: join(dir, 'work'),
        dataDir: join(dir, 'data'),
        updates: { catalogKeys: [ck.pub] },
      }),
      { mode: 0o600 },
    );
    const transport = new MemoryTransport();
    const signals = new ManualSignals();
    let daemon: WorkerDaemon | undefined;
    const running = runWorker({
      ops: nodeOps(),
      host: pathHost(),
      signals,
      transport,
      logSink: () => undefined,
      configPath,
      capabilities: (maxParallelJobs) =>
        Promise.resolve({ runtimes: [], sandboxProfiles: [], maxParallelJobs, tools: [] }),
      onStarted: (d) => {
        daemon = d;
      },
    });
    await vi.waitFor(() => {
      expect(daemon).toBeDefined();
    });
    let seq = 0;
    const master = (type: string, payload: unknown, control = false) =>
      MasterToWorker.parse({
        protocolVersion: '1.0',
        type,
        messageId: randomUUID(),
        seq: control ? 0 : ++seq,
        ts: '2026-10-26T00:00:00.000Z',
        correlationId: 'c-1',
        workerId: 'w-1',
        payload,
      });
    transport.emit({ kind: 'connected', enrolled: false });
    transport.emit({
      kind: 'message',
      message: master('ENROLL_APPROVED', { workerId: 'w-1', approvedAt: '2026-10-26T00:00:01.000Z' }),
    });
    transport.emit({
      kind: 'message',
      message: master(
        'SESSION_ESTABLISHED',
        { negotiatedVersion: '1.0', sessionExpiresAt: '2026-10-26T01:00:00.000Z', resumeFromSeq: 0 },
        true,
      ),
    });
    const caps = () =>
      transport.sent.filter(
        (m): m is Extract<WorkerToMaster, { type: 'CAPABILITIES' }> => m.type === 'CAPABILITIES',
      );
    await vi.waitFor(() => {
      expect(caps().length).toBeGreaterThan(0);
    });
    expect(caps()[0]?.payload.features).toContain('version-catalog-v1');
    expect(caps()[0]?.payload.versionCatalog).toMatchObject({ enabled: true, keys: 1, sequence: 0 });
    const before = caps().length;
    transport.emit({ kind: 'message', message: master('APPLY_VERSION_CATALOG', delivery(catalog(7)), true) });
    await vi.waitFor(() => {
      expect(transport.sent.some((m) => m.type === 'VERSION_CATALOG_STATUS')).toBe(true);
      expect(caps().length).toBeGreaterThan(before);
    });
    expect(transport.sent.find((m) => m.type === 'VERSION_CATALOG_STATUS')?.payload).toEqual({
      sequence: 7,
      outcome: 'accepted',
    });
    await vi.waitFor(() => {
      expect(caps().at(-1)?.payload.versionCatalog).toMatchObject({ sequence: 7 });
    });
    signals.trigger();
    await running;
  });
});

describe('owner upgrade of a tool: the asset must be the fixed template, the download its checksum', () => {
  const bytes = Buffer.from('#!/bin/sh\necho cloudflared version 2026.11.0\n');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const url = toolAssetUrl('cloudflared', 'linux-x64', '2026.11.0') ?? '';
  const open = async () =>
    ToolInstaller.open({
      ops: nodeOps(),
      dataDir: await tempDir(),
      platform: 'linux-x64',
      logger,
      source: { fetch: () => Promise.resolve(new Response(bytes)) },
    });

  it('installs a version outside the recipes from its template URL and published checksum', async () => {
    const t = await open();
    const m = await t.install('cloudflared', '2026.11.0', {
      asset: { url, sha256: sha, size: bytes.length },
    });
    expect(m.version).toBe('2026.11.0');
  });

  it('refuses another host or path, and a download that does not match the checksum', async () => {
    const t = await open();
    await expect(
      t.install('cloudflared', '2026.11.0', {
        asset: { url: 'https://evil.example/cloudflared', sha256: sha, size: bytes.length },
      }),
    ).rejects.toMatchObject({ reason: 'recipe_invalid' });
    await expect(
      t.install('cloudflared', '2026.11.0', {
        asset: {
          url: url.replace('cloudflare/cloudflared', 'evil/cloudflared'),
          sha256: sha,
          size: bytes.length,
        },
      }),
    ).rejects.toMatchObject({ reason: 'recipe_invalid' });
    await expect(
      t.install('cloudflared', '2026.11.0', { asset: { url, sha256: 'f'.repeat(64), size: bytes.length } }),
    ).rejects.toThrow();
  });
});
