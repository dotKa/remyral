import { describe, expect, it } from 'vitest';
import {
  detailsToStore,
  detailsView,
  eventHints,
  headlineSentence,
  storedDetails,
} from '../../src/approvals/details.js';
import { approvalFingerprint } from '../../src/approvals/service.js';

/** p10-approval-readable, master half (docs/design/p10-approval-readable.md §3). */
const TOKEN = `ghp_${'Zx9Qw8Er7Ty6'.repeat(3)}`;

describe('detailsToStore', () => {
  it('validates, pattern-redacts every field and keeps newlines in the command', () => {
    const d = detailsToStore({
      tool: 'Bash',
      description: `push with ${TOKEN}`,
      command: `git push https://x:${TOKEN}@github.com/a/b.git\necho done`,
      shell: 'posix',
      paths: [`/tmp/${TOKEN}`],
    });
    expect(JSON.stringify(d)).not.toContain(TOKEN);
    expect(d?.command).toContain('\necho done');
    expect(d?.description?.startsWith('push with ')).toBe(true);
  });

  it('refuses an invalid shape (null), keeps nothing from it', () => {
    expect(detailsToStore({ tool: 'Bash', command: 42 })).toBeNull();
    expect(detailsToStore({ command: 'ls' })).toBeNull();
    expect(detailsToStore({ tool: 'Bash', command: 'x'.repeat(20_000) })).toBeNull();
    expect(detailsToStore('Bash: ls')).toBeNull();
    expect(detailsToStore(undefined)).toBeNull();
  });

  it('a details object that names nothing beyond the tool is not stored', () => {
    expect(detailsToStore({ tool: 'Bash', command: '   ' })).toBeNull();
  });

  it('makes invisible characters visible again (a worker that skipped it)', () => {
    expect(detailsToStore({ tool: 'Bash', command: 'echo a‮b' })?.command).toBe('echo a⟨U+202E⟩b');
  });
});

describe('storedDetails / detailsView (old and new rows)', () => {
  it('an old row (NULL) shows the summary as headline, no hints', () => {
    expect(storedDetails(null)).toBeNull();
    expect(detailsView(null, 'PowerShell: {"command":"x"}')).toEqual({
      details: null,
      hints: null,
      headline: { text: 'PowerShell: {"command":"x"}', source: 'summary' },
    });
  });

  it('a new row: description headline (agent), hints from the command', () => {
    const v = detailsView(
      storedDetails({
        tool: 'PowerShell',
        description: 'Take a screenshot',
        command: 'New-Item -ItemType Directory -Force out/v; & chrome.exe --headless=new https://a.example',
        shell: 'powershell',
      }),
      'ignored',
    );
    expect(v.headline).toEqual({ text: 'Take a screenshot', source: 'agent' });
    expect(v.hints?.runs).toEqual(['New-Item', 'chrome.exe']);
    expect(v.hints?.reaches).toEqual(['https://a.example']);
    expect(v.hints?.writes).toEqual(['out/v']);
  });

  it('a stored row of an unexpected shape is ignored, not trusted', () => {
    expect(storedDetails({ tool: 'x', paths: 'not-a-list' })).toBeNull();
  });

  it('live events: hints from the payload details, null without', () => {
    expect(eventHints({ details: { tool: 'Bash', command: 'rm -rf build' } })?.deletes).toEqual(['build']);
    expect(eventHints({ description: 'x' })).toBeNull();
  });
});

describe('headlineSentence (notifications, chat)', () => {
  it('labels the agent claim; never repeats the legacy summary', () => {
    expect(headlineSentence({ text: 'Run whoami', source: 'agent' })).toBe(
      'The agent says (unverified): “Run whoami”',
    );
    expect(headlineSentence({ text: 'Bash: make', source: 'command' })).toBe('Command: Bash: make');
    expect(headlineSentence({ text: 'secret summary', source: 'summary' })).toBeNull();
    expect(headlineSentence({ text: 'x'.repeat(500), source: 'agent' })?.length).toBeLessThan(200);
  });
});

describe('approvalFingerprint', () => {
  it('binds the full command when present; unchanged for requests without one', () => {
    const old = approvalFingerprint('runtime.dangerous_tool', 'Bash', 's');
    expect(approvalFingerprint('runtime.dangerous_tool', 'Bash', 's', undefined)).toBe(old);
    expect(approvalFingerprint('runtime.dangerous_tool', 'Bash', 's', 'rm a')).not.toBe(old);
    expect(approvalFingerprint('runtime.dangerous_tool', 'Bash', 's', 'rm a')).not.toBe(
      approvalFingerprint('runtime.dangerous_tool', 'Bash', 's', 'rm b'),
    );
  });
});
