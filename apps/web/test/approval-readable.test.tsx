import { describe, expect, it } from 'vitest';
import { parseApprovalDetails, parseApprovalHeadline, parseApprovalHints } from '../src/api/approvalDetails';

/** p10-approval-readable: the readable approval card, inbox rows and the parsers (docs/design/p10-approval-readable.md §5). */

describe('approval detail parsers', () => {
  it('old master shape: no details / hints, headline from the summary', () => {
    expect(parseApprovalDetails(undefined)).toBeNull();
    expect(parseApprovalHints(undefined)).toBeNull();
    expect(parseApprovalHeadline(undefined, null, 'Bash: x')).toEqual({ text: 'Bash: x', source: 'summary' });
  });

  it('drops wrong types instead of failing the page', () => {
    expect(parseApprovalDetails({ tool: 'Bash', command: 5, paths: ['a', 3], shell: 'zsh' })).toEqual({
      tool: 'Bash',
      paths: ['a'],
    });
    expect(parseApprovalDetails({ command: 'x' })).toBeNull();
    expect(parseApprovalHints({ runs: 'x', elevated: 'yes' })?.runs).toEqual([]);
  });
});
