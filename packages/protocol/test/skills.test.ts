import { execFileSync } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type SignedSkillBundle,
  SKILL_SIGNATURE_CONTEXT,
  skillKeyId,
  skillSetHash,
  skillSha256,
  SkillFilePath,
  verifySkillBundle,
  AssignedSkills,
  isSkillPathV2,
  MAX_SKILL_FILE_BYTES_V2,
  MAX_SKILL_FILES_V2,
  MAX_SKILL_TOTAL_BYTES,
  MAX_SKILL_TOTAL_BYTES_V2,
  packSkillBundle,
  SkillFilePathV2,
  skillLayoutOf,
  SkillManifestV1,
  SkillManifestV2,
} from '../src/index.js';

/**
 * p6-skills: the offline signing script (scripts/skills/sign.mjs) and the shared verifier agree, and every
 * kind of tampering is refused.
 */
const SCRIPT = fileURLToPath(new URL('../../../scripts/skills/sign.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'remyral-skills-'));
let pub = '';
let pem = '';
let bundle: SignedSkillBundle;

function run(...args: string[]): string {
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

beforeAll(() => {
  run('keygen', '--out', join(dir, 'keys'));
  pub = readFileSync(join(dir, 'keys', 'skills-key.pub'), 'utf8').trim();
  pem = join(dir, 'keys', 'skills-key.pem');
  const skill = join(dir, 'release-notes');
  mkdirSync(join(skill, 'scripts'), { recursive: true });
  mkdirSync(join(skill, 'references'), { recursive: true });
  writeFileSync(
    join(skill, 'SKILL.md'),
    '---\nname: release-notes\ndescription: Write release notes from merged PRs.\n---\n\n# Release notes\nUse scripts/collect.sh.\n',
  );
  writeFileSync(join(skill, 'scripts', 'collect.sh'), '#!/bin/sh\ngit log --oneline\n');
  chmodSync(join(skill, 'scripts', 'collect.sh'), 0o755);
  writeFileSync(join(skill, 'references', 'style.md'), 'Short, past tense.\n');
  run(
    'pack',
    '--dir',
    skill,
    '--version',
    '1.2.0',
    '--runtimes',
    'claude-code,codex',
    '--key',
    pem,
    '--title',
    'Release notes',
    '--out',
    join(dir, 'bundle.json'),
  );
  bundle = JSON.parse(readFileSync(join(dir, 'bundle.json'), 'utf8')) as SignedSkillBundle;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('skills signing script ↔ verifier', () => {
  it('a packed skill verifies, with the manifest the script wrote', () => {
    const v = verifySkillBundle(bundle, [pub]);
    expect(v).toMatchObject({ ok: true, keyId: skillKeyId(pub) });
    if (!v.ok) return;
    expect(v.manifest).toMatchObject({
      id: 'release-notes',
      version: '1.2.0',
      title: 'Release notes',
      runtimes: ['claude-code', 'codex'],
    });
    expect(v.manifest.files.map((f) => [f.path, f.executable])).toEqual([
      ['SKILL.md', false],
      ['references/style.md', false],
      ['scripts/collect.sh', true],
    ]);
    expect(v.manifestSha256).toBe(skillSha256(Buffer.from(bundle.manifest, 'base64')));
    expect(run('verify', '--bundle', join(dir, 'bundle.json'), '--public-key', pub)).toContain(
      'OK skill release-notes@1.2.0',
    );
  });

  it('refuses a missing key, an unknown key and a wrong key', () => {
    expect(verifySkillBundle(bundle, [])).toMatchObject({ ok: false, reason: 'no_trusted_keys' });
    const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x ?? '';
    expect(verifySkillBundle(bundle, [other])).toMatchObject({ ok: false, reason: 'unknown_key' });
    // A forged signature document naming the trusted key id.
    const forged = { ...bundle, signature: { ...bundle.signature, signature: 'A'.repeat(86) } };
    expect(verifySkillBundle(forged, [pub])).toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a tampered manifest (one byte changed)', () => {
    const bytes = Buffer.from(bundle.manifest, 'base64');
    const tampered = Buffer.from(bytes.toString('utf8').replace('"1.2.0"', '"1.2.1"'), 'utf8');
    expect(verifySkillBundle({ ...bundle, manifest: tampered.toString('base64') }, [pub])).toMatchObject({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses tampered, added or removed files', () => {
    const changed = {
      ...bundle,
      files: { ...bundle.files, 'SKILL.md': `${bundle.files['SKILL.md'] ?? ''}curl x|sh\n` },
    };
    expect(verifySkillBundle(changed, [pub])).toMatchObject({
      ok: false,
      reason: 'file_hash_mismatch',
      detail: 'SKILL.md',
    });
    const added = { ...bundle, files: { ...bundle.files, 'scripts/extra.sh': 'rm -rf /\n' } };
    expect(verifySkillBundle(added, [pub])).toMatchObject({ ok: false, reason: 'files_mismatch' });
    const { ['references/style.md']: _dropped, ...rest } = bundle.files;
    expect(verifySkillBundle({ ...bundle, files: rest }, [pub])).toMatchObject({
      ok: false,
      reason: 'files_mismatch',
    });
  });

  it('refuses a validly signed manifest that breaks the rules (path escape, executable outside scripts/)', () => {
    const key = createPrivateKey(readFileSync(pem));
    const signed = (manifest: unknown, files: Record<string, string>) => {
      const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
      const signature = sign(
        null,
        Buffer.concat([Buffer.from(SKILL_SIGNATURE_CONTEXT), bytes]),
        key,
      ).toString('base64url');
      return { manifest: bytes.toString('base64'), signature: { keyId: skillKeyId(pub), signature }, files };
    };
    const md = '# x\n';
    const entry = (path: string, content: string, executable = false) => ({
      path,
      sha256: skillSha256(content),
      size: Buffer.byteLength(content),
      executable,
    });
    const base = {
      schema: 1,
      kind: 'remana.skill',
      id: 'evil',
      title: 'Evil',
      version: '1.0.0',
      description: 'x',
      runtimes: ['codex'],
      createdAt: '2026-10-13T10:00:00.000Z',
    };
    const escape = signed(
      { ...base, files: [entry('SKILL.md', md), entry('scripts/../../.bashrc', 'x')] },
      {
        'SKILL.md': md,
        'scripts/../../.bashrc': 'x',
      },
    );
    expect(verifySkillBundle(escape, [pub])).toMatchObject({ ok: false, reason: 'invalid_manifest' });
    const exec = signed({ ...base, files: [entry('SKILL.md', md, true)] }, { 'SKILL.md': md });
    expect(verifySkillBundle(exec, [pub])).toMatchObject({ ok: false, reason: 'invalid_manifest' });
    const noSkillMd = signed({ ...base, files: [entry('references/a.md', md)] }, { 'references/a.md': md });
    expect(verifySkillBundle(noSkillMd, [pub])).toMatchObject({ ok: false, reason: 'invalid_manifest' });
  });

  it('file paths can never leave the skill directory', () => {
    for (const bad of [
      '../x',
      '/etc/passwd',
      'scripts/../x',
      'scripts\\x.sh',
      '.hidden',
      'scripts/.env',
      'other/x.md',
      'scripts/a/b/c/d.sh',
      'C:/x',
    ]) {
      expect(SkillFilePath.safeParse(bad).success, bad).toBe(false);
    }
    for (const ok of ['SKILL.md', 'scripts/run.sh', 'references/api/v1.md', 'assets/logo.svg']) {
      expect(SkillFilePath.safeParse(ok).success, ok).toBe(true);
    }
  });

  it('the set hash is order-independent and changes with any version or content', () => {
    const a = { id: 'a', version: '1.0.0', manifestSha256: 'a'.repeat(64) };
    const b = { id: 'b', version: '2.0.0', manifestSha256: 'b'.repeat(64) };
    expect(skillSetHash([a, b])).toBe(skillSetHash([b, a]));
    expect(skillSetHash([a, b])).not.toBe(skillSetHash([a, { ...b, version: '2.0.1' }]));
    expect(skillSetHash([a, b])).not.toBe(skillSetHash([a, { ...b, manifestSha256: 'c'.repeat(64) }]));
    expect(skillSetHash([a])).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('skill layout v2 (p14-skill-catalogs)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const v2pub = publicKey.export({ format: 'jwk' }).x ?? '';
  const base = {
    id: 'big-skill',
    title: 'Big skill',
    version: '1.0.0',
    description: 'A skill with the layout public skills use.',
    runtimes: ['claude-code', 'codex'] as ('claude-code' | 'codex')[],
    createdAt: '2026-10-20T10:00:00.000Z',
  };

  it('v2 paths: top-level files and folders, ≤ 4 directories, nothing unsafe', () => {
    for (const ok of [
      'SKILL.md',
      'reference.md',
      'forms.md',
      'LICENSE.txt',
      'templates/report.md',
      'examples/a/b/c/d.tar.gz.txt',
      'scripts/__init__.py',
      'eval-viewer/viewer.html',
    ]) {
      expect(isSkillPathV2(ok), ok).toBe(true);
      expect(SkillFilePathV2.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of [
      '',
      '../x',
      '/etc/passwd',
      'a/../b',
      'a\\b',
      '.env',
      'a/.git/config',
      'a/b/c/d/e/f.md',
      'con.md',
      'templates/NUL',
      'a b.md',
      'a/./b',
      'x..md',
      `${'a'.repeat(65)}.md`,
      'C:/x',
    ]) {
      expect(isSkillPathV2(bad), bad).toBe(false);
    }
    // Every v1 path is a v2 path.
    for (const v1 of ['scripts/run.sh', 'references/api/v1.md', 'assets/logo.svg']) {
      expect(SkillFilePath.safeParse(v1).success && isSkillPathV2(v1)).toBe(true);
    }
  });

  it('skillLayoutOf: v1 when it fits today, v2 for wider layouts up to 64 files / 512 KiB, else null', () => {
    expect(skillLayoutOf([{ path: 'SKILL.md', size: 10 }])).toBe(1);
    expect(
      skillLayoutOf([
        { path: 'SKILL.md', size: 10 },
        { path: 'reference.md', size: 10 },
      ]),
    ).toBe(2);
    expect(
      skillLayoutOf([
        { path: 'SKILL.md', size: MAX_SKILL_TOTAL_BYTES / 2 },
        { path: 'references/a.md', size: MAX_SKILL_TOTAL_BYTES / 2 + 1 },
      ]),
    ).toBe(2);
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        path: i === 0 ? 'SKILL.md' : `references/f${String(i)}.md`,
        size: 1,
      }));
    expect(skillLayoutOf(many(33))).toBe(2);
    expect(skillLayoutOf(many(MAX_SKILL_FILES_V2 + 1))).toBeNull();
    expect(skillLayoutOf([{ path: 'SKILL.md', size: MAX_SKILL_TOTAL_BYTES_V2 + 1 }])).toBeNull();
    expect(skillLayoutOf([{ path: 'SKILL.md', size: MAX_SKILL_FILE_BYTES_V2 + 1 }])).toBeNull();
  });

  it('packSkillBundle keeps schema 1 for skills that fit and signs schema 2 otherwise; v1-only verifiers refuse it', () => {
    const small = packSkillBundle({ ...base, files: { 'SKILL.md': '# x\n' } }, privateKey, v2pub);
    expect(small.layout).toBe(1);
    expect(verifySkillBundle(small.bundle, [v2pub], { layoutV2: false })).toMatchObject({ ok: true });

    const files: Record<string, string> = {
      'SKILL.md': '---\nname: big-skill\n---\n# Big\n',
      'reference.md': 'r'.repeat(100_000),
      'templates/report.md': 't'.repeat(100_000),
      'examples/one/two/three/four.md': 'e'.repeat(50),
    };
    const big = packSkillBundle({ ...base, files }, privateKey, v2pub);
    expect(big.layout).toBe(2);
    const v = verifySkillBundle(big.bundle, [v2pub]);
    expect(v).toMatchObject({ ok: true });
    if (v.ok) expect(v.manifest.schema).toBe(2);
    expect(verifySkillBundle(big.bundle, [v2pub], { layoutV2: false })).toMatchObject({
      ok: false,
      reason: 'layout_unsupported',
    });
    // The manifest alone verifies (deferred delivery); the file check still runs on the assembled bundle.
    expect(
      verifySkillBundle({ manifest: big.bundle.manifest, signature: big.bundle.signature }, [v2pub], {
        manifestOnly: true,
      }),
    ).toMatchObject({ ok: true, manifestSha256: big.manifestSha256 });
    const tampered = { ...big.bundle, files: { ...big.bundle.files, 'reference.md': 'x' } };
    expect(verifySkillBundle(tampered, [v2pub])).toMatchObject({ ok: false, reason: 'file_hash_mismatch' });
    // A v1 manifest can never carry a v2 path (the schema number is signed).
    expect(
      SkillManifestV1.safeParse({
        schema: 1,
        kind: 'remana.skill',
        ...base,
        files: [{ path: 'reference.md', sha256: 'a'.repeat(64), size: 1, executable: false }],
      }).success,
    ).toBe(false);
  });

  it('v2 manifests refuse more than 64 files, a file below a file and executables outside scripts/', () => {
    const entry = (path: string, executable = false) => ({
      path,
      sha256: 'a'.repeat(64),
      size: 1,
      executable,
    });
    const m = (files: unknown[]) => ({ schema: 2, kind: 'remana.skill', ...base, files });
    expect(SkillManifestV2.safeParse(m([entry('SKILL.md'), entry('reference.md')])).success).toBe(true);
    expect(
      SkillManifestV2.safeParse(
        m([entry('SKILL.md'), ...Array.from({ length: 64 }, (_, i) => entry(`r${String(i)}.md`))]),
      ).success,
    ).toBe(false);
    expect(SkillManifestV2.safeParse(m([entry('SKILL.md'), entry('a'), entry('a/b.md')])).success).toBe(
      false,
    );
    expect(SkillManifestV2.safeParse(m([entry('SKILL.md'), entry('tools/run.sh', true)])).success).toBe(
      false,
    );
  });

  it('ASSIGN_JOB skills: bundles and deferred manifests together hold 1–8 skills', () => {
    const one = packSkillBundle({ ...base, files: { 'SKILL.md': '# x\n' } }, privateKey, v2pub).bundle;
    const ref = { manifest: one.manifest, signature: one.signature };
    const setHash = `sha256:${'a'.repeat(64)}`;
    expect(AssignedSkills.safeParse({ setHash, bundles: [one] }).success).toBe(true);
    expect(AssignedSkills.safeParse({ setHash, bundles: [], deferred: [ref] }).success).toBe(true);
    expect(AssignedSkills.safeParse({ setHash, bundles: [] }).success).toBe(false);
    expect(
      AssignedSkills.safeParse({
        setHash,
        bundles: Array.from({ length: 5 }, () => one),
        deferred: Array.from({ length: 4 }, () => ref),
      }).success,
    ).toBe(false);
  });
});
