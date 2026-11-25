import { execFile } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../src/sandbox/types.js';
import { jobRunnerSpec, windowsCommandLine } from '../src/sandbox/host/windows-jobrun.js';
import { serviceCommand } from '../src/services/manager.js';

// p19-service-quotes: a service command with double quotes (and single quotes inside) reaches the program intact.
const CODE = `require('http').createServer((q, r) => r.end('ok')).listen(8765)`;
const LINE = `node -e "${CODE}"`;
const CMD = 'C:\\Windows\\system32\\cmd.exe';

/** CommandLineToArgvW / MSVCRT argument parsing (what node.exe does with its command line). */
function parseMsvcrt(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (i >= line.length) break;
    let arg = '';
    let quoted = false;
    for (; i < line.length; i++) {
      const ch = line[i];
      if (!quoted && (ch === ' ' || ch === '\t')) break;
      if (ch === '\\') {
        let n = 0;
        while (line[i] === '\\') {
          n++;
          i++;
        }
        if (line[i] === '"') {
          arg += '\\'.repeat(Math.floor(n / 2));
          if (n % 2 === 1) arg += '"';
          else quoted = !quoted;
        } else {
          arg += '\\'.repeat(n);
          i--;
        }
        continue;
      }
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') {
          arg += '"';
          i++;
        } else quoted = !quoted;
        continue;
      }
      arg += ch;
    }
    out.push(arg);
  }
  return out;
}

/** What `cmd.exe /d /s /c "<x>"` runs: the text after /c with its first and last quote removed. */
function cmdRuns(commandLine: string): string {
  const m = /^\S+ (?:\/[a-z] )*\/c "(.*)"$/i.exec(commandLine);
  if (m === null) throw new Error(`not a cmd /s /c line: ${commandLine}`);
  return m[1] ?? '';
}

describe('service command quoting (p19-service-quotes)', () => {
  it('Windows: cmd.exe /d /s /c with the line passed verbatim inside one pair of quotes', () => {
    const argv = serviceCommand('win32', LINE, null, CMD);
    expect(argv).toEqual({ command: CMD, args: ['/d', '/s', '/c', LINE] });
    const spec = jobRunnerSpec([argv.command, ...argv.args], 'C:\\w', DEFAULT_LIMITS, 8);
    expect(spec.commandLine).toBe(`${CMD} /d /s /c "${LINE}"`);
    // node gets exactly the code (it was cut at the first space when the quotes were escaped as \").
    expect(parseMsvcrt(cmdRuns(spec.commandLine))).toEqual(['node', '-e', CODE]);
  });

  it('Windows: a working directory becomes cd /d in front of the line', () => {
    const argv = serviceCommand('win32', LINE, 'C:\\w\\my "app"', CMD);
    expect(argv.args).toEqual(['/d', '/s', '/c', `cd /d "C:\\w\\my app" && ${LINE}`]);
    expect(windowsCommandLine([argv.command, ...argv.args])).toBe(
      `${CMD} /d /s /c "cd /d "C:\\w\\my app" && ${LINE}"`,
    );
  });

  it('Windows: other command lines keep the CommandLineToArgvW quoting', () => {
    expect(windowsCommandLine(['cmd.exe', '/c', 'a "b"'])).toBe('cmd.exe /c "a \\"b\\""');
    expect(windowsCommandLine(['C:\\rt\\node.exe', '-e', CODE])).toBe(`C:\\rt\\node.exe -e "${CODE}"`);
    expect(parseMsvcrt(windowsCommandLine(['node.exe', '-e', 'say "hi"']))).toEqual([
      'node.exe',
      '-e',
      'say "hi"',
    ]);
  });

  it('Linux / macOS: /bin/sh -c with the line unchanged', () => {
    expect(serviceCommand('linux', LINE, null)).toEqual({ command: '/bin/sh', args: ['-c', LINE] });
    expect(serviceCommand('darwin', LINE, "/w/it's")).toEqual({
      command: '/bin/sh',
      args: ['-c', `cd '/w/it'\\''s' && ${LINE}`],
    });
  });

  it.skipIf(process.platform === 'win32')('Linux / macOS: the shell hands node the exact code', async () => {
    const line = `node -e "process.stdout.write(process.argv[1] + ':' + 'it\\'s ok')" "a b"`;
    const { command, args } = serviceCommand(process.platform, line, null);
    const out = await new Promise<string>((resolve, reject) => {
      execFile(command, args, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
    expect(out).toBe("a b:it's ok");
  });
});
