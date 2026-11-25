import { describe, expect, it } from 'vitest';
import { runtimeApprovalDetails, shellOfTool } from '../src/approval-details.js';
import { ocApprovalDetails } from '../src/runtimes/opencode/events.js';
import { SecretValue } from '../src/secrets.js';

/** p10-approval-readable: the adapter half (docs/design/p10-approval-readable.md §2). */
describe('runtimeApprovalDetails', () => {
  const secrets = { GH_TOKEN: new SecretValue('ghp_canary_000111') };

  it('redacts the job secret values in every field', () => {
    const d = runtimeApprovalDetails(
      'Bash',
      {
        command: 'curl -H "Authorization: token ghp_canary_000111" https://api.github.com',
        description: 'call with ghp_canary_000111',
        cwd: '/w/ghp_canary_000111',
      },
      secrets,
      { shell: 'posix' },
    );
    expect(JSON.stringify(d)).not.toContain('ghp_canary_000111');
    expect(d?.command).toContain('https://api.github.com');
  });

  it('undefined when the input names nothing beyond the tool (the master falls back to the summary)', () => {
    expect(runtimeApprovalDetails('Task', { prompt: 'x' }, {})).toBeUndefined();
    expect(runtimeApprovalDetails('bash', '{"command":"echo cut', {})).toBeUndefined();
  });

  it("Pi's gate input is JSON text cut at 4000 characters: a cut text yields no half-parsed command", () => {
    const cut = JSON.stringify({ command: `echo ${'x'.repeat(5000)}` }).slice(0, 4000);
    expect(runtimeApprovalDetails('bash', cut, {})).toBeUndefined();
  });

  it('shell by tool name', () => {
    expect(shellOfTool('Bash')).toBe('posix');
    expect(shellOfTool('PowerShell')).toBe('powershell');
    expect(shellOfTool('Edit')).toBeUndefined();
  });
});

describe('ocApprovalDetails (OpenCode permission.asked)', () => {
  it('bash: command and description from metadata', () => {
    expect(
      ocApprovalDetails(
        {
          permission: 'bash',
          patterns: ['npm *'],
          metadata: { command: 'npm i', description: 'install deps' },
        },
        {},
        '/w',
      ),
    ).toEqual({
      tool: 'bash',
      description: 'install deps',
      command: 'npm i',
      shell: 'posix',
      workspaceRoot: '/w',
    });
  });

  it('edit: the file path(s), no command; webfetch: the url', () => {
    expect(
      ocApprovalDetails(
        { permission: 'edit', patterns: ['src/a.ts'], metadata: { filepath: '/w/src/a.ts' } },
        {},
      ),
    ).toEqual({ tool: 'edit', paths: ['/w/src/a.ts', 'src/a.ts'] });
    expect(
      ocApprovalDetails(
        { permission: 'webfetch', patterns: ['*'], metadata: { url: 'https://x.dev/a' } },
        {},
      ),
    ).toEqual({ tool: 'webfetch', url: 'https://x.dev/a' });
  });
});
