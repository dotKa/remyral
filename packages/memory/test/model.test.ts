import { describe, expect, it } from 'vitest';
import {
  checkDocumentSettings,
  checkProvenance,
  checkVersionInput,
  LIMITS,
  normalizeText,
  parseNamespace,
  projectCanRead,
  userCanRead,
  userCanWrite,
  writeRoleFloor,
} from '../src/model.js';
import { scanForSecrets } from '../src/secrets.js';
import { CANARY, doc } from './fixtures.js';

describe('namespaces', () => {
  it('parses global, project and skill namespaces', () => {
    expect(parseNamespace('global')).toEqual({ type: 'global' });
    expect(parseNamespace('project:acme-1')).toEqual({ type: 'project', project: 'acme-1' });
    expect(parseNamespace('skill:lint')).toEqual({ type: 'skill', skill: 'lint' });
    for (const bad of ['', 'Global', 'project:', 'project:a b', 'team:x', `project:${'a'.repeat(129)}`]) {
      expect(parseNamespace(bad), bad).toBeNull();
    }
  });
});

const ok = {
  namespace: 'project:acme',
  kind: 'instructions' as const,
  readRole: 'viewer' as const,
  writeRole: 'operator' as const,
  projectScope: 'own' as const,
  grants: [] as string[],
};

describe('document settings', () => {
  it('accepts sane defaults', () => {
    expect(checkDocumentSettings(ok)).toEqual([]);
    expect(
      checkDocumentSettings({ ...ok, namespace: 'global', writeRole: 'admin', projectScope: 'all' }),
    ).toEqual([]);
    expect(
      checkDocumentSettings({
        ...ok,
        namespace: 'global',
        writeRole: 'owner',
        projectScope: 'listed',
        grants: ['acme', 'beta'],
      }),
    ).toEqual([]);
  });

  it('enforces write-role floors: admin for global, operator for projects, never viewer', () => {
    expect(writeRoleFloor({ type: 'global' })).toBe('admin');
    expect(checkDocumentSettings({ ...ok, writeRole: 'viewer' })).toContainEqual({
      field: 'writeRole',
      code: 'below_floor',
    });
    expect(
      checkDocumentSettings({ ...ok, namespace: 'global', writeRole: 'operator', projectScope: 'all' }),
    ).toContainEqual({ field: 'writeRole', code: 'below_floor' });
  });

  it('rejects inconsistent scopes, skill namespaces and read above write', () => {
    const codes = (s: Parameters<typeof checkDocumentSettings>[0]) =>
      checkDocumentSettings(s).map((v) => `${v.field}:${v.code}`);
    expect(codes({ ...ok, projectScope: 'all' })).toContain('projectScope:project_docs_are_own');
    expect(codes({ ...ok, grants: ['x'] })).toContain('projects:project_docs_have_no_grants');
    expect(codes({ ...ok, namespace: 'global', writeRole: 'admin' })).toContain(
      'projectScope:invalid_for_global',
    );
    expect(
      codes({ ...ok, namespace: 'global', writeRole: 'admin', projectScope: 'all', grants: ['a'] }),
    ).toContain('projects:grants_need_listed_scope');
    expect(
      codes({ ...ok, namespace: 'global', writeRole: 'admin', projectScope: 'listed', grants: ['a b'] }),
    ).toContain('projects:invalid_format');
    expect(codes({ ...ok, namespace: 'skill:x' })).toEqual(['namespace:skill_requires_signed_bundle']);
    // p6-skills: the skills service writes signed skill documents (instructions, admin, own scope).
    const skill = {
      ...ok,
      namespace: 'skill:release-notes',
      kind: 'instructions' as const,
      writeRole: 'admin' as const,
    };
    expect(checkDocumentSettings(skill, { signedSkill: true })).toEqual([]);
    expect(codes({ ...skill, writeRole: 'operator' })).toEqual(['namespace:skill_requires_signed_bundle']);
    expect(
      checkDocumentSettings({ ...skill, writeRole: 'operator', kind: 'memory' }, { signedSkill: true }).map(
        (v) => `${v.field}:${v.code}`,
      ),
    ).toEqual(['kind:skills_are_instructions']);
    expect(
      checkDocumentSettings({ ...skill, writeRole: 'operator' }, { signedSkill: true }).map(
        (v) => `${v.field}:${v.code}`,
      ),
    ).toEqual(['writeRole:below_floor']);
    expect(codes({ ...ok, readRole: 'admin' })).toContain('readRole:above_write_role');
    expect(codes({ ...ok, namespace: 'nope' })).toEqual(['namespace:invalid_format']);
  });
});

describe('version input', () => {
  const v = { title: 'Rules', content: 'Use pnpm.', changeNote: null, sortOrder: 0, runtimes: null };
  it('validates limits and runtimes', () => {
    expect(checkVersionInput(v)).toEqual([]);
    const codes = (x: Partial<typeof v> & Record<string, unknown>) =>
      checkVersionInput({ ...v, ...x }).map((i) => `${i.field}:${i.code}`);
    expect(codes({ title: ' ' })).toContain('title:required');
    expect(codes({ title: 'a\nb' })).toContain('title:control_characters');
    expect(codes({ content: 'x'.repeat(LIMITS.contentBytes + 1) })).toContain('content:too_large');
    expect(codes({ runtimes: [] as never })).toContain('runtimes:empty');
    expect(codes({ runtimes: ['vim'] as never })).toContain('runtimes:unknown_runtime');
    expect(codes({ runtimes: ['pi', 'pi'] as never })).toContain('runtimes:duplicate');
    expect(codes({ sortOrder: 1.5 })).toContain('sortOrder:invalid');
  });

  it('normalises line endings and NULs', () => {
    expect(normalizeText('a\r\nb\rc\u0000d')).toBe('a\nb\ncd');
  });
});

describe('provenance', () => {
  const agent = { type: 'agent' as const, jobId: 'j', attemptId: 'a', workerId: 'w' };
  it('agents may only write memory in their own project', () => {
    expect(checkProvenance(agent, 'memory', 'project:acme', 'acme')).toEqual([]);
    expect(checkProvenance(agent, 'instructions', 'project:acme', 'acme')).toContainEqual({
      field: 'kind',
      code: 'agents_write_memory_only',
    });
    expect(checkProvenance(agent, 'memory', 'global', 'acme')).toContainEqual({
      field: 'namespace',
      code: 'agents_write_own_project_only',
    });
    expect(checkProvenance(agent, 'memory', 'project:other', 'acme')).toHaveLength(1);
    expect(checkProvenance({ type: 'platform' }, 'memory', 'project:acme')).toHaveLength(1);
    expect(checkProvenance({ type: 'user', userId: 'u' }, 'instructions', 'global')).toEqual([]);
  });
});

describe('permissions', () => {
  it('project and role checks', () => {
    const p = doc({ namespace: 'project:acme' }).doc;
    expect(projectCanRead(p, 'acme')).toBe(true);
    expect(projectCanRead(p, 'acme2')).toBe(false);
    const g = doc({ namespace: 'global', projectScope: 'listed', grants: ['beta'] }).doc;
    expect(projectCanRead(g, 'beta')).toBe(true);
    expect(projectCanRead(g, 'acme')).toBe(false);
    expect(projectCanRead(doc({ namespace: 'global', deleted: true }).doc, 'acme')).toBe(false);
    expect(userCanRead({ readRole: 'operator' }, 'viewer')).toBe(false);
    expect(userCanRead({ readRole: 'operator' }, 'admin')).toBe(true);
    expect(userCanWrite({ writeRole: 'operator' }, 'operator')).toBe(true);
    expect(userCanWrite({ writeRole: 'viewer' }, 'viewer')).toBe(false);
    expect(userCanWrite({ writeRole: 'admin' }, 'operator')).toBe(false);
  });
});

describe('scanForSecrets', () => {
  it('reports field, line, column and rule, never the value', () => {
    const content = `Line one\nUse key ${CANARY.anthropic} for calls`;
    const findings = scanForSecrets({ content, title: 'clean', changeNote: null });
    expect(findings).toEqual([{ field: 'content', line: 2, column: 9, rule: 'anthropic-key' }]);
    expect(JSON.stringify(findings)).not.toContain(CANARY.anthropic);
  });

  it('finds PEM blocks, GitHub tokens and password assignments in any field', () => {
    const findings = scanForSecrets({
      title: `token ${CANARY.github}`,
      content: `${CANARY.pemBegin}\nMIIEow...`,
      changeNote: 'DB_PASSWORD=hunter2hunter2',
    });
    expect(findings.map((f) => `${f.field}:${f.rule}`).sort()).toEqual([
      'changeNote:secret-assignment',
      'content:pem-private-key',
      'title:github-token',
    ]);
  });

  it('accepts ordinary instructions', () => {
    expect(
      scanForSecrets({
        content: 'Never print secrets. Use the `token` from the keystore; run pnpm verify before pushing.',
      }),
    ).toEqual([]);
  });
});
