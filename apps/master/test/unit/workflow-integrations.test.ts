import { describe, expect, it } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Queryable } from '../../src/db/pool.js';
import type { GitFlowService } from '../../src/gitflow/service.js';
import { ProviderError } from '../../src/gitflow/types.js';
import { OpsError } from '../../src/ops/model.js';
import type { OpsService } from '../../src/ops/service.js';
import type { Probe } from '../../src/uptime/probe.js';
import { createWorkflowIntegrations } from '../../src/workflows/integrations.js';
import { commentMarker, type EffectContext } from '../../src/workflows/v2/integrations.js';

/**
 * p14-workflow-engine 14.2: the integration wiring of engine 2's integration nodes over fakes of the existing
 * services — run-as re-checks, the project's repository through the GitHub App, DNS zone resolution, ops action
 * outcomes, the guarded probe's URL rules. Never a host chosen by the workflow.
 */

const ctx: EffectContext = {
  runId: 'run-1',
  nodeId: 'n',
  nodeRunId: 'nr-1',
  scope: '',
  project: 'p1',
  workflow: 'wf',
  runAs: 'u-1',
  key: 'wf2:abc:1',
};

/** A database fake: the run-as user (role / disabled) and their memberships. */
function db(user: { role: string; disabled?: boolean; member?: string } | null): Queryable {
  return {
    query: (sql: string) => {
      if (sql.includes('FROM users'))
        return Promise.resolve({
          rows:
            user === null
              ? []
              : [{ id: 'u-1', role: user.role, disabled_at: user.disabled === true ? new Date() : null }],
          rowCount: user === null ? 0 : 1,
        });
      if (sql.includes('project_memberships'))
        return Promise.resolve({
          rows: user?.member === undefined ? [] : [{ project_id: 'p1', role: user.member }],
          rowCount: 1,
        });
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  } as unknown as Queryable;
}

const log = { warn: () => undefined, debug: () => undefined } as unknown as FastifyBaseLogger;
const probe: Probe = {
  http: () =>
    Promise.resolve({
      ok: true,
      latencyMs: 12,
      statusCode: 200,
      error: null,
      detail: null,
      tlsExpiresAt: null,
    }),
  tcp: () =>
    Promise.resolve({
      ok: false,
      latencyMs: null,
      statusCode: null,
      error: 'address_refused',
      detail: null,
      tlsExpiresAt: null,
    }),
};

function wiring(opts: {
  user?: { role: string; disabled?: boolean; member?: string } | null;
  ops?: Partial<OpsService>;
  provider?: Record<string, unknown> | null;
}) {
  return createWorkflowIntegrations({
    db: db(opts.user === undefined ? { role: 'owner' } : opts.user),
    log,
    notifications: () => null,
    chat: () => null,
    ops: () => (opts.ops === undefined ? null : (opts.ops as OpsService)),
    gitflow: () =>
      ({
        providerFor: () =>
          Promise.resolve(
            opts.provider === null || opts.provider === undefined
              ? null
              : { provider: opts.provider, config: { baseBranch: 'develop' } },
          ),
      }) as unknown as GitFlowService,
    probe,
  });
}

describe('workflow integrations wiring (p14 14.2)', () => {
  it('re-checks the run-as user at every call', async () => {
    const gone = wiring({ user: null });
    expect(
      await gone.uptimeCheck(ctx, { kind: 'http', url: 'https://example.com/', timeoutSec: 5 }),
    ).toMatchObject({
      kind: 'refused',
      code: 'run_as_not_allowed',
    });
    const disabled = wiring({ user: { role: 'owner', disabled: true } });
    expect(await disabled.mayCreateJob(ctx)).toMatch(/not active/);
    // A viewer member may no longer run workflows (nor deploy).
    const viewer = wiring({ user: { role: 'operator', member: 'viewer' } });
    expect(await viewer.mayCreateJob(ctx)).toMatch(/run workflows/);
    const asViewer = wiring({ user: { role: 'operator', member: 'viewer' }, ops: {} });
    expect(
      await asViewer.opsAction(ctx, { kind: 'coolify.deploy', params: { env: 'preview' } }),
    ).toMatchObject({
      kind: 'refused',
      code: 'run_as_not_allowed',
    });
    const op = wiring({ user: { role: 'operator', member: 'operator' } });
    expect(await op.mayCreateJob(ctx)).toBeNull();
  });

  it('opens pull requests and comments only on the project’s repository through the App (marker, base default)', async () => {
    const seen: unknown[] = [];
    const provider = {
      kind: 'github',
      ensurePullRequest: (input: unknown) => {
        seen.push(input);
        return Promise.resolve({ number: 3, url: 'https://github.test/pull/3' });
      },
      issueComment: (number: number, body: string, marker: string) => {
        seen.push({ number, body, marker });
        return Promise.resolve({ id: 9, url: 'https://github.test/c/9', created: true });
      },
    };
    const w = wiring({ provider });
    expect(
      await w.githubPullRequest(ctx, { head: 'wf/abc/step', base: null, title: 'T', body: 'B', draft: true }),
    ).toMatchObject({
      kind: 'done',
      output: { number: 3, url: 'https://github.test/pull/3', head: 'wf/abc/step' },
    });
    expect(seen[0]).toEqual({
      headBranch: 'wf/abc/step',
      targetBranch: 'develop',
      title: 'T',
      body: 'B',
      draft: true,
    });
    expect(await w.githubComment(ctx, { number: 5, body: 'hello' })).toMatchObject({
      kind: 'done',
      externalRef: '9',
    });
    expect(seen[1]).toEqual({ number: 5, body: 'hello', marker: commentMarker(ctx.key) });
    // A provider refusal is final; a transient one is thrown (the engine retries with the same key).
    const refusing = wiring({
      provider: {
        kind: 'github',
        issueComment: () => Promise.reject(new ProviderError('GitHub create comment: HTTP 404', false, 404)),
      },
    });
    expect(await refusing.githubComment(ctx, { number: 5, body: 'x' })).toMatchObject({
      kind: 'refused',
      code: 'github_refused',
    });
    const flaky = wiring({
      provider: {
        kind: 'github',
        issueComment: () => Promise.reject(new ProviderError('HTTP 502', true, 502)),
      },
    });
    await expect(flaky.githubComment(ctx, { number: 5, body: 'x' })).rejects.toThrow('502');
    // No App-connected repository: refused, nothing called.
    expect(
      await wiring({ provider: { kind: 'git' } }).githubComment(ctx, { number: 1, body: 'x' }),
    ).toMatchObject({
      kind: 'refused',
      code: 'github_not_configured',
    });
  });

  it('requests ops actions as the workflow with the node key, resolves the DNS zone, maps outcomes', async () => {
    const requests: { actor: unknown; input: { idempotencyKey: string; params: unknown } }[] = [];
    let state = 'awaiting_approval';
    const ops = {
      targets: () =>
        Promise.resolve({
          targets: {
            dns: {
              zones: [
                { id: 'a', name: 'example.com' },
                { id: 'b', name: 'other.example' },
              ],
            },
          },
        }),
      request: (actor: unknown, input: { idempotencyKey: string; params: unknown }) => {
        requests.push({ actor, input });
        return Promise.resolve({ action: { id: 'act-1', state, error: null, result: null } });
      },
      get: () =>
        Promise.resolve({ id: 'act-1', state: 'succeeded', error: null, result: { url: 'https://x.test' } }),
    } as unknown as OpsService;
    const w = wiring({ ops });
    expect(
      await w.opsAction(ctx, {
        kind: 'dns.upsert',
        params: { zone: null, type: 'A', name: 'www.example.com', content: '1.2.3.4' },
        recordName: 'www.example.com',
      }),
    ).toMatchObject({ kind: 'requested', externalRef: 'act-1' });
    expect(requests[0]?.actor).toEqual({ type: 'system', id: 'workflow:run-1' });
    expect(requests[0]?.input).toMatchObject({
      idempotencyKey: ctx.key,
      params: { zone: 'example.com', name: 'www.example.com' },
    });
    expect(
      await w.opsAction(ctx, {
        kind: 'dns.delete',
        params: { zone: null, type: 'A', name: 'www.nowhere.example' },
        recordName: 'www.nowhere.example',
      }),
    ).toMatchObject({ kind: 'refused', code: 'dns_zone_unknown' });
    state = 'refused';
    expect(await w.opsAction(ctx, { kind: 'coolify.deploy', params: { env: 'production' } })).toMatchObject({
      kind: 'refused',
      code: 'deploy_refused',
    });
    expect(await w.poll(ctx, 'deploy.coolify', 'act-1')).toMatchObject({
      kind: 'done',
      output: { actionId: 'act-1', state: 'succeeded', url: 'https://x.test' },
    });
    const refusingOps = wiring({
      ops: {
        targets: () => Promise.resolve(null),
        request: () => Promise.reject(new OpsError(409, 'no_deploy_targets', 'No deploy targets.')),
      },
    });
    expect(
      await refusingOps.opsAction(ctx, { kind: 'coolify.restart', params: { env: 'preview' } }),
    ).toMatchObject({
      kind: 'refused',
      code: 'no_deploy_targets',
    });
  });

  it('checks URLs with the uptime rules before the guarded probe', async () => {
    const w = wiring({});
    expect(
      await w.uptimeCheck(ctx, { kind: 'http', url: 'https://example.com:22/', timeoutSec: 5 }),
    ).toMatchObject({
      kind: 'refused',
      code: 'url_refused',
    });
    expect(
      await w.uptimeCheck(ctx, { kind: 'http', url: 'https://example.com/', timeoutSec: 5 }),
    ).toMatchObject({
      kind: 'done',
      output: { up: true, status: 200, latencyMs: 12 },
    });
    expect(
      await w.uptimeCheck(ctx, { kind: 'tcp', host: '10.0.0.1', port: 22, timeoutSec: 2 }),
    ).toMatchObject({
      kind: 'done',
      output: { up: false, error: 'address_refused' },
    });
  });
});
