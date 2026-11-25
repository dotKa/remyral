import type { ProbeReport } from './report.js';

const GIB = 1024 ** 3;

function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

function gib(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

/** Human-readable rendering of a {@link ProbeReport}. `--json` prints the report itself. */
export function formatReport(report: ProbeReport): string {
  const out: string[] = [];
  const f = report.host.facts;
  out.push(
    `Remyral worker probe ${report.probe.workerVersion} — ${report.probedAt} (${String(report.probe.durationMs)} ms)`,
  );
  out.push('');
  out.push('HOST');
  out.push(
    table(
      f
        ? [
            ['hostname', f.hostname],
            ['os', `${f.os} — ${f.osVersion}`],
            ['arch', f.arch + (report.host.raw.hardwareModel ? ` (${report.host.raw.hardwareModel})` : '')],
            ['cpus', String(f.cpuCount)],
            ['memory', gib(f.memoryBytes)],
            ['disk free', `${gib(f.diskFreeBytes)} (${report.host.raw.diskPath})`],
            ['node', report.host.raw.nodeVersion],
          ]
        : [
            ['platform', report.host.raw.platform],
            ['arch', `${report.host.raw.arch} (machine ${report.host.raw.machine})`],
            ['node', report.host.raw.nodeVersion],
            ['facts', 'UNSUPPORTED PLATFORM — see problems'],
          ],
    ),
  );
  out.push('');
  out.push('TOOLS');
  out.push(
    table([
      ['tool', 'found', 'version', 'details'],
      ...report.tools.map((t) => [
        t.name,
        t.found ? 'yes' : 'no',
        t.version ?? '-',
        t.details
          ? Object.entries(t.details)
              .map(([k, v]) => `${k}=${String(v)}`)
              .join(' ')
          : '',
      ]),
    ]),
  );
  out.push('');
  out.push('RUNTIMES');
  out.push(
    table([
      ['runtime', 'installed', 'version', 'pin', 'pin status', 'self-test'],
      ...report.runtimes.map((r) => [
        r.runtime,
        r.capabilities.installed ? 'yes' : 'no',
        r.capabilities.installed ? r.capabilities.version : '-',
        r.pin,
        r.pinStatus,
        r.selfTest ? r.selfTest.status : '-',
      ]),
    ]),
  );
  for (const r of report.runtimes) {
    if (r.selfTest) {
      for (const c of r.selfTest.checks) {
        out.push(`  ${r.runtime}: [${c.ok ? 'ok' : 'FAIL'}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
      }
    }
  }
  out.push(
    '  capabilities: every installed runtime is "unverified" until contract-tested (ADR-0008); see --json.',
  );
  out.push('');
  out.push('SANDBOX PROFILES (ADR-0007)');
  out.push(
    table([
      ['profile', 'available', 'ready', 'notes'],
      ...report.sandboxProfiles.map((p) => [
        p.profile,
        p.available ? 'yes' : 'no',
        p.ready ? 'yes' : 'no',
        [p.runtimes && p.runtimes.length > 0 ? `runtimes: ${p.runtimes.join(', ')}` : '', ...p.notes]
          .filter(Boolean)
          .join('; '),
      ]),
    ]),
  );
  out.push('');
  const counts = { error: 0, warning: 0, info: 0 };
  for (const p of report.problems) counts[p.severity]++;
  out.push(
    `PROBLEMS (${String(counts.error)} error, ${String(counts.warning)} warning, ${String(counts.info)} info)`,
  );
  if (report.problems.length === 0) out.push('  none');
  for (const p of report.problems)
    out.push(`  ${p.severity.toUpperCase().padEnd(7)} ${p.code}: ${p.message}`);
  out.push('');
  return out.join('\n');
}
