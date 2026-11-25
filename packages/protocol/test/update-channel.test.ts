import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type AcceptedCatalog,
  CATALOG_CONTEXT,
  type CatalogFloor,
  checkVersionCatalog,
  compareDotted,
  effectiveRuntimeCatalog,
  effectiveToolCatalog,
  MasterToWorker,
  MAX_CATALOG_BYTES,
  npmTarballUrl,
  releaseBump,
  releaseKeyId,
  RuntimePolicyRule,
  ruleHoldsVersion,
  toolAssetUrl,
  verifyWorkerReleaseFeed,
  WORKER_FEED_CONTEXT,
  WorkerToMaster,
} from '../src/index.js';
import { envelope, workerId } from './fixtures.js';

function keyPair(): { pub: string; priv: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ format: 'jwk' }).x ?? '', priv: privateKey };
}
const sig = (context: string, bytes: Buffer, k: { pub: string; priv: KeyObject }) => ({
  keyId: releaseKeyId(k.pub),
  signature: sign(null, Buffer.concat([Buffer.from(context), bytes]), k.priv).toString('base64url'),
});
const at = <T>(a: T[], i: number): T => {
  const v = a[i];
  if (v === undefined) throw new Error('fixture');
  return v;
};
const integ = (c: string) => `sha512-${c.repeat(86)}==`;

function codexEntry(version: string, over: Record<string, unknown> = {}) {
  return {
    version,
    packageVersion: version,
    integrity: integ('a'),
    verified: true,
    packages: [
      {
        path: 'node_modules/@openai/codex',
        name: '@openai/codex',
        version,
        resolved: npmTarballUrl('@openai/codex', version),
        integrity: integ('a'),
      },
      {
        path: 'node_modules/@openai/codex-darwin-arm64',
        name: '@openai/codex-darwin-arm64',
        version,
        resolved: npmTarballUrl('@openai/codex-darwin-arm64', version),
        integrity: integ('b'),
        optional: true,
        os: ['darwin'],
        cpu: ['arm64'],
      },
    ],
    ...over,
  };
}
function uvEntry(version: string, over: Record<string, unknown> = {}) {
  return {
    version,
    verified: true,
    assets: {
      'linux-x64': {
        url: `https://github.com/astral-sh/uv/releases/download/${version}/uv-x86_64-unknown-linux-gnu.tar.gz`,
        sha256: 'c'.repeat(64),
        size: 1000,
      },
    },
    ...over,
  };
}
function catalogDoc(over: Record<string, unknown> = {}) {
  return {
    schema: 1,
    name: 'remyral-version-catalog',
    sequence: 5,
    generatedAt: '2026-10-26T08:00:00.000Z',
    runtimes: { codex: [codexEntry('0.165.0')] },
    tools: { uv: [uvEntry('0.13.6')] },
    ...over,
  };
}
const bytesOf = (doc: unknown) => Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);

const ck = keyPair();
const floor: CatalogFloor = {
  runtimes: { codex: { version: '0.164.0', scripts: [] } },
  tools: { uv: '0.13.5' },
};
const now = new Date('2026-10-26T09:00:00.000Z');
const check = (
  doc: unknown,
  opts: { previous?: AcceptedCatalog | null; keys?: string[]; signer?: typeof ck } = {},
) => {
  const b = bytesOf(doc);
  return checkVersionCatalog(b, sig(CATALOG_CONTEXT, b, opts.signer ?? ck), {
    keys: opts.keys ?? [ck.pub],
    previous: opts.previous ?? null,
    floor,
    now,
  });
};
const accepted = (doc: unknown): AcceptedCatalog => {
  const r = check(doc);
  if (!r.ok) throw new Error(r.reason);
  return { sequence: r.catalog.sequence, catalog: r.catalog, sha256: r.sha256 };
};
const reason = (r: ReturnType<typeof check>) => (r.ok ? 'ok' : r.reason);

describe('version catalog acceptance (ADR-0065 §5)', () => {
  it('accepts a valid catalog and reports entries below the release floor as skipped', () => {
    const r = check(
      catalogDoc({ tools: { uv: [uvEntry('0.13.6'), uvEntry('0.12.0', { verified: false })] } }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.alreadyCurrent).toBe(false);
    expect(r.skipped).toEqual([{ kind: 'tool', item: 'uv', version: '0.12.0', reason: 'below_release_pin' }]);
  });

  it('refuses foreign keys, tampered bytes and malformed signatures', () => {
    const other = keyPair();
    expect(reason(check(catalogDoc(), { signer: other }))).toBe('unknown_key');
    const b = bytesOf(catalogDoc());
    const s = sig(CATALOG_CONTEXT, b, ck);
    const tampered = Buffer.from(b.toString().replace('0.165.0', '0.166.0'));
    expect(reason(checkVersionCatalog(tampered, s, { keys: [ck.pub], previous: null, floor, now }))).toBe(
      'bad_signature',
    );
    // A forged key id of a trusted key still fails the signature.
    const forged = { keyId: releaseKeyId(ck.pub), signature: sig(CATALOG_CONTEXT, b, other).signature };
    expect(reason(checkVersionCatalog(b, forged, { keys: [ck.pub], previous: null, floor, now }))).toBe(
      'bad_signature',
    );
    expect(
      reason(checkVersionCatalog(b, { keyId: 'x' }, { keys: [ck.pub], previous: null, floor, now })),
    ).toBe('invalid_signature_document');
    expect(reason(checkVersionCatalog(b, s, { keys: [], previous: null, floor, now }))).toBe(
      'no_trusted_keys',
    );
  });

  it('a release signature or a feed signature is not a catalog signature (domain separation)', () => {
    const b = bytesOf(catalogDoc());
    const s = sig(WORKER_FEED_CONTEXT, b, ck);
    expect(reason(checkVersionCatalog(b, s, { keys: [ck.pub], previous: null, floor, now }))).toBe(
      'bad_signature',
    );
  });

  it('accepts the next key of a rotation and refuses a retired one', () => {
    const next = keyPair();
    expect(check(catalogDoc(), { signer: next, keys: [ck.pub, next.pub] }).ok).toBe(true);
    expect(reason(check(catalogDoc(), { keys: [next.pub] }))).toBe('unknown_key');
  });

  it('is monotonic: a lower or equal sequence is refused, the same bytes are idempotent', () => {
    const prev = accepted(catalogDoc());
    const same = check(catalogDoc(), { previous: prev });
    expect(same.ok && same.alreadyCurrent).toBe(true);
    expect(reason(check(catalogDoc({ generatedAt: '2026-10-26T08:30:00.000Z' }), { previous: prev }))).toBe(
      'not_newer',
    );
    expect(reason(check(catalogDoc({ sequence: 4 }), { previous: prev }))).toBe('not_newer');
    expect(check(catalogDoc({ sequence: 6 }), { previous: prev }).ok).toBe(true);
  });

  it('refuses a verified downgrade but allows going back to the release pin or dropping the item', () => {
    const prev = accepted(catalogDoc({ runtimes: { codex: [codexEntry('0.166.0')] } }));
    expect(
      reason(
        check(catalogDoc({ sequence: 6, runtimes: { codex: [codexEntry('0.165.0')] } }), { previous: prev }),
      ),
    ).toBe('version_downgrade');
    expect(
      check(catalogDoc({ sequence: 6, runtimes: { codex: [codexEntry('0.164.0')] } }), { previous: prev }).ok,
    ).toBe(true);
    expect(check(catalogDoc({ sequence: 6, runtimes: {} }), { previous: prev }).ok).toBe(true);
    // An unverified lower entry is only an offer: not a downgrade.
    expect(
      check(
        catalogDoc({
          sequence: 6,
          runtimes: { codex: [codexEntry('0.166.0'), codexEntry('0.165.5', { verified: false })] },
        }),
        { previous: prev },
      ).ok,
    ).toBe(true);
    const prevTool = accepted(catalogDoc({ tools: { uv: [uvEntry('0.13.8')] } }));
    expect(
      reason(check(catalogDoc({ sequence: 6, tools: { uv: [uvEntry('0.13.6')] } }), { previous: prevTool })),
    ).toBe('version_downgrade');
  });

  it('refuses unknown packages, runtimes and wrong SDK lines', () => {
    expect(reason(check(catalogDoc({ runtimes: { openhands: [codexEntry('1.0.0')] } })))).toBe(
      'unknown_package',
    );
    const wrongRoot = codexEntry('0.165.0');
    wrongRoot.packages[0] = { ...at(wrongRoot.packages, 0), path: 'node_modules/evil', name: 'evil' };
    expect(reason(check(catalogDoc({ runtimes: { codex: [wrongRoot] } })))).toBe('unknown_package');
    const otherIntegrity = codexEntry('0.165.0', { integrity: integ('z') });
    expect(reason(check(catalogDoc({ runtimes: { codex: [otherIntegrity] } })))).toBe('unknown_package');
    const mismatch = codexEntry('0.165.0', { packageVersion: '0.165.1' });
    expect(reason(check(catalogDoc({ runtimes: { codex: [mismatch] } })))).toBe('version_mismatch');
    const misnamed = codexEntry('0.165.0');
    misnamed.packages[1] = { ...at(misnamed.packages, 1), name: 'left-pad' };
    expect(reason(check(catalogDoc({ runtimes: { codex: [misnamed] } })))).toBe('unknown_package');
  });

  it('refuses tarballs from another host or another path', () => {
    const host = codexEntry('0.165.0');
    host.packages[1] = {
      ...at(host.packages, 1),
      resolved: 'https://evil.example/@openai/codex-darwin-arm64.tgz',
    };
    expect(reason(check(catalogDoc({ runtimes: { codex: [host] } })))).toBe('unknown_host');
    const http = codexEntry('0.165.0');
    http.packages[1] = {
      ...at(http.packages, 1),
      resolved: at(http.packages, 1).resolved.replace('https', 'http'),
    };
    expect(reason(check(catalogDoc({ runtimes: { codex: [http] } })))).toBe('unknown_host');
    const path = codexEntry('0.165.0');
    path.packages[1] = {
      ...at(path.packages, 1),
      resolved: 'https://registry.npmjs.org/@openai/codex-darwin-arm64/-/other-0.165.0.tgz',
    };
    expect(reason(check(catalogDoc({ runtimes: { codex: [path] } })))).toBe('unknown_source');
    const traversal = codexEntry('0.165.0');
    traversal.packages[1] = { ...at(traversal.packages, 1), path: 'node_modules/../../etc' };
    expect(reason(check(catalogDoc({ runtimes: { codex: [traversal] } })))).toBe('invalid_catalog');
  });

  it('refuses install scripts the release lock does not have', () => {
    const s = codexEntry('0.165.0', { scripts: ['@openai/codex-darwin-arm64'] });
    expect(reason(check(catalogDoc({ runtimes: { codex: [s] } })))).toBe('install_script_refused');
  });

  it('refuses tool assets from an unknown host, another path or an unknown tool', () => {
    const host = uvEntry('0.13.6');
    host.assets['linux-x64'] = { ...host.assets['linux-x64'], url: 'https://evil.example/uv.tar.gz' };
    expect(reason(check(catalogDoc({ tools: { uv: [host] } })))).toBe('unknown_host');
    const path = uvEntry('0.13.6');
    path.assets['linux-x64'] = {
      ...path.assets['linux-x64'],
      url: 'https://github.com/evil/uv/releases/download/0.13.6/uv-x86_64-unknown-linux-gnu.tar.gz',
    };
    expect(reason(check(catalogDoc({ tools: { uv: [path] } })))).toBe('unknown_source');
    expect(reason(check(catalogDoc({ tools: { curl: [uvEntry('8.0.0')] } })))).toBe('unknown_tool');
    // git has a Windows build only.
    const git = {
      version: '2.57.0.1',
      verified: true,
      assets: { 'linux-x64': { url: 'https://github.com/x', sha256: 'c'.repeat(64), size: 1 } },
    };
    expect(reason(check(catalogDoc({ tools: { git: [git] } })))).toBe('unknown_source');
  });

  it('refuses unknown fields anywhere (no commands, scripts or URLs beyond the known ones)', () => {
    expect(reason(check(catalogDoc({ command: 'curl x | sh' })))).toBe('invalid_catalog');
    expect(
      reason(check(catalogDoc({ tools: { uv: [uvEntry('0.13.6', { postInstall: 'rm -rf /' })] } }))),
    ).toBe('invalid_catalog');
    expect(
      reason(
        check(catalogDoc({ runtimes: { codex: [codexEntry('0.165.0', { registry: 'https://evil' })] } })),
      ),
    ).toBe('invalid_catalog');
    expect(reason(check(catalogDoc({ tools: { uv: [uvEntry('0.13.6;rm')] } })))).toBe('invalid_catalog');
  });

  it('refuses future-dated and oversized catalogs', () => {
    expect(reason(check(catalogDoc({ generatedAt: '2026-10-28T09:00:00.000Z' })))).toBe('future_dated');
    const big = Buffer.alloc(MAX_CATALOG_BYTES + 1, 0x20);
    expect(
      reason(
        checkVersionCatalog(big, sig(CATALOG_CONTEXT, big, ck), {
          keys: [ck.pub],
          previous: null,
          floor,
          now,
        }),
      ),
    ).toBe('too_large');
  });

  it('builds tool URLs from fixed templates only', () => {
    expect(toolAssetUrl('git', 'win32-x64', '2.56.0.3')).toBe(
      'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.3/MinGit-2.56.0.3-64-bit.zip',
    );
    expect(toolAssetUrl('git', 'win32-x64', '2.57.0')).toBe(
      'https://github.com/git-for-windows/git/releases/download/v2.57.0.windows.1/MinGit-2.57.0-64-bit.zip',
    );
    expect(toolAssetUrl('browser', 'linux-arm64', '1248', '156.0.8078.4')).toBe(
      'https://cdn.playwright.dev/builds/cft/156.0.8078.4/linux-arm64/chrome-linux-arm64.zip',
    );
    expect(toolAssetUrl('browser', 'linux-arm64', '1248')).toBeNull();
    expect(toolAssetUrl('node', 'win32-x64', '24.22.1')).toBe(
      'https://nodejs.org/dist/v24.22.1/node-v24.22.1-win-x64.zip',
    );
    expect(toolAssetUrl('uv', 'linux-x64', '../../x')).toBeNull();
    expect(toolAssetUrl('python', 'linux-x64', '3.13.17')).toBeNull();
    expect(compareDotted('2.56.0.3', '2.56.0')).toBe(1);
    expect(compareDotted('1248', '1250')).toBe(-1);
  });

  it('derives the effective pin and the unverified offers', () => {
    const c = accepted(
      catalogDoc({
        runtimes: {
          codex: [
            codexEntry('0.165.0'),
            codexEntry('0.166.0', { verified: false }),
            codexEntry('0.163.0', { verified: true }),
          ],
        },
      }),
    ).catalog;
    const eff = effectiveRuntimeCatalog(c, 'codex', '0.164.0');
    expect(eff.pinned?.version).toBe('0.165.0');
    expect(eff.unverified.map((e) => e.version)).toEqual(['0.166.0']);
    expect(effectiveRuntimeCatalog(c, 'codex', '0.170.0')).toEqual({ pinned: null, unverified: [] });
    expect(effectiveRuntimeCatalog(null, 'codex', '0.164.0')).toEqual({ pinned: null, unverified: [] });
    expect(effectiveToolCatalog(c, 'uv', '0.13.5').verified?.version).toBe('0.13.6');
  });
});

describe('worker release feed', () => {
  const rk = keyPair();
  const feedDoc = (over: Record<string, unknown> = {}) => ({
    schema: 1,
    name: 'remyral-worker-feed',
    channel: 'stable',
    generatedAt: '2026-10-26T08:00:00.000Z',
    catalogKeys: [ck.pub],
    releases: [
      {
        version: '1.1.5',
        channel: 'stable',
        publishedAt: '2026-10-26T07:00:00.000Z',
        protocolVersions: ['1.0'],
        minNode: '24.11.0',
        sha256: 'd'.repeat(64),
        size: 1000,
        bundle: { path: '1.1.5/release.json', sha256: 'e'.repeat(64), size: 2000 },
        summary: 'Fixes',
        notes: '- Fixes',
      },
    ],
    ...over,
  });
  it('verifies with the release key only', () => {
    const b = bytesOf(feedDoc());
    const ok = verifyWorkerReleaseFeed(b, sig(WORKER_FEED_CONTEXT, b, rk), [rk.pub]);
    expect(ok.ok && ok.feed.catalogKeys).toEqual([ck.pub]);
    expect(verifyWorkerReleaseFeed(b, sig(WORKER_FEED_CONTEXT, b, ck), [rk.pub])).toMatchObject({
      ok: false,
      reason: 'unknown_key',
    });
    const t = Buffer.from(b.toString().replace('1000', '1001'));
    expect(verifyWorkerReleaseFeed(t, sig(WORKER_FEED_CONTEXT, b, rk), [rk.pub])).toMatchObject({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verifyWorkerReleaseFeed(b, sig(CATALOG_CONTEXT, b, rk), [rk.pub])).toMatchObject({
      ok: false,
      reason: 'bad_signature',
    });
  });
  it('refuses a bundle path outside <version>/release.json', () => {
    const doc = feedDoc();
    (doc.releases[0] as { bundle: { path: string } }).bundle.path = '../../etc/passwd';
    const b = bytesOf(doc);
    expect(verifyWorkerReleaseFeed(b, sig(WORKER_FEED_CONTEXT, b, rk), [rk.pub])).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
  });
  it('classifies the bump', () => {
    expect(releaseBump('1.1.4', '1.1.5')).toBe('patch');
    expect(releaseBump('1.1.4', '1.2.0')).toBe('minor');
    expect(releaseBump('1.1.4', '2.0.0')).toBe('major');
    expect(releaseBump('1.1.4', '1.1.4')).toBe('same');
    expect(releaseBump('1.1.4', '1.1.3')).toBe('older');
    expect(releaseBump(null, '1.1.4')).toBe('first');
    expect(releaseBump('1.1.4', '1.1.5-rc.1')).toBe('prerelease');
  });
});

describe('messages and runtime policy pin mode', () => {
  it('parses APPLY_VERSION_CATALOG and VERSION_CATALOG_STATUS', () => {
    const apply = MasterToWorker.safeParse({
      ...envelope('APPLY_VERSION_CATALOG', { workerId }),
      payload: {
        sequence: 5,
        catalog: Buffer.from('{}').toString('base64'),
        signature: { keyId: 'a'.repeat(16), signature: 'B'.repeat(86) },
      },
    });
    expect(apply.success).toBe(true);
    const status = WorkerToMaster.safeParse({
      ...envelope('VERSION_CATALOG_STATUS', { workerId }),
      payload: { sequence: 5, outcome: 'refused', reason: 'unknown_key' },
    });
    expect(status.success).toBe(true);
  });
  it('a rule without pin follows; hold holds', () => {
    const rule = RuntimePolicyRule.parse({
      version: '2.1.296',
      authModes: ['local-login'],
      allowUnpinned: false,
      modelProfiles: [],
      defaultProfile: null,
    });
    expect(ruleHoldsVersion(rule)).toBe(false);
    expect(ruleHoldsVersion({ ...rule, pin: 'hold' })).toBe(true);
    expect(RuntimePolicyRule.safeParse({ ...rule, pin: 'latest' }).success).toBe(false);
  });
});
