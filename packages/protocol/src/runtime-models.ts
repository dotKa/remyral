import { z } from 'zod';
import { RuntimeKind } from './common.js';

/**
 * p15-model-picker (docs/design/p15-model-picker.md): which models each runtime CLI accepts, so the console offers a
 * list instead of a free-text model field.
 *
 *  - {@link BUILTIN_RUNTIME_MODEL_CATALOG}: the maintained catalog shipped with this master / worker release
 *    (version-stamped by {@link RUNTIME_MODEL_CATALOG_VERSION}; updated with a release, never fetched at run time). It
 *    is the fallback when no worker reported a list.
 *  - {@link RuntimeModelsReport}: what a worker found on its machine (CAPABILITIES `runtimeModels`, feature
 *    `runtime-models-v1`): the runtime's own list command where it has one (`opencode models`, `pi --list-models`,
 *    `codex debug models`), else the aliases this worker release knows (Claude Code has no list command).
 *  - {@link mergeRuntimeModels}: catalog + reports → one list per runtime with the machines each model was seen on.
 *
 * A model the catalog does not know stays usable: every model field also takes a custom id ({@link modelIdIssue}),
 * exactly the strings a free-text field accepted before (parity). Model ids only — never a credential.
 *
 * Browser-safe (zod only): the console imports it as `@remyral/protocol/runtime-models`.
 */

/** Same rule as the worker configuration's `ModelId` (worker-config.ts) and the runtime-policy profile model. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]*$/;
export const MAX_MODEL_ID = 128;

export const RuntimeModelId = z.string().min(1).max(MAX_MODEL_ID).regex(MODEL_ID_PATTERN, 'model id');

/** Why a custom model id is refused (null = acceptable). */
export function modelIdIssue(id: string): 'empty' | 'too_long' | 'invalid' | null {
  if (id.length === 0) return 'empty';
  if (id.length > MAX_MODEL_ID) return 'too_long';
  return MODEL_ID_PATTERN.test(id) ? null : 'invalid';
}

/** Bumped whenever {@link BUILTIN_RUNTIME_MODEL_CATALOG} changes (date + counter). */
export const RUNTIME_MODEL_CATALOG_VERSION = '2026.10.23-1';

/** How a login reaches the model provider (subscription login vs. API key): availability may differ. */
export const ModelAccess = z.enum(['subscription', 'api-key']);
export type ModelAccess = z.infer<typeof ModelAccess>;

export const KnownRuntimeModel = z.object({
  id: RuntimeModelId,
  displayName: z.string().min(1).max(128),
  /** `alias`: a moving name the runtime resolves itself (`sonnet` → the newest Sonnet); `model`: an exact id. */
  kind: z.enum(['alias', 'model']),
  /** For an alias: what it resolves to on the provider's own API at catalog time (informational). */
  resolvesTo: z.string().max(MAX_MODEL_ID).optional(),
  provider: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/)
    .optional(),
  contextWindow: z.number().int().min(1).max(100_000_000).optional(),
  notes: z.string().max(300).optional(),
  /** Logins the model is known to work with; absent = not known to differ. */
  access: z.array(ModelAccess).min(1).max(2).optional(),
});
export type KnownRuntimeModel = z.infer<typeof KnownRuntimeModel>;

export const MAX_CATALOG_MODELS = 200;

export const RuntimeModelCatalog = z.object({
  version: z.string().min(1).max(32),
  runtimes: z.partialRecord(RuntimeKind, z.array(KnownRuntimeModel).max(MAX_CATALOG_MODELS)),
});
export type RuntimeModelCatalog = z.infer<typeof RuntimeModelCatalog>;

const BOTH: ModelAccess[] = ['subscription', 'api-key'];

/**
 * The maintained catalog. Sources (verified 2026-10-23): Claude Code model aliases and ids from
 * code.claude.com/docs/en/model-config (`--model` takes an alias or a full model name; `[1m]` suffixes are left out:
 * the model id rule has no brackets and the current models run 1M natively); Codex from `codex debug models --bundled`
 * (codex-cli 0.163.0, models with visibility `list`); Pi / OpenCode take `provider/model` (`pi --list-models`,
 * `opencode models`), listed here for the Anthropic and OpenAI providers only — the machine lists name the rest.
 */
export const BUILTIN_RUNTIME_MODEL_CATALOG: RuntimeModelCatalog = {
  version: RUNTIME_MODEL_CATALOG_VERSION,
  runtimes: {
    'claude-code': [
      {
        id: 'fable',
        displayName: 'Fable',
        kind: 'alias',
        resolvesTo: 'claude-fable-5-1',
        provider: 'anthropic',
        notes: 'For the longest, hardest tasks; never the account default, chosen explicitly.',
        access: BOTH,
      },
      {
        id: 'opus',
        displayName: 'Opus',
        kind: 'alias',
        resolvesTo: 'claude-opus-5-5',
        provider: 'anthropic',
        access: BOTH,
      },
      {
        id: 'sonnet',
        displayName: 'Sonnet',
        kind: 'alias',
        resolvesTo: 'claude-sonnet-5-5',
        provider: 'anthropic',
        access: BOTH,
      },
      {
        id: 'haiku',
        displayName: 'Haiku',
        kind: 'alias',
        resolvesTo: 'claude-haiku-5-5',
        provider: 'anthropic',
        access: BOTH,
      },
      {
        id: 'best',
        displayName: 'Best (Fable, else Opus)',
        kind: 'alias',
        provider: 'anthropic',
        access: BOTH,
      },
      {
        id: 'opusplan',
        displayName: 'Opus plan (Opus plans, Sonnet executes)',
        kind: 'alias',
        provider: 'anthropic',
        access: BOTH,
      },
      {
        id: 'claude-fable-5-1',
        displayName: 'Claude Fable 5.1',
        kind: 'model',
        provider: 'anthropic',
        contextWindow: 1_000_000,
        access: BOTH,
      },
      {
        id: 'claude-fable-5',
        displayName: 'Claude Fable 5',
        kind: 'model',
        provider: 'anthropic',
        contextWindow: 1_000_000,
        access: BOTH,
      },
      {
        id: 'claude-opus-5-5',
        displayName: 'Claude Opus 5.5',
        kind: 'model',
        provider: 'anthropic',
        contextWindow: 1_000_000,
        access: BOTH,
      },
      {
        id: 'claude-sonnet-5-5',
        displayName: 'Claude Sonnet 5.5',
        kind: 'model',
        provider: 'anthropic',
        contextWindow: 1_000_000,
        access: BOTH,
      },
      {
        id: 'claude-haiku-5-5',
        displayName: 'Claude Haiku 5.5',
        kind: 'model',
        provider: 'anthropic',
        contextWindow: 1_000_000,
        access: BOTH,
      },
      {
        id: 'claude-opus-4-8',
        displayName: 'Claude Opus 4.8',
        kind: 'model',
        provider: 'anthropic',
        access: BOTH,
      },
      {
        id: 'claude-sonnet-5',
        displayName: 'Claude Sonnet 5',
        kind: 'model',
        provider: 'anthropic',
        access: BOTH,
      },
      {
        id: 'claude-opus-4-6',
        displayName: 'Claude Opus 4.6',
        kind: 'model',
        provider: 'anthropic',
        access: BOTH,
      },
      {
        id: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        kind: 'model',
        provider: 'anthropic',
        access: BOTH,
      },
      {
        id: 'claude-haiku-4-5',
        displayName: 'Claude Haiku 4.5',
        kind: 'model',
        provider: 'anthropic',
        contextWindow: 200_000,
        access: BOTH,
      },
    ],
    codex: [
      {
        id: 'gpt-6-astra',
        displayName: 'GPT-6-Astra',
        kind: 'model',
        provider: 'openai',
        contextWindow: 272_000,
      },
      {
        id: 'gpt-6.1-sol',
        displayName: 'GPT-6.1-Sol',
        kind: 'model',
        provider: 'openai',
        contextWindow: 272_000,
      },
      {
        id: 'gpt-6-sol',
        displayName: 'GPT-6-Sol',
        kind: 'model',
        provider: 'openai',
        contextWindow: 272_000,
      },
      {
        id: 'gpt-6-luna',
        displayName: 'GPT-6-Luna',
        kind: 'model',
        provider: 'openai',
        contextWindow: 272_000,
      },
      {
        id: 'gpt-5.6-sol',
        displayName: 'GPT-5.6-Sol',
        kind: 'model',
        provider: 'openai',
        contextWindow: 272_000,
      },
      {
        id: 'gpt-5.6-terra',
        displayName: 'GPT-5.6-Terra',
        kind: 'model',
        provider: 'openai',
        contextWindow: 272_000,
      },
      {
        id: 'gpt-5.6-luna',
        displayName: 'GPT-5.6-Luna',
        kind: 'model',
        provider: 'openai',
        contextWindow: 272_000,
      },
      { id: 'gpt-5.5', displayName: 'GPT-5.5', kind: 'model', provider: 'openai', contextWindow: 272_000 },
    ],
    pi: [
      {
        id: 'anthropic/claude-opus-5-5',
        displayName: 'Claude Opus 5.5 (Anthropic)',
        kind: 'model',
        provider: 'anthropic',
        notes: 'Pi runs models of providers with a configured API key only.',
        access: ['api-key'],
      },
      {
        id: 'anthropic/claude-sonnet-5-5',
        displayName: 'Claude Sonnet 5.5 (Anthropic)',
        kind: 'model',
        provider: 'anthropic',
        access: ['api-key'],
      },
      {
        id: 'anthropic/claude-haiku-5-5',
        displayName: 'Claude Haiku 5.5 (Anthropic)',
        kind: 'model',
        provider: 'anthropic',
        access: ['api-key'],
      },
      {
        id: 'openai/gpt-5.5',
        displayName: 'GPT-5.5 (OpenAI)',
        kind: 'model',
        provider: 'openai',
        access: ['api-key'],
      },
    ],
    opencode: [
      {
        id: 'anthropic/claude-opus-5-5',
        displayName: 'Claude Opus 5.5 (Anthropic)',
        kind: 'model',
        provider: 'anthropic',
        notes: 'OpenCode runs models of configured providers only.',
      },
      {
        id: 'anthropic/claude-sonnet-5-5',
        displayName: 'Claude Sonnet 5.5 (Anthropic)',
        kind: 'model',
        provider: 'anthropic',
      },
      {
        id: 'anthropic/claude-haiku-5-5',
        displayName: 'Claude Haiku 5.5 (Anthropic)',
        kind: 'model',
        provider: 'anthropic',
      },
      { id: 'openai/gpt-5.5', displayName: 'GPT-5.5 (OpenAI)', kind: 'model', provider: 'openai' },
    ],
  },
};

/** The catalog's models of one runtime (empty when it lists none). */
export function catalogModelsFor(
  runtime: RuntimeKind,
  catalog: RuntimeModelCatalog = BUILTIN_RUNTIME_MODEL_CATALOG,
): readonly KnownRuntimeModel[] {
  return catalog.runtimes[runtime] ?? [];
}

// ------------------------------------------------------------------------------------------ worker report

/** At most this many models per runtime in one report (OpenCode / Pi can list hundreds; the rest is `truncated`). */
export const MAX_DISCOVERED_MODELS = 500;

export const DiscoveredModel = z.object({
  id: RuntimeModelId,
  displayName: z.string().max(128).optional(),
  contextWindow: z.number().int().min(1).max(100_000_000).optional(),
});
export type DiscoveredModel = z.infer<typeof DiscoveredModel>;

/**
 * One runtime's models as one worker found them.
 *  - `cli`: the runtime's own list command answered (`command`), so these are the models this machine's login /
 *    configured providers can use;
 *  - `builtin`: the runtime has no list command (Claude Code) — the aliases and ids this worker release knows;
 *  - `failed`: the list command failed (`error`, redacted one line); `models` is empty.
 * `access`: the login kind of the runtime's default account when the worker knows it (subscription vs. API key).
 */
export const RuntimeModelDiscovery = z.object({
  runtime: RuntimeKind,
  source: z.enum(['cli', 'builtin', 'failed']),
  command: z.string().max(128).optional(),
  access: ModelAccess.optional(),
  checkedAt: z.iso.datetime(),
  models: z.array(DiscoveredModel).max(MAX_DISCOVERED_MODELS),
  truncated: z.boolean().optional(),
  error: z.string().max(300).optional(),
});
export type RuntimeModelDiscovery = z.infer<typeof RuntimeModelDiscovery>;

/** CAPABILITIES `runtimeModels` (additive in 1.0, with `runtime-models-v1`). */
export const RuntimeModelsReport = z.object({
  /** The worker release's {@link RUNTIME_MODEL_CATALOG_VERSION}. */
  catalogVersion: z.string().min(1).max(32),
  runtimes: z.array(RuntimeModelDiscovery).max(8),
});
export type RuntimeModelsReport = z.infer<typeof RuntimeModelsReport>;

// ------------------------------------------------------------------------------------------ merge

export interface ModelSeenOn {
  readonly workerId: string;
  readonly workerName: string;
  readonly source: 'cli' | 'builtin';
  readonly access?: ModelAccess | undefined;
}

export interface MergedRuntimeModel {
  readonly id: string;
  readonly displayName: string;
  readonly kind: 'alias' | 'model';
  readonly resolvesTo?: string | undefined;
  readonly provider?: string | undefined;
  readonly contextWindow?: number | undefined;
  readonly notes?: string | undefined;
  readonly access?: readonly ModelAccess[] | undefined;
  /** In the maintained catalog (false: only a machine reported it). */
  readonly inCatalog: boolean;
  /** Machines whose report lists it (empty: catalog only — no machine confirmed it). */
  readonly machines: readonly ModelSeenOn[];
}

export interface WorkerModelReport {
  readonly workerId: string;
  readonly workerName: string;
  readonly discovery: RuntimeModelDiscovery;
}

/**
 * Catalog + worker reports for one runtime: catalog models first (catalog order), then models only machines reported
 * (by id). A model counts as on a machine when that machine's report lists it; failed reports add nothing.
 */
export function mergeRuntimeModels(
  runtime: RuntimeKind,
  reports: readonly WorkerModelReport[],
  catalog: RuntimeModelCatalog = BUILTIN_RUNTIME_MODEL_CATALOG,
): MergedRuntimeModel[] {
  const seen = new Map<string, ModelSeenOn[]>();
  const extra = new Map<string, DiscoveredModel>();
  const known = new Set(catalogModelsFor(runtime, catalog).map((m) => m.id));
  const ordered = [...reports].sort(
    (a, b) => a.workerName.localeCompare(b.workerName) || a.workerId.localeCompare(b.workerId),
  );
  for (const r of ordered) {
    const d = r.discovery;
    if (d.runtime !== runtime || d.source === 'failed') continue;
    for (const m of d.models) {
      const on = seen.get(m.id) ?? [];
      if (on.some((x) => x.workerId === r.workerId)) continue;
      on.push({
        workerId: r.workerId,
        workerName: r.workerName,
        source: d.source,
        ...(d.access === undefined ? {} : { access: d.access }),
      });
      seen.set(m.id, on);
      if (!known.has(m.id) && !extra.has(m.id)) extra.set(m.id, m);
    }
  }
  const out: MergedRuntimeModel[] = catalogModelsFor(runtime, catalog).map((m) => ({
    ...m,
    inCatalog: true,
    machines: seen.get(m.id) ?? [],
  }));
  for (const m of [...extra.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    out.push({
      id: m.id,
      displayName: m.displayName ?? m.id,
      kind: 'model',
      ...(m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow }),
      inCatalog: false,
      machines: seen.get(m.id) ?? [],
    });
  }
  return out;
}
