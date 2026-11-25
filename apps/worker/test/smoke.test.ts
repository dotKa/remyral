import { describe, expect, it } from 'vitest';
import { EXIT_OK, main } from '../src/cli.js';
import { ProbeReport } from '../src/probe/report.js';
import { createNodeSystem } from '../src/system/node.js';

// Real smoke test: runs `probe --json` (no self-test) against the actual host — the
// developer Mac locally, and every CI runner (Linux x64/arm64, macOS, Windows).
describe('probe smoke test on this host', () => {
  it('produces a ProbeReport that validates', { timeout: 120_000 }, async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(['probe', '--json'], createNodeSystem(), {
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    });
    expect(err.join('')).toBe('');
    expect(code).toBe(EXIT_OK);
    const report = ProbeReport.parse(JSON.parse(out.join('')));
    expect(report.host.facts).not.toBeNull();
    expect(report.host.facts?.os).toBe(process.platform);
    expect(report.runtimes).toHaveLength(4);
    expect(report.tools.find((t) => t.name === 'node')?.version).toBe(process.versions.node);
    expect(report.problems.some((p) => p.code === 'probe.section_failed')).toBe(false);
  });
});
