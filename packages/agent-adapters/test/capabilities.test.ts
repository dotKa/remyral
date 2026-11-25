import { inspect } from 'node:util';
import { RuntimeCapabilities } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import {
  ADAPTER_CAPABILITIES,
  applyVersionGate,
  assertPinnedVersion,
  capabilityKeyId,
  CapabilityUnsupportedError,
  containsSecret,
  CursorExpiredError,
  defineCapabilitySet,
  redactSecrets,
  requireCapability,
  SecretValue,
  SessionEventLog,
  toProtocolCapabilities,
  VersionMismatchError,
} from '../src/index.js';

const key = { runtime: 'pi', version: '1.1.0', os: 'darwin', arch: 'arm64' } as const;

describe('capability set (ADR-0008)', () => {
  it('defaults unmentioned capabilities to unverified with a reason', () => {
    const set = defineCapabilitySet(key, { streaming: { status: 'supported' } });
    for (const cap of ADAPTER_CAPABILITIES) {
      if (cap === 'streaming') continue;
      expect(set.capabilities[cap].status).toBe('unverified');
      expect(set.capabilities[cap].reason).toBeTruthy();
    }
    expect(Object.isFrozen(set.capabilities)).toBe(true);
  });

  it('requires a reason for non-supported statuses', () => {
    expect(() => defineCapabilitySet(key, { approval: { status: 'unsupported', reason: ' ' } })).toThrow(
      /requires a reason/,
    );
  });

  it('requireCapability: supported/degraded pass, unsupported/unverified throw typed errors', () => {
    const set = defineCapabilitySet(key, {
      streaming: { status: 'supported' },
      cancel: { status: 'degraded', reason: 'cancel = process kill' },
      approval: { status: 'unsupported', reason: 'no native approvals' },
    });
    expect(requireCapability(set, 'streaming').status).toBe('supported');
    expect(requireCapability(set, 'cancel').status).toBe('degraded');
    let err: unknown;
    try {
      requireCapability(set, 'approval');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CapabilityUnsupportedError);
    expect(err).toMatchObject({
      code: 'capability_unsupported',
      capability: 'approval',
      status: 'unsupported',
      runtime: 'pi',
    });
    expect(() => requireCapability(set, 'resume')).toThrow(CapabilityUnsupportedError);
    expect(requireCapability(set, 'resume', { allowUnverified: true }).status).toBe('unverified');
    expect(() => requireCapability(set, 'approval', { allowUnverified: true })).toThrow(
      CapabilityUnsupportedError,
    );
  });

  it('version gate downgrades offered capabilities to unverified, keeps unsupported', () => {
    const set = defineCapabilitySet(key, {
      streaming: { status: 'supported' },
      cancel: { status: 'degraded', reason: 'kill' },
      approval: { status: 'unsupported', reason: 'none' },
    });
    expect(applyVersionGate(set, '1.1.0')).toBe(set);
    const gated = applyVersionGate(set, '1.2.0');
    expect(gated.capabilities.streaming).toEqual({
      status: 'unverified',
      reason: 'installed version 1.1.0 differs from pinned 1.2.0',
    });
    expect(gated.capabilities.cancel.status).toBe('unverified');
    expect(gated.capabilities.approval.status).toBe('unsupported');
  });

  it('assertPinnedVersion throws VersionMismatchError', () => {
    expect(() => {
      assertPinnedVersion('codex', '0.162.1', '0.162.1');
    }).not.toThrow();
    expect(() => {
      assertPinnedVersion('codex', '0.162.1', '0.163.0');
    }).toThrow(VersionMismatchError);
    expect(() => {
      assertPinnedVersion('codex', '0.162.1', undefined, { allowUnpinned: true });
    }).toThrow(VersionMismatchError);
    expect(() => {
      assertPinnedVersion('codex', '0.162.1', '0.163.0', { allowUnpinned: true });
    }).not.toThrow();
  });

  it('projects onto the protocol CAPABILITIES payload', () => {
    const set = defineCapabilitySet(key, { streaming: { status: 'supported' } });
    const caps = toProtocolCapabilities(set);
    expect(caps.safe_cancel?.status).toBe('unverified');
    const parsed = RuntimeCapabilities.parse({
      runtime: 'pi',
      version: '1.1.0',
      installed: true,
      authenticated: 'unknown',
      capabilities: caps,
    });
    expect(parsed.capabilities.streaming).toEqual({ status: 'supported' });
    expect(parsed.capabilities.approval?.status).toBe('unverified');
    expect(capabilityKeyId(key)).toBe('pi@1.1.0/darwin-arm64');
  });
});

describe('SecretValue', () => {
  it('never renders its value', () => {
    const s = new SecretValue('top-secret');
    expect(String(s)).toBe('[REDACTED]');
    expect(`x${String(s)}`).toBe('x[REDACTED]');
    expect(JSON.stringify({ s })).toBe('{"s":"[REDACTED]"}');
    expect(inspect({ s })).not.toContain('top-secret');
    expect(Object.keys(s)).toEqual([]);
    expect(s.reveal()).toBe('top-secret');
    expect(redactSecrets('a top-secret b top-secret', { K: s })).toBe('a [REDACTED] b [REDACTED]');
    expect(containsSecret('xx top-secret', { K: s })).toBe(true);
    expect(() => new SecretValue('')).toThrow();
  });
});

describe('SessionEventLog', () => {
  const clock = () => new Date('2026-10-12T00:00:00.000Z');

  it('assigns gapless seqs and closes on the terminal event', () => {
    const log = new SessionEventLog({ clock });
    log.append({ kind: 'status', phase: 'starting' });
    const last = log.append({ kind: 'status', phase: 'stopped' });
    expect(last).toEqual({
      seq: 2,
      at: '2026-10-12T00:00:00.000Z',
      event: { kind: 'status', phase: 'stopped' },
    });
    expect(log.closed).toBe(true);
    expect(() => log.append({ kind: 'message', role: 'assistant', text: 'late' })).toThrow(/closed/);
  });

  it('live readers receive appended events and finish at the terminal event', async () => {
    const log = new SessionEventLog({ clock });
    const reader = (async () => {
      const seqs: number[] = [];
      for await (const e of log.read({ afterSeq: 0 })) seqs.push(e.seq);
      return seqs;
    })();
    log.append({ kind: 'status', phase: 'running' });
    await new Promise((r) => setImmediate(r));
    log.append({ kind: 'message', role: 'assistant', text: 'x' });
    log.append({ kind: 'status', phase: 'stopped' });
    expect(await reader).toEqual([1, 2, 3]);
  });

  it('expires cursors before the retention window', async () => {
    const log = new SessionEventLog({ maxRetained: 2, clock });
    for (let i = 0; i < 4; i++) log.append({ kind: 'message', role: 'assistant', text: String(i) });
    expect(log.oldestRetainedSeq).toBe(3);
    expect(log.snapshot({ afterSeq: 2 }).map((e) => e.seq)).toEqual([3, 4]);
    expect(() => log.snapshot({ afterSeq: 1 })).toThrow(CursorExpiredError);
    const it = log.read({ afterSeq: 0 });
    await expect(it.next()).rejects.toBeInstanceOf(CursorExpiredError);
    expect(() => log.snapshot({ afterSeq: -1 })).toThrow(RangeError);
  });

  it('an aborted reader stops quietly', async () => {
    const log = new SessionEventLog({ clock });
    const ac = new AbortController();
    const reader = (async () => {
      const out: number[] = [];
      for await (const e of log.read(undefined, ac.signal)) out.push(e.seq);
      return out;
    })();
    log.append({ kind: 'status', phase: 'running' });
    await new Promise((r) => setImmediate(r));
    ac.abort();
    expect(await reader).toEqual([1]);
  });
});
