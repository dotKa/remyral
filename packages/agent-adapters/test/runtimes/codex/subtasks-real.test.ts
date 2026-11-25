/**
 * p8-subtasks-codex (ADR-0031): the Codex JOB adapter's sub-job tools (app-server dynamic tools, experimental API)
 * against the **real pinned codex-cli 0.164.0** and a local fake Responses API (fixtures/codex/mock-responses.ts). No
 * real key, no model. Opt-in: REMYRAL_CODEX_BIN (the pinned binary). macOS only: the app-server runs under the
 * localhost-only Seatbelt profile (fixtures/codex/helpers.ts), so nothing can leave the machine.
 *
 * What the mock records is what the model is offered: the tests assert the three sub-job tools are top-level
 * function tools only when the job has sub-job tools, that a model call reaches the host with its arguments, that
 * the host's text goes back to the model as the `function_call_output`, and what a resumed (parked) thread offers.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createCodexAdapter,
  SecretValue,
  SUBTASK_TOOL_NAMES,
  type SubtaskToolHost,
} from '../../../src/index.js';
import { localhostOnlyConfiner, pinnedCodexBinary } from '../../fixtures/codex/helpers.js';
import { startMockResponses, type MockResponses } from '../../fixtures/codex/mock-responses.js';
import { drain, spawnContext } from '../../helpers/runtime.js';

const bin = process.env.REMYRAL_CODEX_BIN !== undefined ? pinnedCodexBinary() : undefined;
const confiner = localhostOnlyConfiner();
const base = join(homedir(), '.cache', 'remyral-tests');
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, 'codex-subtasks-real-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const KEY = 'sk-proj-remyral-fake-subtasks-0123456789';

/** Top-level function tools of a model request (and namespaced ones as `ns.name`). */
function offeredTools(req: Record<string, unknown> | undefined): string[] {
  const flat = (tools: unknown, prefix = ''): string[] =>
    (Array.isArray(tools) ? (tools as Record<string, unknown>[]) : []).flatMap((t) =>
      t.type === 'namespace' ? flat(t.tools, `${String(t.name)}.`) : [`${prefix}${String(t.name ?? t.type)}`],
    );
  const input = Array.isArray(req?.input) ? (req.input as Record<string, unknown>[]) : [];
  return [
    ...flat(req?.tools),
    ...input.filter((i) => i.type === 'additional_tools').flatMap((i) => flat(i.tools)),
  ];
}

function recordingHost(): { host: SubtaskToolHost; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    host: {
      request: (args) => {
        calls.push(['request', args]);
        return Promise.resolve({
          ok: true,
          text: 'Sub-job 7d0c "API" (codex): queued. MARKER-SUBJOB-QUEUED',
        });
      },
      wait: (id, waitSec) => {
        calls.push(['wait', id, waitSec]);
        return Promise.resolve({ ok: true, text: 'running' });
      },
      cancel: (id) => {
        calls.push(['cancel', id]);
        return Promise.resolve({ ok: true, text: 'cancelled' });
      },
    },
  };
}

function adapterFor(mock: MockResponses, stateDir: string) {
  return createCodexAdapter({
    authMode: 'secret-ref',
    codexPath: bin ?? 'codex',
    stateDir,
    apiBaseUrl: mock.url,
    sourceEnv: { PATH: process.env.PATH, HOME: mkdtempSync(join(root, 'home-')) },
    confinerFor: () => confiner,
  });
}

describe.skipIf(bin === undefined || confiner === undefined)(
  'Codex job adapter, sub-job tools: real codex-cli 0.164.0 + local fake Responses API',
  { timeout: 180_000 },
  () => {
    it('declares the sub-job tools as dynamic tools, relays a call to the host and returns its text', async () => {
      const args = {
        title: 'API',
        prompt: 'Build the API.',
        paths: ['src/api/', 'docs/api.md'],
        wait: false,
      };
      const mock = await startMockResponses({
        toolName: 'request_subtask',
        toolArguments: JSON.stringify(args),
        answer: ['delegated'],
      });
      const stateDir = mkdtempSync(join(root, 'st-'));
      try {
        const adapter = adapterFor(mock, stateDir);
        await adapter.probe();
        const { host, calls } = recordingHost();
        const ws = mkdtempSync(join(root, 'ws-'));
        const ref = await adapter.spawn(
          spawnContext('codex', ws, {
            job: { runtime: 'codex', prompt: 'delegate', model: 'gpt-5.4', limits: { maxDurationSec: 120 } },
            secretEnv: { CODEX_API_KEY: new SecretValue(KEY) },
            approvalPolicy: 'deny-sensitive',
            subtaskTools: host,
          }),
        );
        try {
          await adapter.sendPrompt(ref, { text: 'delegate the API' });
          const events = (await drain(adapter, ref, 90_000)).map((e) => e.event);
          expect((await adapter.collectResult(ref)).outcome).toBe('succeeded');
          // Offered as plain top-level function tools.
          const offered = offeredTools(mock.requests[0]);
          for (const name of SUBTASK_TOOL_NAMES) expect(offered).toContain(name);
          // Pre-approved (deny-sensitive job): the call reached the host with the model's arguments.
          expect(calls).toEqual([
            [
              'request',
              { ...args, runtime: undefined, requires: undefined, inputs: undefined, waitSec: undefined },
            ],
          ]);
          // The host's text went back to the model as the call's output.
          const second = mock.requests[1];
          const output = (
            Array.isArray(second?.input) ? (second.input as Record<string, unknown>[]) : []
          ).find((i) => i.type === 'function_call_output');
          expect(JSON.stringify(output)).toContain('MARKER-SUBJOB-QUEUED');
          // tool_call / tool_result events from the thread item.
          expect(events).toContainEqual(
            expect.objectContaining({ kind: 'tool_call', toolName: 'request_subtask' }),
          );
          const result = events.find((e) => e.kind === 'tool_result');
          expect(result).toMatchObject({ ok: true });
          expect(JSON.stringify(result)).toContain('MARKER-SUBJOB-QUEUED');
          expect(JSON.stringify(events)).not.toContain(KEY);
        } finally {
          await adapter.cleanup(ref);
        }
      } finally {
        await mock.close();
      }
    });

    it('offers no sub-job tools to a job without them', async () => {
      const mock = await startMockResponses({ toolCall: false, answer: ['done'] });
      const stateDir = mkdtempSync(join(root, 'st-'));
      try {
        const adapter = adapterFor(mock, stateDir);
        await adapter.probe();
        const ws = mkdtempSync(join(root, 'ws-'));
        const ref = await adapter.spawn(
          spawnContext('codex', ws, {
            job: { runtime: 'codex', prompt: 'p', model: 'gpt-5.4', limits: { maxDurationSec: 60 } },
            secretEnv: { CODEX_API_KEY: new SecretValue(KEY) },
            approvalPolicy: 'deny-sensitive',
          }),
        );
        try {
          await adapter.sendPrompt(ref, { text: 'say done' });
          await drain(adapter, ref, 90_000);
          const offered = offeredTools(mock.requests[0]);
          expect(offered.length).toBeGreaterThan(0);
          for (const name of SUBTASK_TOOL_NAMES) expect(offered).not.toContain(name);
        } finally {
          await adapter.cleanup(ref);
        }
      } finally {
        await mock.close();
      }
    });

    it('a parked thread resumed in a new app-server still offers the sub-job tools', async () => {
      const mock = await startMockResponses({
        toolName: 'wait_subtask',
        toolArguments: JSON.stringify({ subtaskId: '00000000-0000-4000-8000-0000000000e2', waitSec: 0 }),
        answer: ['ok'],
      });
      const stateDir = mkdtempSync(join(root, 'st-'));
      try {
        const first = adapterFor(mock, stateDir);
        await first.probe();
        const { host } = recordingHost();
        const ws = mkdtempSync(join(root, 'ws-'));
        const ctx = spawnContext('codex', ws, {
          job: { runtime: 'codex', prompt: 'p', model: 'gpt-5.4', limits: { maxDurationSec: 120 } },
          secretEnv: { CODEX_API_KEY: new SecretValue(KEY) },
          approvalPolicy: 'deny-sensitive',
          subtaskTools: host,
          // `resume` is unverified for Codex (capabilities.ts); park/resume needs the opt-in.
          allowUnverified: true,
        });
        const ref = await first.spawn(ctx);
        await first.sendPrompt(ref, { text: 'wait for it' });
        await drain(first, ref, 90_000);
        const parked = await first.parkSession(ref);
        await first.cleanup(ref);
        const before = mock.requests.length;

        const second = adapterFor(mock, stateDir);
        await second.probe();
        const resumed = await second.resumeParked(ctx, parked);
        try {
          await second.sendPrompt(resumed, { text: 'and again' });
          await drain(second, resumed, 90_000);
          const offered = offeredTools(mock.requests[before]);
          for (const name of SUBTASK_TOOL_NAMES) expect(offered).toContain(name);
        } finally {
          await second.cleanup(resumed);
        }
      } finally {
        await mock.close();
      }
    });
  },
);
