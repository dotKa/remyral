import { describe, expect, it } from 'vitest';
import {
  type Classification,
  classifyCommand,
  modeAllows,
  resolveWorkspacePath,
  SAFE_COMMAND_RULES,
  type ShellFamily,
  type SafePlatform,
} from '../src/safe-commands/index.js';

const POSIX_ROOT = '/srv/remyral/ws/job-1';
const WIN_ROOT = 'C:\\remyral\\ws\\job-1';

function run(command: string, shell: ShellFamily = 'posix', platform?: SafePlatform): Classification {
  const p: SafePlatform = platform ?? (shell === 'posix' ? 'posix' : 'win32');
  return classifyCommand({
    command,
    shells: [shell],
    platform: p,
    workspaceRoot: p === 'win32' ? WIN_ROOT : POSIX_ROOT,
  });
}

describe('POSIX shells (bash, sh, zsh)', () => {
  it.each([
    'git status',
    'git status; git log',
    'git status && git log --oneline -n 5',
    'git --no-pager log -1 --format=%H',
    'git diff HEAD~1 -- src',
    'git diff --stat origin/main',
    'git show HEAD:README.md',
    'git branch',
    'git branch --list',
    "git branch --list 'feat*'",
    'git branch -a -vv',
    'git rev-parse --abbrev-ref HEAD',
    'git ls-files src',
    'ls',
    'ls -la src',
    'ls --color=auto src',
    'ls src | head -5',
    'cat README.md',
    'cat -- -weird-name',
    'wc -l src/a.ts',
    'grep -rn "TODO" src',
    "grep -e 'a|b' -- src/a.ts",
    'rg -n foo src',
    "rg -g '*.ts' foo",
    "find . -name '*.ts' -type f",
    'find src -maxdepth 2',
    'pwd',
    'date',
    'date +%Y-%m-%d',
    'echo hello world',
    'echo "$(date)"',
    'uname -a',
    'whoami',
    'head -n 20 docs/a.md',
    'tail -n 5 log.txt',
    '(ls; pwd)',
    'ls 2>/dev/null',
    'ls 2>&1 | head',
    'cat < README.md',
    'sort data.txt | uniq -c',
    'stat -c %s a.txt',
    'du -sh src',
    'diff a.txt b.txt',
    'tr a-z A-Z',
    `cat ${POSIX_ROOT}/README.md`,
    "cat 'out/a b.md'",
    'git show HEAD~1:src/a.ts',
    'cat backup~1.txt',
  ])('read-only: %s', (cmd) => {
    expect(run(cmd)).toMatchObject({ safe: true, verdict: 'read' });
  });

  it.each([
    'echo hi > out/date.md',
    'mkdir -p out && date > out/date.md',
    'echo "$(date)" >> out/log.md',
    'touch out/x.txt',
    'ls | tee out/list.txt',
    'git diff > out/changes.patch',
    'date +%F >| out/d.md',
  ])('workspace write: %s', (cmd) => {
    expect(run(cmd)).toMatchObject({ safe: true, verdict: 'workspace_write' });
  });

  it.each([
    // outside the workspace
    'cat /etc/passwd',
    'cat ../other-job/secret',
    'cat src/../../x',
    'ls ~',
    'cat ~/.ssh/id_rsa',
    'cat /dev/tcp/10.0.0.1/80',
    'ls -la /',
    'echo x > /tmp/x',
    'echo x > ../x',
    'echo x > out/../../x',
    'cat < /etc/shadow',
    // the repository's metadata and runtime configuration
    'cat .git/config',
    'cat .GIT/config',
    'ls src/../.git/hooks',
    'echo x >> .git/hooks/pre-commit',
    'echo x > .bashrc',
    'echo x > .claude/settings.json',
    'echo x > AGENTS.md',
    'echo x > src/CLAUDE.md',
    'echo x > out/.env',
    'mkdir .husky',
    'ls --ignore=~/x',
    'grep -e x a=~/y',
    'cat x:~/y',
    // variables, globbing and other expansions
    'cat $HOME/x',
    'cat "$HOME"',
    'cat ${HOME}',
    'echo $SECRET_TOKEN',
    'echo "${TOKEN}"',
    'ls *',
    'ls src/*.ts',
    'ls ?',
    'cat {a,b}',
    'ls !',
    'echo "hi!"',
    'ls # comment',
    'ls $((1+1))',
    'ls \\-la',
    'l\\s',
    '=ls',
    'ls ^x',
    "echo 'unterminated",
    // substitution feeding paths or options
    'cat "$(echo /etc/passwd)"',
    'cat $(echo README.md)',
    'echo $(cat /etc/passwd)',
    'echo $(rm -rf /)',
    'echo `rm x`',
    'rg $(echo --pre=sh) x',
    'printf $(echo -v) x',
    '$(echo ls)',
    // compound commands with one unsafe part
    'ls; rm -rf /',
    'ls && curl https://example.com',
    'git status; git push',
    'ls | sh',
    'ls | bash',
    'echo hi | xargs rm',
    'ls & rm x',
    'ls &',
    'ls > out/x &',
    'ls |& cat',
    '(cd /; cat etc/passwd)',
    'ls\nrm -rf src',
    'ls\r\nrm -rf src',
    'cat <(curl x)',
    'diff <(ls) <(ls /)',
    'cat << EOF\nx\nEOF',
    'cat <<< x',
    'ls 2>&1 | tee /tmp/x',
    // unknown or dangerous programs
    'rm out/x',
    'mv a b',
    'cp a b',
    'chmod +x a',
    'curl https://example.com',
    'wget x',
    'npm install',
    'pnpm add x',
    'pip install x',
    'ssh host',
    'nc host 80',
    'env',
    'printenv',
    'sudo ls',
    'exec ls',
    'eval ls',
    'source x',
    '. ./x',
    'bash -c ls',
    "sh -c 'ls'",
    'python -c x',
    'node -e x',
    'command ls',
    'time ls',
    'nohup ls',
    'cd /tmp',
    'export A=1',
    '/bin/ls',
    './ls',
    "'rm' -rf x",
    // control structures, functions, assignments
    'if true; then ls; fi',
    'for i in a; do ls; done',
    'f() { ls; }',
    '[[ -f x ]]',
    'FOO=1 ls',
    'LD_PRELOAD=/tmp/x.so ls',
    'GIT_EXTERNAL_DIFF=sh git diff',
    // git: writes, network, config, global options, outputs outside
    'git push',
    'git push --force origin main',
    'git remote -v',
    'git remote add x y',
    'git config user.name x',
    'git fetch',
    'git pull',
    'git commit -m x',
    'git checkout -- .',
    'git reset --hard',
    'git clean -fdx',
    'git -c core.pager=sh log',
    'git -c core.fsmonitor=x status',
    'git -C /tmp status',
    'git --git-dir=/tmp/x log',
    'git --work-tree=/ status',
    'git --exec-path=/tmp log',
    'git log --output=/tmp/x',
    'git diff --output=out/x',
    'git diff --ou=/tmp/x',
    'git diff --no-index /etc/passwd README.md',
    'git diff --ext-diff',
    'git log -p --textconv',
    'git diff -O/etc/passwd',
    'git branch -D main',
    'git branch new-branch',
    'git branch -m a b',
    'git branch --set-upstream-to=origin/x',
    'git show HEAD:../../etc/passwd',
    'git log -- ../x',
    'git log -- /etc',
    'git',
    // find / rg / grep / tail / sort / date / hostname options
    'find . -exec rm {} ;',
    'find . -delete',
    'find -L .',
    'find . -follow',
    'find . -fprint /tmp/x',
    'find / -name x',
    'find . -newer /etc/passwd',
    'rg --pre cat x',
    'rg --pr=cat x',
    'rg -z x',
    'rg -L x',
    'rg --hostname-bin=/tmp/x x',
    'grep -R x .',
    'grep -f /etc/shadow x',
    'grep -f/etc/shadow x',
    'grep --file=/etc/shadow x',
    'grep --fi=/etc/shadow x',
    'grep x /etc/passwd',
    'ls --color /etc',
    'tail -f log',
    'tail -F log',
    'tail --follow log',
    'sort -o out/x data',
    'sort --compress-program=sh data',
    'uniq in.txt out.txt',
    'date -s 2020-01-01',
    'date 0101000020',
    'hostname evil',
    'hostname -F /etc/x',
    // encoding tricks
    'ls\u0000',
    'cat x\u001b[2J',
    'ls\u2028rm x',
    'ｌｓ',
    'ls ＞ x',
    '',
    '   ',
  ])('not safe: %j', (cmd) => {
    expect(run(cmd).safe).toBe(false);
  });

  it('refuses over-long commands', () => {
    expect(run(`echo ${'a'.repeat(5000)}`)).toMatchObject({ safe: false, reason: 'command_invalid' });
  });

  it('reports the matched rules and the paths for the worker', () => {
    const c = run('grep -rn TODO src | head > out/todo.txt');
    expect(c).toEqual({
      safe: true,
      verdict: 'workspace_write',
      rules: ['posix.grep', 'posix.head', 'redirect.write'],
      reads: [`${POSIX_ROOT}/src`],
      writes: [`${POSIX_ROOT}/out/todo.txt`],
      usesGit: false,
    });
    expect(run('git status')).toMatchObject({ usesGit: true, rules: ['git.read'] });
  });
});

describe('Git Bash on Windows (MSYS paths)', () => {
  it.each([
    'git status',
    'ls src',
    'ls /c/remyral/ws/job-1/src',
    "cat 'C:\\remyral\\ws\\job-1\\README.md'",
    'LS src',
  ])('read-only: %s', (cmd) => {
    expect(run(cmd, 'posix', 'win32')).toMatchObject({ safe: true, verdict: 'read' });
  });
  it.each([
    'cat /etc/passwd',
    'ls /tmp',
    'cat /c/Windows/win.ini',
    'ls /c/remyral/ws/job-1/../other',
    "cat 'C:\\Windows\\win.ini'",
    "cat '\\\\server\\share\\x'",
    'cat //server/share/x',
    "cat 'GIT~1/config'",
    "cat 'x.txt:secret'",
    "cat '.git./config'",
    'echo x > NUL.txt',
    'echo x > out/con',
  ])('not safe: %s', (cmd) => {
    expect(run(cmd, 'posix', 'win32').safe).toBe(false);
  });
});

describe('PowerShell 5.1 / 7 (Windows)', () => {
  it.each([
    'Get-ChildItem',
    'gci -Recurse -Filter *.md',
    'ls src',
    'dir',
    'Get-Content README.md -TotalCount 20',
    'Get-Content -Path a.md,b.md',
    'Get-Content -Path a.md, b.md',
    'cat README.md',
    'type README.md',
    "Select-String -Pattern 'TODO' -Path src\\a.ts",
    'Get-Location',
    'pwd',
    "Get-Date -Format 'yyyy-MM-dd'",
    'Get-CimInstance Win32_OperatingSystem',
    'Get-CimInstance -ClassName Win32_OperatingSystem | Select-Object Caption, Version',
    'Test-Path out',
    'git status; git log -n 3',
    'git log --oneline',
    'Get-ChildItem | Select-Object Name | Sort-Object Name',
    'Get-ChildItem | Measure-Object',
    'Get-Date 2>&1',
    'Get-Date > $null',
    'Write-Output "hello"',
    'echo (Get-Date)',
    'Write-Output $(Get-Date)',
    `Get-Content ${WIN_ROOT}\\README.md`,
    'Get-Content C:/remyral/ws/job-1/README.md',
    'get-childitem -recurse',
  ])('read-only: %s', (cmd) => {
    expect(run(cmd, 'powershell')).toMatchObject({ safe: true, verdict: 'read' });
  });

  it.each([
    'New-Item out -ItemType Directory',
    'New-Item out; Set-Content out/date.md "hi"',
    'New-Item out -ItemType Directory -Force; Set-Content out/date.md (Get-Date)',
    'New-Item -Path out -Name date.md -ItemType File -Value x',
    'Set-Content out\\date.md (Get-Date)',
    'Get-Date | Out-File out/date.md',
    "Add-Content out\\log.md 'x'",
    'Get-Date > out\\date.md',
    'mkdir out',
    'ni out\\a.txt',
  ])('workspace write: %s', (cmd) => {
    expect(run(cmd, 'powershell')).toMatchObject({ safe: true, verdict: 'workspace_write' });
  });

  it.each([
    // commands that change, launch or reach out
    'Remove-Item x',
    'rm x',
    'del x',
    'Move-Item a b',
    'Copy-Item a b',
    'iex "ls"',
    "Invoke-Expression 'ls'",
    'powershell -EncodedCommand ZQBjAGgAbwAgAGgAaQA=',
    'pwsh -enc ZQBjAGgAbwA=',
    'powershell -c ls',
    "& 'ls'",
    '& ls',
    '. ./x.ps1',
    '.\\x.ps1',
    'Start-Process notepad',
    'Invoke-WebRequest https://example.com',
    'iwr https://example.com',
    'curl https://example.com',
    'wget x',
    'Invoke-RestMethod x',
    'sc stop wuauserv',
    'Set-Date 2020-01-01',
    'Get-Date | Set-Date',
    'Get-Process | Stop-Process',
    'cmd /c dir',
    'Get-WmiObject Win32_OperatingSystem',
    'Get-CimInstance Win32_Process',
    'Get-CimInstance -ComputerName srv Win32_OperatingSystem',
    "Get-CimInstance -Query 'select * from Win32_Process'",
    'Get-CimInstance -CimSession $s Win32_OperatingSystem',
    // providers, UNC, device and odd paths
    'Get-Content $env:USERPROFILE\\x',
    'Get-Content env:SECRET',
    'Get-ChildItem Env:',
    'Get-Content HKLM:\\SOFTWARE\\x',
    'Get-ChildItem Cert:\\',
    'Get-Content Microsoft.PowerShell.Core\\FileSystem::C:\\x',
    'Get-Content \\\\server\\share\\x',
    'Get-Content \\\\?\\C:\\remyral\\ws\\job-1\\a.txt',
    'Get-Content \\\\.\\pipe\\x',
    'Get-Content //server/share/x',
    'Get-Content C:x.txt',
    'Get-Content \\Windows\\win.ini',
    'Get-Content ..\\..\\x',
    'Get-Content C:\\Windows\\win.ini',
    'Get-Content D:\\remyral\\ws\\job-1\\a.txt',
    'Get-Content a.txt:secret',
    'Get-Content -Stream s a.txt',
    'Get-Content -Wait a.txt',
    'Get-Content *',
    'Get-Content a[1].txt',
    'Get-Content .git\\config',
    "Get-Content '.GIT\\config'",
    "Get-Content '.git.\\config'",
    "Get-Content '.git \\config'",
    'Get-Content GIT~1\\config',
    'Get-Content PROGRA~1\\x',
    'Get-Content CON',
    'Get-Content NUL.txt',
    'Get-Content out\\com1.log',
    // parameters
    'Get-ChildItem -FollowSymlink',
    'Get-Content -Pa a.txt',
    'Get-Content -LiteralPath',
    'Get-ChildItem -Path',
    'Get-ChildItem -Recurse:$true',
    // pipelines that bind unchecked paths
    'Get-ChildItem | Get-Content',
    'gci out | Select-String x',
    'Get-ChildItem -Recurse | Remove-Item',
    'Get-ChildItem | Set-Content -Value x',
    'Get-Date | % { rm x }',
    'Get-Date | ? { $_ }',
    'Get-Date | ForEach-Object Delete',
    'Get-Date | Where-Object Year',
    // writes outside or into protected places
    'Set-Content -Path ..\\x -Value y',
    'Set-Content C:\\x y',
    'Set-Content .git\\hooks\\pre-commit y',
    'Set-Content out\\x -Stream s y',
    'Set-Content $profile x',
    'Set-Content AGENTS.md x',
    'Set-Content .vscode\\tasks.json x',
    'Set-Content out\\.env x',
    'Get-Content out\\date.md:Zone.Identifier',
    'New-Item -ItemType SymbolicLink -Path out\\l -Value C:\\',
    'New-Item -ItemType Junction -Path out\\j -Value C:\\',
    'New-Item -ItemType HardLink -Path out\\h -Value C:\\x',
    'New-Item -Path out -Name ..\\x',
    'New-Item -Path C:\\ -Name x',
    'New-Item -Name .git',
    'Out-File \\\\server\\x',
    'Get-Date > C:\\x',
    'Get-Date 2> ..\\x',
    'Get-Date > out\\*.txt',
    'Set-Content',
    // syntax PowerShell would accept but we do not model
    'Write-Output $env:SECRET',
    'Write-Output "$env:X"',
    'Write-Output "`$x"',
    'Write-Output @args',
    'Write-Output @(1,2)',
    'Write-Output {ls}',
    "Select-Object -Property @{n='a';e={rm x}}",
    'Select-Object { rm x }',
    "[IO.File]::ReadAllText('x')",
    '(Get-Content x).Replace("a","b")',
    'Write-Output (Get-Date).ToString()',
    'Write-Output (Remove-Item x)',
    'Write-Output $(Invoke-WebRequest x)',
    "'ls'",
    '"Get-ChildItem"',
    'Get-Date; Remove-Item x',
    'Get-Date && Remove-Item x',
    'Get-Date &',
    'gci # comment',
    '<# x #> gci',
    'Get-ChildItem --% x',
    'Get-ChildItem -- x',
    'Get-Content \u2013Path a.txt',
    'Write-Output \u2018x\u2019',
    'Write-Output \u201cx\u201d',
    'Get-Date\u00a0-Format x',
    'Microsoft.PowerShell.Management\\Get-ChildItem',
    'Get-Date `\n; rm x',
    "@'\nx\n'@ | Out-File out\\x",
    // git with global options or writes
    'git -c core.fsmonitor=calc status',
    'git push',
    'git log --output=C:\\x',
    'git config --list',
  ])('not safe: %j', (cmd) => {
    expect(run(cmd, 'powershell').safe).toBe(false);
  });

  it('is not modelled outside Windows (pwsh on Linux runs native ls / cat)', () => {
    expect(run('ls', 'powershell', 'posix')).toMatchObject({ safe: false, reason: 'shell_platform' });
  });
});

describe('cmd.exe', () => {
  it.each([
    'dir',
    'dir /s /b',
    'dir /a:h src',
    'dir /o-d',
    'type out\\a.md',
    'type "out\\a b.md"',
    'dir | findstr /i todo',
    'findstr /s /n TODO src\\a.ts',
    'ver',
    'date /t',
    'time /T',
    'echo hello',
    'git status & git log -n 1',
    'dir 2>nul',
    'dir > nul 2>&1',
  ])('read-only: %s', (cmd) => {
    expect(run(cmd, 'cmd')).toMatchObject({ safe: true, verdict: 'read' });
  });

  it.each(['echo x > out\\date.md', 'mkdir out', 'date /t >> out\\log.txt'])('workspace write: %s', (cmd) => {
    expect(run(cmd, 'cmd')).toMatchObject({ safe: true, verdict: 'workspace_write' });
  });

  it.each([
    'del x',
    'erase x',
    'rd /s /q src',
    'type C:\\Windows\\win.ini',
    'type %USERPROFILE%\\x',
    'echo %PATH%',
    'type !x!',
    'dir & del x',
    'echo x > ..\\x',
    'echo ^& del x',
    '(dir)',
    '@echo off',
    'dir/s',
    'echo.',
    'cd..',
    'cmd /c del x',
    'powershell -c ls',
    'start notepad',
    'findstr /g:C:\\x y',
    'findstr /d:C:\\ x',
    'date 01-01-2020',
    'time 12:00',
    'date',
    'type x,y',
    'type x;y',
    'dir /p',
    'dir \\\\server\\share',
    'type .git\\config',
    'type src\\*.ts',
    'echo x > AGENTS.md',
    'curl https://example.com',
    'git push',
    'git -c x=y status',
    'dir &',
    '| dir',
  ])('not safe: %j', (cmd) => {
    expect(run(cmd, 'cmd').safe).toBe(false);
  });
});

describe('several candidate shells', () => {
  it('must be safe in every one of them', () => {
    const shells: ShellFamily[] = ['posix', 'cmd', 'powershell'];
    const base = { platform: 'win32' as const, workspaceRoot: WIN_ROOT, shells };
    expect(classifyCommand({ ...base, command: 'git status' })).toMatchObject({
      safe: true,
      verdict: 'read',
    });
    expect(classifyCommand({ ...base, command: 'ls' }).safe).toBe(false);
    expect(classifyCommand({ ...base, command: 'echo hi > out\\x' }).safe).toBe(false); // backslash in bash
    expect(classifyCommand({ ...base, command: 'echo hi > out/x' })).toMatchObject({
      safe: true,
      verdict: 'workspace_write',
    });
    expect(classifyCommand({ ...base, command: 'pwd', shells: [] }).safe).toBe(false);
  });

  it('refuses a relative or malformed workspace root', () => {
    for (const workspaceRoot of ['ws/job', '', 'C:relative', '/srv/../etc']) {
      expect(
        classifyCommand({ command: 'ls', shells: ['posix'], platform: 'posix', workspaceRoot }).safe,
      ).toBe(false);
    }
  });
});

describe('modes', () => {
  it('maps project modes to verdicts', () => {
    expect(modeAllows('off', 'read')).toBe(false);
    expect(modeAllows('read-only', 'read')).toBe(true);
    expect(modeAllows('read-only', 'workspace_write')).toBe(false);
    expect(modeAllows('workspace-writes', 'workspace_write')).toBe(true);
    expect(modeAllows('workspace-writes', 'read')).toBe(true);
  });

  it('lists every rule once for the console', () => {
    const ids = SAFE_COMMAND_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('git.read');
    expect(ids).toContain('redirect.write');
  });
});

describe('resolveWorkspacePath', () => {
  it('normalises inside paths and refuses escapes', () => {
    expect(resolveWorkspacePath('out/./a/../b.md', POSIX_ROOT, 'posix')).toMatchObject({
      ok: true,
      abs: `${POSIX_ROOT}/out/b.md`,
    });
    expect(resolveWorkspacePath('OUT\\b.md', 'c:\\remyral\\ws\\job-1', 'win32')).toMatchObject({
      ok: true,
      abs: 'C:\\remyral\\ws\\job-1\\OUT\\b.md',
    });
    expect(resolveWorkspacePath('c:\\REMYRAL\\ws\\JOB-1\\a', WIN_ROOT, 'win32')).toMatchObject({ ok: true });
    expect(resolveWorkspacePath('/srv/remyral/ws/job-10/a', POSIX_ROOT, 'posix').ok).toBe(false);
    expect(resolveWorkspacePath('/srv/remyral/ws/JOB-1/a', POSIX_ROOT, 'posix').ok).toBe(false);
  });
});
