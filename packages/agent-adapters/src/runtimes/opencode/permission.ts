import type { ApprovalPolicy, ApprovalSwitchResult } from '../../contract.js';

/**
 * OpenCode 1.19.0 permission policy (ADR-0012 rule 3: our policy beats repo
 * policy). Keys = `PermissionConfig` properties of the OpenAPI document served
 * by the pinned binary. OpenCode's defaults are permissive ("most permissions
 * default to allow", docs/permissions), so every key is set explicitly — both
 * in `OPENCODE_PERMISSION` (config level) and as the session ruleset on
 * `POST /session` (evaluated after the config, last match wins), the latter
 * starting with a `*` catch-all for tools we do not know.
 */

export type OcPermissionAction = 'allow' | 'ask' | 'deny';

export const OC_PERMISSION_KEYS = [
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'task',
  'external_directory',
  'todowrite',
  'question',
  'webfetch',
  'websearch',
  'lsp',
  'doom_loop',
  'skill',
] as const;
export type OcPermissionKey = (typeof OC_PERMISSION_KEYS)[number];

export interface OcPermissionPolicy {
  /** Config-level map for `OPENCODE_PERMISSION` (and the effective-config check). */
  readonly config: Readonly<Record<OcPermissionKey, OcPermissionAction>>;
  /** Ordered session ruleset for `POST /session {permission}`; `*` first, specific rules after. */
  readonly ruleset: readonly { permission: string; pattern: string; action: OcPermissionAction }[];
}

const READ_ONLY: ReadonlySet<OcPermissionKey> = new Set(['read', 'glob', 'grep', 'list']);
/** Never offered to a job: outside the workspace, sub-agents, questions without a channel, LSP downloads, project skills. */
const ALWAYS_DENY: ReadonlySet<OcPermissionKey> = new Set([
  'external_directory',
  'task',
  'question',
  'lsp',
  'doom_loop',
  'skill',
]);

/** Still denied under `allow-all`: no channel for questions, LSP downloads, project skills (ADR-0010). */
const DENY_EVEN_ALLOW_ALL: ReadonlySet<OcPermissionKey> = new Set(['question', 'lsp', 'skill']);

/**
 * | key                                 | ask-all | ask-sensitive | deny-sensitive | allow-all (ADR-0020) |
 * |-------------------------------------|---------|---------------|----------------|----------------------|
 * | read, glob, grep, list              | ask     | allow         | allow          | allow                |
 * | edit (workspace only, note 1)       | ask     | allow (2)     | deny           | allow                |
 * | bash, webfetch, websearch           | ask     | ask           | deny           | allow                |
 * | todowrite                           | allow   | allow         | allow          | allow                |
 * | external_directory, task, doom_loop | deny    | deny          | deny           | allow                |
 * | question, lsp, skill                | deny    | deny          | deny           | deny                 |
 *
 * (1) `external_directory` is denied for every asking policy, so an `edit` can only touch files inside the
 *     workspace. (2) p5-full-access §2: edits inside the job's own workspace no longer ask.
 *
 * @param askOffered false when the `approval` capability is not offered: then
 *   nothing may wait for a human, and every `ask` becomes `deny` (fail-closed).
 */
export function opencodePermissionPolicy(policy: ApprovalPolicy, askOffered: boolean): OcPermissionPolicy {
  const config = {} as Record<OcPermissionKey, OcPermissionAction>;
  if (policy === 'allow-all') {
    for (const key of OC_PERMISSION_KEYS) config[key] = DENY_EVEN_ALLOW_ALL.has(key) ? 'deny' : 'allow';
    const ruleset = [
      { permission: '*', pattern: '*', action: 'allow' as const },
      ...OC_PERMISSION_KEYS.map((key) => ({ permission: key, pattern: '*', action: config[key] })),
    ];
    return { config, ruleset };
  }
  const ask: OcPermissionAction = askOffered ? 'ask' : 'deny';
  const sensitive: OcPermissionAction = policy === 'deny-sensitive' ? 'deny' : ask;
  const readOnly: OcPermissionAction = policy === 'ask-all' ? ask : 'allow';
  for (const key of OC_PERMISSION_KEYS) {
    if (ALWAYS_DENY.has(key)) config[key] = 'deny';
    else if (READ_ONLY.has(key)) config[key] = readOnly;
    else if (key === 'todowrite')
      config[key] = 'allow'; // the agent's own task list, no side effect
    else if (key === 'edit' && policy === 'ask-sensitive')
      config[key] = 'allow'; // inside the workspace only (external_directory is denied)
    else config[key] = sensitive; // edit, bash, webfetch, websearch
  }
  const ruleset = [
    { permission: '*', pattern: '*', action: sensitive },
    ...OC_PERMISSION_KEYS.map((key) => ({ permission: key, pattern: '*', action: config[key] })),
  ];
  return { config, ruleset };
}

/**
 * p6-approval-mode-switch: what the live mode says about one asked permission (`allow`: reply once without a human,
 * `deny`: reject, `ask`: the normal approval flow). Unknown keys (tool-name patterns) follow the `*` rule.
 */
export function opencodeLiveAction(
  permission: string,
  live: ApprovalPolicy,
  askOffered: boolean,
): OcPermissionAction {
  const p = opencodePermissionPolicy(live, askOffered);
  if ((OC_PERMISSION_KEYS as readonly string[]).includes(permission)) {
    return p.config[permission as OcPermissionKey];
  }
  return p.ruleset[0]?.action ?? 'deny';
}

/**
 * p6-approval-mode-switch: OpenCode keeps the ruleset of `POST /session` for the whole session (no verified live
 * update; `PATCH /config` is blocked by the job server guard). Only what OpenCode asks about can follow the new mode:
 * keys the start ruleset allowed without asking but the new mode would ask or deny make the switch `partial`.
 */
export function opencodeSwitchResult(
  start: ApprovalPolicy,
  next: ApprovalPolicy,
  askOffered: boolean,
): ApprovalSwitchResult {
  const a = opencodePermissionPolicy(start, askOffered);
  const b = opencodePermissionPolicy(next, askOffered);
  const unstoppable: string[] = OC_PERMISSION_KEYS.filter(
    (k) => a.config[k] === 'allow' && b.config[k] !== 'allow',
  );
  if (a.ruleset[0]?.action === 'allow' && b.ruleset[0]?.action !== 'allow') unstoppable.push('other tools');
  if (unstoppable.length > 0) {
    return {
      application: 'partial',
      detail: `OpenCode keeps the permissions it started with and runs ${unstoppable.join(', ')} without asking, so the new mode cannot stop those calls in this session (OpenCode has no live permission update). Everything OpenCode asks about follows the new mode. Cancel the job if the new mode must apply fully now.`,
    };
  }
  return {
    application: 'gate',
    detail:
      'OpenCode asks the worker about every call the new mode decides; the worker answers by the new mode.',
  };
}

/**
 * Compare the server's effective permission map (`GET /config`) with ours.
 * Returns the keys whose effective value differs (a repository or user config
 * managed to change our policy) — the adapter refuses the job if any.
 */
export function permissionDrift(
  expected: Readonly<Record<OcPermissionKey, OcPermissionAction>>,
  effective: Readonly<Record<string, unknown>> | undefined,
): string[] {
  const drift: string[] = [];
  for (const key of OC_PERMISSION_KEYS) {
    const value = effective?.[key];
    if (value !== expected[key]) drift.push(key);
  }
  return drift;
}
