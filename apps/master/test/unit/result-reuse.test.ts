import { describe, expect, it } from 'vitest';
import {
  ageText,
  inputsDigest,
  normalisePrompt,
  promptDigest,
  workflowStepPromptDigest,
} from '../../src/reuse/digest.js';

/** p6-result-reuse (docs/design/p6-result-reuse.md §2): the digests that decide "the same job". */
describe('result reuse digests', () => {
  it('normalises case, whitespace runs and Unicode form; nothing else', () => {
    expect(normalisePrompt('  Fix\tthe\n\nREADME  ')).toBe('fix the readme');
    // NFC: a precomposed and a decomposed "é" are one prompt.
    expect(promptDigest('café menu')).toBe(promptDigest('café MENU'));
    expect(promptDigest('Fix the README')).toBe(promptDigest(' fix   the readme\n'));
    expect(promptDigest('Fix the README')).not.toBe(promptDigest('Fix the README.'));
    expect(promptDigest('fix the readme')).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('masks the run id of a workflow step so runs of the same step match', () => {
    const a = workflowStepPromptDigest(
      'You are step "docs" (run 11111111-aaaa). Docs for 11111111-aaaa',
      '11111111-aaaa',
    );
    const b = workflowStepPromptDigest(
      'You are step "docs" (run 22222222-bbbb). Docs for 22222222-bbbb',
      '22222222-bbbb',
    );
    expect(a).toBe(b);
    expect(a).not.toBe(promptDigest('You are step "docs" (run 11111111-aaaa). Docs for 11111111-aaaa'));
  });

  it('digests inputs by name and content, independent of order', () => {
    const x = { name: 'a.csv', sha256: '1'.repeat(64) };
    const y = { name: 'b.csv', sha256: '2'.repeat(64) };
    expect(inputsDigest([x, y])).toBe(inputsDigest([y, x]));
    expect(inputsDigest([x, y])).not.toBe(inputsDigest([x]));
    expect(inputsDigest([x])).not.toBe(inputsDigest([{ ...x, name: 'c.csv' }]));
    expect(inputsDigest([x])).not.toBe(inputsDigest([{ ...x, sha256: '3'.repeat(64) }]));
    expect(inputsDigest([])).not.toBe(promptDigest(''));
  });

  it('words the age of an earlier result', () => {
    expect(ageText(10_000)).toBe('just now');
    expect(ageText(35 * 60_000)).toBe('35 min ago');
    expect(ageText(2 * 3_600_000 + 5 * 60_000)).toBe('2 h ago');
    expect(ageText(72 * 3_600_000)).toBe('3 days ago');
    expect(ageText(-5)).toBe('just now');
  });
});
