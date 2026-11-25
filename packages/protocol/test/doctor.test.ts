import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_TOOLS,
  assistantToolInput,
  DEFAULT_SUPPORT_SECTIONS,
  DoctorFinding,
  findingKey,
  OpsOperation,
  OpsUpdatePayload,
  sortFindings,
  summarizeFindings,
  WorkerDoctorReport,
  WorkerFeatureList,
} from '../src/index.js';

/** p16-doctor: the finding / machine report wire, the doctor.run op, the support sections, the assistant tools. */
const report = {
  schemaVersion: 1,
  collectedAt: '2026-10-23T12:00:00.000Z',
  mode: 'local',
  workerVersion: '1.0.75',
  host: { platform: 'linux', release: '6.8', arch: 'x64', node: 'v24.11.0' },
  master: 'https://remyral.example.com',
  summary: { ok: 1, info: 0, warning: 0, error: 1 },
  findings: [
    {
      check: 'master.dns',
      code: 'dns_failed',
      severity: 'error',
      message: 'remyral.example.com does not resolve',
      params: { host: 'remyral.example.com' },
    },
    { check: 'config', code: 'ok', severity: 'ok', message: 'Config is valid' },
  ],
};

describe('doctor wire (p16-doctor)', () => {
  it('a machine report parses; closed ids, codes, severities and bounds are enforced', () => {
    expect(WorkerDoctorReport.safeParse(report).success).toBe(true);
    const bad = (f: Record<string, unknown>) =>
      DoctorFinding.safeParse({ check: 'disk', code: 'low', severity: 'warning', message: 'x', ...f })
        .success;
    expect(bad({})).toBe(true);
    expect(bad({ check: 'Disk Space' })).toBe(false);
    expect(bad({ code: 'low-disk' })).toBe(false);
    expect(bad({ severity: 'critical' })).toBe(false);
    expect(bad({ message: 'x'.repeat(501) })).toBe(false);
    expect(
      bad({ params: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`p${String(i)}`, i])) }),
    ).toBe(false);
    expect(
      WorkerDoctorReport.safeParse({
        ...report,
        findings: Array.from({ length: 65 }, () => report.findings[1]),
      }).success,
    ).toBe(false);
    expect(WorkerDoctorReport.safeParse({ ...report, schemaVersion: 2 }).success).toBe(false);
  });

  it('doctor.run is an op without parameters; OPS_UPDATE carries the report; doctor-v1 is a known feature', () => {
    expect(OpsOperation.safeParse({ kind: 'doctor.run' }).success).toBe(true);
    expect(OpsOperation.parse({ kind: 'doctor.run', extra: 1 })).toEqual({ kind: 'doctor.run' });
    const u = OpsUpdatePayload.parse({
      commandId: '6f9c2e1a-3b4d-4c5e-8f60-718293a4b5c6',
      seq: 1,
      kind: 'doctor.run',
      state: 'succeeded',
      doctor: report,
    });
    expect(u.doctor?.summary.error).toBe(1);
    expect(WorkerFeatureList.parse(['remote-ops-v1', 'doctor-v1'])).toEqual(['remote-ops-v1', 'doctor-v1']);
  });

  it('summary, identity and order of findings', () => {
    const fs = DoctorFinding.array().parse(report.findings);
    expect(summarizeFindings(fs)).toEqual({ ok: 1, info: 0, warning: 0, error: 1 });
    expect(findingKey({ check: 'workers.offline', code: 'offline', subject: 'wrk_x' })).toBe(
      'workers.offline|offline|wrk_x',
    );
    expect(sortFindings([...fs].reverse())[0]?.severity).toBe('error');
  });

  it('job prompts are never a default section of the support report', () => {
    expect(DEFAULT_SUPPORT_SECTIONS).not.toContain('job_prompts');
    expect(DEFAULT_SUPPORT_SECTIONS).toContain('logs');
  });

  it('run_diagnostics is a read, draft_support_report a draft with strict inputs', () => {
    expect(ASSISTANT_TOOLS.run_diagnostics.kind).toBe('read');
    expect(ASSISTANT_TOOLS.draft_support_report.kind).toBe('draft');
    expect(assistantToolInput('run_diagnostics').safeParse({ machines: true }).success).toBe(true);
    const d = assistantToolInput('draft_support_report');
    expect(
      d.safeParse({ description: 'Jobs fail', sections: ['doctor', 'logs'], hours: 24, ccMe: true }).success,
    ).toBe(true);
    expect(d.safeParse({}).success).toBe(false);
    expect(d.safeParse({ description: 'x', sections: ['secrets'] }).success).toBe(false);
    expect(d.safeParse({ description: 'x', hours: 100 }).success).toBe(false);
    expect(d.safeParse({ description: 'x', to: 'evil@example.com' }).success).toBe(false);
  });
});
