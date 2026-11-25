/**
 * p8-subtasks-pi (ADR-0031): the Pi JOB adapter's sub-job tools against the REAL pinned Pi 1.4.0 (no credentials, no
 * network, no model): the scripted faux provider (fixtures/pi/faux-provider.mjs, `faux:tool:<name>:<json>`) calls a
 * tool and answers with the tool's text, so tool registration, the permission gate, the extension-UI relay, abort and
 * the tool events are the real runtime's.
 *
 * Opt-in: set REMYRAL_PI_BIN to the pinned executable (e.g. the `pi` launcher of
 * `npm install --prefix <dir> --ignore-scripts @earendil-works/pi-coding-agent@1.4.0`).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createPiAdapter, type PiAdapterOptions, type SubtaskToolHost } from '../src/index.js';
import { drain, spawnContext, waitFor } from './helpers/runtime.js';

const PI_BIN = process.env.REMYRAL_PI_BIN ?? '';
const enabled = PI_BIN !== '';
const FAUX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pi', 'faux-provider.mjs');
const root = mkdtempSync(join(tmpdir(), 'remyral-pi-subtasks-real-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function adapter(extra: Partial<PiAdapterOptions> = {}) {
  return createPiAdapter({
    command: PI_BIN,
    stateDir: join(root, 'state', randomUUID()),
    authMode: 'secret-ref',
    extraExtensions: [FAUX],
    model: 'remyral-faux/scripted',
    ...extra,
  });
}

function workspace(): string {
  const dir = join(root, 'ws', randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
}

function recordingHost(opts: { blockWait?: boolean } = {}) {
  const calls: unknown[][] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const host: SubtaskToolHost = {
    request: (args, signal) => {
      calls.push(['request', args]);
      signals.push(signal);
      return Promise.resolve({ ok: true, text: 'Sub-job 7d0c "API" (pi): queued. MARKER-QUEUED' });
    },
    wait: (id, waitSec, signal) => {
      calls.push(['wait', id, waitSec]);
      signals.push(signal);
      if (opts.blockWait !== true) return Promise.resolve({ ok: true, text: 'running' });
      return new Promise((resolve) => {
        signal?.addEventListener(
          'abort',
          () => {
            resolve({ ok: true, text: 'Still running.' });
          },
          { once: true },
        );
      });
    },
    cancel: (id) => {
      calls.push(['cancel', id]);
      return Promise.resolve({ ok: true, text: 'cancelled' });
    },
  };
  return { host, calls, signals };
}

const SUB_ID = '00000000-0000-4000-8000-0000000000e2';

describe.skipIf(!enabled)(
  'pi 1.4.0 real binary: sub-job tools (p8-subtasks-pi)',
  { timeout: 120_000 },
  () => {
    it('ask-all job: a request_subtask call needs no approval, reaches the host and its text reaches the model', async () => {
      const a = adapter();
      const { host, calls } = recordingHost();
      const args = { title: 'API', prompt: 'Build it.', paths: ['src/api/', 'docs/api.md'], wait: false };
      const ref = await a.spawn(
        spawnContext('pi', workspace(), { approvalPolicy: 'ask-all', subtaskTools: host }),
      );
      await a.sendPrompt(ref, { text: `faux:tool:request_subtask:${JSON.stringify(args)}` });
      const events = (await drain(a, ref)).map((e) => e.event);
      expect(events.some((e) => e.kind === 'approval_request')).toBe(false);
      expect(calls).toEqual([
        [
          'request',
          {
            title: 'API',
            prompt: 'Build it.',
            runtime: undefined,
            requires: undefined,
            inputs: undefined,
            paths: ['src/api/', 'docs/api.md'],
            wait: false,
            waitSec: undefined,
          },
        ],
      ]);
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'tool_call', toolName: 'request_subtask' }),
      );
      expect(events).toContainEqual(expect.objectContaining({ kind: 'tool_result', ok: true }));
      const answer = events.filter((e) => e.kind === 'message' && e.role === 'assistant').at(-1);
      expect(answer?.kind === 'message' ? answer.text : '').toContain('MARKER-QUEUED');
      expect((await a.collectResult(ref)).outcome).toBe('succeeded');
      await a.cleanup(ref);
    });

    it('invalid arguments come back as an error result without a host call', async () => {
      const a = adapter();
      const { host, calls } = recordingHost();
      const ref = await a.spawn(spawnContext('pi', workspace(), { subtaskTools: host }));
      await a.sendPrompt(ref, {
        text: `faux:tool:request_subtask:${JSON.stringify({ title: 't', prompt: 'p', paths: ['../escape'] })}`,
      });
      const events = (await drain(a, ref)).map((e) => e.event);
      expect(calls).toEqual([]);
      const answer = events.filter((e) => e.kind === 'message' && e.role === 'assistant').at(-1);
      expect(answer?.kind === 'message' ? answer.text : '').toMatch(/invalid arguments: paths/);
      await a.cleanup(ref);
    });

    it('a job without sub-job tools has no such tool (Pi refuses the call itself)', async () => {
      const a = adapter();
      const ref = await a.spawn(spawnContext('pi', workspace(), { approvalPolicy: 'deny-sensitive' }));
      await a.sendPrompt(ref, {
        text: `faux:tool:request_subtask:${JSON.stringify({ title: 't', prompt: 'p' })}`,
      });
      const events = (await drain(a, ref)).map((e) => e.event);
      expect(events).toContainEqual(expect.objectContaining({ kind: 'tool_result', ok: false }));
      await a.cleanup(ref);
    });

    it('cancel while wait_subtask waits aborts the host call and stops the session', async () => {
      const a = adapter();
      const { host, calls, signals } = recordingHost({ blockWait: true });
      const ref = await a.spawn(spawnContext('pi', workspace(), { subtaskTools: host }));
      await a.sendPrompt(ref, {
        text: `faux:tool:wait_subtask:${JSON.stringify({ subtaskId: SUB_ID, waitSec: 300 })}`,
      });
      await waitFor(a, ref, (e) => e.event.kind === 'tool_call');
      const end = Date.now() + 10_000;
      while (calls.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
      expect(calls).toEqual([['wait', SUB_ID, 300]]);
      expect(signals[0]?.aborted).toBe(false);
      await a.cancel(ref);
      expect(signals[0]?.aborted).toBe(true);
      expect((await a.collectResult(ref)).outcome).toBe('cancelled');
      await a.cleanup(ref);
    });
  },
);
