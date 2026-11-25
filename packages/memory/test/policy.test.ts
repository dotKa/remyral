import { describe, expect, it } from 'vitest';
import {
  bundleLeaks,
  checkMemoryWrite,
  checkNamespacePolicy,
  defaultNamespacePolicy,
  isExpired,
  type NamespacePolicy,
  versionsToPrune,
} from '../src/policy.js';
import { projectCanRead, type ResolvableDocument } from '../src/model.js';
import { resolveBundle } from '../src/resolver.js';
import { doc } from './fixtures.js';

const P = (over: Partial<NamespacePolicy> = {}): NamespacePolicy => ({
  ...defaultNamespacePolicy('project:acme'),
  ...over,
});

describe('namespace policy validation', () => {
  it('accepts the default and rejects out-of-range values', () => {
    expect(checkNamespacePolicy(P())).toEqual([]);
    expect(checkNamespacePolicy(defaultNamespacePolicy('global'))).toEqual([]);
    const issues = checkNamespacePolicy(
      P({
        namespace: 'skill:x',
        maxAgeDays: 0,
        maxVersions: 1.5,
        deleteRetentionDays: 400,
        memory: { enabled: true, maxBytes: 10, maxPerJob: -1, maxPerHour: 99_999 },
      }),
    );
    expect(issues.map((i) => i.field).sort()).toEqual(
      [
        'deleteRetentionDays',
        'maxAgeDays',
        'maxVersions',
        'memory.maxBytes',
        'memory.maxPerHour',
        'memory.maxPerJob',
        'namespace',
      ].sort(),
    );
  });
});

describe('memory-write policy', () => {
  const ok = { contentBytes: 100, writesByJob: 0, writesLastHour: 0 };
  it('allows within limits and refuses in a fixed order', () => {
    expect(checkMemoryWrite(P(), ok)).toBeNull();
    expect(checkMemoryWrite(P({ memory: { ...P().memory, enabled: false } }), ok)).toBe(
      'agent_memory_disabled',
    );
    expect(checkMemoryWrite(P(), { ...ok, contentBytes: 16 * 1024 + 1 })).toBe('memory_too_large');
    expect(checkMemoryWrite(P(), { ...ok, writesByJob: 20 })).toBe('memory_job_quota');
    expect(checkMemoryWrite(P(), { ...ok, writesLastHour: 60 })).toBe('memory_rate_limited');
  });
});

describe('retention', () => {
  const now = new Date('2026-10-13T00:00:00Z');
  const old = { deletedAt: null, updatedAt: new Date('2026-01-01T00:00:00Z') };
  it('expires live documents past max age unless held or unlimited', () => {
    expect(isExpired(old, P({ maxAgeDays: 90 }), now)).toBe(true);
    expect(
      isExpired({ ...old, updatedAt: new Date('2026-10-01T00:00:00Z') }, P({ maxAgeDays: 90 }), now),
    ).toBe(false);
    expect(isExpired(old, P({ maxAgeDays: 90, legalHold: true }), now)).toBe(false);
    expect(isExpired(old, P(), now)).toBe(false);
    expect(isExpired({ ...old, deletedAt: now }, P({ maxAgeDays: 1 }), now)).toBe(false);
  });

  it('prunes all but the newest versions, keeping the current and pinned ones', () => {
    const versions = [1, 2, 3, 4, 5, 6];
    expect(versionsToPrune(versions, 6, P({ maxVersions: 3 }))).toEqual([1, 2, 3]);
    // Rolled back to 2: version 2 is current and survives.
    expect(versionsToPrune(versions, 2, P({ maxVersions: 3 }))).toEqual([1, 3]);
    expect(versionsToPrune(versions, 6, P({ maxVersions: 3 }), new Set([1]))).toEqual([2, 3]);
    expect(versionsToPrune(versions, 6, P({ maxVersions: 3, legalHold: true }))).toEqual([]);
    expect(versionsToPrune(versions, 6, P())).toEqual([]);
  });
});

/** Deterministic PRNG (mulberry32) so the property test is reproducible from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('cross-project leak check (property)', () => {
  const PROJECTS = ['acme', 'beta', 'gamma', 'delta'];

  function randomWorld(r: () => number): ResolvableDocument[] {
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
    const docs: ResolvableDocument[] = [];
    const n = 1 + Math.floor(r() * 25);
    for (let i = 0; i < n; i++) {
      const global = r() < 0.4;
      const listed = global && r() < 0.6;
      const grants = listed ? PROJECTS.filter(() => r() < 0.4) : [];
      docs.push(
        doc({
          namespace: global ? 'global' : `project:${pick(PROJECTS)}`,
          kind: pick(['instructions', 'memory', 'reference'] as const),
          projectScope: global ? (listed ? 'listed' : 'all') : 'own',
          grants,
          deleted: r() < 0.15,
          runtimes: r() < 0.3 ? ['codex'] : null,
        }),
      );
    }
    return docs;
  }

  it('a resolved bundle never contains a document the project cannot read (500 random worlds)', () => {
    const r = rng(0x5eed);
    for (let world = 0; world < 500; world++) {
      const docs = randomWorld(r);
      for (const project of PROJECTS) {
        const select = r() < 0.5 ? docs.filter(() => r() < 0.5).map((d) => d.doc.id) : undefined;
        const bundle = resolveBundle({
          project,
          runtime: r() < 0.5 ? 'codex' : 'pi',
          documents: docs,
          ...(select === undefined ? {} : { select }),
        });
        expect(bundleLeaks(bundle, docs)).toEqual([]);
        for (const item of bundle.items.slice(1)) {
          const d = docs.find((x) => x.doc.id === item.docId);
          expect(d !== undefined && projectCanRead(d.doc, project)).toBe(true);
        }
      }
    }
  });

  it('detects a foreign, ungranted, deleted or substituted document injected into a bundle', () => {
    const own = doc({ namespace: 'project:acme' });
    const foreign = doc({ namespace: 'project:beta' });
    const ungranted = doc({ namespace: 'global', projectScope: 'listed', grants: ['beta'] });
    const bundle = resolveBundle({ project: 'acme', runtime: 'codex', documents: [own] });
    expect(bundleLeaks(bundle, [own])).toEqual([]);
    // A bundle built for beta, presented as acme's.
    const forged = {
      ...resolveBundle({ project: 'beta', runtime: 'codex', documents: [foreign, ungranted] }),
      project: 'acme',
    };
    expect(bundleLeaks(forged, [foreign, ungranted]).map((f) => f.reason)).toEqual([
      'not_readable_by_project',
      'not_readable_by_project',
    ]);
    const deleted = { ...own, doc: { ...own.doc, deletedAt: new Date() } };
    expect(bundleLeaks(bundle, [deleted])).toMatchObject([{ reason: 'not_readable_by_project' }]);
    expect(bundleLeaks(bundle, [])).toMatchObject([{ reason: 'unknown_document' }]);
    const newer = { ...own, version: { ...own.version, version: 2 } };
    expect(bundleLeaks(bundle, [newer])).toMatchObject([{ reason: 'version_mismatch' }]);
  });
});
