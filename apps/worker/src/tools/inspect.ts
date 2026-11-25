import type { InspectSection, MachineInspectReport, ToolInventoryReport } from '@remyral/protocol';
import type { RunFn } from '../remote-ops/process.js';

/**
 * `machine.inspect` (p5-machine-admin §2): a read-only look at the machine for the panel and the ops chat —
 * installed software, services, disk usage, recent worker log lines and the tool inventory. Runs as the worker's
 * service account with fixed commands (no argument comes from the panel but the section names), bounded output,
 * short timeouts; every string is redacted before it leaves the worker (and again on the master).
 *
 * Windows uses Windows PowerShell 5.1 with `-EncodedCommand` (no quoting issues, ASCII-only scripts with
 * case-sensitive operators only) and forces UTF-8 output so non-English names (tr-TR) survive.
 */

const MAX_ITEMS = 500;
const TIMEOUT_MS = 30_000;

export interface InspectDeps {
  readonly platform: NodeJS.Platform;
  readonly run: RunFn;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly redact: (s: string) => string;
  readonly logs: () => Promise<string[]>;
  readonly tools: () => Promise<ToolInventoryReport>;
  readonly clock?: () => Date;
  /** Absolute path of Windows PowerShell (default under %SystemRoot%). */
  readonly powershell?: string;
}

/** The fixed PowerShell scripts (exported for the ASCII / case-sensitive-operator check). */
export const PS_SOFTWARE = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$keys = @('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
  '$items = Get-ItemProperty -Path $keys | Where-Object { $_.DisplayName } | Sort-Object DisplayName -Unique | Select-Object -First 500',
  '@($items | ForEach-Object { [pscustomobject]@{ n = [string]$_.DisplayName; v = [string]$_.DisplayVersion } }) | ConvertTo-Json -Compress',
].join('\n');

export const PS_SERVICES = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  "$ErrorActionPreference = 'SilentlyContinue'",
  '@(Get-Service | Sort-Object Name | Select-Object -First 500 | ForEach-Object { [pscustomobject]@{ n = [string]$_.Name; s = [string]$_.Status; t = [string]$_.StartType } }) | ConvertTo-Json -Compress',
].join('\n');

export const PS_DISK = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  "$ErrorActionPreference = 'SilentlyContinue'",
  '@([System.IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady } | ForEach-Object { [pscustomobject]@{ m = [string]$_.Name; f = [int64]$_.AvailableFreeSpace; t = [int64]$_.TotalSize } }) | ConvertTo-Json -Compress',
].join('\n');

function encoded(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Drops control characters (registry values often carry trailing NULs, e.g. "Mesh Agent\0" seen on the real
 * Windows target) and clips to `n` characters.
 */
function clip(s: string, n: number): string {
  let t = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c === 0x09) t += ' ';
    else if (c >= 0x20 && c !== 0x7f) t += ch;
  }
  t = t.trim();
  return t.length > n ? t.slice(0, n) : t;
}

function asArray(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v))
    return v.filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object');
  return v !== null && typeof v === 'object' ? [v as Record<string, unknown>] : [];
}

export async function inspectMachine(
  d: InspectDeps,
  sections: readonly InspectSection[],
): Promise<MachineInspectReport> {
  const problems: NonNullable<MachineInspectReport['problems']> = [];
  let truncated = false;
  const r = (s: string, n: number) => clip(d.redact(s), n);
  const ps = async (script: string): Promise<unknown> => {
    const exe =
      d.powershell ??
      `${d.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const res = await d.run(
      exe,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encoded(script),
      ],
      { env: d.env, cwd: d.cwd, timeoutMs: TIMEOUT_MS, maxBytes: 2 * 1024 * 1024 },
    );
    if (res.exitCode !== 0) throw new Error(`powershell exited ${String(res.exitCode)}`);
    const text = res.stdout.trim().replace(/^\uFEFF/, '');
    return text === '' ? [] : (JSON.parse(text) as unknown);
  };
  const cmd = async (file: string, args: readonly string[]): Promise<string> => {
    const res = await d.run(file, args, {
      env: d.env,
      cwd: d.cwd,
      timeoutMs: TIMEOUT_MS,
      maxBytes: 2 * 1024 * 1024,
    });
    if (res.exitCode !== 0) throw new Error(`${file} exited ${String(res.exitCode)}`);
    return res.stdout;
  };
  const out: MachineInspectReport = {
    collectedAt: (d.clock?.() ?? new Date()).toISOString(),
    platform: d.platform,
    truncated: false,
  };
  const attempt = async (section: InspectSection, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      problems.push({ section, message: r(err instanceof Error ? err.message : String(err), 300) });
    }
  };

  if (sections.includes('software')) {
    await attempt('software', async () => {
      let items: { name: string; version?: string }[];
      if (d.platform === 'win32') {
        items = asArray(await ps(PS_SOFTWARE)).map((x) => ({
          name: typeof x.n === 'string' ? x.n : '',
          ...(typeof x.v === 'string' && x.v !== '' ? { version: x.v } : {}),
        }));
      } else if (d.platform === 'darwin') {
        const text = await cmd('/bin/ls', ['/Applications']);
        items = text
          .split('\n')
          .filter((l) => l.endsWith('.app'))
          .map((l) => ({ name: l.slice(0, -4) }));
      } else {
        const dpkg = await cmd('/usr/bin/dpkg-query', ['-W', '-f=${Package}\t${Version}\n']).catch(
          () => null,
        );
        const text = dpkg ?? (await cmd('/usr/bin/rpm', ['-qa', '--qf', '%{NAME}\t%{VERSION}-%{RELEASE}\n']));
        items = text
          .split('\n')
          .filter((l) => l.trim() !== '')
          .map((l) => {
            const [name = '', version] = l.split('\t');
            return { name, ...(version === undefined || version === '' ? {} : { version }) };
          });
      }
      if (items.length > MAX_ITEMS) truncated = true;
      out.software = items
        .filter((i) => i.name !== '')
        .slice(0, MAX_ITEMS)
        .map((i) => ({
          name: r(i.name, 200),
          ...(i.version === undefined ? {} : { version: r(i.version, 64) }),
        }));
    });
  }
  if (sections.includes('services')) {
    await attempt('services', async () => {
      let items: { name: string; state?: string; startType?: string }[];
      if (d.platform === 'win32') {
        items = asArray(await ps(PS_SERVICES)).map((x) => ({
          name: typeof x.n === 'string' ? x.n : '',
          ...(typeof x.s === 'string' ? { state: x.s } : {}),
          ...(typeof x.t === 'string' ? { startType: x.t } : {}),
        }));
      } else if (d.platform === 'darwin') {
        const text = await cmd('/bin/launchctl', ['list']);
        items = text
          .split('\n')
          .slice(1)
          .filter((l) => l.trim() !== '')
          .map((l) => {
            const [pid = '-', , label = ''] = l.split('\t');
            return { name: label, state: pid === '-' ? 'stopped' : 'running' };
          });
      } else {
        const text = await cmd('/usr/bin/systemctl', [
          'list-units',
          '--type=service',
          '--all',
          '--no-pager',
          '--no-legend',
          '--plain',
        ]);
        items = text
          .split('\n')
          .filter((l) => l.trim() !== '')
          .map((l) => {
            const [unit = '', , active = '', sub = ''] = l.trim().split(/\s+/);
            return { name: unit, state: `${active}/${sub}` };
          });
      }
      if (items.length > MAX_ITEMS) truncated = true;
      out.services = items
        .filter((i) => i.name !== '')
        .slice(0, MAX_ITEMS)
        .map((i) => ({
          name: r(i.name, 200),
          ...(i.state === undefined ? {} : { state: r(i.state, 64) }),
          ...(i.startType === undefined ? {} : { startType: r(i.startType, 64) }),
        }));
    });
  }
  if (sections.includes('disk')) {
    await attempt('disk', async () => {
      if (d.platform === 'win32') {
        out.disk = asArray(await ps(PS_DISK))
          .slice(0, 32)
          .map((x) => ({
            mount: r(typeof x.m === 'string' ? x.m : '', 256),
            freeBytes: typeof x.f === 'number' && x.f >= 0 ? x.f : null,
            totalBytes: typeof x.t === 'number' && x.t >= 0 ? x.t : null,
          }));
        return;
      }
      const text = await cmd('/bin/df', ['-P', '-k']);
      out.disk = text
        .split('\n')
        .slice(1)
        .filter((l) => l.trim() !== '')
        .map((l) => l.trim().split(/\s+/))
        .filter((c) => c.length >= 6 && (c[0] ?? '').startsWith('/'))
        .slice(0, 32)
        .map((c) => ({
          mount: r(c.slice(5).join(' '), 256),
          freeBytes: Number.isFinite(Number(c[3])) ? Number(c[3]) * 1024 : null,
          totalBytes: Number.isFinite(Number(c[1])) ? Number(c[1]) * 1024 : null,
        }));
    });
  }
  if (sections.includes('logs')) {
    await attempt('logs', async () => {
      const lines = await d.logs();
      if (lines.length > 200) truncated = true;
      out.logs = lines.slice(-200).map((l) => r(l, 512));
    });
  }
  if (sections.includes('tools')) {
    await attempt('tools', async () => {
      out.tools = await d.tools();
    });
  }
  if (problems.length > 0) out.problems = problems.slice(0, 8);
  out.truncated = truncated;
  return out;
}
