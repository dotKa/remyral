import { generateKeyPairSync } from 'node:crypto';
import {
  MAX_JOB_SKILL_BYTES_V2,
  packSkillBundle,
  type SignedSkillBundle,
  skillSetHash,
  skillSha256,
} from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { fetchDeferredSkills, type SkillSliceAnswer } from '../src/skills/fetch.js';
import { verifyAssignedSkills } from '../src/skills/verify.js';

/**
 * p14-skill-catalogs (skills-layout-v2): layout-v2 manifests and deferred skills — the manifest is verified at
 * admission, the files are pulled slice by slice and the assembled bundle is verified in full; a lying master (wrong
 * bytes, extra bytes, refusals, never-ending answers) fails the job.
 */
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pub = publicKey.export({ format: 'jwk' }).x ?? '';

function big(id: string): SignedSkillBundle {
  return packSkillBundle(
    {
      id,
      title: id,
      version: '1.0.0',
      description: 'A layout-v2 skill.',
      runtimes: ['codex'],
      createdAt: '2026-10-20T10:00:00.000Z',
      files: {
        'SKILL.md': `---\nname: ${id}\n---\n# ${id}\nRead reference.md.\n`,
        'reference.md': 'r'.repeat(100_000),
        'templates/report.md': 't'.repeat(90_000),
      },
    },
    privateKey,
    pub,
  ).bundle;
}

const sha = (b: SignedSkillBundle) => skillSha256(Buffer.from(b.manifest, 'base64'));

function assigned(inline: SignedSkillBundle[], deferred: SignedSkillBundle[]) {
  const pins = [...inline, ...deferred].map((b) => {
    const m = JSON.parse(Buffer.from(b.manifest, 'base64').toString('utf8')) as {
      id: string;
      version: string;
    };
    return { id: m.id, version: m.version, manifestSha256: sha(b) };
  });
  return {
    setHash: skillSetHash(pins),
    bundles: inline,
    ...(deferred.length === 0
      ? {}
      : { deferred: deferred.map((b) => ({ manifest: b.manifest, signature: b.signature })) }),
  };
}

/** A master answering slices from the given bundles (optionally lying about the bytes). */
function master(
  bundles: SignedSkillBundle[],
  chunk = 64 * 1024,
  lie?: (path: string, data: Buffer) => Buffer,
) {
  const byHash = new Map(bundles.map((b) => [sha(b), b]));
  const calls: string[] = [];
  const request = (manifestSha256: string, path: string, offset: number): Promise<SkillSliceAnswer> => {
    calls.push(`${path}@${String(offset)}`);
    const content = byHash.get(manifestSha256)?.files[path];
    if (content === undefined) return Promise.resolve({ status: 'not_found' });
    let bytes: Buffer = Buffer.from(content, 'utf8');
    if (lie !== undefined) bytes = lie(path, bytes);
    const data = bytes.subarray(offset, offset + chunk);
    return Promise.resolve({ status: 'ok', data, eof: offset + data.length >= bytes.length });
  };
  return { request, calls };
}

describe('layout v2 and deferred skills on the worker (p14-skill-catalogs)', () => {
  it('a v2 bundle inline verifies; a worker without v2 refuses it and any deferred skill', () => {
    const b = big('big-a');
    expect(verifyAssignedSkills(assigned([b], []), 'codex', [pub])).toMatchObject({ ok: true });
    const old = verifyAssignedSkills(assigned([b], []), 'codex', [pub], { layoutV2: false });
    expect(old.ok ? '' : old.message).toContain('layout_unsupported');
    const deferredOld = verifyAssignedSkills(assigned([], [b]), 'codex', [pub], { layoutV2: false });
    expect(deferredOld.ok ? '' : deferredOld.message).toContain('skills-layout-v2');
  });

  it('deferred: admission checks the signed manifest and set hash; fetched files are verified in full', async () => {
    const a = big('big-a');
    const b = big('big-b');
    const check = verifyAssignedSkills(assigned([a], [b]), 'codex', [pub]);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.skills.map((s) => s.id)).toEqual(['big-a']);
    expect(check.deferred.map((d) => d.manifest.id)).toEqual(['big-b']);
    const m = master([b]);
    const fetched = await fetchDeferredSkills(check.deferred, m.request);
    expect(fetched[0]?.files.map((f) => f.path).sort()).toEqual([
      'SKILL.md',
      'reference.md',
      'templates/report.md',
    ]);
    expect(fetched[0]?.files.find((f) => f.path === 'reference.md')?.content).toBe('r'.repeat(100_000));
    // 100 000 bytes in 64 KiB slices: two requests for that file.
    expect(m.calls.filter((c) => c.startsWith('reference.md@'))).toEqual([
      'reference.md@0',
      'reference.md@65536',
    ]);
  });

  it('a forged manifest (wrong signature) or a swapped set hash declines the job at admission', () => {
    const b = big('big-b');
    const other = big('big-c');
    const forged = {
      ...assigned([], [b]),
      deferred: [
        {
          manifest: Buffer.from(
            Buffer.from(other.manifest, 'base64').toString().replace('big-c', 'big-x'),
          ).toString('base64'),
          signature: other.signature,
        },
      ],
    };
    const out = verifyAssignedSkills(forged, 'codex', [pub]);
    expect(out.ok ? '' : out.message).toContain('bad_signature');
    const swapped = { ...assigned([], [b]), setHash: `sha256:${'0'.repeat(64)}` };
    const s = verifyAssignedSkills(swapped, 'codex', [pub]);
    expect(s.ok ? '' : s.message).toContain('pinned hash');
  });

  it('a lying master fails the job: changed bytes, extra bytes, refusals, endless answers', async () => {
    const b = big('big-b');
    const check = verifyAssignedSkills(assigned([], [b]), 'codex', [pub]);
    if (!check.ok) throw new Error(check.message);
    const changed = master([b], 64 * 1024, (p, d) =>
      p === 'reference.md' ? Buffer.from(`x${d.toString().slice(1)}`) : d,
    );
    await expect(fetchDeferredSkills(check.deferred, changed.request)).rejects.toThrow(/file_hash_mismatch/);
    const longer = master([b], 64 * 1024, (p, d) =>
      p === 'SKILL.md' ? Buffer.concat([d, Buffer.from('more')]) : d,
    );
    await expect(fetchDeferredSkills(check.deferred, longer.request)).rejects.toThrow(
      /longer than its manifest/,
    );
    await expect(
      fetchDeferredSkills(check.deferred, () => Promise.resolve({ status: 'refused' })),
    ).rejects.toThrow(/skill_fetch_failed.*refused/);
    await expect(
      fetchDeferredSkills(check.deferred, () =>
        Promise.resolve({ status: 'ok', data: Buffer.alloc(0), eof: false }),
      ),
    ).rejects.toThrow(/incomplete/);
  });

  it('a job above 640 KiB of skills is refused even if every skill is valid', () => {
    const many = ['a', 'b', 'c', 'd'].map((x) => big(`big-${x}`));
    const total = many.reduce(
      (n, b) => n + Object.values(b.files).reduce((m, c) => m + Buffer.byteLength(c), 0),
      0,
    );
    expect(total).toBeGreaterThan(MAX_JOB_SKILL_BYTES_V2);
    const out = verifyAssignedSkills(assigned([], many), 'codex', [pub]);
    expect(out.ok ? '' : out.message).toContain('limit');
  });
});
