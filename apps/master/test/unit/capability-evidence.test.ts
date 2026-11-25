import { AssignJob } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import {
  buildVerifiedIndex,
  effectiveCapabilities,
  overlaidCapabilities,
  type ReportedRuntime,
  verifiedList,
} from '../../src/capability-evidence/overlay.js';
import { verificationState } from '../../src/capability-evidence/service.js';
import type { LeaseSigner } from '../../src/orchestration/lease-signer.js';
import { assignPayload } from '../../src/orchestration/messages.js';
import { capabilityStatuses } from '../../src/orchestration/orchestrator.js';

/** p17-runtime-verify (master, pure): the precedence rules, expiry by tuple, placement facts, ASSIGN_JOB. */

const REV = 'pi-adapter/1+pin1.4.0';
const DECLARED = {
  streaming: 'supported',
  interactive_prompt: 'supported',
  approval: 'degraded',
  cancel: 'supported',
  safe_cancel: 'degraded',
  resume: 'degraded',
  cost_reporting: 'degraded',
  artifacts: 'unsupported',
};
const caps = (over: Record<string, string> = {}) =>
  Object.fromEntries(
    Object.keys(DECLARED).map((c) => [
      c,
      { status: over[c] ?? (c === 'artifacts' ? 'unsupported' : 'unverified'), note: 'static' },
    ]),
  );

const runtime = (over: Partial<ReportedRuntime> = {}): ReportedRuntime => ({
  runtime: 'pi',
  version: '1.4.0',
  os: 'win32',
  arch: 'x64',
  adapterVersion: REV,
  declared: DECLARED,
  capabilities: caps(),
  ...over,
});

const run = (
  id: string,
  finishedAt: string,
  results: Record<string, 'passed' | 'failed' | 'skipped'>,
  over: Partial<{ runtimeVersion: string; os: string; arch: string; adapterVersion: string }> = {},
) => ({
  evidenceId: id,
  workerId: 'w-1',
  runtime: 'pi',
  runtimeVersion: '1.4.0',
  os: 'win32',
  arch: 'x64',
  adapterVersion: REV,
  finishedAt,
  results: Object.entries(results).map(([capability, status]) => ({
    capability,
    status,
    reason: `${capability} ${status}`,
  })),
  ...over,
});

describe('evidence index', () => {
  it('per tuple and capability the newest decided run counts; skipped changes nothing', () => {
    const index = buildVerifiedIndex([
      run('old', '2026-10-27T09:00:00.000Z', {
        streaming: 'passed',
        cancel: 'passed',
        safe_cancel: 'passed',
      }),
      run('new', '2026-10-27T10:00:00.000Z', {
        streaming: 'passed',
        cancel: 'failed',
        safe_cancel: 'skipped',
      }),
    ]);
    const eff = effectiveCapabilities(runtime(), index);
    const of = (c: string) => eff.find((e) => e.capability === c);
    expect(of('streaming')).toMatchObject({
      effective: 'supported',
      verified: true,
      decided: { evidenceId: 'new' },
    });
    // A newer failure revokes the earlier pass and says why.
    expect(of('cancel')).toMatchObject({
      effective: 'unverified',
      verified: false,
      decided: { outcome: 'failed', reason: 'cancel failed' },
    });
    // The newer run skipped it: the older pass stands.
    expect(of('safe_cancel')).toMatchObject({
      effective: 'degraded',
      verified: true,
      decided: { evidenceId: 'old' },
    });
    expect(of('resume')).toMatchObject({ effective: 'unverified', decided: null });
  });

  it('never above the declared table, never changes a reported supported / degraded / unsupported', () => {
    const index = buildVerifiedIndex([
      run('r', '2026-10-27T10:00:00.000Z', { streaming: 'passed', artifacts: 'passed', approval: 'passed' }),
    ]);
    const eff = effectiveCapabilities(
      runtime({
        capabilities: caps({ approval: 'degraded' }),
        declared: { ...DECLARED, streaming: 'degraded' },
      }),
      index,
    );
    const of = (c: string) => eff.find((e) => e.capability === c);
    expect(of('streaming')?.effective).toBe('degraded');
    expect(of('artifacts')).toMatchObject({ effective: 'unsupported', verified: false });
    expect(of('approval')).toMatchObject({ reported: 'degraded', effective: 'degraded', verified: false });
  });

  it('expires with the runtime version, the adapter revision or another platform; older workers get nothing', () => {
    const index = buildVerifiedIndex([run('r', '2026-10-27T10:00:00.000Z', { streaming: 'passed' })]);
    const lifted = (r: ReportedRuntime) => verifiedList(r, index);
    expect(lifted(runtime())).toEqual(['streaming']);
    expect(lifted(runtime({ version: '1.5.0' }))).toEqual([]);
    expect(lifted(runtime({ adapterVersion: 'pi-adapter/2+pin1.4.0' }))).toEqual([]);
    expect(lifted(runtime({ arch: 'arm64' }))).toEqual([]);
    expect(lifted(runtime({ adapterVersion: null, declared: null }))).toEqual([]);
  });

  it('placement facts use the effective status (the reported shape, with a verified marker)', () => {
    const index = buildVerifiedIndex([
      run('r', '2026-10-27T10:00:00.000Z', { streaming: 'passed', cancel: 'passed', approval: 'passed' }),
    ]);
    const overlaid = overlaidCapabilities(runtime(), index);
    expect(overlaid.streaming).toMatchObject({ status: 'supported', verified: true });
    expect(overlaid.resume).toEqual({ status: 'unverified', note: 'static' });
    expect(capabilityStatuses(overlaid)).toMatchObject({
      streaming: 'supported',
      cancel: 'supported',
      approval: 'degraded',
      resume: 'unverified',
      artifacts: 'unsupported',
    });
  });

  it('the panel state: verified / partial / unverified / not applicable', () => {
    const all = Object.fromEntries(Object.keys(DECLARED).map((c) => [c, 'passed' as const]));
    expect(
      verificationState(
        effectiveCapabilities(runtime(), buildVerifiedIndex([run('a', '2026-10-27T10:00:00.000Z', all)])),
      ),
    ).toBe('verified');
    expect(
      verificationState(
        effectiveCapabilities(
          runtime(),
          buildVerifiedIndex([run('a', '2026-10-27T10:00:00.000Z', { streaming: 'passed' })]),
        ),
      ),
    ).toBe('partial');
    expect(verificationState(effectiveCapabilities(runtime(), buildVerifiedIndex([])))).toBe('unverified');
    expect(
      verificationState(effectiveCapabilities(runtime({ capabilities: null }), buildVerifiedIndex([]))),
    ).toBe('not_applicable');
  });
});

describe('ASSIGN_JOB execution.verifiedCapabilities', () => {
  const signer = { sign: () => 'token' } as unknown as LeaseSigner;
  const lease = {
    id: '1',
    jobId: 'j',
    attemptId: 'a',
    workerId: 'w',
    epoch: 1,
    acquiredAt: new Date(0),
    expiresAt: new Date(60_000),
    releasedAt: null,
    releaseReason: null,
  };
  const spec = {
    runtime: 'pi',
    prompt: 'p',
    sandboxProfile: 'host-restricted',
    approvalPolicy: 'ask-sensitive',
    limits: { maxDurationSec: 60 },
  } as unknown as Parameters<typeof assignPayload>[1]['spec'];

  it('is sent only when evidence applies, and is valid on the wire', () => {
    const verified = {
      runtime: 'pi' as const,
      runtimeVersion: '1.4.0',
      os: 'win32' as const,
      arch: 'x64' as const,
      adapterVersion: REV,
      capabilities: ['streaming' as const, 'cancel' as const],
    };
    const on = assignPayload(
      signer,
      { lease, project: 'acme', spec, verifiedCapabilities: verified },
      new Date(0),
    );
    expect(on.execution?.verifiedCapabilities).toEqual(verified);
    expect(AssignJob.shape.payload.shape.execution.unwrap().safeParse(on.execution).success).toBe(true);
    const off = assignPayload(signer, { lease, project: 'acme', spec }, new Date(0));
    expect(off.execution).not.toHaveProperty('verifiedCapabilities');
  });
});
