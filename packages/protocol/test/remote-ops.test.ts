import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  Capabilities,
  isAllowedLoginUrl,
  leaseKeyId,
  MasterToWorker,
  MAX_OPS_COMMAND_TTL_MS,
  OpsCommandPayload,
  opsCommandStatement,
  opsCommandWindow,
  type OpsOperation,
  OpsUpdatePayload,
  RemoteOpsReport,
  signOpsCommand,
  verifyOpsCommand,
  WorkerFeature,
  WorkerToMaster,
} from '../src/index.js';
import { masterMessages, workerMessages } from './fixtures.js';

function masterKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' }).x as string;
  return { privateKey, lease: { kid: leaseKeyId(raw), publicKey: raw } };
}

const base = {
  workerId: 'wrk_mac1',
  commandId: '00000000-0000-4000-8000-0000000000a1',
  issuedAt: '2026-10-14T10:00:00.000Z',
  expiresAt: '2026-10-14T10:02:00.000Z',
};
const install: OpsOperation = { kind: 'runtime.install', runtime: 'codex', version: '0.162.1' };

describe('OPS_COMMAND signatures', () => {
  it('verifies a signature bound to worker, command, window and operation', () => {
    const k = masterKey();
    const sig = signOpsCommand({ ...base, op: install }, k.lease.kid, k.privateKey);
    expect(verifyOpsCommand({ ...base, op: install }, sig, [k.lease])).toBe('ok');
    // Any change of binding breaks it.
    expect(verifyOpsCommand({ ...base, workerId: 'wrk_other', op: install }, sig, [k.lease])).toBe(
      'bad_signature',
    );
    expect(
      verifyOpsCommand({ ...base, commandId: '00000000-0000-4000-8000-0000000000a2', op: install }, sig, [
        k.lease,
      ]),
    ).toBe('bad_signature');
    expect(verifyOpsCommand({ ...base, op: { ...install, version: '0.161.0' } }, sig, [k.lease])).toBe(
      'bad_signature',
    );
    expect(
      verifyOpsCommand({ ...base, expiresAt: '2026-10-14T10:04:00.000Z', op: install }, sig, [k.lease]),
    ).toBe('bad_signature');
    expect(verifyOpsCommand({ ...base, op: install }, undefined, [k.lease])).toBe('missing');
    expect(verifyOpsCommand({ ...base, op: install }, sig, [masterKey().lease])).toBe('unknown_key');
  });

  it('statement is canonical in the operation key order', () => {
    const a = opsCommandStatement({ ...base, op: { kind: 'logs.tail', lines: 10, maxBytes: 2048 } });
    const b = opsCommandStatement({
      ...base,
      op: JSON.parse('{"maxBytes":2048,"lines":10,"kind":"logs.tail"}') as OpsOperation,
    });
    expect(a.equals(b)).toBe(true);
  });

  it('checks the validity window with bounded skew', () => {
    const at = (iso: string) => new Date(iso);
    expect(opsCommandWindow(base, at('2026-10-14T10:01:00.000Z'))).toBe('ok');
    expect(opsCommandWindow(base, at('2026-10-14T10:03:59.000Z'))).toBe('ok'); // within skew
    expect(opsCommandWindow(base, at('2026-10-14T10:05:00.000Z'))).toBe('expired');
    expect(opsCommandWindow(base, at('2026-10-14T09:55:00.000Z'))).toBe('not_yet_valid');
    const long = new Date(Date.parse(base.issuedAt) + MAX_OPS_COMMAND_TTL_MS + 1000).toISOString();
    expect(opsCommandWindow({ ...base, expiresAt: long }, at(base.issuedAt))).toBe('window_too_long');
  });
});

describe('OPS_COMMAND schema', () => {
  it('accepts every operation kind and refuses free-form arguments', () => {
    const ops: OpsOperation[] = [
      install,
      { kind: 'runtime.remove', runtime: 'pi', version: '1.1.0' },
      { kind: 'runtime.restart', runtime: 'opencode' },
      { kind: 'login.start', runtime: 'claude-code' },
      { kind: 'login.input', target: base.commandId, code: 'abcDEF123_-~.#state' },
      { kind: 'login.status', runtime: 'codex' },
      { kind: 'login.logout', runtime: 'codex' },
      { kind: 'ops.cancel', target: base.commandId },
      { kind: 'service.restart', drain: true, drainTimeoutSec: 600 },
      { kind: 'logs.tail', lines: 200, maxBytes: 65536 },
      { kind: 'diagnostics.run' },
    ];
    for (const op of ops) expect(OpsCommandPayload.safeParse({ ...base, op }).success).toBe(true);
    const bad = [
      { kind: 'runtime.install', runtime: 'codex', version: 'latest' },
      { kind: 'runtime.install', runtime: 'codex', version: '0.162.1; rm -rf /' },
      { kind: 'runtime.install', runtime: 'bash', version: '1.0.0' },
      { kind: 'login.start', runtime: 'openhands' }, // ADR-0023: a retired runtime is refused
      { kind: 'login.input', target: base.commandId, code: 'has space' },
      { kind: 'logs.tail', lines: 100000, maxBytes: 1024 },
      { kind: 'runtime.install', runtime: 'codex', version: '0.162.1', url: 'https://evil.example/x.tgz' },
    ];
    for (const op of bad.slice(0, 6))
      expect(OpsCommandPayload.safeParse({ ...base, op }).success).toBe(false);
    // Unknown fields are stripped (ADR-0011 §4): a URL can never reach the installer.
    const parsed = OpsCommandPayload.parse({ ...base, op: bad[6] });
    expect(parsed.op).toEqual(install);
  });

  it('is part of the master message union and the feature list', () => {
    expect(MasterToWorker.safeParse(masterMessages.OPS_COMMAND).success).toBe(true);
    expect(WorkerToMaster.safeParse(workerMessages.OPS_UPDATE).success).toBe(true);
    expect(WorkerFeature.safeParse('remote-ops-v1').success).toBe(true);
  });
});

describe('OPS_UPDATE login relay', () => {
  it('allows only the providers’ https sign-in hosts', () => {
    expect(isAllowedLoginUrl('https://claude.com/cai/oauth/authorize?code=true&x=1')).toBe(true);
    expect(isAllowedLoginUrl('https://auth.openai.com/codex/device')).toBe(true);
    expect(isAllowedLoginUrl('http://auth.openai.com/codex/device')).toBe(false);
    expect(isAllowedLoginUrl('https://auth.openai.com.evil.example/')).toBe(false);
    expect(isAllowedLoginUrl('https://user:pw@claude.com/')).toBe(false);
    expect(isAllowedLoginUrl('https://claude.com:8443/')).toBe(false);
    expect(isAllowedLoginUrl('javascript:alert(1)')).toBe(false);
  });

  it('carries no free-form output: a token-shaped device code or a foreign URL is invalid', () => {
    const update = (login: Record<string, unknown>) =>
      OpsUpdatePayload.safeParse({
        commandId: base.commandId,
        seq: 1,
        kind: 'login.start',
        state: 'waiting_for_user',
        login: { runtime: 'claude-code', expectsCode: true, ...login },
      }).success;
    expect(update({ url: 'https://claude.com/cai/oauth/authorize?code=true' })).toBe(true);
    expect(update({ url: 'https://evil.example/collect' })).toBe(false);
    expect(update({ userCode: 'sk-ant-oat01-abcdefghijklmnop' })).toBe(false);
    // An unknown `token` field is stripped, never relayed.
    const parsed = OpsUpdatePayload.parse({
      commandId: base.commandId,
      seq: 1,
      kind: 'login.start',
      state: 'succeeded',
      login: { runtime: 'codex', expectsCode: false, token: 'secret-token-value' },
    });
    expect(JSON.stringify(parsed)).not.toContain('secret-token-value');
  });

  it('bounds log chunks and requires the worker’s redaction assertion', () => {
    const chunk = (lines: string[], redacted: unknown = true) =>
      OpsUpdatePayload.safeParse({
        commandId: base.commandId,
        seq: 3,
        kind: 'logs.tail',
        state: 'running',
        logs: { lines, truncated: false, redacted, last: false },
      }).success;
    expect(chunk(['a', 'b'])).toBe(true);
    expect(chunk(['a'], false)).toBe(false);
    expect(chunk(Array.from({ length: 201 }, () => 'x'))).toBe(false);
    expect(chunk(['x'.repeat(4097)])).toBe(false);
  });
});

describe('CAPABILITIES.remoteOps', () => {
  it('parses a report', () => {
    const report = {
      runtimes: [
        {
          runtime: 'codex',
          method: 'npm',
          supported: true,
          pinned: '0.162.1',
          available: ['0.162.1'],
          installed: [{ version: '0.162.1', installedAt: '2026-10-14T10:00:00.000Z', integrity: 'ok' }],
          active: '0.162.1',
        },
      ],
      login: [{ runtime: 'claude-code', status: 'logged_in', method: 'claude.ai' }],
      service: { manager: 'systemd', restartable: true },
      logs: { available: true, bytes: 1024 },
    };
    expect(RemoteOpsReport.safeParse(report).success).toBe(true);
    const caps = Capabilities.safeParse({
      ...workerMessages.CAPABILITIES,
      payload: { ...(workerMessages.CAPABILITIES.payload as object), remoteOps: report },
    });
    expect(caps.success).toBe(true);
  });
});
