/**
 * p6-ui-refactor §4 "Humane reasons", p14-i18n-reasons (i18n Phase 4): one mapping from the reason codes the
 * master, the scheduler and the worker report (packages/scheduler/src/placement.ts REASON_CODES, the fleet
 * compatibility statuses of apps/master/src/fleetview/overview.ts, the worker's `login_expired`, …) to one sentence
 * in user vocabulary plus the action that fixes it. The sentences and fix labels live in the `reasons` namespace of
 * `@remyral/i18n` (TR + EN, one catalog for both shells — this file keeps only the fix targets); a code whose sentence
 * depends on why it happened is said from the reason's `params.cause` (`@remyral/protocol/reasons` REASON_CAUSES).
 * The raw code and the reported text stay available (ReasonNotice / DyReason show them under "Details"). Unknown
 * codes fall back to the raw text, never to a made-up sentence.
 *
 * Reason texts are untrusted (built from worker reports): they are only ever rendered as text.
 */
import {
  type Locale,
  messagesFor,
  reasonCodes,
  reasonSentence,
  type ReasonActionKey,
  type ReasonVars,
} from '@remyral/i18n';
import { boundedReasonParams, reasonCause, type ReasonParams } from '@remyral/protocol/reasons';

export type { ReasonParams } from '@remyral/protocol/reasons';

export interface ReasonAction {
  readonly label: string;
  readonly href: string;
}

/** What the reason is about, so the sentence and the fix link can be specific. All optional. */
export interface ReasonContext {
  readonly workerId?: string | null;
  /** The machine's display name (used in sentences when given). */
  readonly workerName?: string | null;
  readonly runtime?: string | null;
  readonly project?: string | null;
}

export interface ReasonInfo {
  /** The code (`capability_unverified`), or null when the raw text carries none. */
  readonly code: string | null;
  /** The variant the sentence was said in (`params.cause`, or the legacy text fallback); null: the default. */
  readonly cause: string | null;
  /** One sentence in user vocabulary; the raw text itself when the code is unknown. */
  readonly sentence: string;
  /** The fix, or null when there is nothing the user can do from the panel. */
  readonly action: ReasonAction | null;
  /** The text as reported (code plus the master's message). */
  readonly raw: string;
  /** False when the code is not in the mapping (the sentence is then the raw text). */
  readonly known: boolean;
}

/** API parsing (lenient): `{ params }` when `v` holds client-safe reason params, else `{}` (older masters). */
export function reasonParamsField(v: unknown): { readonly params?: ReasonParams } {
  const params = boundedReasonParams(v);
  return params === undefined ? {} : { params };
}

/** How to say a reason: the reader's language (default English, the classic console) and the reason's params. */
export interface DescribeOptions {
  readonly locale?: Locale;
  /** The reason's params as reported (`cause` picks the variant); absent for reasons that carry none. */
  readonly params?: ReasonParams | null | undefined;
}

const RUNTIME_NAMES: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
  // ADR-0023: removed from the platform; only stored history still names it.
  openhands: 'OpenHands (removed)',
};

/** ADR-0023: runtimes the platform no longer runs (history only — never offered for new work). */
export const RETIRED_RUNTIMES: readonly string[] = ['openhands'];

export function isRetiredRuntime(id: string | null | undefined): boolean {
  return id !== null && id !== undefined && RETIRED_RUNTIMES.includes(id);
}

/** "Claude Code" for `claude-code`; unknown ids as they are. */
export function runtimeName(id: string): string {
  return RUNTIME_NAMES[id] ?? id;
}

/**
 * Machine page deep link (`/machines?worker=<id>&section=<card>`), or the machine list without a worker. The
 * machine list redirects it to `/machines/<id>?tab=<tab>` (screens/fleet/machineLinks.ts maps the sections).
 */
export function machineHref(workerId: string | null | undefined, section?: string): string {
  if (workerId === null || workerId === undefined || workerId === '') return '/machines';
  const q = new URLSearchParams({ worker: workerId });
  if (section !== undefined) q.set('section', section);
  return `/machines?${q.toString()}`;
}

/** A project's page (`/projects/:id`, p6 Phase B), optionally on one tab; `/projects` without a project. */
export function projectHref(
  project: string | null | undefined,
  tab?: 'repository' | 'machines' | 'policy' | 'members',
): string {
  if (project === null || project === undefined || project === '') return '/projects';
  return `/projects/${encodeURIComponent(project)}${tab === undefined ? '' : `?tab=${tab}`}`;
}

/** A fix: the catalog key of its label and its target. */
interface Fix {
  readonly key: ReasonActionKey;
  readonly href: string;
}
/** The fix for a code (`cause`: the variant, p14-login-status-consistency: the fix depends on why). */
type FixOf = (c: ReasonContext, cause: string | null) => Fix | null;

const RUNTIME_POLICY: Fix = { key: 'openRuntimePolicy', href: '/settings/runtimes' };
const allow: FixOf = () => ({ key: 'allow', href: '/settings/runtimes' });
const runtimePolicy: FixOf = () => RUNTIME_POLICY;
const projectPolicy: FixOf = (c) => ({ key: 'openProjectPolicy', href: projectHref(c.project, 'policy') });
const openMachine: FixOf = (c) => ({ key: 'openMachine', href: machineHref(c.workerId) });
const relogin: FixOf = (c) => ({ key: 'logInAgain', href: machineHref(c.workerId, 'remote-ops') });
const install: FixOf = (c) => ({ key: 'installRuntime', href: machineHref(c.workerId, 'remote-ops') });
const installPinned: FixOf = (c) => ({ key: 'installPinned', href: machineHref(c.workerId, 'remote-ops') });
const update: FixOf = (c) => ({ key: 'updateMachine', href: machineHref(c.workerId) });
const usage: FixOf = () => ({ key: 'openUsage', href: '/usage' });
const credentials: FixOf = () => ({ key: 'openCredentials', href: '/settings/credentials' });
const configuration: FixOf = (c) => ({
  key: 'openConfiguration',
  href: machineHref(c.workerId, 'configuration'),
});
const sandbox =
  (key: ReasonActionKey): FixOf =>
  (c) => ({ key, href: machineHref(c.workerId, 'sandbox') });

/**
 * The fix per code (absent: nothing to do from the panel). Every code here has a catalog sentence and every catalog
 * code is known (KNOWN_REASON_CODES comes from the catalog).
 */
const FIXES: Readonly<Record<string, FixOf>> = {
  capability_unverified: allow,
  unverified: allow,
  runtime_not_installed: install,
  not_installed: install,
  // p10-claude-login-health: a waiting job starts once someone logs in again.
  runtime_not_authenticated: relogin,
  // p14-login-status-consistency: when jobs use an API key or no sign-in method, a subscription login does not
  // help — the fix is the machine's configuration, not logging in again.
  not_authenticated: (c, cause) =>
    cause === 'no_job_auth' || cause === 'job_auth_secret_ref' ? configuration(c, cause) : relogin(c, cause),
  login_expired: relogin,
  login_refresh_contention: relogin,
  // p22-runtime-diagnostics: the fix depends on why the runtime died.
  runtime_crashed: (c, cause) =>
    cause === 'login'
      ? relogin(c, cause)
      : cause === 'usage_limit'
        ? usage(c, cause)
        : cause === 'out_of_memory' || cause === 'killed'
          ? openMachine(c, cause)
          : null,
  runtime_version_unverified: installPinned,
  pin_mismatch: installPinned,
  runtime_version_mismatch: (c) => ({ key: 'changeVersion', href: machineHref(c.workerId, 'remote-ops') }),
  runtime_not_allowed_by_policy: runtimePolicy,
  not_allowed: runtimePolicy,
  runtime_not_enabled: (c) => ({ key: 'enableRuntime', href: machineHref(c.workerId, 'configuration') }),
  no_ready_runtime: (c) => ({ key: 'setUpRuntime', href: machineHref(c.workerId, 'remote-ops') }),
  // Unverified capabilities are in use because the runtime policy allows them: the policy is where that is decided.
  degraded: runtimePolicy,
  model_profile_unavailable: () => ({ key: 'openModels', href: '/settings/models' }),
  model_profile_not_allowed: runtimePolicy,
  credential_missing: credentials,
  secret_bound_to_other_worker: credentials,
  tool_missing: (c) => ({ key: 'installTools', href: machineHref(c.workerId, 'tools') }),
  sandbox_profile_unavailable: sandbox('prepareSandbox'),
  unconfined_not_enabled: sandbox('openSandbox'),
  unconfined_not_opted_in: projectPolicy,
  host_execution_not_enabled: projectPolicy,
  auto_approve_not_allowed: projectPolicy,
  approval_policy_unsupported: update,
  workspace_unsupported: update,
  pr_head_unsupported: update,
  site_bundle_unsupported: update,
  input_bundle_unsupported: update,
  repo_inputs_unsupported: update,
  skill_layout_unsupported: update,
  mcp_unsupported: update,
  function_unsupported: update,
  mcp_not_installed: () => ({ key: 'openMcpServers', href: '/skills?tab=mcp' }),
  integration_unsupported: update,
  machine_admin_unsupported: update,
  machine_admin_not_enabled: (c) => ({
    key: 'openMachineAdmin',
    href: machineHref(c.workerId, 'machine-admin'),
  }),
  project_not_assigned: (c) => ({ key: 'assignMachine', href: projectHref(c.project, 'machines') }),
  project_not_allowed: openMachine,
  project_not_in_worker_allowlist: openMachine,
  repo_not_registered: (c) => ({ key: 'registerRepository', href: projectHref(c.project, 'repository') }),
  config_not_applied: configuration,
  // p15-merge-approvals: Makine → Yapılandırma → En az boş disk.
  disk_low: (c) => ({ key: 'openDiskSetting', href: machineHref(c.workerId, 'configuration') }),
  urgent_slot_reserved: openMachine,
  not_enrolled: (c) => ({ key: 'pairMachine', href: machineHref(c.workerId) }),
  quarantined: openMachine,
  offline: openMachine,
  worker_offline: openMachine,
  draining: openMachine,
  no_workers: () => ({ key: 'openMachines', href: '/machines' }),
  provider_paused: usage,
  account_concurrency: usage,
  budget_exceeded: () => ({ key: 'openBudgets', href: '/usage' }),
  provider_usage_limit: usage,
  usage_limited: usage,
  account_limited: usage,
};

/** The codes with a mapped sentence (tests, docs): the `reasons` catalog's codes. */
// p14-web-perf-2: Turkish is always loaded; both catalogs have the same codes (catalog parity test).
export const KNOWN_REASON_CODES: readonly string[] = reasonCodes(messagesFor('tr'));
const KNOWN = new Set(KNOWN_REASON_CODES);

// ---------------------------------------------------------------------------------------------------------------
// LEGACY text fallback (p14-i18n-reasons) — REMOVE in the release after this one (i18n Phase 9 cleanup).
// Reasons recorded or reported before this release carry no `params.cause`: older workers' JOB_RESULT errors and
// the job history they left, schedule rows written by the previous master. Only for those the variant is read
// from the English text, exactly as the console did before Phase 4. New reasons never reach these regexes when
// they carry a cause; nothing else in the console may match English reason text.
// ---------------------------------------------------------------------------------------------------------------
/** LEGACY: the previous master's not_authenticated reasons (apps/master/src/fleetview/overview.ts). */
export const NO_JOB_AUTH = /no sign-in method is configured for jobs/;
/** LEGACY: as NO_JOB_AUTH. */
export const KEY_JOB_AUTH = /jobs on this machine use an API key \(secret-ref\)/;
const LEGACY_CAUSES: Readonly<Record<string, readonly (readonly [RegExp, string])[]>> = {
  runtime_not_authenticated: [[/ — waiting \(until /, 'login_wait']],
  not_authenticated: [
    [NO_JOB_AUTH, 'no_job_auth'],
    [KEY_JOB_AUTH, 'job_auth_secret_ref'],
  ],
  login_expired: [[/refreshing it at the same time/, 'shared_refresh_race']],
  login_refresh_contention: [[/run the job again/, 'run_again']],
};
/** LEGACY: the variant an old reason's English text implies (null: the default sentence). */
export function legacyReasonCause(code: string, message: string): string | null {
  for (const [re, cause] of LEGACY_CAUSES[code] ?? []) if (re.test(message)) return cause;
  return null;
}
// ---------------------------------------------------------------------------------------------------------------

const CODE = /^([a-z][a-z0-9]*(?:_[a-z0-9]+)*)(?:\s*[:—-]\s*([\s\S]*))?$/;

/** Splits `code: message` (or a bare code) into its parts; free text yields `code: null`. */
export function parseReason(raw: string): { code: string | null; message: string } {
  const text = raw.trim();
  const m = CODE.exec(text);
  if (m === null) return { code: null, message: text };
  const code = m[1] ?? null;
  // A single plain word ("ready", "offline") counts as a code only when it is mapped.
  if (code !== null && !code.includes('_') && !KNOWN.has(code)) return { code: null, message: text };
  return { code, message: (m[2] ?? '').trim() };
}

/** Whether `code` has a mapped sentence. */
export function isKnownReason(code: string): boolean {
  return KNOWN.has(code);
}

/** The variant of a reported reason: its `params.cause`, else (LEGACY, old reasons) what its text implies. */
export function reasonCauseOf(
  code: string,
  message: string,
  params: ReasonParams | null | undefined,
): string | null {
  return reasonCause(code, params) ?? legacyReasonCause(code, message);
}

/**
 * The sentence and fix for a reported reason (`code`, `code: text` or free text) in `opts.locale` (default English,
 * the classic console); `opts.params` are the reason's params when the API reported them.
 */
export function describeReason(raw: string, ctx: ReasonContext = {}, opts: DescribeOptions = {}): ReasonInfo {
  const { code, message } = parseReason(raw);
  if (code === null || !KNOWN.has(code))
    return { code, cause: null, sentence: raw.trim(), action: null, raw, known: false };
  const t = messagesFor(opts.locale ?? 'en');
  const cause = reasonCauseOf(code, message, opts.params);
  const vars: ReasonVars = {
    runtime: ctx.runtime ? runtimeName(ctx.runtime) : null,
    machine: ctx.workerName ? ctx.workerName : null,
  };
  const fix = FIXES[code]?.(ctx, cause) ?? null;
  return {
    code,
    cause,
    sentence: reasonSentence(t, code, vars, cause) ?? raw.trim(),
    action: fix === null ? null : { label: t.reasons.actions[fix.key], href: fix.href },
    raw,
    known: true,
  };
}
