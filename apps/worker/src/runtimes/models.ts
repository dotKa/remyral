import { tmpdir } from 'node:os';
import {
  catalogModelsFor,
  type DiscoveredModel,
  MAX_DISCOVERED_MODELS,
  type ModelAccess,
  modelIdIssue,
  RUNTIME_MODEL_CATALOG_VERSION,
  RuntimeKind,
  type RuntimeAuthMode,
  type RuntimeModelDiscovery,
  type RuntimeModelsReport,
} from '@remyral/protocol';
import { type RunFn, runProcess } from '../remote-ops/process.js';

/**
 * p15-model-picker (docs/design/p15-model-picker.md §2): which models each installed runtime can use on this machine,
 * reported in CAPABILITIES `runtimeModels` (feature `runtime-models-v1`). Read-only list commands, no model request:
 *
 *  - OpenCode: `opencode models` — one `provider/model` per line, the providers configured on this machine;
 *  - Pi: `pi --list-models` — a table (provider, model, context, …) of models with a configured API key;
 *  - Codex: `codex debug models` — the model catalog JSON for this login (refreshed from the account; `--bundled`, the
 *    catalog shipped with the binary, when the refresh fails); models with visibility `list` only;
 *  - Claude Code has no list command: the aliases and ids of this release's catalog (source `builtin`), reported only
 *    when the runtime is installed.
 *
 * Verified against opencode 1.19.0, pi 0.85.1 and codex-cli 0.163.0 (pins: opencode 1.19.0, pi 1.1.0, codex 0.162.1 —
 * the latter two unverified, a different output falls back to `failed` and the console to the catalog). The commands
 * run with the worker's plain helper environment (no credential is injected: the list shows the machine's own
 * configuration), a hard timeout and bounded output. Cached; refreshed every {@link MODEL_LIST_TTL_MS} or on demand.
 */

export const MODEL_LIST_TTL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 30_000;
/** `codex debug models` prints ~650 KB (instructions per model); keep enough to parse it whole. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function clean(models: readonly DiscoveredModel[]): { models: DiscoveredModel[]; truncated: boolean } {
  const seen = new Set<string>();
  const out: DiscoveredModel[] = [];
  for (const m of models) {
    if (modelIdIssue(m.id) !== null || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out.length > MAX_DISCOVERED_MODELS
    ? { models: out.slice(0, MAX_DISCOVERED_MODELS), truncated: true }
    : { models: out, truncated: false };
}

/** ANSI colour sequences (ESC [ … m) some CLIs print even with NO_COLOR. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** `opencode models`: `provider/model` per line (ANSI colour and blank lines ignored). */
export function parseOpencodeModels(stdout: string): DiscoveredModel[] {
  return stdout
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.includes('/') && !/\s/.test(l))
    .map((id) => ({ id }));
}

/** `1M` → 1 000 000, `65.5K` → 65 500, `200000` → 200 000; anything else undefined. */
function tokens(v: string | undefined): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([KkMm]?)$/.exec(v ?? '');
  if (m === null) return undefined;
  const n = Number(m[1]) * (m[2] === '' ? 1 : m[2]?.toLowerCase() === 'k' ? 1_000 : 1_000_000);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : undefined;
}

/**
 * `pi --list-models`: a header `provider  model  context  max-out  thinking  images`, then one row per model. The id
 * Pi takes is `provider/model` (`--model provider/id`).
 */
export function parsePiListModels(stdout: string): DiscoveredModel[] {
  const out: DiscoveredModel[] = [];
  for (const line of stdout.replace(ANSI, '').split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2 || (cols[0] === 'provider' && cols[1] === 'model')) continue;
    const [provider, model, context] = cols;
    if (provider === undefined || model === undefined || !/^[a-z0-9][a-z0-9_.-]*$/.test(provider)) continue;
    const contextWindow = tokens(context);
    out.push({ id: `${provider}/${model}`, ...(contextWindow === undefined ? {} : { contextWindow }) });
  }
  return out;
}

/** `codex debug models`: `{models: [{slug, display_name, visibility, context_window, …}]}`; listed models only. */
export function parseCodexDebugModels(stdout: string): DiscoveredModel[] {
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error('no JSON in output');
  const doc = JSON.parse(stdout.slice(start)) as { models?: unknown };
  if (!Array.isArray(doc.models)) throw new Error('no models array');
  const out: DiscoveredModel[] = [];
  for (const raw of doc.models as unknown[]) {
    if (raw === null || typeof raw !== 'object') continue;
    const m = raw as Record<string, unknown>;
    if (typeof m.slug !== 'string' || m.visibility === 'hide') continue;
    const name = typeof m.display_name === 'string' ? m.display_name.slice(0, 128) : undefined;
    const ctx =
      typeof m.context_window === 'number' && Number.isInteger(m.context_window) ? m.context_window : 0;
    out.push({
      id: m.slug,
      ...(name === undefined ? {} : { displayName: name }),
      ...(ctx >= 1 && ctx <= 100_000_000 ? { contextWindow: ctx } : {}),
    });
  }
  return out;
}

/** One redacted line of a failed command (no paths beyond the runtime's own words, ≤ 300 chars). */
function failure(
  command: string,
  r: { exitCode: number | null; stderr: string; timedOut: boolean; spawnError?: string },
): string {
  const why = r.timedOut
    ? 'timed out'
    : r.spawnError !== undefined
      ? r.spawnError
      : `exit ${String(r.exitCode)}${(() => {
          const line = r.stderr
            .replace(ANSI, '')
            .split(/\r?\n/)
            .map((l) => l.trim())
            .find((l) => l !== '');
          return line === undefined ? '' : `: ${line}`;
        })()}`;
  return `${command}: ${why}`.replace(/(sk-|key=|token=)\S+/gi, '$1***').slice(0, 300);
}

export interface RuntimeModelListerDeps {
  /** The runtime's executable (+ leading args for a managed Pi), null when it is not installed. */
  readonly launch: (
    runtime: RuntimeKind,
  ) => { readonly command: string; readonly args: readonly string[] } | null;
  /** The runtime's configured auth mode (subscription login vs. API key), null = unknown. */
  readonly authMode?: (runtime: RuntimeKind) => RuntimeAuthMode | null;
  /** The plain helper environment (PATH, HOME, …; never a credential). */
  readonly env: Readonly<Record<string, string>>;
  readonly run?: RunFn;
  readonly clock?: () => Date;
  readonly ttlMs?: number;
}

function accessOf(runtime: RuntimeKind, mode: RuntimeAuthMode | null | undefined): ModelAccess | undefined {
  if (runtime === 'pi' || runtime === 'opencode') return 'api-key';
  if (mode === 'local-login') return 'subscription';
  if (mode === 'secret-ref') return 'api-key';
  return undefined;
}

export class RuntimeModelLister {
  readonly #d: RuntimeModelListerDeps;
  readonly #run: RunFn;
  #cached: RuntimeModelsReport | null = null;
  #at = 0;
  #pending: Promise<RuntimeModelsReport> | null = null;

  constructor(deps: RuntimeModelListerDeps) {
    this.#d = deps;
    this.#run = deps.run ?? runProcess;
  }

  #now(): Date {
    return this.#d.clock?.() ?? new Date();
  }

  /** The last report without waiting; a missing or stale one is detected in the background, then `onReady`. */
  snapshot(onReady?: () => void): RuntimeModelsReport | null {
    const stale = this.#now().getTime() - this.#at > (this.#d.ttlMs ?? MODEL_LIST_TTL_MS);
    if ((this.#cached === null || stale) && this.#pending === null) {
      void this.detect()
        .then(() => onReady?.())
        .catch(() => undefined);
    }
    return this.#cached;
  }

  /** Lists again now (one detection at a time). */
  detect(): Promise<RuntimeModelsReport> {
    this.#pending ??= this.#detect().finally(() => {
      this.#pending = null;
    });
    return this.#pending;
  }

  async #detect(): Promise<RuntimeModelsReport> {
    const runtimes: RuntimeModelDiscovery[] = [];
    for (const runtime of RuntimeKind.options) {
      const d = await this.discover(runtime).catch(() => null);
      if (d !== null) runtimes.push(d);
    }
    const report = { catalogVersion: RUNTIME_MODEL_CATALOG_VERSION, runtimes };
    this.#cached = report;
    this.#at = this.#now().getTime();
    return report;
  }

  async #list(
    launch: { command: string; args: readonly string[] },
    args: readonly string[],
  ): Promise<Awaited<ReturnType<RunFn>>> {
    return this.#run(launch.command, [...launch.args, ...args], {
      env: { ...this.#d.env, NO_COLOR: '1', CI: '1' },
      cwd: tmpdir(),
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_OUTPUT_BYTES,
    });
  }

  /** One runtime's models on this machine, or null when the runtime is not installed. */
  async discover(runtime: RuntimeKind): Promise<RuntimeModelDiscovery | null> {
    const launch = this.#d.launch(runtime);
    if (launch === null) return null;
    const checkedAt = this.#now().toISOString();
    const access = accessOf(runtime, this.#d.authMode?.(runtime));
    const base = { runtime, checkedAt, ...(access === undefined ? {} : { access }) };
    if (runtime === 'claude-code') {
      const { models } = clean(
        catalogModelsFor('claude-code').map((m) => ({ id: m.id, displayName: m.displayName })),
      );
      return { ...base, source: 'builtin', models };
    }
    const attempts: { args: string[]; command: string; parse: (s: string) => DiscoveredModel[] }[] =
      runtime === 'opencode'
        ? [{ args: ['models'], command: 'opencode models', parse: parseOpencodeModels }]
        : runtime === 'pi'
          ? [{ args: ['--list-models'], command: 'pi --list-models', parse: parsePiListModels }]
          : [
              { args: ['debug', 'models'], command: 'codex debug models', parse: parseCodexDebugModels },
              {
                args: ['debug', 'models', '--bundled'],
                command: 'codex debug models --bundled',
                parse: parseCodexDebugModels,
              },
            ];
    let error = '';
    for (const a of attempts) {
      const r = await this.#list(launch, a.args);
      if (r.exitCode !== 0 || r.timedOut || r.spawnError !== undefined) {
        error = failure(a.command, r);
        continue;
      }
      try {
        const { models, truncated } = clean(a.parse(r.stdout));
        return { ...base, source: 'cli', command: a.command, models, ...(truncated ? { truncated } : {}) };
      } catch (err) {
        error =
          `${a.command}: unreadable output (${err instanceof Error ? err.message : 'parse error'})`.slice(
            0,
            300,
          );
      }
    }
    return { ...base, source: 'failed', models: [], error };
  }
}
