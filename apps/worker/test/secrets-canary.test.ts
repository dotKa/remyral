import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, Redactor } from '@remyral/observability';
import { Event, LogChunk, PROTOCOL_VERSION } from '@remyral/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { planJobEnv, resolveJobEnv, type ResolvedJobEnv } from '../src/secrets/env.js';
import { JobOutputRedaction, type RedactedLogChunk } from '../src/secrets/job-output.js';
import { SecretRegistry } from '../src/secrets/registry.js';
import { FileSecretStore } from '../src/secrets/store.js';
import { Outbox } from '../src/store/outbox.js';
import { spyOnFs } from './fs-spy.js';
import { isWindows, nodeOps, tempDir } from './helpers.js';

/** Provider key canary without any vendor prefix: only exact-value redaction can catch it. */
const CANARY = 'canary-7d1f0c9e-provider-key-4b2a';
const DAEMON_CANARY = 'daemon-own-credential-91c3e5aa';
const OAUTH_CANARY = `sk-ant-oat01-${'Zq9'.repeat(12)}`;

const savedEnv: Record<string, string | undefined> = {};
function setDaemonEnv(name: string, value: string): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  process.env[name] = value;
}
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
    Reflect.deleteProperty(savedEnv, k);
  }
});

const IDS = { workerId: 'w-1', jobId: 'job-1', attemptId: 'att-1', epoch: 2 };

/** Runs `script` with exactly `env` (nothing inherited) and feeds its output through the job redaction. */
async function runChild(
  script: string,
  env: ResolvedJobEnv,
  redaction: JobOutputRedaction,
  splitEvery = 0,
): Promise<RedactedLogChunk[]> {
  const child = spawn(process.execPath, ['-e', script], {
    env: { ...env.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks: RedactedLogChunk[] = [];
  const feed = (stream: 'stdout' | 'stderr') => (b: Buffer) => {
    const text = b.toString('utf8');
    if (splitEvery > 0) {
      for (let i = 0; i < text.length; i += splitEvery)
        chunks.push(...redaction.push(stream, text.slice(i, i + splitEvery)));
    } else {
      chunks.push(...redaction.push(stream, text));
    }
  };
  child.stdout.on('data', feed('stdout'));
  child.stderr.on('data', feed('stderr'));
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  expect(code).toBe(0);
  chunks.push(...redaction.end('stdout'), ...redaction.end('stderr'));
  return chunks;
}

async function writeToOutbox(dir: string, chunks: RedactedLogChunk[], event: unknown): Promise<string> {
  const path = join(dir, 'outbox.jsonl');
  const { outbox } = await Outbox.open(nodeOps(), path, 0);
  const envelope = (seq: number) => ({
    protocolVersion: PROTOCOL_VERSION,
    messageId: randomUUID(),
    seq,
    ts: new Date().toISOString(),
    correlationId: IDS.jobId,
    workerId: IDS.workerId,
    jobId: IDS.jobId,
  });
  for (const c of chunks) {
    await outbox.append((seq) =>
      LogChunk.parse({
        ...envelope(seq),
        type: 'LOG_CHUNK',
        payload: { attemptId: IDS.attemptId, epoch: IDS.epoch, ...c },
      }),
    );
  }
  await outbox.append((seq) =>
    Event.parse({
      ...envelope(seq),
      type: 'EVENT',
      payload: { attemptId: IDS.attemptId, epoch: IDS.epoch, event },
    }),
  );
  return readFile(path, 'utf8');
}

const LEAKY_CHILD = `
const crypto = require('node:crypto');
const key = process.env.ANTHROPIC_API_KEY ?? '';
console.log('sha=' + crypto.createHash('sha256').update(key).digest('hex'));
console.log('leak: Authorization uses ' + key + ' (oops)');
console.error(JSON.stringify(process.env));
console.log('daemon=' + (process.env.REMYRAL_TEST_DAEMON_TOKEN ?? 'absent'));
console.log('aws=' + (process.env.AWS_SECRET_ACCESS_KEY ?? 'absent'));
console.log('oauth=' + (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? 'absent'));
`;

describe.skipIf(isWindows)(
  'canary: injected secrets never leave the worker unredacted (ADR-0006, A-SEC-3)',
  () => {
    it('secret-ref: value reaches the child only, and is redacted from logs, LOG_CHUNKs, events and the outbox', async () => {
      const dir = await tempDir('rw-canary-');
      setDaemonEnv('REMYRAL_TEST_DAEMON_TOKEN', DAEMON_CANARY);
      setDaemonEnv('AWS_SECRET_ACCESS_KEY', DAEMON_CANARY);
      setDaemonEnv('CLAUDE_CODE_OAUTH_TOKEN', OAUTH_CANARY);
      const store = new FileSecretStore(nodeOps(), dir);
      await store.set('anthropic', CANARY);

      const redactor = new Redactor();
      const lines: string[] = [];
      const logger = createLogger({ sink: (l) => lines.push(l), redactor, level: 'trace' });
      const registry = new SecretRegistry(redactor.secrets);
      const lease = registry.lease();

      const plan = planJobEnv(
        { runtime: 'claude-code', auth: { mode: 'secret-ref', ref: 'worker:w-1/secret:anthropic' } },
        'w-1',
      );
      expect(JSON.stringify(plan)).not.toContain(CANARY);
      const resolved = await resolveJobEnv(plan, { store, lease });
      // A careless log of the whole env, the resolved object, an error carrying the value:
      logger.info('spawning runtime', { env: resolved.env, resolved, note: `key=${CANARY}` });
      logger.error('spawn failed', { error: new Error(`bad key ${CANARY}`) });
      expect(JSON.stringify(resolved)).not.toContain(CANARY);

      const redaction = new JobOutputRedaction(redactor);
      const chunks = await runChild(LEAKY_CHILD, resolved, redaction, 7);
      const event = redaction.event({
        kind: 'message',
        role: 'assistant',
        text: `I found the key ${CANARY} in env`,
      });
      const outbox = await writeToOutbox(dir, chunks, event);
      const logText = lines.join('\n');
      const all = `${outbox}\n${logText}`;

      expect(all).not.toContain(CANARY);
      expect(all).not.toContain(Buffer.from(CANARY).toString('base64').replace(/=+$/, ''));
      expect(all).not.toContain(DAEMON_CANARY);
      expect(all).not.toContain(OAUTH_CANARY);
      expect(outbox).toContain('[REDACTED:ANTHROPIC_API_KEY]');
      expect(logText).toContain('[REDACTED:ANTHROPIC_API_KEY]');
      // The child really got the key (hash), and nothing of the daemon's own environment.
      expect(outbox).toContain(`sha=${createHash('sha256').update(CANARY).digest('hex')}`);
      expect(outbox).toContain('daemon=absent');
      expect(outbox).toContain('aws=absent');
      expect(outbox).toContain('oauth=absent');

      lease.release();
      expect(registry.size).toBe(0);
    });

    it('local-login: the worker never opens the runtime credential paths nor runs keychain tools', async () => {
      const dir = await realpath(await tempDir('rw-login-'));
      const home = join(dir, 'home');
      const decoys = {
        claude: join(home, '.claude', '.credentials.json'),
        claudeJson: join(home, '.claude.json'),
        codex: join(home, '.codex', 'auth.json'),
        opencode: join(home, '.local', 'share', 'opencode', 'auth.json'),
        keychain: join(home, 'Library', 'Keychains', 'login.keychain-db'),
      };
      for (const p of Object.values(decoys)) {
        await mkdir(join(p, '..'), { recursive: true });
        await writeFile(p, JSON.stringify({ accessToken: OAUTH_CANARY }));
      }
      const sourceEnv = {
        PATH: process.env.PATH ?? '',
        HOME: home,
        USER: 'worker',
        LOGNAME: 'worker',
        CODEX_HOME: join(home, '.codex'),
        CLAUDE_CODE_OAUTH_TOKEN: OAUTH_CANARY,
        ANTHROPIC_API_KEY: DAEMON_CANARY,
      };
      const store = new FileSecretStore(nodeOps(), join(dir, 'data'));
      const redactor = new Redactor();
      const registry = new SecretRegistry(redactor.secrets);

      const results: Record<string, ResolvedJobEnv> = {};
      const spy = spyOnFs();
      try {
        for (const runtime of ['claude-code', 'codex', 'opencode', 'pi'] as const) {
          const plan = planJobEnv({ runtime, auth: { mode: 'local-login' } }, 'w-1');
          results[runtime] = await resolveJobEnv(plan, { store, lease: registry.lease(), sourceEnv });
        }
        // Positive control: the spy does observe the worker's own reads.
        await store.get('anthropic');
      } finally {
        spy.restore();
      }
      expect(spy.paths.some((p) => p.startsWith(join(dir, 'data')))).toBe(true);
      expect(spy.paths.filter((p) => p.startsWith(home))).toEqual([]);
      expect(spy.commands).toEqual([]);
      expect(registry.size).toBe(0);

      const claude = results['claude-code'];
      if (claude === undefined) throw new Error('missing');
      expect(claude.authMode).toBe('local-login');
      expect(claude.env.HOME).toBe(home);
      expect(claude.env.USER).toBe('worker');
      expect(claude.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(claude.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(Object.keys(claude.secretEnv)).toEqual([]);
      expect(results.codex?.env.CODEX_HOME).toBe(join(home, '.codex'));
      expect(results['claude-code']?.env.CODEX_HOME).toBeUndefined();

      // The runtime (a child process, not the worker) can still find its own login via HOME,
      // and a runtime that prints its token is caught by the pattern pass.
      const redaction = new JobOutputRedaction(redactor);
      const chunks = await runChild(
        `const fs=require('node:fs'),path=require('node:path');
       const raw=fs.readFileSync(path.join(process.env.HOME,'.claude','.credentials.json'),'utf8');
       console.log('login-found=' + (JSON.parse(raw).accessToken.length > 0));
       console.log('debug token ' + JSON.parse(raw).accessToken);
       console.log('CLAUDE_CODE_OAUTH_TOKEN=' + JSON.parse(raw).accessToken);`,
        claude,
        redaction,
      );
      const text = chunks.map((c) => c.data).join('');
      expect(text).toContain('login-found=true');
      expect(text).not.toContain(OAUTH_CANARY);
      expect(text).toContain('[REDACTED:anthropic-key]');
    });
  },
);
