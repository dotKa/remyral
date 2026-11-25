/**
 * p14-workflow-engine 14.2 (§3.5, §5.1 rule 1, §5.3): the master integrations engine 2 performs for integration nodes —
 * always through an **existing** integration of the platform, never towards a host chosen by a workflow author or by
 * data: platform notifications, the creator's ops chat, ops actions under the project's deploy policy (Coolify
 * connections, Cloudflare Pages, DNS), the project's repository through the GitHub App, and the SSRF-guarded uptime
 * probe. Wired to the real services in compose.ts (`createWorkflowIntegrations`); tests pass fakes.
 *
 * Every call carries the node run's idempotency key (identical across a replay of the same attempt). The engine
 * writes an outbox row (`workflow_side_effects`, unique key) before the first call and calls again with the same key
 * after a crash, so each integration must deduplicate by it: notifications by dedupe key, chat messages by a meta
 * marker, ops actions by their idempotency key, GitHub comments by a hidden marker in the body, pull requests by
 * their head branch. Requests hold resolved values only; values that came from data are untrusted text.
 */

/** Who / what asks (the run's creator is the run-as user; re-checked by every integration). */
export interface EffectContext {
  readonly runId: string;
  readonly nodeId: string;
  readonly nodeRunId: string;
  readonly scope: string;
  readonly project: string;
  /** The workflow's name (labels, thread titles). */
  readonly workflow: string;
  /** The run's creator — the user the integration acts for (permissions re-checked at every call). */
  readonly runAs: string;
  /** Stable per node-run attempt: deduplicates the effect at the integration. */
  readonly key: string;
}

/** What an integration call did. */
export type EffectResult =
  /** Done: the node succeeds with `output` on `out`. */
  | {
      readonly kind: 'done';
      readonly output: unknown;
      readonly externalRef: string | null;
      readonly detail: Readonly<Record<string, unknown>>;
    }
  /** Started: the node waits until {@link WorkflowIntegrations.poll} reports a terminal state. */
  | {
      readonly kind: 'requested';
      readonly externalRef: string;
      readonly detail: Readonly<Record<string, unknown>>;
    }
  /** Refused by a policy / permission / configuration (never retried). */
  | {
      readonly kind: 'refused';
      readonly code: string;
      readonly message: string;
      readonly detail?: Readonly<Record<string, unknown>>;
    }
  /** Failed (the node's retry policy may repeat it). */
  | {
      readonly kind: 'failed';
      readonly code: string;
      readonly message: string;
      readonly detail?: Readonly<Record<string, unknown>>;
    };

export type PollResult =
  | { readonly kind: 'pending'; readonly detail?: Readonly<Record<string, unknown>> }
  | Exclude<EffectResult, { kind: 'requested' }>;

export interface NotifyRequest {
  readonly recipients: {
    readonly creator: boolean;
    readonly role?: 'viewer' | 'operator' | 'admin' | 'owner' | undefined;
    readonly users?: readonly string[] | undefined;
  };
  readonly title: string;
  readonly body: string;
  readonly severity: 'info' | 'warning' | 'critical';
}

export interface ChatRequest {
  /** `creator-ops`: the creator's thread of this workflow (created on first use); else a thread the creator owns. */
  readonly thread: 'creator-ops' | { readonly threadId: string };
  readonly text: string;
}

export interface OpsRequest {
  readonly kind: 'coolify.deploy' | 'coolify.restart' | 'pages.deploy' | 'dns.upsert' | 'dns.delete';
  /** Fixed parameters from the node's static config (and the upstream step's job for Pages). */
  readonly params: Readonly<Record<string, unknown>>;
  /** dns.change: the record name whose zone is looked up among the project's zones when no zone is named. */
  readonly recordName?: string | undefined;
}

export interface GithubCommentRequest {
  readonly number: number;
  /** The comment text; the integration appends the hidden marker `<!-- remyral:<key> -->`. */
  readonly body: string;
}

export interface GithubPullRequestRequest {
  /** The branch an upstream AI step produced. */
  readonly head: string;
  /** null: the project's base branch. */
  readonly base: string | null;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
}

export type UptimeRequest =
  | { readonly kind: 'http'; readonly url: string; readonly timeoutSec: number }
  | { readonly kind: 'tcp'; readonly host: string; readonly port: number; readonly timeoutSec: number };

export interface WorkflowIntegrations {
  notify(ctx: EffectContext, req: NotifyRequest): Promise<EffectResult>;
  chatMessage(ctx: EffectContext, req: ChatRequest): Promise<EffectResult>;
  /** May the run-as user create jobs in the project now (`jobs.create`, active account)? null: yes, else why not. */
  mayCreateJob(ctx: EffectContext): Promise<string | null>;
  opsAction(ctx: EffectContext, req: OpsRequest): Promise<EffectResult>;
  githubComment(ctx: EffectContext, req: GithubCommentRequest): Promise<EffectResult>;
  githubPullRequest(ctx: EffectContext, req: GithubPullRequestRequest): Promise<EffectResult>;
  uptimeCheck(ctx: EffectContext, req: UptimeRequest): Promise<EffectResult>;
  /** The state of a requested effect (ops action) by its external reference. */
  poll(ctx: EffectContext, kind: string, externalRef: string): Promise<PollResult>;
  /** Cancels a requested effect that has not started yet (an ops action still awaiting approval); best effort. */
  cancel?(ctx: EffectContext, kind: string, externalRef: string, reason: string): Promise<void>;
}

/** The hidden marker a GitHub comment carries (re-found before posting again after a crash). */
export function commentMarker(key: string): string {
  return `<!-- remyral:${key.slice(0, 80)} -->`;
}

/** Integrations are absent (a master without the services): every call is refused with a fixed code. */
export const NO_INTEGRATIONS: WorkflowIntegrations = {
  notify: () => Promise.resolve(unavailable()),
  chatMessage: () => Promise.resolve(unavailable()),
  mayCreateJob: () => Promise.resolve('integrations are not available'),
  opsAction: () => Promise.resolve(unavailable()),
  githubComment: () => Promise.resolve(unavailable()),
  githubPullRequest: () => Promise.resolve(unavailable()),
  uptimeCheck: () => Promise.resolve(unavailable()),
  poll: () => Promise.resolve(unavailable()),
};

function unavailable(): Extract<EffectResult, { kind: 'refused' }> {
  return { kind: 'refused', code: 'integration_unavailable', message: 'This integration is not available.' };
}
