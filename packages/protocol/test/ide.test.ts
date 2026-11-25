import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  IDE_EXTENSION_LIMITS,
  IDE_EXTENSIONS_FEATURE,
  IDE_FEATURE,
  IDE_LIMITS,
  IdeDownloadToken,
  IdeExtensionId,
  IdeExtensionRef,
  IdeProfile,
  ideProfileHash,
  IdeBranch,
  IdeEventPayload,
  IdeRelPath,
  IdeReport,
  IdeSpec,
  ideBasePath,
  ideBranch,
  ideMessageFresh,
  ideSpecHash,
  ideUserSlug,
  leaseKeyId,
  signIdeControl,
  signIdeGit,
  signIdeStart,
  verifyIdeControl,
  verifyIdeGit,
  verifyIdeStart,
  WorkerFeature,
  WorkerFeatureList,
} from '../src/index.js';

const WS = '00000000-0000-4000-8000-00000000e001';

const spec = {
  workspaceId: WS,
  projectId: 'shop',
  userId: 'u-1',
  name: 'checkout-fix',
  source: {
    kind: 'repository',
    repositoryUrl: 'https://github.com/acme/shop.git',
    baseRef: 'main',
    branch: 'remyral/ide/ayse/checkout-fix',
  },
  memoryMb: IDE_LIMITS.memoryMb,
  idleMinutes: IDE_LIMITS.idleMinutes,
  sandboxProfile: 'host-restricted',
  gitAuthor: { name: 'Ayşe', email: 'ayse@example.com' },
} as const;

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = String(publicKey.export({ format: 'jwk' }).x);
  return { privateKey, key: { kid: leaseKeyId(raw), publicKey: raw } };
}

describe('p19-ide W2 wire', () => {
  it('is an advertised worker feature (and streams-v1 stays retired)', () => {
    expect(WorkerFeature.safeParse(IDE_FEATURE).success).toBe(true);
    expect(WorkerFeatureList.parse(['ide-v1', 'streams-v1'])).toEqual(['ide-v1']);
  });

  it('parses a spec and refuses other profiles, limits and branches', () => {
    const s = IdeSpec.parse(spec);
    expect(s.source).toMatchObject({ kind: 'repository', branch: 'remyral/ide/ayse/checkout-fix' });
    expect(IdeSpec.safeParse({ ...spec, sandboxProfile: 'unconfined' }).success).toBe(false);
    expect(IdeSpec.safeParse({ ...spec, memoryMb: 512 }).success).toBe(false);
    expect(IdeSpec.safeParse({ ...spec, memoryMb: 32768 }).success).toBe(false);
    expect(IdeSpec.safeParse({ ...spec, idleMinutes: 5 }).success).toBe(false);
    expect(IdeSpec.safeParse({ ...spec, name: 'Has Space' }).success).toBe(false);
    expect(IdeSpec.safeParse({ ...spec, extra: 1 }).success).toBe(false);
    for (const branch of ['main', 'remyral/ide/a/b/c', 'rac/x/y', 'remyral/ide/A/b', 'remyral/ide/a/-b']) {
      expect(IdeBranch.safeParse(branch).success, branch).toBe(false);
    }
    expect(IdeSpec.safeParse({ ...spec, source: { kind: 'files', seed: null } }).success).toBe(true);
  });

  it('derives the user slug, the branch and the base path', () => {
    expect(ideUserSlug('Ayşe Yılmaz')).toBe('ayse-yilmaz');
    expect(ideUserSlug('__')).toBe('user');
    expect(ideUserSlug('x'.repeat(80))).toHaveLength(32);
    expect(IdeBranch.safeParse(ideBranch(ideUserSlug('Ömer.Çelik'), 'fix-1')).success).toBe(true);
    expect(ideBasePath(WS)).toBe(`/w/${WS}`);
  });

  it('confines relative paths', () => {
    for (const p of ['src/a.ts', 'README.md', '.vscode/settings.json']) {
      expect(IdeRelPath.safeParse(p).success, p).toBe(true);
    }
    for (const p of ['/etc/passwd', '../x', 'a/../b', 'a//b', 'a\\b', 'a/./b', '']) {
      expect(IdeRelPath.safeParse(p).success, p).toBe(false);
    }
  });

  it('signs and verifies start / control / git, bound to the worker and the content', () => {
    const { privateKey, key } = keys();
    const s = IdeSpec.parse(spec);
    const issuedAt = '2026-10-28T10:00:00.000Z';
    const start = { workerId: 'wrk_1', revision: 1, issuedAt, spec: s };
    const sig = signIdeStart(start, key.kid, privateKey);
    expect(verifyIdeStart(start, sig, [key])).toBe('ok');
    expect(verifyIdeStart({ ...start, workerId: 'wrk_2' }, sig, [key])).toBe('bad_signature');
    expect(verifyIdeStart({ ...start, spec: { ...s, memoryMb: 8192 } }, sig, [key])).toBe('bad_signature');
    expect(verifyIdeStart(start, undefined, [key])).toBe('missing');
    expect(verifyIdeStart(start, { ...sig, kid: 'other123' }, [key])).toBe('unknown_key');

    const control = { workerId: 'wrk_1', workspaceId: WS, op: 'remove' as const, issuedAt };
    const csig = signIdeControl(control, key.kid, privateKey);
    expect(verifyIdeControl(control, csig, [key])).toBe('ok');
    expect(verifyIdeControl({ ...control, op: 'stop' }, csig, [key])).toBe('bad_signature');

    const git = {
      workerId: 'wrk_1',
      workspaceId: WS,
      requestId: '00000000-0000-4000-8000-00000000e002',
      op: 'push' as const,
      message: 'fix checkout',
      issuedAt,
    };
    const gsig = signIdeGit(git, key.kid, privateKey);
    expect(verifyIdeGit(git, gsig, [key])).toBe('ok');
    expect(verifyIdeGit({ ...git, message: 'other' }, gsig, [key])).toBe('bad_signature');
    expect(verifyIdeGit({ ...git, op: 'status' }, gsig, [key])).toBe('bad_signature');
    expect(ideSpecHash(s)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses stale and future messages', () => {
    const now = new Date('2026-10-28T10:10:00.000Z');
    expect(ideMessageFresh('2026-10-28T10:08:00.000Z', now)).toBe(true);
    expect(ideMessageFresh('2026-10-28T09:58:00.000Z', now)).toBe(false);
    expect(ideMessageFresh('2026-10-28T10:20:00.000Z', now)).toBe(false);
    expect(ideMessageFresh('nope', now)).toBe(false);
  });

  it('parses bridge events and the capabilities report', () => {
    const at = '2026-10-28T10:00:00.000Z';
    const eventId = '00000000-0000-4000-8000-00000000e003';
    expect(
      IdeEventPayload.safeParse({
        kind: 'reference',
        workspaceId: WS,
        eventId,
        at,
        path: 'src/a.ts',
        startLine: 3,
        endLine: 9,
      }).success,
    ).toBe(true);
    expect(
      IdeEventPayload.safeParse({
        kind: 'reference',
        workspaceId: WS,
        eventId,
        at,
        path: '../a',
        startLine: 1,
        endLine: 1,
      }).success,
    ).toBe(false);
    expect(
      IdeEventPayload.safeParse({
        kind: 'push',
        workspaceId: WS,
        eventId,
        at,
        message: 'x',
        pullRequest: true,
      }).success,
    ).toBe(true);
    expect(IdeEventPayload.safeParse({ kind: 'shell', workspaceId: WS, eventId, at }).success).toBe(false);
    expect(
      IdeReport.safeParse({
        available: true,
        serverVersion: '1.109.5',
        max: 2,
        workspaces: [{ workspaceId: WS, revision: 1, state: 'running', since: at }],
      }).success,
    ).toBe(true);
  });
});

describe('p19-ide W3 wire (extensions + settings sync)', () => {
  const profile = IdeProfile.parse({
    extensions: [
      {
        id: 'redhat.vscode-yaml',
        version: '2.1.0',
        targetPlatform: 'universal',
        sha256: 'a'.repeat(64),
        size: 1000,
      },
    ],
    allowed: ['redhat.vscode-yaml'],
    enforcedSettings: { 'files.exclude': { '**/dist': true } },
    settingsSync: true,
  });

  it('is an advertised worker feature', () => {
    expect(WorkerFeature.safeParse(IDE_EXTENSIONS_FEATURE).success).toBe(true);
  });

  it('signs the profile with the start (a changed profile fails; no profile keeps the W2 statement)', () => {
    const k = keys();
    const base = {
      workerId: 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      revision: 1,
      issuedAt: '2026-10-29T10:00:00.000Z',
    };
    const s = IdeSpec.parse(spec);
    const sig = signIdeStart({ ...base, spec: s, profile }, k.key.kid, k.privateKey);
    expect(verifyIdeStart({ ...base, spec: s, profile }, sig, [k.key])).toBe('ok');
    const changed = { ...profile, allowed: [...profile.allowed, 'evil.ext'] };
    expect(verifyIdeStart({ ...base, spec: s, profile: changed }, sig, [k.key])).toBe('bad_signature');
    expect(verifyIdeStart({ ...base, spec: s }, sig, [k.key])).toBe('bad_signature');
    const w2 = signIdeStart({ ...base, spec: s }, k.key.kid, k.privateKey);
    expect(verifyIdeStart({ ...base, spec: s, profile: undefined }, w2, [k.key])).toBe('ok');
    expect(ideProfileHash(profile)).toBe(
      ideProfileHash(IdeProfile.parse(JSON.parse(JSON.stringify(profile)) as unknown)),
    );
  });

  it('bounds ids, versions, targets, hashes and enforced settings', () => {
    expect(IdeExtensionId.safeParse('Redhat.Yaml').success).toBe(false);
    expect(IdeExtensionId.safeParse('redhat/yaml').success).toBe(false);
    expect(
      IdeExtensionRef.safeParse({
        id: 'a.b',
        version: '1.0.0',
        targetPlatform: 'win32-arm64',
        sha256: 'a'.repeat(64),
        size: 1,
      }).success,
    ).toBe(false);
    expect(
      IdeProfile.safeParse({
        ...profile,
        enforcedSettings: { big: 'x'.repeat(IDE_EXTENSION_LIMITS.enforcedMaxBytes) },
      }).success,
    ).toBe(false);
    expect(IdeDownloadToken.safeParse('A'.repeat(43)).success).toBe(true);
  });

  it('carries settings saves from the bridge (≤ 256 KiB)', () => {
    const ev = {
      kind: 'settings',
      workspaceId: WS,
      eventId: '00000000-0000-4000-8000-00000000e002',
      at: '2026-10-29T10:00:00.000Z',
      file: 'settings',
      content: '{"editor.fontSize": 14}',
    };
    expect(IdeEventPayload.parse(ev)).toMatchObject({ kind: 'settings', file: 'settings' });
    expect(IdeEventPayload.safeParse({ ...ev, file: 'tasks' }).success).toBe(false);
    expect(
      IdeEventPayload.safeParse({ ...ev, content: 'x'.repeat(IDE_EXTENSION_LIMITS.settingsMaxBytes + 1) })
        .success,
    ).toBe(false);
  });
});
