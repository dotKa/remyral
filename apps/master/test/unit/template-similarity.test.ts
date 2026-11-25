import { describe, expect, it } from 'vitest';
import {
  groupItems,
  inferTemplate,
  minhash,
  shingles,
  similarity,
  type SourceItem,
  suggest,
  suggestionId,
  tokenize,
} from '../../src/templates/similarity.js';

let n = 0;
function item(prompt: string, extra: Partial<SourceItem> = {}): SourceItem {
  n++;
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return {
    key: `job:${id}`,
    kind: 'job',
    id,
    project: 'genel',
    prompt,
    title: prompt.slice(0, 40),
    createdAt: `2026-10-${String(10 + (n % 5)).padStart(2, '0')}T10:00:${String(n % 60).padStart(2, '0')}Z`,
    runtime: 'claude-code',
    model: null,
    sandboxProfile: 'container',
    approvalPolicy: 'ask-sensitive',
    ...extra,
  };
}

const LANDING = (url: string): string =>
  `Hedef kitle analizi yap ve ${url} için bir landing page taslağı hazırla. Sonucu site/ klasörüne yaz.`;

describe('template similarity (p8-templates)', () => {
  it('URLs and numbers collapse to one class, so prompts that differ only there are identical', () => {
    const a = minhash(shingles(tokenize(LANDING('https://a.example'))));
    const b = minhash(shingles(tokenize(LANDING('https://b.example/x?y=1'))));
    const c = minhash(shingles(tokenize('Write release notes for version 2 of the CLI and post them.')));
    expect(similarity(a, b)).toBe(1);
    expect(similarity(a, c)).toBeLessThan(0.2);
  });

  it('groups a recurring pattern (3×) and ignores unrelated and other-project prompts', () => {
    const items = [
      item(LANDING('https://a.example')),
      item('Fix the flaky login test in apps/web.'),
      item(LANDING('https://b.example')),
      item(LANDING('https://c.example')),
      item(LANDING('https://d.example'), { project: 'other' }),
      item('Summarise yesterday’s failed jobs.'),
    ];
    const groups = groupItems(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.project).toBe('genel');
    expect(groups[0]?.members).toHaveLength(3);
    // Deterministic: same input, same output (also when shuffled).
    expect(groupItems([...items].reverse())).toEqual(groups);
  });

  it('"not similar" feedback keeps those items apart', () => {
    const items = [
      item(LANDING('https://a.example')),
      item(LANDING('https://b.example')),
      item(LANDING('https://c.example')),
    ];
    expect(groupItems(items, { notSimilar: [[items[0]?.key ?? '', items[1]?.key ?? '']] })).toEqual([]);
  });

  it('infers a template with typed parameters from the varying spans', () => {
    const items = [
      item(`${LANDING('https://a.example')} Hedef: 200 kişi, ton resmi.`),
      item(`${LANDING('https://b.example')} Hedef: 500 kişi, ton samimi.`),
      item(`${LANDING('https://c.example')} Hedef: 300 kişi, ton resmi.`),
      item(`${LANDING('https://d.example')} Hedef: 50 kişi, ton resmi.`),
    ];
    const [g] = groupItems(items, { threshold: 0.5, medoidThreshold: 0.4 });
    expect(g).toBeDefined();
    if (g === undefined) return;
    const t = inferTemplate(g);
    expect(t?.parameters.map((p) => `${p.name}:${p.type}`)).toEqual(['url:url', 'count:int', 'ton:enum']);
    expect(t?.prompt).toContain('{{url}} için bir landing page');
    expect(t?.prompt).toContain('Hedef: {{count}} kişi, ton {{ton}}.');
    expect(t?.parameters[2]?.options).toEqual(['resmi', 'samimi']);
  });

  it('suggestions carry a stable id, members, occurrences and majority defaults', () => {
    const items = [
      item(LANDING('https://a.example')),
      item(LANDING('https://b.example'), { runtime: 'codex' }),
      item(LANDING('https://c.example')),
    ];
    const [s] = suggest(items);
    expect(s?.occurrences).toBe(3);
    expect(s?.defaults.runtime).toBe('claude-code');
    expect(s?.prompt).toBe(LANDING('{{url}}'));
    expect(s?.id).toBe(suggestionId('genel', LANDING('{{url}}')));
    expect(s?.members.map((m) => m.kind)).toEqual(['job', 'job', 'job']);
  });

  it('identical prompts make no template (nothing varies)', () => {
    expect(
      suggest([
        item('Run the nightly report'),
        item('Run the nightly report'),
        item('Run the nightly report'),
      ]),
    ).toEqual([]);
  });
});
