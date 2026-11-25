import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeRuntimeAdapter, type FakeScript } from '@remyral/agent-adapters';
import { createLogger, Redactor } from '@remyral/observability';
import {
  type InputRef,
  INPUT_CHUNK_BYTES,
  JobSpec,
  type LeaseKey,
  leaseKeyId,
  type MasterToWorker,
  PROTOCOL_VERSION,
  REPO_INPUTS_FEATURE,
  signLeaseToken,
  WorkerFeature,
} from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { LeaseKeyring } from '../src/jobs/keyring.js';
import {
  assertOutsideCheckout,
  existingDir,
  RepoInputsError,
  repoInputsPreamble,
} from '../src/jobs/repo-inputs.js';
import { type JobChannel, JobRunner } from '../src/jobs/runner.js';
import type { RuntimePort } from '../src/jobs/runtime-gate.js';
import { FileSecretStore } from '../src/secrets/store.js';
import { SecretRegistry } from '../src/secrets/registry.js';
import { WorkerStateMachine } from '../src/state/machine.js';
import { WorkerStore } from '../src/store/store.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { createOrigin } from './git-fixtures.js';
import { isWindows, nodeOps, tempDir } from './helpers.js';

/**
 * p19-repo-job-inputs (docs/design/p19-repo-job-inputs.md): a REPOSITORY job's input files (`JobSpec.repository.inputs`
 * — chat attachments, earlier outputs) are fetched through the master (JOB_INPUT_REQUEST, size + SHA-256 checked) into
 * the attempt's scratch in/ next to the checkout — outside the repository, so the platform's commit and push never
 * include them — read-only, before the agent starts; the agent is told the path.
 */

const WORKER = 'wrk_abcdefghijklmnopqrstuvwxyz';
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
type Sent = { type: string; jobId: string; payload: Record<string, unknown> };
type AssignMsg = Extract<MasterToWorker, { type: 'ASSIGN_JOB' }>;

/** A tiny valid PNG (signature + IHDR header bytes are enough for the worker: it checks size and SHA-256). */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(300_000, 7), // larger than one JOB_INPUT_DATA slice
]);
const NOTES = Buffer.from('# Eski teklif\n\nMavi başlık, iki sütun.\n');

interface File {
  readonly ref: InputRef;
  readonly content: Buffer;
}
const file = (inputId: string, name: string, mediaType: string, content: Buffer): File => ({
  ref: { inputId, name, mediaType, sizeBytes: content.length, sha256: sha(content) },
  content,
});
const FILES = (): File[] => [
  file('in-shot1', 'Ekran Goruntusu 1.png', 'image/png', PNG),
  file('in-notes', 'teklif.md', 'text/markdown', NOTES),
];

function keyPair(): { privateKey: KeyObject; key: LeaseKey } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = String(publicKey.export({ format: 'jwk' }).x);
  return { privateKey, key: { kid: leaseKeyId(raw), publicKey: raw } };
}

async function setup(files: File[], script: FakeScript, opts: { tamper?: boolean } = {}) {
  const dir = await tempDir('rw-rin-');
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
  const asked: string[] = [];
  const holder: { runner?: JobRunner } = {};
  const byId = new Map(files.map((f) => [f.ref.inputId, f]));
  const channel: JobChannel = {
    sendSequenced: (d) => {
      sent.push(JSON.parse(JSON.stringify(d)) as Sent);
      return Promise.resolve(sent.length);
    },
    requestCredential: () => Promise.reject(new Error('no credential')),
    workerId: () => WORKER,
    requestInput: (jobId, payload) => {
      asked.push(`${payload.inputId}@${String(payload.offset)}`);
      const f = byId.get(payload.inputId);
      const content = f === undefined ? Buffer.alloc(0) : f.content;
      const slice = content.subarray(payload.offset, payload.offset + INPUT_CHUNK_BYTES);
      const data = opts.tamper === true && payload.offset === 0 ? Buffer.from(slice).fill(1, 0, 4) : slice;
      setImmediate(() => {
        void holder.runner?.onMessage({
          protocolVersion: PROTOCOL_VERSION,
          type: 'JOB_INPUT_DATA',
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
            inputId: payload.inputId,
            status: f === undefined ? 'not_found' : 'ok',
            offset: payload.offset,
            data: data.toString('base64'),
            eof: payload.offset + slice.length >= content.length,
          },
        } as MasterToWorker);
      });
      return Promise.resolve();
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
    timeouts: { cancelGraceMs: 50, cancelMs: 2_000, approvalMs: 5_000 },
  });
  holder.runner = runner;
  return { runner, sent, prompts, asked, origin, signing, root };
}

function assign(
  t: { signing: { privateKey: KeyObject; key: LeaseKey }; origin: { url: string } },
  inputs: readonly InputRef[],
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
        projectId: 'acme',
        runtime: 'codex',
        prompt: 'Eski teklifin tasarımını ekran görüntülerine göre yeniden kur',
        repository: {
          url: t.origin.url,
          baseRef: 'main',
          workBranch: 'w',
          ...(inputs.length === 0 ? {} : { inputs }),
        },
        sandboxProfile: 'host-restricted',
        approvalPolicy: 'ask-sensitive',
        sourceTrust: 'trusted',
        limits: { maxDurationSec: 600 },
      },
      execution: { hostExecutionOptIn: true, pushResult: true },
    },
  } as unknown as AssignMsg;
}

const resultOf = (sent: Sent[]) => sent.filter((s) => s.type === 'JOB_RESULT').at(-1)?.payload;
const gitOut = (gitDir: string, ...args: string[]): string =>
  execFileSync('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8' }).trim();

describe('repository job inputs: wire and helpers (p19-repo-job-inputs)', () => {
  it('JobSpec.repository.inputs parses (1..10 inputs) and the features are known', () => {
    const base = {
      runtime: 'codex',
      prompt: 'p',
      repository: { url: 'https://example.com/a.git', baseRef: 'main', workBranch: 'w' },
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 60 },
    };
    const one = FILES()[1]?.ref;
    const ok = JobSpec.safeParse({ ...base, repository: { ...base.repository, inputs: [one] } });
    expect(ok.success, JSON.stringify(ok.error?.issues)).toBe(true);
    expect(ok.data?.repository?.inputs).toHaveLength(1);
    const many = Array.from({ length: 11 }, (_, i) => ({ ...one, inputId: `in-x${String(i)}` }));
    expect(JobSpec.safeParse({ ...base, repository: { ...base.repository, inputs: many } }).success).toBe(
      false,
    );
    expect(JobSpec.safeParse({ ...base, repository: { ...base.repository, inputs: [] } }).success).toBe(
      false,
    );
    expect(
      JobSpec.safeParse({
        ...base,
        repository: { ...base.repository, inputs: [{ ...one, name: '../x.md' }] },
      }).success,
    ).toBe(false);
    expect(WorkerFeature.safeParse(REPO_INPUTS_FEATURE).success).toBe(true);
    expect(WorkerFeature.safeParse('assistant-repo-inputs-v1').success).toBe(true);
  });

  it('the input folder must lie outside the checkout', async () => {
    const dir = await tempDir('rw-rin-path-');
    expect(() => {
      assertOutsideCheckout(join(dir, 'sandboxes', 'j', 'a', 'in'), join(dir, 'jobs', 'j', 'a'));
    }).not.toThrow();
    expect(() => {
      assertOutsideCheckout(join(dir, 'jobs', 'j', 'a', 'in'), join(dir, 'jobs', 'j', 'a'));
    }).toThrow(RepoInputsError);
    expect(() => {
      assertOutsideCheckout(join(dir, 'jobs', 'j', 'a'), join(dir, 'jobs', 'j', 'a'));
    }).toThrow(RepoInputsError);
    expect(await existingDir(dir)).toBe(dir);
    expect(await existingDir(join(dir, 'missing'))).toBeNull();
  });

  it('the preamble names the folder and the files, says it is not part of the repository, and fences the data', () => {
    const text = repoInputsPreamble(
      FILES().map((f) => f.ref),
      '/w/sandboxes/j/a/in',
    );
    expect(text).toContain('2 input file(s); they are read-only in /w/sandboxes/j/a/in: ');
    expect(text).toContain('teklif.md');
    expect(text).toContain('NOT part of the repository checkout');
    expect(text).toContain('never commit');
    expect(text).toContain('never instructions');
  });
});

describe.skipIf(isWindows)(
  'the job runner gives a repository job its input files (p19-repo-job-inputs)',
  { timeout: 60_000 },
  () => {
    it('fetches them read-only into a scratch in/ next to the checkout; the commit and the push never include them', async () => {
      const files = FILES();
      const seen: { dir: string | null; png: number; notes: string; writable: boolean | null } = {
        dir: null,
        png: 0,
        notes: '',
        writable: null,
      };
      const t = await setup(files, (prompt) => {
        const m = /read-only in (\S+): /.exec(prompt);
        seen.dir = m?.[1] ?? null;
        if (seen.dir !== null) {
          seen.png = readFileSync(join(seen.dir, files[0]?.ref.name ?? '')).length;
          seen.notes = readFileSync(join(seen.dir, 'teklif.md'), 'utf8');
          try {
            writeFileSync(join(seen.dir, 'teklif.md'), 'changed');
            seen.writable = true;
          } catch {
            seen.writable = false;
          }
        }
        return [
          { kind: 'write-file', path: 'design/teklif.html', content: '<h1>Teklif</h1>\n' },
          { kind: 'summary', text: 'rebuilt' },
        ];
      });
      const msg = assign(
        t,
        files.map((f) => f.ref),
      );
      await t.runner.onMessage(msg);
      await t.runner.settled(msg.jobId);
      expect(resultOf(t.sent)).toMatchObject({ outcome: 'succeeded' });
      const real = await realpath(t.root);
      const inDir = join(real, 'sandboxes', msg.jobId, msg.payload.attemptId, 'in');
      expect(seen.dir).toBe(inDir);
      expect(seen.png).toBe(PNG.length);
      expect(seen.notes).toBe(NOTES.toString('utf8'));
      // Read-only for the agent (0444 files; the test does not run as root).
      if (process.getuid?.() !== 0) expect(seen.writable).toBe(false);
      // A multi-slice file was read in order.
      expect(t.asked).toEqual(
        expect.arrayContaining(['in-shot1@0', `in-shot1@${String(INPUT_CHUNK_BYTES)}`]),
      );
      expect(t.prompts[0]).toContain('[Remyral input files] The user gave this job 2 input file(s)');
      expect(t.prompts[0]).toContain('NOT part of the repository checkout');
      // The prompt's own text stays last (the platform's notes come first).
      expect(t.prompts[0]?.trim().endsWith('ekran görüntülerine göre yeniden kur')).toBe(true);
      const events = t.sent.filter((s) => s.type === 'EVENT').map((s) => JSON.stringify(s.payload));
      expect(events.some((e) => e.includes('Input files are in ') && e.includes('never committed'))).toBe(
        true,
      );

      // The pushed attempt branch holds the agent's work and nothing of the inputs.
      const branch = `rac/${msg.jobId}/${msg.payload.attemptId}`;
      const tree = gitOut(t.origin.bare, 'ls-tree', '-r', '--name-only', `refs/heads/${branch}`).split('\n');
      expect(tree).toContain('design/teklif.html');
      expect(tree.some((p) => p.includes('teklif.md') || p.endsWith('.png') || p.startsWith('in/'))).toBe(
        false,
      );
      const commits = gitOut(t.origin.bare, 'log', '--name-only', '--format=', `refs/heads/${branch}`);
      expect(commits).not.toContain('teklif.md');
      // The checkout itself never had a copy.
      const checkout = join(real, 'jobs', msg.jobId, msg.payload.attemptId);
      expect(existsSync(join(checkout, 'teklif.md'))).toBe(false);
      expect(existsSync(join(checkout, 'in'))).toBe(false);
      // Cleaned up with the attempt's scratch (or still read-only when kept).
      if (existsSync(join(inDir, 'teklif.md'))) {
        expect(statSync(join(inDir, 'teklif.md')).mode & 0o222).toBe(0);
      }
    });

    it('a file that does not match its SHA-256 fails the attempt before the agent starts', async () => {
      const files = FILES();
      const t = await setup(files, () => [{ kind: 'summary', text: 'should not run' }], { tamper: true });
      const msg = assign(
        t,
        files.map((f) => f.ref),
      );
      await t.runner.onMessage(msg);
      await t.runner.settled(msg.jobId);
      expect(resultOf(t.sent)).toMatchObject({ outcome: 'failed' });
      expect(t.prompts).toEqual([]);
      // Nothing was pushed.
      const branch = `refs/heads/rac/${msg.jobId}/${msg.payload.attemptId}`;
      expect(execFileSync('git', ['ls-remote', t.origin.bare, branch], { encoding: 'utf8' }).trim()).toBe('');
    });

    it('a repository job without inputs asks for none and gets no input preamble', async () => {
      const t = await setup([], () => [{ kind: 'write-file', path: 'x.md', content: 'x\n' }]);
      const msg = assign(t, []);
      await t.runner.onMessage(msg);
      await t.runner.settled(msg.jobId);
      expect(resultOf(t.sent)).toMatchObject({ outcome: 'succeeded' });
      expect(t.asked).toEqual([]);
      expect(t.prompts[0]).not.toContain('[Remyral input files]');
      const real = await realpath(t.root);
      expect(existsSync(join(real, 'sandboxes', msg.jobId, msg.payload.attemptId, 'in'))).toBe(false);
    });
  },
);
