import type { FastifyBaseLogger } from 'fastify';
import { loadSubject } from '../authz/authorizer.js';
import { authorize, type Role } from '../authz/model.js';
import type { ChatService } from '../chat/service.js';
import type { Queryable } from '../db/pool.js';
import type { GitFlowService } from '../gitflow/service.js';
import { ProviderError } from '../gitflow/types.js';
import type { NotificationService } from '../notifications/service.js';
import { projectRecipients } from '../notifications/recipients.js';
import { OpsError } from '../ops/model.js';
import type { OpsService } from '../ops/service.js';
import { HttpConfig, TcpConfig, urlProblem } from '../uptime/model.js';
import type { Probe } from '../uptime/probe.js';
import {
  commentMarker,
  type EffectContext,
  type EffectResult,
  type PollResult,
  type WorkflowIntegrations,
} from './v2/integrations.js';

/**
 * p14-workflow-engine 14.2: engine 2's integration nodes wired to the platform's **existing** integrations (§5.1 rule
 * 1 — no new master network path): the notification service (kind `workflow.notify`, the users' own channels), the
 * ops chat, the ops service (Coolify / Pages / DNS under the project's deploy policy — production waits for an
 * approval with an always-fresh step-up, never lowered), the project's repository through the GitHub App (the git-flow
 * provider), and the SSRF-guarded uptime probe (public addresses only, no headers, no credentials).
 *
 * Every call re-checks the run-as user (the run's creator): an active account that still holds `workflows.run` in the
 * project, plus the integration's own action (`deploy.request`, `jobs.create`).
 */
export interface WorkflowIntegrationDeps {
  readonly db: Queryable;
  readonly log: FastifyBaseLogger;
  readonly notifications: () => NotificationService | null;
  readonly chat: () => ChatService | null;
  readonly ops: () => OpsService | null;
  readonly gitflow: () => GitFlowService | null;
  readonly probe: Probe;
}

const refused = (code: string, message: string): Extract<EffectResult, { kind: 'refused' }> => ({
  kind: 'refused',
  code,
  message,
});

/** The run-as user's verdict for an action in the project (null: allowed, else why not). */
export async function runAsDenied(
  db: Queryable,
  ctx: EffectContext,
  actions: readonly string[],
): Promise<string | null> {
  const { rows } = await db.query<{ id: string; role: Role; disabled_at: Date | null }>(
    'SELECT id, role, disabled_at FROM users WHERE id::text = $1',
    [ctx.runAs],
  );
  const u = rows[0];
  if (u === undefined || u.disabled_at !== null) return 'the run’s creator is not active';
  const subject = await loadSubject(db, { id: u.id, role: u.role });
  for (const a of ['workflows.run', ...actions]) {
    if (!authorize(subject, a, { project: ctx.project }).allow)
      return `the run’s creator may no longer ${a === 'workflows.run' ? 'run workflows' : `use ${a}`} in this project`;
  }
  return null;
}

/** OpsAction states → a poll result. */
function opsPoll(view: {
  state: string;
  error: string | null;
  result: Record<string, unknown> | null;
  id: string;
}) {
  const url = typeof view.result?.url === 'string' ? view.result.url : null;
  const detail = { actionId: view.id, state: view.state, ...(url === null ? {} : { url }) };
  switch (view.state) {
    case 'succeeded':
      return {
        kind: 'done' as const,
        output: { actionId: view.id, state: view.state, url },
        externalRef: view.id,
        detail,
      };
    case 'refused':
    case 'denied':
    case 'expired':
      return {
        kind: 'refused' as const,
        code: `deploy_${view.state}`,
        message: `the ops action was ${view.state}${view.error === null ? '' : `: ${view.error.slice(0, 300)}`}`,
        detail,
      };
    case 'failed':
      return {
        kind: 'failed' as const,
        code: 'deploy_failed',
        message: `the ops action failed${view.error === null ? '' : `: ${view.error.slice(0, 300)}`}`,
        detail,
      };
    default:
      return { kind: 'pending' as const, detail };
  }
}

export function createWorkflowIntegrations(deps: WorkflowIntegrationDeps): WorkflowIntegrations {
  const db = deps.db;
  return {
    async notify(ctx, req) {
      const denied = await runAsDenied(db, ctx, []);
      if (denied !== null) return refused('run_as_not_allowed', denied);
      const svc = deps.notifications();
      if (svc === null) return refused('integration_unavailable', 'Notifications are not available.');
      const members = new Set(await projectRecipients(db, ctx.project, 'viewer'));
      const ids = new Set<string>();
      if (req.recipients.creator && members.has(ctx.runAs)) ids.add(ctx.runAs);
      if (req.recipients.role !== undefined)
        for (const id of await projectRecipients(db, ctx.project, req.recipients.role)) ids.add(id);
      // Named users only while they can read the project (never a way to reach outsiders).
      for (const id of req.recipients.users ?? []) if (members.has(id)) ids.add(id);
      const created = await svc.notify(db, [...ids], {
        kind: 'workflow.notify',
        severity: req.severity,
        title: req.title,
        body: req.body,
        link: `/jobs/workflows/${ctx.runId}`,
        dedupeKey: `workflow.notify:${ctx.key}`,
      });
      return {
        kind: 'done',
        output: { recipients: ids.size },
        externalRef: null,
        detail: { recipients: ids.size, created },
      };
    },

    async chatMessage(ctx, req) {
      const denied = await runAsDenied(db, ctx, []);
      if (denied !== null) return refused('run_as_not_allowed', denied);
      const chat = deps.chat();
      if (chat === null) return refused('integration_unavailable', 'The ops chat is not available.');
      const out = await chat.postWorkflowMessage({
        userId: ctx.runAs,
        thread: req.thread,
        workflow: ctx.workflow,
        runId: ctx.runId,
        nodeId: ctx.nodeId,
        text: req.text,
        key: ctx.key,
      });
      if ('refused' in out) return refused('thread_not_found', out.refused);
      return {
        kind: 'done',
        output: { threadId: out.threadId, messageId: out.messageId },
        externalRef: out.messageId,
        detail: { threadId: out.threadId },
      };
    },

    mayCreateJob: (ctx) => runAsDenied(db, ctx, ['jobs.create']),

    async opsAction(ctx, req) {
      const denied = await runAsDenied(db, ctx, ['deploy.request']);
      if (denied !== null) return refused('run_as_not_allowed', denied);
      const ops = deps.ops();
      if (ops === null) return refused('integration_unavailable', 'Deploy integrations are not available.');
      let params: Record<string, unknown> = { ...req.params };
      // dns.change without a zone: the project's only allowed zone that contains the record name.
      if ((req.kind === 'dns.upsert' || req.kind === 'dns.delete') && params.zone === null) {
        const t = await ops.targets(ctx.project);
        const name = (req.recordName ?? '').toLowerCase();
        const zones = (t?.targets.dns.zones ?? []).filter(
          (z) => name === z.name.toLowerCase() || name.endsWith(`.${z.name.toLowerCase()}`),
        );
        if (zones.length !== 1)
          return refused(
            'dns_zone_unknown',
            zones.length === 0
              ? 'No allowed DNS zone of this project contains the record name (Project → Deploy).'
              : 'Several allowed DNS zones contain the record name; name the zone in the node.',
          );
        params = { ...params, zone: zones[0]?.name };
      }
      try {
        const out = await ops.request(
          { type: 'system', id: `workflow:${ctx.runId}` },
          {
            project: ctx.project,
            kind: req.kind,
            params,
            idempotencyKey: ctx.key.slice(0, 128),
            note: `Workflow ${ctx.workflow}, run ${ctx.runId}, node ${ctx.nodeId}`.slice(0, 500),
          },
          'workflow',
          { source: { workflowRunId: ctx.runId, nodeId: ctx.nodeId, createdBy: ctx.runAs } },
        );
        const p = opsPoll(out.action);
        if (p.kind === 'pending') return { kind: 'requested', externalRef: out.action.id, detail: p.detail };
        return p;
      } catch (err) {
        if (err instanceof OpsError && err.status < 500) return refused(err.code, err.message.slice(0, 500));
        throw err;
      }
    },

    async githubComment(ctx, req) {
      const denied = await runAsDenied(db, ctx, []);
      if (denied !== null) return refused('run_as_not_allowed', denied);
      const flow = deps.gitflow();
      const p = flow === null ? null : await flow.providerFor(ctx.project);
      if (p?.provider.kind !== 'github' || p.provider.issueComment === undefined)
        return refused(
          'github_not_configured',
          'This project has no GitHub repository connected through the App.',
        );
      try {
        const c = await p.provider.issueComment(req.number, req.body, commentMarker(ctx.key));
        return {
          kind: 'done',
          output: { id: c.id, url: c.url, number: req.number },
          externalRef: String(c.id),
          detail: { url: c.url, number: req.number, created: c.created },
        };
      } catch (err) {
        if (err instanceof ProviderError && !err.transient)
          return refused('github_refused', err.message.slice(0, 300));
        throw err;
      }
    },

    async githubPullRequest(ctx, req) {
      const denied = await runAsDenied(db, ctx, []);
      if (denied !== null) return refused('run_as_not_allowed', denied);
      const flow = deps.gitflow();
      const p = flow === null ? null : await flow.providerFor(ctx.project);
      if (p?.provider.kind !== 'github')
        return refused(
          'github_not_configured',
          'This project has no GitHub repository connected through the App.',
        );
      try {
        const pr = await p.provider.ensurePullRequest({
          headBranch: req.head,
          targetBranch: req.base ?? p.config.baseBranch,
          title: req.title,
          body: req.body,
          draft: req.draft,
        });
        if (pr === null) return refused('github_not_configured', 'The provider opens no pull requests.');
        return {
          kind: 'done',
          output: { number: pr.number, url: pr.url, head: req.head },
          externalRef: String(pr.number),
          detail: { url: pr.url, number: pr.number },
        };
      } catch (err) {
        if (err instanceof ProviderError && !err.transient)
          return refused('github_refused', err.message.slice(0, 300));
        throw err;
      }
    },

    async uptimeCheck(ctx, req) {
      const denied = await runAsDenied(db, ctx, []);
      if (denied !== null) return refused('run_as_not_allowed', denied);
      const timeoutMs = Math.min(Math.max(req.timeoutSec, 1), 30) * 1000;
      if (req.kind === 'http') {
        const problem = urlProblem(req.url);
        if (problem !== null) return refused('url_refused', problem);
        const cfg = HttpConfig.safeParse({ url: req.url });
        if (!cfg.success) return refused('url_refused', 'the URL is not allowed');
        const r = await deps.probe.http(cfg.data, timeoutMs);
        return {
          kind: 'done',
          output: { up: r.ok === true, status: r.statusCode, latencyMs: r.latencyMs, error: r.error },
          externalRef: null,
          detail: { up: r.ok === true, status: r.statusCode, error: r.error },
        };
      }
      const cfg = TcpConfig.safeParse({ host: req.host, port: req.port });
      if (!cfg.success) return refused('url_refused', 'the host is not allowed');
      const r = await deps.probe.tcp(cfg.data, timeoutMs);
      return {
        kind: 'done',
        output: { up: r.ok === true, status: null, latencyMs: r.latencyMs, error: r.error },
        externalRef: null,
        detail: { up: r.ok === true, error: r.error },
      };
    },

    async poll(_ctx, _kind, externalRef): Promise<PollResult> {
      const ops = deps.ops();
      if (ops === null) return { kind: 'pending' };
      try {
        return opsPoll(await ops.get(externalRef));
      } catch (err) {
        if (err instanceof OpsError && err.status === 404)
          return { kind: 'failed', code: 'deploy_missing', message: 'the ops action no longer exists' };
        throw err;
      }
    },

    async cancel(ctx, _kind, externalRef, reason) {
      const ops = deps.ops();
      if (ops === null) return;
      const view = await ops.get(externalRef);
      if (view.state !== 'awaiting_approval') return;
      // The request is withdrawn on behalf of the run's creator, who asked for it (no execution after a cancel).
      await ops.deny(
        { type: 'user', id: ctx.runAs },
        externalRef,
        `Workflow run cancelled: ${reason}`.slice(0, 500),
      );
    },
  };
}
