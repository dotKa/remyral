import { describe, expect, it } from 'vitest';
import { MAX_STEP_OUTCOME_NOTE, parseStepOutcome } from '../src/index.js';

describe('parseStepOutcome (p22-run-attention)', () => {
  it('reads partial / none with their note, in the usual separators and markup', () => {
    expect(parseStepOutcome('Did half.\nOUTCOME: partial — batch 2 input was cut off')).toEqual({
      kind: 'partial',
      note: 'batch 2 input was cut off',
    });
    expect(parseStepOutcome('- **OUTCOME:** none - the gateway answer was truncated')).toEqual({
      kind: 'none',
      note: 'the gateway answer was truncated',
    });
    expect(parseStepOutcome('OUTCOME: NONE')).toEqual({ kind: 'none', note: '' });
  });

  it('is null without the line, for ok/done, inside code fences and for prose mentions', () => {
    expect(parseStepOutcome('All 280 leads updated.')).toBeNull();
    expect(parseStepOutcome('OUTCOME: ok')).toBeNull();
    expect(parseStepOutcome('```\nOUTCOME: none — example\n```')).toBeNull();
    expect(parseStepOutcome('The outcome: none of them changed.')).toBeNull();
    expect(parseStepOutcome('Outcome: none of them changed.')).toBeNull();
    expect(parseStepOutcome('OUTCOME: maybe — unsure')).toBeNull();
  });

  it('the last line wins, and the note is bounded', () => {
    expect(parseStepOutcome('OUTCOME: none — first\nfixed it\nOUTCOME: done')).toBeNull();
    expect(parseStepOutcome('OUTCOME: none — a\nOUTCOME: partial — b')).toEqual({
      kind: 'partial',
      note: 'b',
    });
    const long = parseStepOutcome(`OUTCOME: partial — ${'x'.repeat(1000)}`);
    expect(long?.note.length).toBe(MAX_STEP_OUTCOME_NOTE);
  });
});
