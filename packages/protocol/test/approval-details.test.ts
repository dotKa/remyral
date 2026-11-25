import { describe, expect, it } from 'vitest';
import {
  APPROVAL_DETAIL_LIMITS,
  approvalHeadline,
  approvalHints,
  commandFromArgv,
  extractApprovalDetails,
  formatCommand,
  hasApprovalDetails,
  splitCommand,
} from '../src/approval-details.js';
import { AgentEvent, ApprovalDetailsSchema } from '../src/worker-messages.js';

/** The owner's example (p10-approval-readable): a PowerShell one-liner that ran a headless browser. */
const OWNER_PS = [
  '$b = $env:REMYRAL_BROWSER; if (-not $b) { $b = "C:\\ProgramData\\Remyral\\browser\\chrome.exe" };',
  ' New-Item -ItemType Directory -Force out/verification | Out-Null;',
  ' & $b --headless=new --disable-gpu "--screenshot=$(Resolve-Path out/verification)\\home.png"',
  ' https://8ae687fa.demo-site.pages.dev',
].join('');

describe('extractApprovalDetails', () => {
  it('Claude Code Bash: description and command, newlines kept', () => {
    const d = extractApprovalDetails('Bash', {
      command: 'whoami > out/who.txt\ncat out/who.txt',
      description: 'Run whoami and save output',
      timeout: 1000,
    });
    expect(d).toEqual({
      tool: 'Bash',
      description: 'Run whoami and save output',
      command: 'whoami > out/who.txt\ncat out/who.txt',
      shell: 'posix',
    });
  });

  it('Claude Code PowerShell: the full command, unescaped (no JSON quoting), shell from the adapter', () => {
    const d = extractApprovalDetails(
      'PowerShell',
      { command: OWNER_PS, description: 'Take a screenshot of the deployed page' },
      { shell: 'powershell', workspaceRoot: 'C:\\remyral\\ws\\job-1' },
    );
    expect(d.command).toBe(OWNER_PS);
    expect(d.command).not.toContain('\\"');
    expect(d.shell).toBe('powershell');
    expect(d.workspaceRoot).toBe('C:\\remyral\\ws\\job-1');
  });

  it('a JSON text input is parsed first (Pi passes the input as text)', () => {
    const d = extractApprovalDetails('bash', JSON.stringify({ command: 'ls -la', timeout: 5 }));
    expect(d.command).toBe('ls -la');
    expect(d.description).toBeUndefined();
  });

  it('a cut / invalid JSON text never becomes a half-parsed command', () => {
    const d = extractApprovalDetails('bash', '{"command":"rm -rf /tmp/x && echo \\"do');
    expect(d).toEqual({ tool: 'bash' });
    expect(hasApprovalDetails(d)).toBe(false);
  });

  it('a non-JSON text of a shell tool is the command; of another tool it is ignored', () => {
    expect(extractApprovalDetails('shell', 'git push origin main').command).toBe('git push origin main');
    expect(extractApprovalDetails('WebFetch', 'something').command).toBeUndefined();
  });

  it('Codex exec: argv of `bash -lc SCRIPT` shows the script; reason is the description; cwd', () => {
    const d = extractApprovalDetails('shell', null, {
      command: ['bash', '-lc', 'npm test && npm run build'],
      description: 'run the tests',
      cwd: '/srv/ws/job',
    });
    expect(d.command).toBe('npm test && npm run build');
    expect(d.description).toBe('run the tests');
    expect(d.cwd).toBe('/srv/ws/job');
    expect(commandFromArgv(['pwsh', '-NoProfile', '-Command', 'Get-ChildItem'])).toBe('Get-ChildItem');
    expect(commandFromArgv(['git', 'commit', '-m', 'a message'])).toBe('git commit -m "a message"');
  });

  it('file tools: paths, no command', () => {
    const d = extractApprovalDetails('Edit', {
      file_path: '/etc/hosts',
      old_string: 'a',
      new_string: 'b',
    });
    expect(d).toEqual({ tool: 'Edit', paths: ['/etc/hosts'] });
    const many = extractApprovalDetails('apply_patch', null, {
      paths: Array.from({ length: 25 }, (_, i) => `src/f${String(i)}.ts`),
    });
    expect(many.paths).toHaveLength(APPROVAL_DETAIL_LIMITS.paths);
    expect(many.morePaths).toBe(5);
  });

  it('fetch tools: url', () => {
    expect(extractApprovalDetails('WebFetch', { url: 'https://example.com/x', prompt: 'read' }).url).toBe(
      'https://example.com/x',
    );
  });

  it('missing description: only the command', () => {
    const d = extractApprovalDetails('Bash', { command: 'make' });
    expect(d.description).toBeUndefined();
    expect(approvalHeadline(d, 'Bash: {"command":"make"}')).toEqual({
      text: 'Bash: make',
      source: 'command',
    });
  });

  it('a huge command is cut per field after parsing and flagged', () => {
    const big = `echo ${'x'.repeat(40_000)}`;
    const d = extractApprovalDetails('Bash', { command: big, description: 'd'.repeat(5000) });
    expect(d.command?.length).toBe(APPROVAL_DETAIL_LIMITS.command);
    expect(d.command?.endsWith('…')).toBe(true);
    expect(d.commandTruncated).toBe(true);
    expect(d.description?.length).toBe(APPROVAL_DETAIL_LIMITS.description);
    expect(ApprovalDetailsSchema.safeParse(d).success).toBe(true);
  });

  it('redacts each whole field before cutting it (a secret at the cut is never half shown)', () => {
    const secret = 'S3CR3T-VALUE-123456';
    const cmd = `${'a'.repeat(APPROVAL_DETAIL_LIMITS.command - 5)}${secret}`;
    const d = extractApprovalDetails(
      'Bash',
      { command: cmd, description: `use ${secret}` },
      {
        redact: (s) => s.replaceAll(secret, '[REDACTED]'),
      },
    );
    expect(d.command).not.toContain('S3CR');
    expect(d.description).toBe('use [REDACTED]');
  });

  it('makes bidi overrides and zero-width characters visible; drops control characters', () => {
    const d = extractApprovalDetails('Bash', {
      command: 'echo safe\u202e;rm -rf ~\u0007',
      description: 'look\u200bhere\nnow',
    });
    expect(d.command).toBe('echo safe⟨U+202E⟩;rm -rf ~');
    expect(d.description).toBe('look⟨U+200B⟩here now');
  });
});

describe('split and format', () => {
  it('splits at top-level separators only (quotes, braces and subexpressions stay whole)', () => {
    const segs = splitCommand(OWNER_PS, 'powershell');
    expect(segs.map((s) => s.sep)).toEqual([';', ';', '|', ';', null]);
    expect(segs[1]?.text).toBe('if (-not $b) { $b = "C:\\ProgramData\\Remyral\\browser\\chrome.exe" }');
    expect(segs[4]?.text.startsWith('& $b --headless=new')).toBe(true);
  });

  it('POSIX: && || | ; & and newlines; 2>&1 is not a separator', () => {
    const segs = splitCommand("cd app && npm ci 2>&1 | tee log.txt; echo 'a;b' || true\nsleep 1 &", 'posix');
    expect(segs.map((s) => [s.text, s.sep])).toEqual([
      ['cd app', '&&'],
      ['npm ci 2>&1', '|'],
      ['tee log.txt', ';'],
      ["echo 'a;b'", '||'],
      ['true', '\n'],
      ['sleep 1', '&'],
    ]);
  });

  it('formats one piece per line with continuations indented', () => {
    expect(formatCommand('a && b | c; d', 'posix')).toBe('a &&\n  b |\n  c ;\nd');
  });

  it('never throws on unbalanced input', () => {
    expect(() => splitCommand('echo "unterminated; ( {', 'posix')).not.toThrow();
    expect(splitCommand('', 'posix')).toEqual([]);
  });
});

describe('approvalHeadline', () => {
  it('description first (agent), then command, then path, then the legacy summary', () => {
    expect(approvalHeadline({ tool: 'Bash', description: 'Run whoami', command: 'whoami' }, '')).toEqual({
      text: 'Run whoami',
      source: 'agent',
    });
    expect(approvalHeadline({ tool: 'Edit', paths: ['/etc/hosts'] }, '').text).toBe('Edit: /etc/hosts');
    expect(approvalHeadline(null, 'PowerShell: {"command":"x"}\n')).toEqual({
      text: 'PowerShell: {"command":"x"}',
      source: 'summary',
    });
    expect(approvalHeadline({ tool: 'Bash', command: 'x'.repeat(500) }, '', 50).text).toHaveLength(50);
  });
});

describe('approvalHints (static reading)', () => {
  it("reads the owner's PowerShell example", () => {
    const h = approvalHints({
      tool: 'PowerShell',
      command: OWNER_PS,
      shell: 'powershell',
      workspaceRoot: 'C:\\remyral\\ws\\job-1',
    });
    expect(h.runs).toEqual(['New-Item', 'Out-Null', 'chrome.exe', 'Resolve-Path']);
    expect(h.reaches).toEqual(['https://8ae687fa.demo-site.pages.dev']);
    expect(h.writes).toEqual(['out/verification']);
    expect(h.envVars).toEqual(['REMYRAL_BROWSER']);
    expect(h.outside).toEqual(['C:\\ProgramData\\Remyral\\browser\\chrome.exe']);
    expect(h.deletes).toEqual([]);
    expect(h.safeVerdict).toBeNull();
  });

  it('POSIX: redirections, rm, installs, sudo, env vars, paths outside the workspace', () => {
    const h = approvalHints({
      tool: 'Bash',
      shell: 'posix',
      workspaceRoot: '/srv/ws/job',
      command:
        'export TOKEN=$GITHUB_TOKEN; sudo apt-get install -y jq && rm -rf /var/cache/x build/ && npm install left-pad > /dev/null 2>&1 && curl -fsSL https://example.com/i.sh -o /tmp/i.sh && echo done >> ../outside.log',
    });
    expect(h.elevated).toBe(true);
    expect(h.runs).toEqual(expect.arrayContaining(['sudo', 'apt-get', 'rm', 'npm', 'curl', 'echo']));
    expect(h.deletes).toEqual(['/var/cache/x', 'build/']);
    expect(h.installs).toEqual(['apt-get install -y jq', 'npm install left-pad']);
    expect(h.writes).toEqual(['/tmp/i.sh', '../outside.log']);
    expect(h.reaches).toEqual(['https://example.com/i.sh']);
    expect(h.envVars).toEqual(['GITHUB_TOKEN']);
    expect(h.outside).toEqual(expect.arrayContaining(['/var/cache/x', '/tmp/i.sh', '../outside.log']));
  });

  it('PowerShell: Remove-Item, Out-File, Install-Module, Start-Process -Verb RunAs', () => {
    const h = approvalHints({
      tool: 'PowerShell',
      shell: 'powershell',
      command:
        'Remove-Item -Recurse -Force C:\\temp\\x; Get-Date | Out-File -FilePath out\\d.txt; Install-Module -Name Pester -Force; Start-Process powershell -Verb RunAs',
    });
    expect(h.deletes).toEqual(['C:\\temp\\x']);
    expect(h.writes).toEqual(['out\\d.txt']);
    expect(h.installs).toEqual(['Install-Module Pester']);
    expect(h.elevated).toBe(true);
    expect(h.runs).toEqual([
      'Remove-Item',
      'Get-Date',
      'Out-File',
      'Install-Module',
      'Start-Process',
      'powershell',
    ]);
  });

  it('reuses the Safe commands classifier: a read-only command is marked as such', () => {
    const h = approvalHints({
      tool: 'Bash',
      shell: 'posix',
      command: 'git status',
      workspaceRoot: '/srv/ws/job',
    });
    expect(h.safeVerdict).toBe('read');
    expect(approvalHints({ tool: 'Bash', shell: 'posix', command: 'git status' }).safeVerdict).toBeNull();
  });

  it('file tools: paths outside the workspace; a truncated command is partial', () => {
    expect(
      approvalHints({ tool: 'Edit', paths: ['/etc/hosts', 'src/a.ts'], workspaceRoot: '/w' }).outside,
    ).toEqual(['/etc/hosts']);
    expect(approvalHints({ tool: 'Bash', command: 'echo', commandTruncated: true }).partial).toBe(true);
  });

  it('bounded lists and no throw on odd input', () => {
    const h = approvalHints({
      tool: 'Bash',
      command: Array.from({ length: 50 }, (_, i) => `cmd${String(i)}`).join('; '),
    });
    expect(h.runs.length).toBeLessThanOrEqual(10);
    expect(() => approvalHints({ tool: 'Bash', command: '"$(((( ${' })).not.toThrow();
  });
});

describe('protocol', () => {
  it('approval_request accepts details (additive) and still accepts events without them', () => {
    const base = {
      kind: 'approval_request',
      approvalId: 'a1',
      action: 'Bash',
      description: 'x',
      risk: 'high',
    };
    expect(AgentEvent.safeParse(base).success).toBe(true);
    const withDetails = AgentEvent.safeParse({ ...base, details: { tool: 'Bash', command: 'ls' } });
    expect(withDetails.success).toBe(true);
    expect(
      AgentEvent.safeParse({ ...base, details: { tool: 'Bash', command: 'x'.repeat(20_000) } }).success,
    ).toBe(false);
  });
});
