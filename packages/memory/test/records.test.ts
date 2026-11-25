import { STEP_OUTCOME_NOTE } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import {
  bundleHashOf,
  checkEvidence,
  checkRecordFields,
  checkTypeScope,
  composeRecordContent,
  contradiction,
  formatRecordScope,
  MEMORY_PROPOSAL_NOTE,
  parseRecordScope,
  renderBundle,
  renderJobContext,
  resolveBundle,
  RUNTIME_KINDS,
  scopeTarget,
  statementSimilarity,
} from '../src/index.js';
import { doc } from './fixtures.js';

const USER = '00000000-0000-4000-8000-00000000aaaa';
const OTHER = '00000000-0000-4000-8000-00000000bbbb';

describe('record scopes (p11-memory-layers)', () => {
  it('parses and formats every scope; maps it to a namespace and runtime filter', () => {
    for (const s of ['global', 'runtime:codex', `user:${USER}`, 'project:acme', 'project:acme+runtime:pi']) {
      const parsed = parseRecordScope(s);
      expect(parsed, s).not.toBeNull();
      if (parsed !== null) expect(formatRecordScope(parsed)).toBe(s);
    }
    expect(parseRecordScope('runtime:openhands')).toBeNull();
    expect(parseRecordScope('user:not-a-uuid')).toBeNull();
    expect(parseRecordScope('project:a b')).toBeNull();
    expect(scopeTarget({ type: 'project', project: 'acme', runtime: 'codex' })).toEqual({
      namespace: 'project:acme',
      runtimes: ['codex'],
    });
    expect(scopeTarget({ type: 'global', runtime: 'pi' })).toEqual({ namespace: 'global', runtimes: ['pi'] });
    expect(scopeTarget({ type: 'user', user: USER })).toEqual({ namespace: `user:${USER}`, runtimes: null });
  });

  it('personal scope holds rules only; decisions are never runtime-specific', () => {
    expect(checkTypeScope('fact', { type: 'user', user: USER })).toEqual([
      { field: 'scope', code: 'user_scope_is_rules_only' },
    ]);
    expect(checkTypeScope('rule', { type: 'user', user: USER })).toEqual([]);
    expect(checkTypeScope('decision', { type: 'project', project: 'a', runtime: 'codex' })).toHaveLength(1);
    expect(checkTypeScope('lesson', { type: 'project', project: 'a', runtime: 'codex' })).toEqual([]);
  });

  it('validates fields: decision-only fields, dates, evidence refs', () => {
    expect(checkRecordFields({ type: 'fact', statement: 'x', consequences: 'y' })).toEqual([
      { field: 'consequences', code: 'decisions_only' },
    ]);
    expect(checkRecordFields({ type: 'decision', statement: 'x', decidedAt: '2026-13-40' })).toEqual([
      { field: 'decidedAt', code: 'invalid_date' },
    ]);
    expect(checkRecordFields({ type: 'rule', statement: '   ' })).toEqual([
      { field: 'statement', code: 'required' },
    ]);
    expect(checkEvidence([{ kind: 'adr', ref: 'docs/adr/0043-memory-layers.md' }])).toEqual([]);
    expect(checkEvidence([{ kind: 'adr', ref: '../../etc/passwd.md' }])).toHaveLength(1);
    expect(checkEvidence([{ kind: 'url', ref: 'http://insecure.example' }])).toHaveLength(1);
    expect(checkEvidence([{ kind: 'job', ref: USER }])).toEqual([]);
  });

  it('composes the injected text deterministically', () => {
    expect(
      composeRecordContent({ type: 'rule', statement: 'Use pnpm.', rationale: 'The lockfile is pnpm.' }),
    ).toBe('Use pnpm.\nWhy: The lockfile is pnpm.');
    expect(
      composeRecordContent({
        type: 'decision',
        statement: 'Deploy with Coolify',
        rationale: 'One host',
        consequences: 'No Vercel',
        decidedAt: '2026-10-19',
        decidedBy: 'Alex',
      }),
    ).toBe(
      'Decision: Deploy with Coolify\nContext: One host\nConsequences: No Vercel\nDecided: 2026-10-19 by Alex',
    );
  });
});

describe('conflict heuristics', () => {
  it('negation, a different tool of one family, a different value; unrelated stays null', () => {
    expect(
      contradiction('Always run the e2e suite before merging', 'Never run the e2e suite before merging'),
    ).toBe('negation');
    expect(
      contradiction('This repository uses pnpm for installs', 'This repository uses yarn for installs'),
    ).toBe('different_choice');
    expect(contradiction('The brand primary colour is #FF5A1F', 'The brand primary colour is #00AAFF')).toBe(
      'different_value',
    );
    expect(contradiction('Use pnpm for installs', 'The staging host is in Frankfurt')).toBeNull();
    expect(statementSimilarity('Use pnpm for installs', 'use pnpm for installs!')).toBe(1);
  });
});

describe('typed bundles: precedence, budget priority, user rules, identical rendering', () => {
  const globalRule = doc({ namespace: 'global', kind: 'instructions', content: 'G rule' });
  const userRule = doc({ namespace: `user:${USER}`, kind: 'instructions', content: 'U rule' });
  const otherUserRule = doc({ namespace: `user:${OTHER}`, kind: 'instructions', content: 'other user rule' });
  const projectRule = doc({ kind: 'instructions', content: 'P rule' });
  const decision = doc({ kind: 'memory', content: 'D'.repeat(40) });
  const fact = doc({ kind: 'memory', content: 'F'.repeat(40) });
  const legacy = doc({ kind: 'memory', content: 'L'.repeat(40) });
  const lessonCodex = doc({ kind: 'memory', content: 'X'.repeat(40), runtimes: ['codex'] });
  const typed = [
    globalRule,
    { ...userRule, recordType: 'rule' as const },
    { ...otherUserRule, recordType: 'rule' as const },
    { ...projectRule, recordType: 'rule' as const },
    { ...decision, recordType: 'decision' as const },
    { ...fact, recordType: 'fact' as const },
    legacy,
    { ...lessonCodex, recordType: 'lesson' as const },
  ];

  it('orders global rules → the creator’s rules → project rules → decisions → facts → runtime lessons', () => {
    const b = resolveBundle({ project: 'acme', runtime: 'codex', documents: typed, user: USER });
    expect(b.items.map((i) => [i.layer, i.docId, i.recordType ?? null])).toEqual([
      ['platform', 'platform-policy', null],
      ['global', globalRule.doc.id, null],
      ['user', userRule.doc.id, 'rule'],
      ['project', projectRule.doc.id, 'rule'],
      ['memory', decision.doc.id, 'decision'],
      ['memory', fact.doc.id, 'fact'],
      ['memory', legacy.doc.id, null],
      ['memory', lessonCodex.doc.id, 'lesson'],
    ]);
    // Never another person's rules; none at all without a creator; runtime lessons only for their runtime.
    expect(b.items.some((i) => i.docId === otherUserRule.doc.id)).toBe(false);
    const noUser = resolveBundle({ project: 'acme', runtime: 'pi', documents: typed });
    expect(noUser.items.some((i) => i.layer === 'user')).toBe(false);
    expect(noUser.items.some((i) => i.docId === lessonCodex.doc.id)).toBe(false);
  });

  it('fills the budget by priority (decision > fact > lesson), relevance first inside a type', () => {
    const b = resolveBundle({
      project: 'acme',
      runtime: 'codex',
      documents: typed,
      user: USER,
      memoryBudgetBytes: 80,
    });
    expect(b.items.filter((i) => i.layer === 'memory').map((i) => i.docId)).toEqual([
      decision.doc.id,
      fact.doc.id,
    ]);
    expect(b.omitted.map((o) => o.docId).sort()).toEqual([legacy.doc.id, lessonCodex.doc.id].sort());
    // The more relevant fact wins the last slot; the output order does not depend on relevance.
    const ranked = typed.map((d) =>
      d.doc.id === legacy.doc.id
        ? { ...d, relevance: 0.9 }
        : d.doc.id === fact.doc.id
          ? { ...d, relevance: 0.1 }
          : d,
    );
    const r = resolveBundle({
      project: 'acme',
      runtime: 'codex',
      documents: ranked,
      user: USER,
      memoryBudgetBytes: 80,
    });
    expect(r.items.filter((i) => i.layer === 'memory').map((i) => i.docId)).toEqual([
      decision.doc.id,
      legacy.doc.id,
    ]);
  });

  it('hashes the record type only for typed items (untyped bundles keep the p6 hash)', () => {
    const plain = resolveBundle({ project: 'acme', runtime: 'codex', documents: [projectRule, fact] });
    expect(plain.bundleHash).toBe(bundleHashOf(plain.items));
    const asRecords = resolveBundle({
      project: 'acme',
      runtime: 'codex',
      documents: [
        { ...projectRule, recordType: 'rule' },
        { ...fact, recordType: 'fact' },
      ],
    });
    expect(asRecords.bundleHash).not.toBe(plain.bundleHash);
    expect(plain.items.every((i) => i.recordType === undefined)).toBe(true);
  });

  it('renders byte-identically for all four runtimes (only runtime-scoped records differ)', () => {
    const shared = typed.filter((d) => d.doc.id !== lessonCodex.doc.id);
    const texts = RUNTIME_KINDS.map((runtime) =>
      renderJobContext(resolveBundle({ project: 'acme', runtime, documents: shared, user: USER })),
    );
    expect(texts).toHaveLength(4);
    for (const t of texts) expect(t).toBe(texts[0]);
    expect(texts[0]).toContain(MEMORY_PROPOSAL_NOTE);
    // p22-run-attention: every job is told how to say it could not do the task.
    expect(texts[0]).toContain(`Reporting the outcome: ${STEP_OUTCOME_NOTE}`);
    expect(texts[0]).toContain(' type=decision ');
    expect(renderBundle(resolveBundle({ project: 'acme', runtime: 'pi', documents: [fact] }))).not.toContain(
      'type=',
    );
  });
});
