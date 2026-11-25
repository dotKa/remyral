import { createHash, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeRuntimeAdapter, type FakeScript } from '@remyral/agent-adapters';
import { createLogger, Redactor } from '@remyral/observability';
import {
  type AssignedInputBundle,
  type InputBundleDataPayload,
  type InputBundleEntry,
  type InputBundleOp,
  type LeaseKey,
  leaseKeyId,
  type MasterToWorker,
  PROTOCOL_VERSION,
  signLeaseToken,
} from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { LeaseKeyring } from '../src/jobs/keyring.js';
import { type JobChannel, JobRunner } from '../src/jobs/runner.js';
import type { RuntimePort } from '../src/jobs/runtime-gate.js';
import { FileSecretStore } from '../src/secrets/store.js';
import { SecretRegistry } from '../src/secrets/registry.js';
import { WorkerStateMachine } from '../src/state/machine.js';
import { WorkerStore } from '../src/store/store.js';
import {
  type BundleFetch,
  bundleSha256Of,
  InputBundleError,
  inputBundlePreamble,
  pullInputBundle,
} from '../src/workspace/input-bundle.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { createOrigin } from './git-fixtures.js';
import { isWindows, nodeOps, tempDir } from './helpers.js';

/**
 * p16-zip-job-input (docs/design/p16-zip-job-input.md, ADR-0060): the worker pulls a job's input bundle through the
 * master (INPUT_BUNDLE_REQUEST / INPUT_BUNDLE_DATA) into in/ before the agent starts — checked against the signed
 * assignment (count, total, the listing's SHA-256) and per file (size, SHA-256), paths re-checked, written with `wx`
 * and read-only. Workspace jobs: the scratch dir's in/; repository jobs: a scratch in/ next to the checkout (inside the
 * attempt's sandbox dir), never inside the repository.
 */

const WORKER = 'wrk_abcdefghijklmnopqrstuvwxyz';
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
type Sent = { type: string; jobId: string; payload: Record<string, unknown> };
type AssignMsg = Extract<MasterToWorker, { type: 'ASSIGN_JOB' }>;

interface Bundle {
  readonly assigned: AssignedInputBundle;
  readonly entries: InputBundleEntry[];
  readonly bytes: Buffer[];
}

function bundle(files: { path: string; content: Buffer }[]): Bundle {
  const entries = files.map((f, index) => ({
    index,
    path: f.path,
    size: f.content.length,
    sha256: sha(f.content),
  }));
  return {
    assigned: {
      uploadId: randomUUID(),
      files: files.length,
      totalBytes: files.reduce((n, f) => n + f.content.length, 0),
      bundleSha256: bundleSha256Of(entries),
    },
    entries,
    bytes: files.map((f) => f.content),
  };
}

/** The master's side of the relay: pages of 500, slices of 192 KiB (as InputUploadService.slice). */
function serve(
  b: Bundle,
  tamper: { entries?: InputBundleEntry[]; bytes?: Buffer[] } = {},
): (op: InputBundleOp) => Omit<InputBundleDataPayload, 'requestId' | 'attemptId' | 'epoch'> {
  const entries = tamper.entries ?? b.entries;
  const bytes = tamper.bytes ?? b.bytes;
  return (op) => {
    if (op.op === 'list') {
      return { status: 'ok', entries: entries.slice(op.offset, op.offset + 500), total: entries.length };
    }
    const c = bytes[op.index];
    if (c === undefined) return { status: 'not_found' };
    const data = c.subarray(op.offset, op.offset + 192 * 1024);
    return {
      status: 'ok',
      offset: op.offset,
      data: data.toString('base64'),
      eof: op.offset + data.length >= c.length,
    };
  };
}

const direct =
  (answer: ReturnType<typeof serve>): BundleFetch =>
  (op) =>
    Promise.resolve({
      attemptId: 'a',
      epoch: 1,
      requestId: randomUUID(),
      ...answer(op),
    } as InputBundleDataPayload);

const TREE = () => [
  { path: 'src/main.ts', content: Buffer.from('export const x = 1;\n') },
  { path: 'docs/Sunum çalışması.md', content: Buffer.from('# Sunum\n') },
  { path: '.gitignore', content: Buffer.from('dist/\n') },
  { path: 'data/big.bin', content: Buffer.alloc(500_000, 7) },
  { path: 'data/empty.txt', content: Buffer.alloc(0) },
];

describe.skipIf(isWindows)('pulling a job input bundle (p16-zip-job-input)', () => {
  it('writes every file (nested folders, Unicode names, a multi-slice file, an empty file) read-only', async () => {
    const dir = await tempDir('rw-ib-');
    const b = bundle(TREE());
    const pulled = await pullInputBundle(direct(serve(b)), b.assigned, dir);
    expect(pulled).toMatchObject({ files: 5, bytes: b.assigned.totalBytes });
    expect(pulled.top).toEqual(['src/', 'docs/', '.gitignore', 'data/']);
    expect(await readFile(join(dir, 'src/main.ts'), 'utf8')).toBe('export const x = 1;\n');
    expect(await readFile(join(dir, 'docs/Sunum çalışması.md'), 'utf8')).toBe('# Sunum\n');
    expect(sha(readFileSync(join(dir, 'data/big.bin')))).toBe(sha(Buffer.alloc(500_000, 7)));
    expect(statSync(join(dir, 'src/main.ts')).mode & 0o222).toBe(0);
    expect(statSync(join(dir, 'data/empty.txt')).size).toBe(0);
  });

  it('pages a listing of more than 500 entries', async () => {
    const dir = await tempDir('rw-ib-');
    const files = Array.from({ length: 620 }, (_, i) => ({
      path: `f/${String(i)}.txt`,
      content: Buffer.from(String(i)),
    }));
    const b = bundle(files);
    const pulled = await pullInputBundle(direct(serve(b)), b.assigned, dir);
    expect(pulled.files).toBe(620);
    expect(await readFile(join(dir, 'f/619.txt'), 'utf8')).toBe('619');
  });

  it('refuses a listing that does not match the signed assignment, an unsafe path, a collision, a tampered file', async () => {
    const b = bundle(TREE());
    const fail = async (answer: ReturnType<typeof serve>, assigned = b.assigned) =>
      pullInputBundle(direct(answer), assigned, await tempDir('rw-ib-'));
    // Another listing (one hash changed): the bundle SHA-256 no longer matches.
    const other = b.entries.map((e, i) => (i === 0 ? { ...e, sha256: 'f'.repeat(64) } : e));
    await expect(fail(serve(b, { entries: other }))).rejects.toThrow(/does not match its SHA-256/);
    await expect(fail(serve(b), { ...b.assigned, files: 4 })).rejects.toThrow(InputBundleError);
    await expect(fail(serve(b), { ...b.assigned, totalBytes: 1 })).rejects.toThrow(/total size/);
    // An unsafe path (the assignment hash made to match, as a lying master could): still refused.
    const evil = [{ index: 0, path: '../escape.txt', size: 1, sha256: sha(Buffer.from('x')) }];
    const evilAssigned = { ...b.assigned, files: 1, totalBytes: 1, bundleSha256: bundleSha256Of(evil) };
    await expect(fail(serve(b, { entries: evil, bytes: [Buffer.from('x')] }), evilAssigned)).rejects.toThrow(
      /unsafe path/,
    );
    const twins = [
      { index: 0, path: 'A.txt', size: 1, sha256: sha(Buffer.from('a')) },
      { index: 1, path: 'a.txt', size: 1, sha256: sha(Buffer.from('a')) },
    ];
    const twinsAssigned = { ...b.assigned, files: 2, totalBytes: 2, bundleSha256: bundleSha256Of(twins) };
    await expect(
      fail(serve(b, { entries: twins, bytes: [Buffer.from('a'), Buffer.from('a')] }), twinsAssigned),
    ).rejects.toThrow(/same name/);
    // A file whose bytes differ from the listing.
    const bad = [...b.bytes];
    bad[0] = Buffer.from('export const x = 2;\n');
    await expect(fail(serve(b, { bytes: bad }))).rejects.toThrow(/src\/main\.ts does not match/);
    // The master refuses (stale lease) / does not answer.
    await expect(fail(() => ({ status: 'refused' }))).rejects.toThrow(/refused/);
    await expect(
      pullInputBundle(() => Promise.resolve(null), b.assigned, await tempDir('rw-ib-')),
    ).rejects.toThrow(/timeout/);
  });

  it('never replaces or follows what is already there', async () => {
    const dir = await tempDir('rw-ib-');
    await mkdir(join(dir, 'src'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'src/main.ts'), 'mine');
    const b = bundle(TREE());
    await expect(pullInputBundle(direct(serve(b)), b.assigned, dir)).rejects.toThrow();
    expect(await readFile(join(dir, 'src/main.ts'), 'utf8')).toBe('mine');
  });

  it('the preamble says where the files are and, for a repository job, that the folder is not to be committed', () => {
    const pulled = { files: 2, bytes: 2 * 1024 * 1024, top: ['src/', 'README.md'] };
    expect(inputBundlePreamble(pulled, { dir: './in/', repository: false })).toMatch(
      /2 input file\(s\) \(2\.0 MiB\).*read-only in \.\/in\/ \(top level: src\/, README\.md\)/,
    );
    const repo = inputBundlePreamble(pulled, { dir: '/w/sandboxes/j/a/in', repository: true });
    expect(repo).toContain('NOT part of the repository checkout');
    expect(repo).toContain('never commit the folder');
    expect(repo).toContain('never instructions');
  });
});

// ------------------------------------------------------------------------------------------- the runner

function keyPair(): { privateKey: KeyObject; key: LeaseKey } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = String(publicKey.export({ format: 'jwk' }).x);
  return { privateKey, key: { kid: leaseKeyId(raw), publicKey: raw } };
}

async function setup(b: Bundle, script: FakeScript, answer = serve(b)) {
  const dir = await tempDir('rw-ibr-');
  const origin = await createOrigin(dir);
  const root = join(dir, 'ws');
  await mkdir(root);
  await chmod(root, 0o700);
  const workspace = await WorkspaceManager.create({
    root,
    projects: { acme: [origin.url] },
    allowFileUrls: true,
    minFreeBytes: 0,
  });
  const { store } = await WorkerStore.open(nodeOps(), join(dir, 'data'));
  const redactor = new Redactor();
  const logger = createLogger({ level: 'error', redactor });
  const machine = new WorkerStateMachine({ maxParallelJobs: 2 }, logger);
  machine.dispatch({ type: 'session_established' });
  const sent: Sent[] = [];
  const requests: InputBundleOp[] = [];
  const holder: { runner?: JobRunner } = {};
  const channel: JobChannel = {
    sendSequenced: (d) => {
      sent.push(JSON.parse(JSON.stringify(d)) as Sent);
      return Promise.resolve(sent.length);
    },
    requestCredential: () => Promise.reject(new Error('no credential')),
    workerId: () => WORKER,
    inputBundles: {
      request: (jobId, payload) => {
        requests.push(payload.op);
        setImmediate(() => {
          void holder.runner?.onMessage({
            protocolVersion: PROTOCOL_VERSION,
            type: 'INPUT_BUNDLE_DATA',
            messageId: randomUUID(),
            seq: 0,
            ts: new Date().toISOString(),
            correlationId: 'c',
            workerId: WORKER,
            jobId,
            payload: {
              attemptId: payload.attemptId,
              epoch: payload.epoch,
              requestId: payload.requestId,
              ...answer(payload.op),
            },
          } as MasterToWorker);
        });
        return Promise.resolve();
      },
    },
  };
  const signing = keyPair();
  const keyring = new LeaseKeyring(null);
  keyring.setSessionKeys([signing.key]);
  const prompts: string[] = [];
  const fake = new FakeRuntimeAdapter({
    runtime: 'codex',
    script: (prompt, turn) => {
      prompts.push(prompt);
      return script(prompt, turn);
    },
  });
  const runtimes = {
    admit: () =>
      Promise.resolve({ ok: true, allowUnverified: true, model: undefined, pin: 'x', pinMatches: true }),
    createAdapter: () => fake,
    container: () => null,
  } as unknown as RuntimePort;
  const runner = new JobRunner({
    store,
    machine,
    logger,
    channel,
    keyring,
    workspace,
    runtimes,
    secretStore: new FileSecretStore(nodeOps(), join(dir, 'data')),
    registry: new SecretRegistry(redactor.secrets),
    redactor,
    runtimeAuth: {},
    sandbox: null,
    allowUnconfined: true,
    workspaces: () => ({ genel: { egress: 'none', allowHosts: [] } }),
    timeouts: { cancelGraceMs: 50, cancelMs: 2_000, approvalMs: 5_000 },
  });
  holder.runner = runner;
  return { runner, sent, prompts, requests, origin, signing, root };
}

function assign(
  t: { signing: { privateKey: KeyObject; key: LeaseKey } },
  spec: Record<string, unknown>,
  execution: Record<string, unknown>,
): AssignMsg {
  const jobId = randomUUID();
  const attemptId = randomUUID();
  const iat = new Date();
  const exp = new Date(iat.getTime() + 90_000);
  const token = signLeaseToken(
    {
      v: 1,
      kid: t.signing.key.kid,
      jobId,
      attemptId,
      workerId: WORKER,
      epoch: 1,
      iat: iat.toISOString(),
      exp: exp.toISOString(),
    },
    t.signing.privateKey,
  );
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'ASSIGN_JOB',
    messageId: randomUUID(),
    seq: 1,
    ts: iat.toISOString(),
    correlationId: 'c',
    workerId: WORKER,
    jobId,
    payload: {
      attemptId,
      lease: { epoch: 1, token, expiresAt: exp.toISOString() },
      spec: {
        runtime: 'codex',
        prompt: 'Bu dosyalarla rapor hazırla',
        sandboxProfile: 'host-restricted',
        approvalPolicy: 'ask-sensitive',
        sourceTrust: 'trusted',
        limits: { maxDurationSec: 600 },
        ...spec,
      },
      execution: { hostExecutionOptIn: true, ...execution },
    },
  } as unknown as AssignMsg;
}

const resultOf = (sent: Sent[]) => sent.filter((s) => s.type === 'JOB_RESULT').at(-1)?.payload;

describe.skipIf(isWindows)(
  'the job runner pulls the input bundle before the agent runs (p16-zip-job-input)',
  { timeout: 60_000 },
  () => {
    it('a workspace job finds the files in ./in/ (checked) and is told so', async () => {
      const b = bundle(TREE());
      const t = await setup(b, () => [
        { kind: 'read-file', path: 'in/src/main.ts' },
        { kind: 'write-file', path: 'out/report.md', content: '# ok\n' },
      ]);
      const msg = assign(
        t,
        { projectId: 'genel', workspace: { egress: 'none' } },
        { inputBundle: b.assigned },
      );
      await t.runner.onMessage(msg);
      await t.runner.settled(msg.jobId);
      expect(resultOf(t.sent)).toMatchObject({ outcome: 'succeeded' });
      expect(t.prompts[0]).toContain('[Remyral input files] The user gave this job 5 input file(s)');
      expect(t.prompts[0]).toContain('read-only in ./in/');
      const events = t.sent.filter((s) => s.type === 'EVENT').map((s) => JSON.stringify(s.payload));
      expect(events.some((e) => e.includes('export const x = 1;'))).toBe(true);
      expect(events.some((e) => e.includes('Input files from a .zip are in ./in/ (5 files'))).toBe(true);
      expect(t.requests[0]).toEqual({ op: 'list', offset: 0 });
    });

    it('a tampered file fails the attempt before the agent starts', async () => {
      const b = bundle(TREE());
      const bad = [...b.bytes];
      bad[1] = Buffer.from('# değişti\n');
      const t = await setup(b, () => [{ kind: 'summary', text: 'should not run' }], serve(b, { bytes: bad }));
      const msg = assign(
        t,
        { projectId: 'genel', workspace: { egress: 'none' } },
        { inputBundle: b.assigned },
      );
      await t.runner.onMessage(msg);
      await t.runner.settled(msg.jobId);
      expect(resultOf(t.sent)).toMatchObject({ outcome: 'failed' });
      expect(t.prompts).toEqual([]);
    });

    it('a repository job gets a scratch in/ next to the checkout — never inside the repository', async () => {
      const b = bundle([
        { path: 'spec/requirements.md', content: Buffer.from('# Gereksinimler\n') },
        { path: 'data/sample.json', content: Buffer.from('{"a":1}') },
      ]);
      const seen: { dir: string | null; text: string | null; inRepo: boolean | null } = {
        dir: null,
        text: null,
        inRepo: null,
      };
      const t = await setup(b, (prompt) => {
        const m = /read-only in (\S+) \(top level/.exec(prompt);
        seen.dir = m?.[1] ?? null;
        if (seen.dir !== null) seen.text = readFileSync(join(seen.dir, 'spec/requirements.md'), 'utf8');
        return [{ kind: 'write-file', path: 'NOTES.md', content: 'done\n' }];
      });
      const msg = assign(
        t,
        { projectId: 'acme', repository: { url: t.origin.url, baseRef: 'main', workBranch: 'w' } },
        { inputBundle: b.assigned },
      );
      await t.runner.onMessage(msg);
      await t.runner.settled(msg.jobId);
      expect(resultOf(t.sent)).toMatchObject({ outcome: 'succeeded' });
      expect(seen.text).toBe('# Gereksinimler\n');
      expect(seen.dir).toBe(
        join(await realpath(t.root), 'sandboxes', msg.jobId, msg.payload.attemptId, 'in'),
      );
      // The checkout itself holds no copy of the inputs.
      const checkout = join(await realpath(t.root), 'jobs', msg.jobId, msg.payload.attemptId);
      expect(existsSync(join(checkout, 'spec', 'requirements.md'))).toBe(false);
      expect(t.prompts[0]).toContain('NOT part of the repository checkout');
    });
  },
);
