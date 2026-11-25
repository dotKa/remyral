import { createHash, type KeyObject, sign } from 'node:crypto';
import { z } from 'zod';
import { verifyEd25519 } from './auth.js';
import {
  Ed25519PublicKey,
  Identifier,
  RuntimeKind,
  runtimeKindList,
  SandboxProfile,
  withoutRetiredKeys,
  Sha256Hex,
  Text,
  Timestamp,
} from './common.js';
import { DiskHygieneSettings } from './disk-hygiene.js';
import { LeaseKey } from './lease.js';
import { MAX_PACKAGE_CACHE_MAX_BYTES } from './package-caches.js';
import { AddedAccountId, MAX_ACCOUNTS_PER_RUNTIME, RuntimeAccountKind } from './runtime-account-ids.js';
import { canonicalPolicyJson, PolicyName, RuntimeAuthMode } from './runtime-policy.js';
import { WorkspaceProjectConfig } from './workspace.js';
import { AppliedWorkerSettings, WorkerSettings, workerSettingsIssues } from './worker-managed.js';

/**
 * Panel-managed worker configuration (ADR-0015, docs/design/p5-managed-workers.md).
 *
 * The master is the source of truth for a worker's operational configuration: which projects (and, from each
 * project's registered git configuration, which repository URLs) it may check out, which runtimes it runs and
 * how they authenticate (by reference only), how many jobs run in parallel, which sandbox profiles are allowed,
 * workspace hygiene and labels. The worker's local file keeps only what it needs to connect and prove identity,
 * plus an optional **local ceiling** the owner can pin at install time; the ceiling always wins.
 *
 * Delivered in `APPLY_WORKER_CONFIG` (control message, additive in protocol 1.0, sent only to workers that
 * advertise the `worker-config-v1` feature) and acknowledged with `WORKER_CONFIG_STATUS` / the `workerConfig`
 * report in CAPABILITIES. Pure: schemas, the canonical hash, consistency rules and the signature statement,
 * shared by master and worker so both judge a document identically.
 *
 * Never carries a secret value: runtime credentials are references (`credentialRef`) — a worker-store secret
 * name or a panel vault credential id (p5-credentials-models; the value itself travels separately, sealed to
 * the worker's own key, in APPLY_CREDENTIAL) — plus the env var they are injected as.
 */

export const WORKER_CONFIG_SCHEMA_VERSION = 1;

/** Upper bound of a document's canonical JSON (keeps the control frame far below MAX_FRAME_BYTES). */
export const MAX_WORKER_CONFIG_BYTES = 64 * 1024;
export const MAX_WORKER_CONFIG_PROJECTS = 256;
export const MAX_REPOSITORIES_PER_PROJECT = 16;
export const MAX_WORKER_LABELS = 32;

/** Project id as the master stores it (`projects.id`). */
export const ConfigProjectId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/, 'project id');

/** https:// or ssh:// repository URL without credentials, query or fragment (the worker re-validates it fully). */
export const ConfigRepositoryUrl = z
  .string()
  .min(1)
  .max(2048)
  .regex(
    /^(https:\/\/|ssh:\/\/([A-Za-z0-9._-]+@)?)[A-Za-z0-9.-]+(:\d{1,5})?\/[^\s?#@]+$/,
    'https:// (no user) or ssh://[user@] repository URL without credentials, query or fragment',
  );

export const LabelKey = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/, 'label key [a-z0-9_.-]');
export const LabelValue = z.string().regex(/^[A-Za-z0-9 _.:/@+-]{0,128}$/, 'label value');

export const EnvVarName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'environment variable name');
/** Subscription tokens are never injected (ADR-0014); `local-login` is the only way to use a subscription. */
export const FORBIDDEN_INJECTION_ENV: ReadonlySet<string> = new Set(['CLAUDE_CODE_OAUTH_TOKEN']);
export const InjectableEnv = EnvVarName.refine((n) => !FORBIDDEN_INJECTION_ENV.has(n), {
  message: 'subscription tokens are never injected; use local-login',
});

/**
 * Id of a panel vault credential (p5-credentials-models). Narrower than other ids: the worker stores the value
 * in its own secret store under `vault-<id>` (a secret name: no dots).
 */
export const VaultCredentialId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/, 'credential id [a-z0-9_-]');
/** Worker secret-store name of a vault credential. */
export function vaultSecretName(id: string): string {
  return `vault-${id}`;
}

/**
 * A credential by reference (ADR-0006 §2). Never a value.
 *
 *  - `worker-store`: a secret stored on the worker itself (`remyral-worker secrets set <name>`); `name` is what
 *    `secret:<name>` names in the worker config.
 *  - `vault`: a panel vault credential (p5-credentials-models, ADR-0016), delivered separately in
 *    APPLY_CREDENTIAL sealed end-to-end to the worker's own X25519 key and stored in the worker's secret store
 *    as `vault-<id>`. Workers without the `credential-vault-v1` feature reject documents that use it
 *    (`credential_source_unsupported`); the master refuses to store such a document for them.
 *
 * `env`: the variable the value is injected as (default per runtime when omitted for runtime auth).
 */
export const CredentialRef = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('worker-store'),
    name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'secret name'),
    env: InjectableEnv.optional(),
  }),
  z.object({
    source: z.literal('vault'),
    id: VaultCredentialId,
    env: InjectableEnv.optional(),
  }),
]);
export type CredentialRef = z.infer<typeof CredentialRef>;

/** How a runtime authenticates on the worker (ADR-0014): the runtime's own local login, or a credential ref. */
export const RuntimeAuthSetting = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('local-login') }),
  z.object({ mode: z.literal('secret-ref'), credentialRef: CredentialRef }),
]);
export type RuntimeAuthSetting = z.infer<typeof RuntimeAuthSetting>;

/**
 * p13-runtime-accounts (ADR-0049; only to `runtime-accounts-v1` workers): an account added to a runtime besides the
 * machine's configured auth (`default`). Filled by the master from its account table, never edited in a spec.
 * `subscription`: the runtime's own login in the account's config dir on the worker (no reference); `api_key`: a vault
 * credential (sealed to this worker, ADR-0016). Labels, order and pause state stay on the master.
 */
export const RuntimeAccountSetting = z.object({
  id: AddedAccountId,
  kind: RuntimeAccountKind,
  credentialRef: CredentialRef.optional(),
});
export type RuntimeAccountSetting = z.infer<typeof RuntimeAccountSetting>;

export const ModelId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/@+-]*$/, 'model id');
export const ProviderName = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/, 'provider name');
export const HttpsUrl = z
  .string()
  .max(2048)
  .regex(/^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/, 'an https:// URL without credentials, query or fragment');

/** Keys whose literal values would be credentials inside a runtime's free-form options. */
const CREDENTIAL_KEY = /^(api[_-]?key|apikey|token|secret|password|authorization|auth)$/i;

/**
 * Path of the first credential-like key whose value is not an `{env:NAME}` reference, or null. Shared with the
 * worker's local config check, so the panel and the local file refuse the same things.
 */
export function credentialLikePath(value: unknown, path: readonly string[] = []): string | null {
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      const bad = credentialLikePath(v, [...path, String(i)]);
      if (bad !== null) return bad;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (CREDENTIAL_KEY.test(k) && typeof v === 'string' && !/^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(v)) {
        return [...path, k].join('.');
      }
      const bad = credentialLikePath(v, [...path, k]);
      if (bad !== null) return bad;
    }
  }
  return null;
}

/** Settings every runtime accepts. */
const common = {
  auth: RuntimeAuthSetting.optional(),
  /**
   * Default model profile: a model catalog id (p5-credentials-models) or a profile name of the worker's runtime
   * policy for this runtime. Used when a job names no model; a job's own choice and the policy's project
   * restrictions still win. The master resolves a catalog profile into this runtime's concrete settings (model,
   * provider, credential) when it builds the delivered document; values set explicitly win.
   */
  modelProfile: PolicyName.optional(),
};

/**
 * Per-runtime settings, each validated by its own schema. Executable paths and operator extension files stay
 * in the local file (a panel must never choose what binary or code a worker executes).
 */
export const ClaudeCodeSettings = z.object({
  ...common,
  /** p13-runtime-accounts: added accounts (see {@link RuntimeAccountSetting}). */
  accounts: z.array(RuntimeAccountSetting).max(MAX_ACCOUNTS_PER_RUNTIME).optional(),
  /**
   * Default model id (`--model`) when a job names none and the runtime policy defines no profiles
   * (p5-credentials-models; needs the `credential-vault-v1` feature: older workers would strip it).
   */
  model: ModelId.optional(),
});
export const CodexSettings = z.object({
  ...common,
  /** p13-runtime-accounts: added accounts (see {@link RuntimeAccountSetting}). */
  accounts: z.array(RuntimeAccountSetting).max(MAX_ACCOUNTS_PER_RUNTIME).optional(),
  /** Default model id (`-m`); same rules as Claude Code's. */
  model: ModelId.optional(),
});
export const PiSettings = z.object({
  ...common,
  /** Default `provider/model` parts for Pi (`--provider`, `--model`). */
  provider: ProviderName.optional(),
  model: ModelId.optional(),
});
export const OpenCodeSettings = z.object({
  ...common,
  /** Default `provider/model`. */
  model: ModelId.optional(),
  /** Merged into OPENCODE_CONFIG_CONTENT (e.g. custom providers); credential-like keys must be `{env:NAME}`. */
  options: z.record(z.string().max(128), z.unknown()).optional(),
});
export const WorkerRuntimeSettings = z.object({
  'claude-code': ClaudeCodeSettings.optional(),
  codex: CodexSettings.optional(),
  pi: PiSettings.optional(),
  opencode: OpenCodeSettings.optional(),
  // ADR-0023: `openhands` settings of stored generations are dropped when parsed (unknown keys are stripped).
});
export type WorkerRuntimeSettings = z.infer<typeof WorkerRuntimeSettings>;

export const WorkspaceOptions = z.object({
  /** Failed/cancelled workspaces kept for inspection. */
  retainFailed: z.number().int().min(0).max(1000).optional(),
  /** Free bytes required under the workspace root before a checkout (the local file may raise it). */
  minFreeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  submodules: z.enum(['skip', 'allowlisted']).optional(),
  /**
   * p6-warm-caches (ADR-0029; only to `package-caches-v1` workers): size limit of the machine's shared package
   * caches; 0 switches them off (and empties them). Absent: the local file's value, else 10 GiB.
   */
  packageCacheMaxBytes: z.number().int().min(0).max(MAX_PACKAGE_CACHE_MAX_BYTES).optional(),
  /**
   * p17-disk-selfclean (only to `disk-hygiene-v1` workers): the worker's own disk cleanup — on / off and the margin above
   * `minFreeBytes` it cleans up to. Absent: on, with the default margin.
   */
  diskHygiene: DiskHygieneSettings.optional(),
});

/** Fields shared by the admin's spec and the delivered document. */
const operational = {
  /** ADR-0023: a retired runtime in a stored generation is dropped when parsed. */
  allowedRuntimes: runtimeKindList(RuntimeKind.options.length),
  /** 0 = the worker takes no jobs. */
  maxParallelJobs: z.number().int().min(0).max(64),
  /** Sandbox profiles jobs may use on this worker (ADR-0007); the worker's own readiness still applies. */
  sandboxProfiles: z.array(SandboxProfile).max(SandboxProfile.options.length),
  workspace: WorkspaceOptions,
  labels: z.record(LabelKey, LabelValue),
  runtimes: WorkerRuntimeSettings,
  /**
   * p5-sandbox-ops (ADR-0019): the worker may offer the `unconfined` profile (runtime runs as the worker's service
   * account, no filesystem or egress confinement). Never listed in `sandboxProfiles`; set only with admin +
   * always-fresh step-up, audited, owner notified. The master sends it only to `sandbox-ops-v1` workers and only
   * when true (older workers and hashes never see the key). The worker's local ceiling can still forbid it.
   */
  allowUnconfined: z.boolean().optional(),
  /**
   * p19-unconfined-parallel: attempts without filesystem confinement (`unconfined`, and host profiles on a machine
   * that cannot isolate attempts from each other) run in parallel — beside each other and beside other attempts, up to
   * `maxParallelJobs` — instead of alone on an otherwise idle worker (T-SBX-4). Only with `allowUnconfined`; set
   * through the same route (admin + always-fresh step-up, audited, owner notified). Sent only to
   * `unconfined-parallel-v1` workers and only when true. A local `sandbox.unconfinedParallel` pins it.
   */
  unconfinedParallel: z.boolean().optional(),
  /**
   * p5-machine-admin (ADR-0021): AI machine administration on this worker — `machine-admin` jobs may run elevated
   * commands (root / Administrator / SYSTEM) through the privileged helper, each signed by the master. `autoApprove`:
   * commands of `allow-all` jobs are signed without a human (the `machines` project must allow auto-approve too).
   * Set only by the owner with always-fresh step-up (audited, critical notification); every other change carries
   * the current value. Sent only to `machine-admin-v1` workers and only when enabled. The local ceiling
   * (`localCeiling.allowMachineAdmin: false`) still forbids it.
   */
  machineAdmin: z.object({ enabled: z.literal(true), autoApprove: z.boolean() }).optional(),
  /**
   * p17-worker-managed (only to `worker-managed-v1` workers): local settings managed from the panel (updates, log level,
   * telemetry, assistant, remote operations, package caches switch, probe intervals, runtime paths). A key the local
   * file writes pins it; `localCeiling.*` is never here. `runtimePaths` changes only through its owner-only route.
   */
  settings: WorkerSettings.optional(),
};

/**
 * What an administrator edits: projects by id only. Repository URLs are never typed into a worker config —
 * the master resolves them from each project's registered git configuration (`PUT /projects/:id/git`).
 */
export const WorkerConfigSpec = z.object({
  projects: z.array(ConfigProjectId).max(MAX_WORKER_CONFIG_PROJECTS),
  ...operational,
});
export type WorkerConfigSpec = z.infer<typeof WorkerConfigSpec>;

/** What the worker receives: projects resolved to their registered repository URLs. */
export const WorkerConfigDocument = z.object({
  schemaVersion: z.literal(WORKER_CONFIG_SCHEMA_VERSION),
  projects: z.record(
    ConfigProjectId,
    z.object({ repositories: z.array(ConfigRepositoryUrl).min(1).max(MAX_REPOSITORIES_PER_PROJECT) }),
  ),
  /**
   * p5-research-workspace (additive; only for workers advertising `workspace-v1`, whose hash covers it): workspace
   * projects of the spec — no repository, the project's egress policy. A project id is in `projects` or here,
   * never both.
   */
  workspaces: z.record(ConfigProjectId, WorkspaceProjectConfig).optional(),
  /**
   * p5-machine-admin (ADR-0021; only for `panel-skills-v1` workers): the public key(s) of the panel-held skills
   * key. The worker trusts skills signed by them next to the offline keys of its local `skills.publicKeys` —
   * delivered only in this signed, generation-checked document, never in a job; the local ceiling
   * (`localCeiling.allowPanelSkills: false`) refuses them. Filled by the master, never edited.
   */
  panelSkillKeys: z.array(Ed25519PublicKey).min(1).max(2).optional(),
  ...operational,
});
export type WorkerConfigDocument = z.infer<typeof WorkerConfigDocument>;

/** Detached Ed25519 signature by a master lease-signing key over {@link workerConfigStatement}. */
export const WorkerConfigSignature = z.object({
  kid: LeaseKey.shape.kid,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/, 'base64url Ed25519 signature'),
});

/** `APPLY_WORKER_CONFIG` payload. */
export const WorkerConfigDelivery = z.object({
  /** Per-worker monotonic generation (the panel's version of this worker's config). */
  generation: z.number().int().min(1),
  documentHash: Sha256Hex,
  issuedAt: Timestamp,
  document: WorkerConfigDocument,
  /** Absent only when the master has no lease-signing key; workers that pin keys then refuse the document. */
  signature: WorkerConfigSignature.optional(),
});
export type WorkerConfigDelivery = z.infer<typeof WorkerConfigDelivery>;

export interface ConfigIssue {
  readonly path: string;
  readonly code: string;
}

type Json = Parameters<typeof canonicalPolicyJson>[0];

/** Lowercase hex SHA-256 of the canonical JSON of a document. */
export function workerConfigHash(document: WorkerConfigDocument): string {
  return createHash('sha256')
    .update(canonicalPolicyJson(document as unknown as Json), 'utf8')
    .digest('hex');
}

export const WORKER_CONFIG_SIGNATURE_CONTEXT = 'remana-worker-config/v1\n';

/** The exact bytes a delivery signature covers: domain prefix, worker, generation, hash, issue time. */
export function workerConfigStatement(input: {
  readonly workerId: string;
  readonly generation: number;
  readonly documentHash: string;
  readonly issuedAt: string;
}): Buffer {
  return Buffer.from(
    `${WORKER_CONFIG_SIGNATURE_CONTEXT}${input.workerId}\n${String(input.generation)}\n${input.documentHash}\n${input.issuedAt}`,
    'utf8',
  );
}

/** Signs a delivery statement with the master's Ed25519 lease key. */
export function signWorkerConfig(
  input: Parameters<typeof workerConfigStatement>[0],
  kid: string,
  privateKey: KeyObject,
): z.infer<typeof WorkerConfigSignature> {
  return { kid, signature: sign(null, workerConfigStatement(input), privateKey).toString('base64url') };
}

/** Verifies a delivery signature against trusted keys. Never throws. */
export function verifyWorkerConfigSignature(
  workerId: string,
  delivery: WorkerConfigDelivery,
  keys: readonly LeaseKey[],
): 'ok' | 'missing' | 'unknown_key' | 'bad_signature' {
  const sig = delivery.signature;
  if (sig === undefined) return 'missing';
  const key = keys.find((k) => k.kid === sig.kid);
  if (key === undefined) return 'unknown_key';
  const statement = workerConfigStatement({
    workerId,
    generation: delivery.generation,
    documentHash: delivery.documentHash,
    issuedAt: delivery.issuedAt,
  });
  return verifyEd25519(key.publicKey, statement, sig.signature) ? 'ok' : 'bad_signature';
}

function duplicates(values: readonly unknown[]): boolean {
  return new Set(values).size !== values.length;
}

/** What the judging side supports (the master passes the target worker's features). */
export interface WorkerConfigIssueOptions {
  /** `credentialRef.source = "vault"` is acceptable (worker advertises `credential-vault-v1`). */
  readonly vault?: boolean;
  /** p13-runtime-accounts: `runtimes.<rt>.accounts` is acceptable (worker advertises `runtime-accounts-v1`). */
  readonly accounts?: boolean;
}

/** Consistency rules shared by spec and document (runtime settings, auth, sizes). */
function operationalIssues(
  d: Omit<WorkerConfigSpec, 'projects'>,
  opts: WorkerConfigIssueOptions,
): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  if (duplicates(d.allowedRuntimes)) out.push({ path: 'allowedRuntimes', code: 'duplicate' });
  if (duplicates(d.sandboxProfiles)) out.push({ path: 'sandboxProfiles', code: 'duplicate' });
  // ADR-0019: unconfined is switched on only through `allowUnconfined` (step-up, audit, notification).
  if (d.sandboxProfiles.includes('unconfined')) {
    out.push({ path: 'sandboxProfiles', code: 'unconfined_needs_allow_flag' });
  }
  // p19-unconfined-parallel: parallel unconfined attempts only where unconfined is allowed at all.
  if (d.unconfinedParallel === true && d.allowUnconfined !== true) {
    out.push({ path: 'unconfinedParallel', code: 'unconfined_parallel_needs_allow' });
  }
  if (Object.keys(d.labels).length > MAX_WORKER_LABELS) out.push({ path: 'labels', code: 'too_many' });
  // p17-worker-managed: runtime path rules (the runtime's own executable name, Pi-only extension files).
  if (d.settings !== undefined) out.push(...workerSettingsIssues(d.settings));
  for (const runtime of RuntimeKind.options) {
    const s = d.runtimes[runtime];
    if (s === undefined) continue;
    const base = `runtimes.${runtime}`;
    if (!d.allowedRuntimes.includes(runtime)) out.push({ path: base, code: 'runtime_not_allowed' });
    const auth = s.auth;
    if (auth?.mode === 'secret-ref' && auth.credentialRef.source === 'vault' && opts.vault !== true) {
      out.push({ path: `${base}.auth.credentialRef`, code: 'credential_source_unsupported' });
    }
    const accounts =
      runtime === 'claude-code' || runtime === 'codex' ? d.runtimes[runtime]?.accounts : undefined;
    if (accounts !== undefined && accounts.length > 0) {
      if (opts.accounts !== true) out.push({ path: `${base}.accounts`, code: 'accounts_unsupported' });
      if (duplicates(accounts.map((a) => a.id))) out.push({ path: `${base}.accounts`, code: 'duplicate' });
      accounts.forEach((a, i) => {
        const at = `${base}.accounts.${String(i)}`;
        if (a.kind === 'api_key') {
          if (a.credentialRef?.source !== 'vault')
            out.push({ path: `${at}.credentialRef`, code: 'vault_required' });
          else if (opts.vault !== true) {
            out.push({ path: `${at}.credentialRef`, code: 'credential_source_unsupported' });
          }
        } else if (a.credentialRef !== undefined) {
          out.push({ path: `${at}.credentialRef`, code: 'subscription_has_no_credential' });
        }
      });
    }
    if (runtime === 'opencode') {
      const ocOptions = d.runtimes.opencode?.options;
      const bad = ocOptions === undefined ? null : credentialLikePath(ocOptions);
      if (bad !== null) out.push({ path: `${base}.options.${bad}`, code: 'credential_value' });
    }
  }
  return out;
}

/** Consistency rules a schema cannot express for an administrator's spec. Empty = acceptable. */
export function workerConfigSpecIssues(
  spec: WorkerConfigSpec,
  opts: WorkerConfigIssueOptions = {},
): ConfigIssue[] {
  const out = operationalIssues(spec, opts);
  if (duplicates(spec.projects)) out.push({ path: 'projects', code: 'duplicate' });
  return out;
}

/**
 * Consistency rules for a delivered document. The master refuses to store, and the worker refuses to apply, a
 * document with issues.
 */
export function workerConfigIssues(
  document: WorkerConfigDocument,
  opts: WorkerConfigIssueOptions = {},
): ConfigIssue[] {
  const out = operationalIssues(document, opts);
  const projects = Object.keys(document.projects);
  if (projects.length > MAX_WORKER_CONFIG_PROJECTS) out.push({ path: 'projects', code: 'too_many' });
  for (const p of projects.sort()) {
    const repos = document.projects[p]?.repositories ?? [];
    if (duplicates(repos)) out.push({ path: `projects.${p}.repositories`, code: 'duplicate' });
  }
  const workspaces = Object.keys(document.workspaces ?? {});
  if (projects.length + workspaces.length > MAX_WORKER_CONFIG_PROJECTS) {
    out.push({ path: 'workspaces', code: 'too_many' });
  }
  for (const p of workspaces.sort()) {
    if (Object.hasOwn(document.projects, p)) out.push({ path: `workspaces.${p}`, code: 'duplicate' });
  }
  if (Buffer.byteLength(canonicalPolicyJson(document as unknown as Json), 'utf8') > MAX_WORKER_CONFIG_BYTES) {
    out.push({ path: '', code: 'too_large' });
  }
  return out;
}

// ------------------------------------------------------------------------------------------ reports

/** Why part of a document is not in effect on the worker. */
export const ConfigBlockCode = z.enum([
  /** The owner's local ceiling (or a locally pinned setting) excludes it. */
  'blocked_by_local_ceiling',
  /** The worker cannot use the value (unsafe project id, repository URL it refuses). */
  'invalid_value',
  /** This worker build does not implement it (truthful report, ADR-0008). */
  'unsupported',
]);
export type ConfigBlockCode = z.infer<typeof ConfigBlockCode>;

export const ConfigBlock = z.object({
  path: z.string().max(256),
  code: ConfigBlockCode,
  detail: z.string().max(500).optional(),
});
export type ConfigBlock = z.infer<typeof ConfigBlock>;

/** What the owner pinned in the worker's local file (null = no ceiling for that dimension). */
export const LocalCeilingReport = z.object({
  projects: z.array(Identifier).max(1024).nullable(),
  repoHosts: z.array(z.string().max(255)).max(64).nullable(),
  allowedRuntimes: runtimeKindList(8).nullable(),
  maxParallelJobs: z.number().int().min(0).max(64).nullable(),
  sandboxProfiles: z.array(SandboxProfile).max(8).nullable(),
  /** p5-sandbox-ops (additive): false = the local file forbids `unconfined` (null/absent: not restricted). */
  allowUnconfined: z.boolean().nullable().optional(),
  /** p5-machine-admin (additive): false = the local file forbids machine administration (null/absent: not restricted). */
  allowMachineAdmin: z.boolean().nullable().optional(),
  /** p5-machine-admin (additive): false = the local file refuses panel-signed skills (null/absent: not restricted). */
  allowPanelSkills: z.boolean().nullable().optional(),
  /** p14-mcp-core (additive): false = the local file refuses external MCP servers for jobs. */
  allowMcp: z.boolean().nullable().optional(),
  /** p14-mcp-core (additive): false = the local file never adds MCP hosts to an attempt's egress. */
  allowMcpEgress: z.boolean().nullable().optional(),
  /** p14-mcp-stdio (additive): false = the local file refuses local (stdio) MCP servers. */
  allowMcpStdio: z.boolean().nullable().optional(),
  /** p14-mcp-core (additive): false = panel-signed MCP specs refused (follows allowPanelSkills unless set). */
  allowPanelMcp: z.boolean().nullable().optional(),
  /** p17-worker-managed (additive): false = the local file refuses custom tool downloads from the panel. */
  allowCustomTools: z.boolean().nullable().optional(),
  /** p17-worker-managed (additive): false = the local file refuses long-running services. */
  allowServices: z.boolean().nullable().optional(),
  /** Runtimes whose auth or settings the local file pins (the panel's values for them are not used). */
  pinnedRuntimes: runtimeKindList(8),
});
export type LocalCeilingReport = z.infer<typeof LocalCeilingReport>;

/**
 * Per-runtime settings a worker actually applied (p5-credentials-models; additive): names and model ids only,
 * never a credential value. `credential` is a worker-store secret name or a vault credential id; `present`
 * says whether the worker holds it.
 */
export const AppliedRuntimeSettings = z.object({
  auth: z
    .object({
      mode: RuntimeAuthMode,
      source: z.enum(['worker-store', 'vault']).optional(),
      credential: z.string().max(80).optional(),
      env: EnvVarName.optional(),
      present: z.boolean().optional(),
    })
    .optional(),
  modelProfile: PolicyName.optional(),
  model: z.string().max(128).optional(),
  provider: z.string().max(64).optional(),
  /** The local file pins this runtime's auth or settings (panel values not used). */
  pinned: z.boolean().optional(),
});
export type AppliedRuntimeSettings = z.infer<typeof AppliedRuntimeSettings>;

/** The configuration actually in effect (panel ∩ ceiling), without repository URLs or credential refs. */
export const EffectiveConfigReport = z.object({
  projects: z.array(Identifier).max(1024),
  allowedRuntimes: runtimeKindList(8),
  maxParallelJobs: z.number().int().min(0).max(64),
  sandboxProfiles: z.array(SandboxProfile).max(8),
  runtimeAuth: withoutRetiredKeys(z.partialRecord(RuntimeKind, RuntimeAuthMode)),
  labels: z.record(LabelKey, LabelValue),
  /** p5-credentials-models (additive): what each runtime actually runs with. */
  runtimes: withoutRetiredKeys(z.partialRecord(RuntimeKind, AppliedRuntimeSettings)).optional(),
  /** p5-sandbox-ops (additive): `unconfined` is in effect (panel allowed it and the ceiling does not forbid it). */
  allowUnconfined: z.boolean().optional(),
  /**
   * p19-unconfined-parallel (additive): attempts without filesystem confinement run in parallel here (panel value, or
   * the local `sandbox.unconfinedParallel` pin). Absent: they run alone.
   */
  unconfinedParallel: z.boolean().optional(),
  /** p5-machine-admin (additive): machine administration in effect (panel enabled it, the ceiling does not forbid). */
  machineAdmin: z.object({ enabled: z.boolean(), autoApprove: z.boolean() }).optional(),
  /** p5-machine-admin (additive): key ids (skillKeyId) of the panel skills keys the worker trusts now. */
  panelSkillKeyIds: z
    .array(z.string().regex(/^[a-f0-9]{16}$/))
    .max(2)
    .optional(),
  /** p17-worker-managed (additive, `worker-managed-v1`): the managed local settings in effect, pins, pending restarts. */
  settings: AppliedWorkerSettings.optional(),
});
export type EffectiveConfigReport = z.infer<typeof EffectiveConfigReport>;

/** A refused delivery and why (shown in the panel). */
export const ConfigRejection = z.object({
  generation: z.number().int().min(1),
  reason: z.string().regex(/^[a-z0-9_]{1,64}$/),
  detail: z.string().max(500).optional(),
  issues: z.array(z.object({ path: z.string().max(256), code: z.string().max(64) })).max(50),
});
export type ConfigRejection = z.infer<typeof ConfigRejection>;

/**
 * The worker's view of its configuration, in CAPABILITIES (`workerConfig`) and in WORKER_CONFIG_STATUS.
 * `source: 'local'` = no panel document applied yet: the worker runs on its local file (legacy or fresh).
 */
export const WorkerConfigReport = z.object({
  source: z.enum(['panel', 'local']),
  /** Applied panel generation (0 with `source: 'local'`). */
  generation: z.number().int().min(0),
  documentHash: Sha256Hex.optional(),
  appliedAt: Timestamp.optional(),
  effective: EffectiveConfigReport,
  ceiling: LocalCeilingReport,
  blocked: z.array(ConfigBlock).max(64),
  /** The last delivery the worker refused (newer than the applied one), if any. */
  rejected: ConfigRejection.optional(),
});
export type WorkerConfigReport = z.infer<typeof WorkerConfigReport>;

/** `WORKER_CONFIG_STATUS` payload: the outcome of one APPLY_WORKER_CONFIG and the resulting report. */
export const WorkerConfigStatusPayload = z.object({
  generation: z.number().int().min(1),
  outcome: z.enum(['applied', 'unchanged', 'stale', 'rejected']),
  report: WorkerConfigReport,
  detail: Text.optional(),
});
