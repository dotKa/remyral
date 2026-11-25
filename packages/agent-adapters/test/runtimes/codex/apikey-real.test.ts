/**
 * p6-codex-apikey-fix: the Codex JOB adapter in secret-ref (API key) mode against the **real pinned
 * codex-cli 0.164.0** and a local fake Responses API (fixtures/codex/mock-responses.ts). No real key, no model.
 * Opt-in: REMYRAL_CODEX_BIN (the pinned binary). macOS only: the app-server runs under a localhost-only Seatbelt
 * profile (fixtures/codex/helpers.ts `localhostOnlyConfiner`), so nothing can reach api.openai.com even if an
 * override were missed — such a request fails instead of leaving the machine.
 *
 * Background (verified with the same binary, docs/compat/codex.md §4.1): with the built-in `openai` provider the
 * app-server ignores `CODEX_API_KEY` / `OPENAI_API_KEY` in its environment and sends no `Authorization` header.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CODEX_API_KEY_PROVIDER, createCodexAdapter, SecretValue } from '../../../src/index.js';
import { localhostOnlyConfiner, pinnedCodexBinary } from '../../fixtures/codex/helpers.js';
import { startMockResponses } from '../../fixtures/codex/mock-responses.js';
import { drain, spawnContext } from '../../helpers/runtime.js';

const bin = process.env.REMYRAL_CODEX_BIN !== undefined ? pinnedCodexBinary() : undefined;
const confiner = localhostOnlyConfiner();
const base = join(homedir(), '.cache', 'remyral-tests');
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, 'codex-apikey-real-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Every regular file under `dir` that contains `needle` (binary-safe). */
function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  for (const f of readdirSync(dir, { recursive: true }) as string[]) {
    const p = join(dir, f);
    try {
      if (statSync(p).isFile() && readFileSync(p).includes(needle)) hits.push(f);
    } catch {
      // vanished while listing (sqlite journals)
    }
  }
  return hits;
}

describe.skipIf(bin === undefined || confiner === undefined)(
  'Codex job adapter, API key: real codex-cli 0.164.0 + local fake Responses API',
  { timeout: 120_000 },
  () => {
    for (const keyEnv of ['CODEX_API_KEY', 'OPENAI_API_KEY'] as const) {
      it(`${keyEnv}: the key reaches the provider as a bearer token, never argv or disk`, async () => {
        const mock = await startMockResponses({ toolCall: false, answer: ['done'] });
        try {
          const key = `sk-proj-remyral-fake-${keyEnv.toLowerCase()}-0123456789`;
          const stateDir = mkdtempSync(join(root, 'st-'));
          const home = mkdtempSync(join(root, 'home-'));
          const argvSeen: string[][] = [];
          const adapter = createCodexAdapter({
            authMode: 'secret-ref',
            codexPath: bin ?? 'codex',
            stateDir,
            apiBaseUrl: mock.url,
            sourceEnv: { PATH: process.env.PATH, HOME: home },
            confinerFor: () => ({
              kind: 'test:record',
              confine: (plan) => {
                argvSeen.push([...plan.args]);
                if (confiner === undefined) throw new Error('unreachable');
                return confiner.confine(plan);
              },
            }),
          });
          await adapter.probe();
          const ws = mkdtempSync(join(root, 'ws-'));
          const ref = await adapter.spawn(
            spawnContext('codex', ws, {
              job: { runtime: 'codex', prompt: 'say done', model: 'gpt-5.4', limits: { maxDurationSec: 60 } },
              secretEnv: { [keyEnv]: new SecretValue(key) },
              approvalPolicy: 'deny-sensitive',
            }),
          );
          let codexHome = '';
          try {
            const info = adapter.threadInfo(ref);
            expect(info?.modelProvider).toBe(CODEX_API_KEY_PROVIDER);
            codexHome = info?.codexHome ?? '';
            expect(codexHome.startsWith(stateDir)).toBe(true);
            await adapter.sendPrompt(ref, { text: 'say done' });
            const events = await drain(adapter, ref, 60_000);
            const result = await adapter.collectResult(ref);
            expect(result.outcome).toBe('succeeded');
            expect(JSON.stringify(events)).not.toContain(key);
            const usage = events.map((e) => e.event).find((e) => e.kind === 'usage');
            expect(usage).toMatchObject({ provider: 'openai', authMode: 'secret-ref' });

            // Every model request went to the fake and carried the key; nothing went anywhere else.
            expect(mock.requests.length).toBeGreaterThanOrEqual(1);
            expect(mock.authorizations.length).toBe(mock.requests.length);
            expect(mock.authorizations.every((a) => a === `Bearer ${key}`)).toBe(true);
            // The key is only in the environment: not in argv, not in any file of the private CODEX_HOME.
            expect(argvSeen.flat().join(' ')).not.toContain(key);
            expect(argvSeen.flat().join(' ')).toContain(`env_key = "${keyEnv}"`);
            expect(filesContaining(codexHome, key)).toEqual([]);
            expect(readdirSync(codexHome)).not.toContain('auth.json');
          } finally {
            await adapter.cleanup(ref);
          }
          expect(readdirSync(stateDir)).toEqual([]);
          expect(filesContaining(ws, key)).toEqual([]);
        } finally {
          await mock.close();
        }
      });
    }
  },
);
