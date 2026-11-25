import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Logger } from '@remyral/observability';
import type { ManageStep, OpsCommandPayload, OpsUpdatePayload } from '@remyral/protocol';
import {
  PrepareResult,
  type PrepareRequest,
  prepareRequestPath,
  prepareResultPath,
} from '../sandbox/prepare-shared.js';
import { MANAGE_HELPER_MARKER, ManageResult, manageResultPath } from '../update/manage-shared.js';

/**
 * p17-worker-managed — the worker's part of `worker.uninstall` (Part 3) and `helper.manage` (Part 4): the worker cannot
 * do either itself (its service account owns neither the service nor the program files). It checks that the installed
 * privileged helper knows them (MANAGE_HELPER_MARKER in the updater bundle), hands the signed command over through the
 * prepare request file (the same root/SYSTEM trigger as `sandbox.prepare`) and relays the helper's result:
 *  - uninstall: `succeeded` as soon as the helper accepted it (it stops the service about 15 s later; the master then
 *    revokes the worker), `refused` with the helper's reason, `failed` when no helper answered in time;
 *  - helper.manage: the step's outcome once the helper is done.
 * An older helper answers a manage command with a refused prepare result: reported as `helper_outdated`.
 */

type Emit = (u: Omit<OpsUpdatePayload, 'commandId' | 'seq' | 'kind'>) => void;

export interface ManageRequesterDeps {
  readonly platform: NodeJS.Platform;
  readonly dataDir: string;
  readonly installDir: string | undefined;
  readonly logger: Logger;
  /** Windows polls once a minute: the default waits 5 minutes. */
  readonly helperTimeoutMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly readText?: (path: string) => Promise<string>;
  readonly writeRequest?: (path: string, text: string) => Promise<void>;
}

const UPDATER_FILE = 'remyral-worker-updater.mjs';

export class ManageRequester {
  readonly #d: ManageRequesterDeps;
  #busy = false;

  constructor(d: ManageRequesterDeps) {
    this.#d = d;
  }

  #read(path: string): Promise<string> {
    return this.#d.readText?.(path) ?? readFile(path, 'utf8');
  }

  /** Whether the installed helper runs manage commands (the updater bundle carries the marker). */
  async helperReady(): Promise<{ ok: boolean; detail?: string }> {
    const dir = this.#d.installDir;
    if (dir === undefined) return { ok: false, detail: 'install dir unknown' };
    const file = join(dir, UPDATER_FILE);
    try {
      if (this.#d.readText === undefined) await stat(file);
      return (await this.#read(file)).includes(MANAGE_HELPER_MARKER)
        ? { ok: true }
        : {
            ok: false,
            detail: 'the installed updater predates removal from the panel; update the worker first',
          };
    } catch {
      return {
        ok: false,
        detail: 'no privileged updater installed (re-run the installer kit with its updater)',
      };
    }
  }

  async run(workerId: string, cmd: OpsCommandPayload, emit: Emit): Promise<void> {
    const op = cmd.op;
    if (op.kind !== 'worker.uninstall' && op.kind !== 'helper.manage') return;
    if (this.#busy) {
      emit({ state: 'refused', reason: 'manage_in_progress' });
      return;
    }
    const ready = await this.helperReady();
    const installDir = this.#d.installDir;
    if (!ready.ok || installDir === undefined) {
      emit({
        state: 'refused',
        reason: 'helper_unavailable',
        detail: ready.detail ?? 'no privileged helper',
      });
      return;
    }
    this.#busy = true;
    try {
      const steps: ManageStep[] = [{ id: 'helper_request', state: 'running' }];
      emit({ state: 'running', progress: { step: 'helper_request' }, manage: { steps } });
      const reqPath = prepareRequestPath(this.#d.platform, this.#d.dataDir);
      const request: PrepareRequest = { v: 1, workerId, command: cmd };
      await (this.#d.writeRequest ?? atomicRequest)(reqPath, JSON.stringify(request));
      this.#d.logger.info('privileged manage requested', { commandId: cmd.commandId, kind: op.kind });
      const sleep = this.#d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const deadline = Date.now() + (this.#d.helperTimeoutMs ?? 5 * 60_000);
      while (Date.now() < deadline) {
        await sleep(this.#d.pollMs ?? 2000);
        const res = await this.#result(installDir, cmd.commandId);
        if (res === null) continue;
        if (res.state === 'refused') {
          emit({
            state: 'refused',
            reason: res.reason ?? 'helper_refused',
            detail: (res.detail ?? 'the privileged helper refused the request').slice(0, 300),
            manage: {
              steps: [{ id: 'helper_request', state: 'failed', ...(res.reason ? { code: res.reason } : {}) }],
            },
          });
          return;
        }
        const all: ManageStep[] = [{ id: 'helper_request', state: 'done' }, ...res.steps];
        if (op.kind === 'worker.uninstall' && res.state === 'accepted') {
          emit({ state: 'succeeded', detail: res.detail ?? 'removal accepted', manage: { steps: all } });
          return;
        }
        if (res.state === 'done') {
          const failed = res.steps.find((s) => s.state === 'failed');
          if (failed === undefined) emit({ state: 'succeeded', manage: { steps: all } });
          else {
            emit({
              state: 'failed',
              reason: res.reason ?? failed.code ?? 'step_failed',
              detail: (failed.detail ?? res.detail ?? '').slice(0, 300),
              manage: { steps: all },
            });
          }
          return;
        }
      }
      emit({
        state: 'failed',
        reason: 'helper_timeout',
        detail:
          this.#d.platform === 'win32'
            ? 'the RemyralWorkerUpdater scheduled task did not answer (it runs once a minute as SYSTEM)'
            : 'the privileged helper did not answer (Linux: remyral-worker-prepare.path; macOS: com.remyral.worker.updater)',
        manage: { steps: [{ id: 'helper_request', state: 'failed', code: 'helper_timeout' }] },
      });
    } finally {
      this.#busy = false;
    }
  }

  /** The helper's answer to this command (manage-result.json; an older helper's refused prepare-result.json). */
  async #result(
    installDir: string,
    commandId: string,
  ): Promise<{
    state: ManageResult['state'];
    reason?: string | undefined;
    detail?: string | undefined;
    steps: ManageStep[];
  } | null> {
    try {
      const parsed = ManageResult.safeParse(JSON.parse(await this.#read(manageResultPath(installDir))));
      if (parsed.success && parsed.data.commandId === commandId) return parsed.data;
    } catch {
      // not written yet
    }
    try {
      const old = PrepareResult.safeParse(
        JSON.parse(await this.#read(prepareResultPath(this.#d.platform, installDir))),
      );
      if (old.success && old.data.commandId === commandId && old.data.state === 'refused') {
        return {
          state: 'refused',
          reason:
            old.data.reason === 'not_a_privileged_prepare'
              ? 'helper_outdated'
              : (old.data.reason ?? 'helper_refused'),
          detail:
            old.data.reason === 'not_a_privileged_prepare'
              ? 'the installed privileged helper predates removal from the panel; update the worker first'
              : (old.data.detail ?? ''),
          steps: [],
        };
      }
    } catch {
      // none
    }
    return null;
  }
}

async function atomicRequest(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, path);
}
