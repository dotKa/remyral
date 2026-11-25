import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  claudeSafeCommandClaim,
  safeCommandClaim,
  SecretValue,
  shellsForTool,
  type SafeFsProbe,
} from '../src/index.js';
import { withPiSafeClaim } from '../src/runtimes/pi/adapter.js';
import { piShellCommand } from '../src/runtimes/pi/events.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;
const base = realpathSync(mkdtempSync(join(tmpdir(), 'remyral-safe-')));
const ws = join(base, 'ws');
const noRepo = join(base, 'no-repo');
const outside = join(base, 'outside');
mkdirSync(join(ws, 'out'), { recursive: true });
mkdirSync(join(ws, 'src'), { recursive: true });
mkdirSync(join(ws, '.git'), { recursive: true });
mkdirSync(noRepo, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(ws, 'README.md'), 'x');
writeFileSync(join(ws, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n');
const risky = join(base, 'risky');
mkdirSync(join(risky, '.git'), { recursive: true });
writeFileSync(join(risky, '.git', 'config'), '[core]\n\tfsmonitor = /tmp/evil.sh\n');
const linked = join(base, 'linked');
mkdirSync(linked, { recursive: true });
writeFileSync(join(linked, '.git'), 'gitdir: /srv/mirrors/app.git/worktrees/job-1\n');
writeFileSync(join(outside, 'secret.txt'), 'x');
if (process.platform !== 'win32') {
  symlinkSync(outside, join(ws, 'escape'));
  symlinkSync(join(outside, 'secret.txt'), join(ws, 'link.txt'));
  symlinkSync(join(outside, 'nope', 'file'), join(ws, 'dangling'));
  linkSync(join(outside, 'secret.txt'), join(ws, 'hard.txt'));
}
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function claim(command: string, root = ws) {
  return safeCommandClaim({
    tool: 'Bash',
    command,
    shells: ['posix'],
    workspaceRoot: root,
    platform: 'posix',
  });
}

describePosix('safeCommandClaim (worker half, real filesystem)', () => {
  it.each([
    ['cat README.md', 'read'],
    ['ls -la src', 'read'],
    ['git status; git log --oneline', 'read'],
    ['grep -rn x . | head', 'read'],
    ['echo hi > out/new.md', 'workspace_write'],
    ['mkdir -p out/deep/er && date > out/deep/er/d.md', 'workspace_write'],
  ])('%s → claim (%s)', (cmd, verdict) => {
    expect(claim(cmd)).toMatchObject({
      tool: 'Bash',
      command: cmd,
      shells: ['posix'],
      platform: 'posix',
      workspaceRoot: ws,
      verdict,
    });
  });

  it.each([
    ['cat link.txt', 'a file symlink to outside'],
    ['ls escape', 'a directory symlink to outside'],
    ['cat escape/secret.txt', 'through a directory symlink'],
    ['echo x > escape/new.txt', 'a write through a directory symlink'],
    ['echo x > link.txt', 'a write through a file symlink'],
    ['cat dangling', 'a dangling symlink'],
    ['cat hard.txt', 'a hard link (may be a file outside)'],
    ['echo x >> hard.txt', 'a write to a hard link'],
    ['cat /etc/passwd', 'outside'],
    ['rm README.md', 'not read-only'],
  ])('%s → no claim (%s)', (cmd) => {
    expect(claim(cmd)).toBeNull();
  });

  it('git needs the repository at the workspace root (no parent-repository discovery)', () => {
    expect(claim('git status', noRepo)).toBeNull();
    expect(claim('ls', noRepo)).not.toBeNull();
  });

  it('git: a worktree link is fine; a repository config that names a program is not', () => {
    expect(claim('git status', linked)).toMatchObject({ verdict: 'read' });
    expect(claim('git status', risky)).toBeNull();
    expect(claim('ls', risky)).not.toBeNull();
  });

  it('never claims a command that carries a job secret', () => {
    const secretEnv = { TOKEN: new SecretValue('s3cr3t-token-value') };
    expect(
      safeCommandClaim({
        tool: 'Bash',
        command: 'grep s3cr3t-token-value README.md',
        shells: ['posix'],
        workspaceRoot: ws,
        platform: 'posix',
        secretEnv,
      }),
    ).toBeNull();
    expect(
      safeCommandClaim({
        tool: 'Bash',
        command: 'grep other README.md',
        shells: ['posix'],
        workspaceRoot: ws,
        platform: 'posix',
        secretEnv,
      }),
    ).not.toBeNull();
  });

  it('a missing workspace root claims nothing', () => {
    expect(claim('ls', join(base, 'missing'))).toBeNull();
  });
});

describePosix('runtime glue', () => {
  const ctx = { workspaceRoot: ws, secretEnv: {}, approvalPolicy: 'ask-sensitive' as const };

  it('Claude Code: Bash only with known input keys', () => {
    expect(claudeSafeCommandClaim('Bash', { command: 'ls', description: 'list' }, ctx)).toMatchObject({
      verdict: 'read',
    });
    expect(claudeSafeCommandClaim('Bash', { command: 'ls', run_in_background: true }, ctx)).toBeNull();
    expect(
      claudeSafeCommandClaim('Bash', { command: 'ls', dangerouslyDisableSandbox: true }, ctx),
    ).toBeNull();
    expect(claudeSafeCommandClaim('Bash', { cmd: 'ls' }, ctx)).toBeNull();
    expect(claudeSafeCommandClaim('PowerShell', { command: 'Get-ChildItem' }, ctx)).toBeNull(); // POSIX host
    expect(claudeSafeCommandClaim('Read', { file_path: 'README.md' }, ctx)).toBeNull();
  });

  it('Pi: the gated input must be complete JSON with only command / timeout', () => {
    expect(piShellCommand('bash', JSON.stringify({ command: 'ls', timeout: 5 }))).toBe('ls');
    expect(piShellCommand('bash', JSON.stringify({ command: 'ls', cwd: '/' }))).toBeNull();
    expect(piShellCommand('edit', JSON.stringify({ command: 'ls' }))).toBeNull();
    expect(piShellCommand('bash', `{"command":"${'a'.repeat(3990)}"}`)).toBeNull(); // truncated by the gate
    expect(piShellCommand('bash', '{"command":"ls"')).toBeNull();
    const action = {
      kind: 'approval' as const,
      uiId: 'u1',
      approvalId: 'u1',
      toolName: 'bash',
      shellCommand: 'git status',
      event: {
        kind: 'approval_request' as const,
        approvalId: 'u1',
        action: 'runtime.dangerous_tool',
        description: 'bash: git status',
        risk: 'high' as const,
      },
    };
    expect(withPiSafeClaim(action, ctx)).toMatchObject({ safeCommand: { tool: 'bash', verdict: 'read' } });
    expect(withPiSafeClaim(action, { ...ctx, approvalPolicy: 'ask-all' })).not.toHaveProperty('safeCommand');
  });

  it('OpenCode on Windows must be safe in every shell it may pick', () => {
    expect(shellsForTool('opencode', 'bash', 'win32')).toEqual(['posix', 'cmd', 'powershell']);
    expect(shellsForTool('opencode', 'bash', 'posix')).toEqual(['posix']);
    expect(shellsForTool('opencode', 'edit', 'posix')).toBeNull();
    expect(shellsForTool('claude-code', 'PowerShell', 'win32')).toEqual(['powershell']);
    expect(shellsForTool('pi', 'powershell', 'posix')).toBeNull();
  });
});

describe('safeCommandClaim on a Windows layout (injected filesystem)', () => {
  const root = 'C:\\ProgramData\\RemyralWorker\\work\\jobs\\job-1\\att-1';
  const dirs = [
    'C:\\',
    'C:\\ProgramData',
    'C:\\ProgramData\\RemyralWorker',
    'C:\\ProgramData\\RemyralWorker\\work',
    'C:\\ProgramData\\RemyralWorker\\work\\jobs',
    'C:\\ProgramData\\RemyralWorker\\work\\jobs\\job-1',
    root,
    `${root}\\out`,
    `${root}\\.git`,
  ];
  const canonical = new Map(dirs.map((p) => [p.toLowerCase(), p]));
  const fs: SafeFsProbe = {
    realpath: (p) => {
      const c = canonical.get(p.toLowerCase());
      if (c === undefined) throw new Error('ENOENT');
      return c;
    },
    // `.git` is the worker's worktree link (a file), like a real repository job.
    lstat: (p) =>
      canonical.has(p.toLowerCase()) ? { isFile: p.toLowerCase().endsWith('\\.git'), nlink: 1 } : null,
  };
  const win = (command: string, shells: ('posix' | 'powershell' | 'cmd')[]) =>
    safeCommandClaim({ tool: 'PowerShell', command, shells, workspaceRoot: root, platform: 'win32' }, fs);

  it('claims the commands of the live finding', () => {
    expect(win('git status; git log', ['powershell'])).toMatchObject({ verdict: 'read' });
    expect(win('Get-ChildItem', ['powershell'])).toMatchObject({ verdict: 'read' });
    expect(
      win('New-Item out -ItemType Directory -Force; Set-Content out/date.md (Get-Date)', ['powershell']),
    ).toMatchObject({ verdict: 'workspace_write' });
  });

  it('refuses paths outside, on another drive or through UNC', () => {
    expect(win('Get-Content ..\\att-2\\x', ['powershell'])).toBeNull();
    expect(win('Get-Content D:\\x', ['powershell'])).toBeNull();
    expect(win('Get-Content \\\\srv\\share\\x', ['powershell'])).toBeNull();
  });
});
