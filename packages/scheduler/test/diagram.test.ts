import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toMarkdownTable, toMermaid, TRANSITIONS } from '../src/index.js';

const DOC = new URL('../../../docs/design/p4-job-state-machine.md', import.meta.url);
const BEGIN = '<!-- BEGIN GENERATED: pnpm --filter @remyral/scheduler docs:diagram -->';
const END = '<!-- END GENERATED -->';

function generatedSection(): string {
  return `${BEGIN}\n\n\`\`\`mermaid\n${toMermaid()}\`\`\`\n\n${toMarkdownTable()}\n${END}`;
}

describe('state machine documentation', () => {
  it('renders one labelled edge per transition', () => {
    const mermaid = toMermaid();
    expect(mermaid.startsWith('stateDiagram-v2\n  [*] --> DRAFT\n')).toBe(true);
    for (const r of TRANSITIONS) {
      expect(mermaid).toMatch(new RegExp(`^  ${r.from} --> ${r.to}: .*\\b${r.trigger}\\b`, 'm'));
    }
    for (const t of ['SUCCEEDED', 'FAILED', 'CANCELLED']) expect(mermaid).toContain(`  ${t} --> [*]`);
    expect(toMermaid()).toBe(mermaid);
  });

  it('docs/design/p4-job-state-machine.md is up to date (regenerate with docs:diagram)', () => {
    const doc = readFileSync(DOC, 'utf8');
    const start = doc.indexOf(BEGIN);
    const end = doc.indexOf(END);
    expect(start, 'generated-section markers missing').toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const current = doc.slice(start, end + END.length);
    const expected = generatedSection();
    if (current !== expected && process.env.UPDATE_STATE_DIAGRAM === '1') {
      writeFileSync(DOC, doc.slice(0, start) + expected + doc.slice(end + END.length));
      return;
    }
    expect(current).toBe(expected);
  });
});
