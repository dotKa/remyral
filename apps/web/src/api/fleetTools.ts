import { apiRequest, obj, type RequestOptions, ShapeError } from './client';

/**
 * p13-fleet-tools (docs/design/p13-fleet-tools.md, ADR-0052; apps/master/src/fleet-tools): tool and runtime versions
 * across the fleet, bulk updates / installs (remote operations or machine-admin jobs, queued for offline machines),
 * admin-defined ("custom") tool recipes and the weekly update digest setting.
 *
 * Reads are fleet information (viewer+). Bulk release-recipe installs and runtime installs are remote operations
 * (admin + step-up); elevated recipes and custom tools are machine administration (admin + always-fresh step-up).
 */

type Opts = Pick<RequestOptions, 'signal' | 'fetchImpl' | 'cookieString'>;

export type VersionStatus = 'current' | 'update_available' | 'pin_differs' | 'not_found' | 'unknown';
export type ItemKind = 'runtime' | 'tool' | 'custom';
export type LatestState = 'ok' | 'unchecked' | 'failed' | 'none';

/** One tool / runtime the fleet view knows (rows of the matrix). */
export interface CatalogItem {
  /** `claude-code`, `codex`, `pi`, `opencode`, `git`, `python`, `node`, `uv`, `browser`, `cloudflared`, `ffmpeg`, `custom:<name>`. */
  readonly id: string;
  readonly kind: ItemKind;
  readonly label: string;
  /** Release recipe of a managed tool (absent: the platform cannot install it). */
  readonly recipe?: string;
  /** The fleet default pin: the runtime pin of this release / the release recipe version / the custom recipe version. */
  readonly pinned: string | null;
  /** Latest version at the official source (null: unknown — see latestState). */
  readonly latest: string | null;
  readonly latestState: LatestState;
  readonly latestCheckedAt: string | null;
  /** Human link to the source (npm page, GitHub releases …). */
  readonly sourceUrl: string | null;
  /** Upstream release behind the recipe pin (e.g. Playwright 1.64.1 for Chromium revision 1248). */
  readonly upstreamPinned?: string | null;
  /** p17-update-channel: the newest entry of the master's version catalog (verified ones first; absent: none). */
  readonly catalog?: {
    readonly version: string;
    readonly verified: boolean;
    readonly sequence: number;
  } | null;
}

export type ActionKind =
  'tool.install' | 'tool.remove' | 'runtime.install' | 'tool.elevated' | 'custom.install' | 'custom.remove';

/** What the fleet can do for one cell (null: nothing to do, or not possible on this machine). */
export interface CellAction {
  readonly kind: ActionKind;
  readonly version: string;
}

export interface MatrixCell {
  readonly item: string;
  /** What jobs use (the effective install), null when not found. */
  readonly installed: string | null;
  readonly source: 'managed' | 'system' | 'config' | 'path' | null;
  /** Also present: the other install that jobs do not use (e.g. a system git next to the worker's). */
  readonly shadowed?: { readonly version: string | null; readonly source: 'managed' | 'system' } | null;
  /** The pin that applies on this machine (runtime policy pin / release recipe version). */
  readonly pinned: string | null;
  readonly latest: string | null;
  readonly status: VersionStatus;
  /** An update / install this machine can take now. */
  readonly action: CellAction | null;
  /**
   * Why no action is possible — a CODE, not display text: `worker_update_required`, `platform_unsupported`,
   * `release_update_required`, `machine_admin_not_enabled`, `not_operable` (see {@link blockedText}; unknown codes
   * show raw).
   */
  readonly blocked?: string;
  /** Runtimes: versions the worker can install (its pinned set). */
  readonly available?: readonly string[];
  /**
   * p16-runtime-updates: a version newer than this machine's release pins it can install labelled unverified (only
   * while the security policy allows it and the worker build supports it).
   */
  readonly unverifiedAction?: CellAction;
  /** p16-runtime-updates: the active version is an owner-approved install outside the pins. */
  readonly unverifiedActive?: { readonly version: string; readonly pin: string };
  /** p16-runtime-updates: back to the pin (from an unverified version). */
  readonly rollback?: CellAction;
  /** p16-runtime-updates: false when the machine cannot install outside its pinned set. */
  readonly unverifiedSupported?: boolean;
}

export interface MatrixMachine {
  readonly workerId: string;
  readonly name: string;
  readonly os: string;
  readonly arch: string;
  readonly connected: boolean;
  readonly state: string;
  /** Canary machine of its runtime policy group. */
  readonly canary: boolean;
  readonly policy: string | null;
  readonly machineAdminEnabled: boolean;
  readonly features: {
    readonly remoteOps: boolean;
    readonly tools: boolean;
    readonly customTools: boolean;
    readonly machineAdmin: boolean;
    /** p16-runtime-updates: `runtime-unverified-v1` (absent on an older master). */
    readonly runtimeUnverified?: boolean;
  };
  readonly inventoryAt: string | null;
  readonly cells: readonly MatrixCell[];
}

export interface FleetToolsSummary {
  /** Cells with `update_available` or `pin_differs`. */
  readonly updates: number;
  /** Of those, the ones an action can fix now. */
  readonly actionable: number;
  readonly machinesWithUpdates: number;
  readonly notFound: number;
  /** p16-runtime-updates: of `updates`, the ones an action can do now (pinned or unverified) — "kurulabilir". */
  readonly installable?: number;
  /** p16-runtime-updates: updates only a new worker release can bring. */
  readonly releaseRequired?: number;
  /** p16-runtime-updates: of `installable`, the ones that would be unverified. */
  readonly unverified?: number;
  /** p16-runtime-updates: runtimes running an owner-approved unverified version. */
  readonly unverifiedActive?: number;
}

export type VerifyCheckId =
  | 'integrity'
  | 'version'
  | 'bundled_version'
  | 'help'
  | 'server_auth'
  | 'adapter_probe'
  | 'headless_prompt'
  | 'contract_suite';

/** One check of a runtime verification run (`skipped`: not automatable — never counted as passed). */
export interface VerifyCheck {
  readonly id: string;
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly required?: boolean;
  readonly detail?: string;
}

export interface VerificationRun {
  readonly id: string;
  readonly workerId: string;
  readonly workerName: string | null;
  readonly os: string | null;
  readonly arch: string | null;
  readonly trigger: 'schedule' | 'feed' | 'manual';
  readonly state: 'running' | 'passed' | 'failed' | 'error';
  readonly checks: readonly VerifyCheck[];
  readonly reason: string | null;
  readonly detail: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

/** p16-runtime-updates: a runtime version newer than the pin, resolved from the registry, and its verification. */
export interface RuntimeCandidate {
  readonly runtime: string;
  readonly version: string;
  readonly pin: string;
  readonly package: string;
  readonly packageVersion: string;
  readonly integrity: string;
  readonly resolvedAt: string;
  /** passed = a verified candidate (the automatable checks only), ready for promotion by a worker release. */
  readonly verifyState: 'none' | 'running' | 'passed' | 'failed';
  readonly verifiedAt: string | null;
  readonly lock: { readonly sha256: string; readonly bytes: number; readonly workerId: string | null } | null;
  readonly lastRun: VerificationRun | null;
}

export interface FleetTools {
  readonly generatedAt: string;
  readonly feed: { readonly enabled: boolean; readonly checkedAt: string | null };
  readonly catalog: readonly CatalogItem[];
  readonly machines: readonly MatrixMachine[];
  readonly summary: FleetToolsSummary;
  /** p16-runtime-updates: the security policy's fleet switch as the matrix applied it (absent: an older master). */
  readonly policy?: { readonly unverifiedRuntimeUpdates: boolean };
  /** p16-runtime-updates: resolved runtime versions outside the pins and their verification (newest first). */
  readonly candidates?: readonly RuntimeCandidate[];
}

export type TargetState =
  'queued' | 'held' | 'sent' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'expired' | 'cancelled';

export interface ActionTarget {
  readonly workerId: string;
  readonly name: string;
  /** 1: canary machines (rollout canary-first), 2: the rest. */
  readonly phase: 1 | 2;
  readonly state: TargetState;
  readonly version: string | null;
  readonly attempts: number;
  /**
   * A machine CODE (`version_not_available`, `worker_update_required`, `machine_admin_not_enabled`,
   * `platform_unsupported`, `no_platform_step`, `actor_not_authorised`, `expired`, `send_failed`, worker remote-op
   * reasons such as `integrity_mismatch` / `custom_tools_not_allowed`); see {@link reasonText}.
   */
  readonly reason: string | null;
  /** English detail from the worker / master (secondary text). */
  readonly detail: string | null;
  readonly opId: string | null;
  readonly jobId: string | null;
  readonly updatedAt: string;
}

export interface FleetAction {
  readonly id: string;
  readonly kind: ActionKind;
  readonly item: string;
  readonly version: string | null;
  readonly rollout: 'all' | 'canary-first';
  readonly state: 'running' | 'held' | 'done' | 'cancelled';
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly expiresAt: string;
  readonly finishedAt: string | null;
  readonly counts: Readonly<Partial<Record<TargetState, number>>>;
  readonly targets: readonly ActionTarget[];
}

export interface NewAction {
  readonly kind: ActionKind;
  readonly item: string;
  /** Absent: per machine, the best target (the pin / the release recipe). */
  readonly version?: string;
  /** Worker ids, or 'all' (every machine the action applies to). */
  readonly workers: readonly string[] | 'all';
  readonly rollout?: 'all' | 'canary-first';
  /** Offline machines get it when they reconnect, until this many hours have passed (1–168, default 24). */
  readonly expiresInHours?: number;
  /** Machine-admin actions only. */
  readonly approvalPolicy?: 'ask-all' | 'allow-all';
  /**
   * p16-runtime-updates: `runtime.install` of a version outside the release pins (default: the newest at the source),
   * labelled unverified — only while the security policy allows it.
   */
  readonly unverified?: boolean;
}

/** p16-runtime-updates: one machine's skip reason in a 409 `nothing_to_do` (never swallowed by the console). */
export interface SkippedTarget {
  readonly workerId: string;
  readonly reason: string;
}

/** The per-machine reasons of a refused fleet action (`details.skipped` of a 409), or [] for any other error. */
export function skippedOf(err: unknown): SkippedTarget[] {
  if (typeof err !== 'object' || err === null) return [];
  const details = (err as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) return [];
  const list = (details as { skipped?: unknown }).skipped;
  if (!Array.isArray(list)) return [];
  return list.flatMap((x: unknown) => {
    if (typeof x !== 'object' || x === null) return [];
    const o = x as Record<string, unknown>;
    return typeof o.workerId === 'string' && typeof o.reason === 'string'
      ? [{ workerId: o.workerId, reason: o.reason }]
      : [];
  });
}

/** Elevated recipes and custom tools are machine administration (always-fresh step-up). */
export function isAdminAction(kind: ActionKind): boolean {
  return kind === 'tool.elevated' || kind === 'custom.install' || kind === 'custom.remove';
}

export type ToolPlatform = 'win32-x64' | 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64';
export const TOOL_PLATFORMS: readonly ToolPlatform[] = [
  'win32-x64',
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
];
export type PackageManager = 'winget' | 'brew' | 'apt' | 'dnf' | 'npm' | 'pipx';
export const PACKAGE_MANAGERS: readonly PackageManager[] = ['winget', 'brew', 'apt', 'dnf', 'npm', 'pipx'];

export type CustomStep =
  | {
      readonly kind: 'download';
      readonly url: string;
      readonly sha256: string;
      readonly size: number;
      readonly format: 'zip' | 'tgz' | 'raw';
      readonly strip?: string;
      readonly entry: string;
    }
  | { readonly kind: 'package'; readonly manager: PackageManager; readonly package: string };

export interface CustomRecipeDoc {
  readonly name: string;
  readonly title: string;
  readonly version: string;
  readonly description?: string;
  readonly pinPackageVersion?: boolean;
  readonly platforms: Readonly<Partial<Record<ToolPlatform, CustomStep>>>;
  readonly check: { readonly binary?: string; readonly args?: readonly string[] };
}

export interface CustomRecipe {
  readonly id: string;
  readonly recipe: CustomRecipeDoc;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: string | null;
}

export interface FleetToolSettings {
  readonly digestEnabled: boolean;
  readonly lastDigestAt: string | null;
}

/** Hosts a custom download may come from (the master and the worker check the same list). */
export interface RecipeLimits {
  readonly hosts: readonly string[];
  readonly reservedNames: readonly string[];
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the checked body is the caller's type
function shape<T>(check: (o: Record<string, unknown>) => boolean, what: string) {
  return (body: unknown): T => {
    const o = obj(body);
    if (!check(o)) throw new ShapeError(`unexpected ${what}`);
    return o as T;
  };
}

const parseTools = shape<FleetTools>(
  (o) => Array.isArray(o.machines) && Array.isArray(o.catalog),
  'fleet tools',
);
const parseAction = shape<FleetAction>((o) => typeof o.id === 'string' && Array.isArray(o.targets), 'action');
const parseActions = (b: unknown): FleetAction[] => {
  const o = obj(b);
  if (!Array.isArray(o.actions)) throw new ShapeError('unexpected actions');
  return o.actions as FleetAction[];
};
const parseRecipe = shape<CustomRecipe>(
  (o) => typeof o.id === 'string' && typeof o.recipe === 'object',
  'recipe',
);
const parseRecipes = (b: unknown): { recipes: CustomRecipe[]; limits: RecipeLimits } => {
  const o = obj(b);
  if (!Array.isArray(o.recipes)) throw new ShapeError('unexpected recipes');
  return { recipes: o.recipes as CustomRecipe[], limits: obj(o.limits) as unknown as RecipeLimits };
};
const parseSettings = shape<FleetToolSettings>((o) => typeof o.digestEnabled === 'boolean', 'settings');

/** The fleet matrix; `worker` narrows it to one machine (Makine → Araçlar / Runtime’lar). */
export function getFleetTools(worker?: string, opts: Opts = {}): Promise<FleetTools> {
  const q = worker === undefined ? '' : `?worker=${encodeURIComponent(worker)}`;
  return apiRequest('GET', `/fleet/tools${q}`, parseTools, opts);
}

export function refreshVersionFeed(opts: Opts = {}): Promise<FleetTools> {
  return apiRequest('POST', '/fleet/tools/feed/refresh', parseTools, { ...opts, body: {} });
}

export function listFleetActions(opts: Opts = {}): Promise<FleetAction[]> {
  return apiRequest('GET', '/fleet/tools/actions', parseActions, opts);
}

export function getFleetAction(id: string, opts: Opts = {}): Promise<FleetAction> {
  return apiRequest('GET', `/fleet/tools/actions/${encodeURIComponent(id)}`, parseAction, opts);
}

/**
 * Release recipes and runtimes → `/actions` (step-up); elevated / custom → `/admin-actions` (always-fresh).
 * Answers 201 with the created {@link FleetAction}.
 */
export function startFleetAction(a: NewAction, opts: Opts = {}): Promise<FleetAction> {
  const path = isAdminAction(a.kind) ? '/fleet/tools/admin-actions' : '/fleet/tools/actions';
  return apiRequest('POST', path, parseAction, { ...opts, body: a });
}

/** p16-runtime-updates: "Şimdi doğrula" — verify a runtime version newer than the pin on a canary machine (step-up). */
export function verifyRuntimeCandidate(
  runtime: string,
  version?: string,
  opts: Opts = {},
): Promise<{ id: string; workerId: string }> {
  return apiRequest(
    'POST',
    '/fleet/tools/runtime-candidates/verify',
    (b) => {
      const o = obj(b);
      if (typeof o.id !== 'string' || typeof o.workerId !== 'string') throw new ShapeError('unexpected run');
      return { id: o.id, workerId: o.workerId };
    },
    { ...opts, body: version === undefined ? { runtime } : { runtime, version } },
  );
}

/** p16-runtime-updates: the stored npm lockfile of a runtime release outside the pins (promotion input). */
export function getRuntimeLock(runtime: string, version: string, opts: Opts = {}): Promise<unknown> {
  return apiRequest(
    'GET',
    `/fleet/tools/runtime-candidates/${encodeURIComponent(runtime)}/${encodeURIComponent(version)}/lock`,
    (b) => b,
    opts,
  );
}

function actionPost(id: string, verb: 'continue' | 'retry' | 'cancel', body: unknown, opts: Opts) {
  return apiRequest('POST', `/fleet/tools/actions/${encodeURIComponent(id)}/${verb}`, parseAction, {
    ...opts,
    body,
  });
}

/** Canary-first: the canary machines succeeded — roll out to the rest. */
export function continueFleetAction(id: string, opts: Opts = {}): Promise<FleetAction> {
  return actionPost(id, 'continue', {}, opts);
}

export function retryFleetAction(id: string, workers?: readonly string[], opts: Opts = {}) {
  return actionPost(id, 'retry', workers === undefined ? {} : { workers }, opts);
}

export function cancelFleetAction(id: string, opts: Opts = {}): Promise<FleetAction> {
  return actionPost(id, 'cancel', {}, opts);
}

export function listCustomRecipes(opts: Opts = {}) {
  return apiRequest('GET', '/fleet/tools/recipes', parseRecipes, opts);
}

export function createCustomRecipe(recipe: CustomRecipeDoc, opts: Opts = {}): Promise<CustomRecipe> {
  return apiRequest('POST', '/fleet/tools/recipes', parseRecipe, { ...opts, body: { recipe } });
}

export function updateCustomRecipe(
  id: string,
  recipe: CustomRecipeDoc,
  opts: Opts = {},
): Promise<CustomRecipe> {
  return apiRequest('PUT', `/fleet/tools/recipes/${encodeURIComponent(id)}`, parseRecipe, {
    ...opts,
    body: { recipe },
  });
}

export function deleteCustomRecipe(id: string, opts: Opts = {}): Promise<void> {
  return apiRequest('DELETE', `/fleet/tools/recipes/${encodeURIComponent(id)}`, () => undefined, opts);
}

export function getFleetToolSettings(opts: Opts = {}): Promise<FleetToolSettings> {
  return apiRequest('GET', '/fleet/tools/settings', parseSettings, opts);
}

export function putFleetToolSettings(digestEnabled: boolean, opts: Opts = {}): Promise<FleetToolSettings> {
  return apiRequest('PUT', '/fleet/tools/settings', parseSettings, { ...opts, body: { digestEnabled } });
}

export const STATUS_WORD: Readonly<Record<VersionStatus, string>> = {
  current: 'güncel',
  update_available: 'güncelleme var',
  pin_differs: 'pin’den farklı',
  not_found: 'bulunamadı',
  unknown: 'bilinmiyor',
};

// ------------------------------------------------------------------------------------------------ words (web only)

/** `MatrixCell.blocked` codes in Turkish (unknown: the raw code). */
export const BLOCKED_WORD: Readonly<Record<string, string>> = {
  worker_update_required: 'Worker güncellenmeli',
  platform_unsupported: 'Bu işletim sistemi/mimaride kurulamaz',
  release_update_required: 'Yeni sürüm worker sürümüyle gelir',
  machine_admin_not_enabled: 'Makine yönetimi açık değil',
  not_operable: 'Makine işlem alamaz (onay bekliyor / karantinada)',
};

export function blockedText(code: string): string {
  return BLOCKED_WORD[code] ?? code;
}

/** `ActionTarget.reason` codes in Turkish (unknown: the raw code). */
export const REASON_WORD: Readonly<Record<string, string>> = {
  version_not_available: 'Bu sürüm bu makinede kurulamıyor',
  worker_update_required: 'Worker güncellenmeli',
  machine_admin_not_enabled: 'Makine yönetimi açık değil',
  platform_unsupported: 'Bu işletim sistemi/mimaride kurulamaz',
  no_platform_step: 'Tarifte bu platform için adım yok',
  actor_not_authorised: 'Bu işlemi başlatan kişinin yetkisi yok',
  expired: 'Makine süre dolmadan geri gelmedi',
  send_failed: 'Makineye gönderilemedi',
  integrity_mismatch: 'Sağlama toplamı tutmadı',
  custom_tools_not_allowed: 'Bu makinede özel araçlara izin verilmiyor',
};

export function reasonText(code: string): string {
  return REASON_WORD[code] ?? code;
}

/** Per-machine progress states in Turkish. */
export const TARGET_STATE_WORD: Readonly<Record<TargetState, string>> = {
  queued: 'sırada',
  held: 'beklemede (kanarya sonrası)',
  sent: 'gönderildi',
  running: 'çalışıyor',
  succeeded: 'başarılı',
  failed: 'başarısız',
  skipped: 'atlandı',
  expired: 'süresi doldu',
  cancelled: 'iptal',
};

export const ACTION_KIND_WORD: Readonly<Record<ActionKind, string>> = {
  'tool.install': 'Kurulum / güncelleme',
  'tool.remove': 'Kaldırma',
  'runtime.install': 'Runtime kurulumu / güncellemesi',
  'tool.elevated': 'Yetkili kurulum (makine yönetimi)',
  'custom.install': 'Özel araç kurulumu',
  'custom.remove': 'Özel araç kaldırma',
};

/** The matrix item of an inventory tool name (`playwright-chromium` → `browser`; custom tools → `custom:<name>`). */
export function itemOfTool(name: string, custom = false): string {
  if (custom) return `custom:${name}`;
  return name === 'playwright-chromium' ? 'browser' : name;
}

/** "en son" in words: the version, or why it is unknown. */
export function latestText(item: Pick<CatalogItem, 'latest' | 'latestState'> | undefined): string {
  if (item === undefined) return '—';
  if (item.latestState === 'failed') return 'kontrol edilemedi';
  if (item.latestState === 'unchecked') return 'henüz kontrol edilmedi';
  return item.latest ?? '—';
}
