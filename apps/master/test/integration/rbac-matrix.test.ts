import { afterAll, beforeAll, expect, it } from 'vitest';
import { ApprovalService } from '../../src/approvals/index.js';
import { AuditLog } from '../../src/audit/audit.js';
import type { Role } from '../../src/auth/users.js';
import { type Action, ACTION_NAMES } from '../../src/authz/model.js';
import { ContextStore } from '../../src/context/index.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { UsageStore } from '../../src/usage/index.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p5-rbac-api authorization matrix (threat model T-CP-3). Generated from the route declarations: every
 * registered full-session route × every persona, through the `authzProbe` seam (204 right after the
 * authorization decision, before validation and handlers — no side effects). A new route is covered
 * automatically; a new action fails until its expectation is added to EXPECTED below.
 *
 * EXPECTED restates the policy independently of src/authz/model.ts, so a change to the catalog (e.g.
 * lowering `audit.read` to viewer) fails here and must be made deliberately in both places.
 */
const EXPECTED: Record<Action, { readonly min: Role; readonly perProject: boolean }> = {
  'session.self': { min: 'viewer', perProject: false },
  'api.docs': { min: 'viewer', perProject: false },
  'notifications.self': { min: 'viewer', perProject: false },
  'jobs.read': { min: 'viewer', perProject: true },
  'jobs.create': { min: 'operator', perProject: true },
  'jobs.cancel': { min: 'operator', perProject: true },
  'jobs.queue.reorder': { min: 'operator', perProject: true },
  'jobs.queue.runnow': { min: 'admin', perProject: true },
  'jobs.export': { min: 'operator', perProject: true },
  'jobs.message': { min: 'operator', perProject: true },
  'jobs.approval.mode': { min: 'operator', perProject: true },
  'jobs.resume': { min: 'operator', perProject: true },
  'jobs.merge': { min: 'operator', perProject: true },
  'code.read': { min: 'viewer', perProject: true },
  'ide.use': { min: 'operator', perProject: true },
  'ide.manage': { min: 'admin', perProject: true },
  'ide.extensions': { min: 'admin', perProject: true },
  'code.review': { min: 'operator', perProject: true },
  'approvals.read': { min: 'viewer', perProject: true },
  'approvals.decide': { min: 'operator', perProject: true },
  'policy.read': { min: 'admin', perProject: true },
  'policy.write': { min: 'admin', perProject: true },
  'context.read': { min: 'viewer', perProject: true },
  'context.write': { min: 'operator', perProject: true },
  'context.delete': { min: 'admin', perProject: true },
  'context.purge': { min: 'admin', perProject: false },
  'context.bundle': { min: 'operator', perProject: true },
  'context.retention': { min: 'admin', perProject: true },
  'context.export': { min: 'operator', perProject: true },
  'context.receipts': { min: 'admin', perProject: true },
  'context.search': { min: 'viewer', perProject: true },
  'context.search.admin': { min: 'admin', perProject: true },
  'context.defaults': { min: 'admin', perProject: false },
  'memory.suggestions.read': { min: 'viewer', perProject: true },
  'memory.suggestions.decide': { min: 'operator', perProject: true },
  'memory.suggestions.admin': { min: 'admin', perProject: true },
  'memory.personal': { min: 'viewer', perProject: false },
  'audit.read': { min: 'admin', perProject: false },
  'audit.verify': { min: 'admin', perProject: false },
  'audit.export': { min: 'admin', perProject: false },
  'backups.read': { min: 'admin', perProject: false },
  'system.status': { min: 'admin', perProject: false },
  'system.logs': { min: 'admin', perProject: false },
  'onboarding.manage': { min: 'owner', perProject: false },
  'updates.read': { min: 'owner', perProject: false },
  'console.domain.read': { min: 'owner', perProject: false },
  'console.domain.write': { min: 'owner', perProject: false },
  'host.actions.read': { min: 'owner', perProject: false },
  'settings.panel.read': { min: 'admin', perProject: false },
  'settings.panel.write': { min: 'owner', perProject: false },
  'users.recover': { min: 'admin', perProject: false },
  'keys.rotate': { min: 'owner', perProject: false },
  'maintenance.read': { min: 'admin', perProject: false },
  'maintenance.run': { min: 'owner', perProject: false },
  'host.update': { min: 'owner', perProject: false },
  'backups.manage': { min: 'owner', perProject: false },
  'backups.restore': { min: 'owner', perProject: false },
  'workers.read': { min: 'viewer', perProject: false },
  'workers.approve': { min: 'admin', perProject: false },
  'workers.revoke': { min: 'admin', perProject: false },
  'workers.drain': { min: 'admin', perProject: false },
  'workers.archive': { min: 'admin', perProject: false },
  'workers.rename': { min: 'admin', perProject: false },
  'workers.rotate': { min: 'admin', perProject: false },
  'workers.update': { min: 'admin', perProject: false },
  'workers.config.read': { min: 'admin', perProject: false },
  'workers.config.write': { min: 'admin', perProject: false },
  'workers.ops.read': { min: 'admin', perProject: false },
  'workers.ops.write': { min: 'admin', perProject: false },
  'machines.admin.read': { min: 'admin', perProject: false },
  'machines.admin.enable': { min: 'owner', perProject: false },
  'machines.admin.run': { min: 'admin', perProject: false },
  'vault.read': { min: 'admin', perProject: false },
  'vault.write': { min: 'admin', perProject: false },
  'models.read': { min: 'viewer', perProject: false },
  'models.write': { min: 'admin', perProject: false },
  'runtimes.read': { min: 'viewer', perProject: false },
  'runtimes.write': { min: 'admin', perProject: false },
  'releases.read': { min: 'viewer', perProject: false },
  'releases.publish': { min: 'admin', perProject: false },
  'updates.channel.write': { min: 'owner', perProject: false },
  'installers.read': { min: 'admin', perProject: false },
  'skills.read': { min: 'viewer', perProject: false },
  'skills.publish': { min: 'admin', perProject: false },
  'skills.assign': { min: 'admin', perProject: false },
  'mcp.read': { min: 'viewer', perProject: false },
  'mcp.manage': { min: 'admin', perProject: false },
  'mcp.assign': { min: 'admin', perProject: false },
  'mcp.scripts': { min: 'admin', perProject: false },
  'usage.read': { min: 'viewer', perProject: true },
  'usage.records': { min: 'operator', perProject: true },
  'prices.write': { min: 'admin', perProject: false },
  'budgets.read': { min: 'viewer', perProject: true },
  'budgets.write': { min: 'admin', perProject: true },
  // p8-cost-efficiency.
  'budgets.override': { min: 'admin', perProject: true },
  'reports.self': { min: 'viewer', perProject: false },
  'workflows.read': { min: 'viewer', perProject: true },
  'workflows.define': { min: 'operator', perProject: true },
  'workflows.run': { min: 'operator', perProject: true },
  'workflows.approve': { min: 'operator', perProject: true },
  // p14-workflow-engine 14.1: expression preview and single-node tests.
  'workflows.test': { min: 'operator', perProject: true },
  // p14-workflow-engine 14.2: privileged node deltas (step-up) and trigger activation.
  'workflows.define.network': { min: 'admin', perProject: true },
  'workflows.define.deploy': { min: 'admin', perProject: true },
  'workflows.define.code': { min: 'admin', perProject: true },
  'workflows.activate': { min: 'operator', perProject: true },
  'workflows.egress.write': { min: 'admin', perProject: true },
  // p18-multi-project: shared workflows.
  'workflows.share': { min: 'admin', perProject: true },
  'workflows.attach': { min: 'admin', perProject: true },
  'workflows.attach.credentials': { min: 'admin', perProject: true },
  'schedules.read': { min: 'viewer', perProject: true },
  'schedules.write': { min: 'operator', perProject: true },
  'automations.read': { min: 'viewer', perProject: true },
  'automations.write': { min: 'operator', perProject: true },
  'automations.external': { min: 'admin', perProject: true },
  'automations.crossproject': { min: 'admin', perProject: true },
  'templates.read': { min: 'viewer', perProject: true },
  'templates.write': { min: 'operator', perProject: true },
  'templates.share': { min: 'operator', perProject: true },
  'templates.global': { min: 'admin', perProject: false },
  'quotas.read': { min: 'viewer', perProject: false },
  'quotas.write': { min: 'admin', perProject: false },
  'quotas.refresh': { min: 'operator', perProject: false },
  'projects.kill': { min: 'admin', perProject: true },
  'projects.read': { min: 'viewer', perProject: true },
  'projects.create': { min: 'admin', perProject: false },
  'projects.git.read': { min: 'viewer', perProject: true },
  'projects.git.write': { min: 'admin', perProject: true },
  'git.identity.read': { min: 'admin', perProject: false },
  'git.identity.write': { min: 'admin', perProject: false },
  'projects.workspace.read': { min: 'viewer', perProject: true },
  'projects.workspace.write': { min: 'admin', perProject: true },
  'projects.execution.read': { min: 'viewer', perProject: true },
  'projects.execution.write': { min: 'admin', perProject: true },
  'projects.egress.write': { min: 'admin', perProject: true },
  'projects.workers.read': { min: 'viewer', perProject: true },
  'projects.workers.write': { min: 'admin', perProject: true },
  'projects.members.read': { min: 'viewer', perProject: true },
  'projects.members.write': { min: 'admin', perProject: true },
  'chat.use': { min: 'viewer', perProject: false },
  'chat.admin': { min: 'admin', perProject: false },
  'users.read': { min: 'admin', perProject: false },
  'users.manage': { min: 'owner', perProject: false },
  'security.read': { min: 'admin', perProject: false },
  'jobs.timelimit': { min: 'operator', perProject: true },
  'security.write': { min: 'admin', perProject: false },
  // p16-api-tokens (ADR-0058).
  'tokens.self': { min: 'viewer', perProject: false },
  'tokens.admin': { min: 'admin', perProject: false },
  'serviceaccounts.read': { min: 'admin', perProject: false },
  'serviceaccounts.manage': { min: 'admin', perProject: false },
  // p16-webhooks-out.
  'webhooks.read': { min: 'admin', perProject: false },
  'webhooks.write': { min: 'admin', perProject: false },
  'webhooks.internal': { min: 'owner', perProject: false },
  // p16-doctor.
  'doctor.run': { min: 'admin', perProject: false },
  'support.report': { min: 'admin', perProject: false },
  'support.settings': { min: 'owner', perProject: false },
  'sso.coolify': { min: 'admin', perProject: false },
  'integrations.github.read': { min: 'admin', perProject: false },
  'integrations.github.write': { min: 'admin', perProject: false },
  'integrations.ops.read': { min: 'admin', perProject: false },
  'integrations.ops.write': { min: 'admin', perProject: false },
  'integrations.bedrock.read': { min: 'admin', perProject: false },
  'integrations.bedrock.write': { min: 'admin', perProject: false },
  'integrations.storage.read': { min: 'admin', perProject: false },
  'integrations.storage.write': { min: 'owner', perProject: false },
  'integrations.githosts.read': { min: 'admin', perProject: false },
  'integrations.githosts.write': { min: 'admin', perProject: false },
  'deploy.read': { min: 'viewer', perProject: true },
  'deploy.request': { min: 'operator', perProject: true },
  'deploy.approve': { min: 'admin', perProject: true },
  'deploy.targets.write': { min: 'admin', perProject: true },
  'deploy.coolify.read': { min: 'admin', perProject: true },
  'deploy.coolify.manage': { min: 'admin', perProject: true },
  'coolify.read': { min: 'admin', perProject: false },
  'coolify.manage': { min: 'admin', perProject: false },
  'outputs.read': { min: 'viewer', perProject: true },
  'outputs.write': { min: 'operator', perProject: true },
  'outputs.folders': { min: 'viewer', perProject: true },
  'outputs.share': { min: 'admin', perProject: true },
  'uptime.read': { min: 'viewer', perProject: true },
  'uptime.write': { min: 'operator', perProject: true },
  'uptime.settings': { min: 'admin', perProject: true },
  'previews.read': { min: 'viewer', perProject: true },
  'previews.open': { min: 'operator', perProject: true },
  'previews.reveal': { min: 'admin', perProject: true },
  'services.read': { min: 'viewer', perProject: true },
  'services.manage': { min: 'operator', perProject: true },
  'workfiles.read': { min: 'viewer', perProject: true },
  'workfiles.manage': { min: 'operator', perProject: true },
  'workfiles.settings': { min: 'admin', perProject: false },
};

const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };
const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'alpha';
const OTHER = 'beta';
const MISSING_ID = '00000000-0000-4000-8000-0000000000aa';

interface Persona {
  readonly name: string;
  readonly account: Role;
  /** Role in PROJECT (null: not a member; such personas are members of OTHER instead). */
  readonly inProject: Role | null;
  client: Client;
}

type Outcome = 'allow' | 'forbidden' | 'hidden';

function expected(action: Action, persona: Persona, boundToProject: boolean): Outcome {
  const rule = EXPECTED[action];
  if (RANK[persona.account] < RANK[rule.min]) return 'forbidden';
  if (!rule.perProject || !boundToProject) return 'allow';
  if (persona.inProject === null) return 'hidden';
  return RANK[persona.inProject] < RANK[rule.min] ? 'forbidden' : 'allow';
}

let h: Harness;
const personas: Persona[] = [];
const fixtures: Partial<Record<string, string>> = {};
let pending: Client;
let enrolling: Client;
let changing: Client;

/**
 * Which route parameters address a resource in PROJECT. A route whose action is project-scoped and that
 * has a parameter not listed here fails the "fixtures" test below: add its fixture so the matrix checks
 * project isolation (404 for non-members) instead of passing on a non-existent id.
 */
function bindParams(url: string): { path: string; bound: boolean; unresolved: string[] } {
  const unresolved: string[] = [];
  let bound = false;
  const path = url.replace(/:([A-Za-z]+)/g, (_m, name: string, offset: number) => {
    const prefix = url.slice(0, offset);
    const key =
      name === 'version'
        ? 'version'
        : prefix.startsWith('/ide/extensions/')
          ? // p19-ide W3: an extension of the global allowlist (not a project resource).
            'ideExtension'
          : prefix.startsWith('/workflows/templates/')
            ? // p14-workflow-engine 14.5: a template id (static catalog); the project comes from the body.
              'workflowTemplate'
            : prefix.startsWith('/workflows/ai/threads/')
              ? // p15-workflow-ai: the caller's own chat thread (private, not a project resource); the project is in the body.
                'workflowAiThread'
              : prefix.startsWith('/workflow-attachments/')
                ? // p18-multi-project: an attachment in PROJECT (`:slot` resolves through the same row).
                  'workflowAttachment'
                : prefix.startsWith('/workflows/runs/')
                  ? 'workflowRun'
                  : prefix.startsWith('/workflows/')
                    ? 'workflow'
                    : prefix.startsWith('/automation-groups/')
                      ? // p18-multi-project W4: an automation group (siblings are checked per project, not a project resource).
                        'automationGroup'
                      : prefix.startsWith('/jobs/batches/')
                        ? // p18-multi-project W5: the caller's own batch (not a project resource; members are checked per project).
                          'jobBatch'
                        : prefix.startsWith('/jobs/')
                          ? 'job'
                          : prefix.startsWith('/approvals/')
                            ? 'approval'
                            : prefix.startsWith('/context/docs/')
                              ? 'doc'
                              : prefix.startsWith('/projects/')
                                ? 'project'
                                : prefix.startsWith('/users/')
                                  ? 'user'
                                  : prefix.startsWith('/budgets/')
                                    ? 'budget'
                                    : prefix.startsWith('/schedules/')
                                      ? 'schedule'
                                      : prefix.startsWith('/automations/') && name === 'runId'
                                        ? 'automationRun'
                                        : prefix.startsWith('/automations/')
                                          ? 'automation'
                                          : prefix.startsWith('/templates/')
                                            ? 'template'
                                            : prefix.startsWith('/deploy/actions/')
                                              ? 'opsAction'
                                              : prefix.startsWith('/outputs/item-notes/')
                                                ? 'outputItemNote'
                                                : prefix.startsWith('/outputs/notes/')
                                                  ? 'outputNote'
                                                  : prefix.startsWith('/outputs/folders/')
                                                    ? 'outputFolder'
                                                    : prefix.startsWith('/uptime/monitors/')
                                                      ? 'monitor'
                                                      : prefix.startsWith('/previews/')
                                                        ? 'preview'
                                                        : prefix.startsWith('/services/')
                                                          ? 'service'
                                                          : prefix.startsWith('/ide/workspaces/')
                                                            ? // p19-ide W2: a Tam IDE workspace in PROJECT.
                                                              'ideWorkspace'
                                                            : prefix.startsWith('/memory-suggestions/')
                                                              ? 'memorySuggestion'
                                                              : prefix.startsWith(
                                                                    '/memory-records/conflicts/',
                                                                  )
                                                                ? 'memoryConflict'
                                                                : prefix.startsWith('/memory-records/jobs/')
                                                                  ? 'job'
                                                                  : prefix.startsWith('/memory-records/type/')
                                                                    ? 'doc'
                                                                    : prefix.startsWith('/memory-records/')
                                                                      ? 'memoryRecord'
                                                                      : prefix.startsWith('/deploy-health/')
                                                                        ? 'deployHealth'
                                                                        : prefix.startsWith('/integrations/')
                                                                          ? 'integration'
                                                                          : null;
    if (key === null) {
      unresolved.push(name);
      return MISSING_ID;
    }
    if (
      key !== 'version' &&
      key !== 'user' &&
      key !== 'workflowTemplate' &&
      key !== 'workflowAiThread' &&
      key !== 'jobBatch' &&
      key !== 'automationGroup' &&
      key !== 'ideExtension'
    )
      bound = true;
    return encodeURIComponent(fixtures[key] ?? MISSING_ID);
  });
  return { path, bound, unresolved };
}

/** Routes whose resource is named in the query string (key: path, or `METHOD path` for one method only). */
const QUERY_BOUND: Record<string, string> = {
  '/context/bundle': `?project=${PROJECT}&runtime=codex`,
  // p6-context-policy.
  '/context/policies': `?namespace=project:${PROJECT}`,
  '/context/deletion-receipts': `?namespace=project:${PROJECT}`,
  '/context/export': `?project=${PROJECT}`,
  // p6-vector.
  '/context/search': `?project=${PROJECT}&q=deploy`,
  '/context/search/settings': `?namespace=project:${PROJECT}`,
  // p10-semantic-memory (`:job` is replaced by the job fixture).
  'GET /memory-suggestions': `?project=${PROJECT}`,
  // p22-output-delivery: the pending merge decisions of a project.
  'GET /approvals/merge-batch': `?project=${PROJECT}`,
  'GET /memory-suggestions/settings': `?project=${PROJECT}`,
  '/memory-suggestions/agent-prompt': '?job=:job',
  // p10-chat-memory-suggestions.
  '/memory-suggestions/chat-prompt': `?project=${PROJECT}&thread=00000000-0000-4000-8000-000000000001`,
  // p11-memory-layers.
  'GET /memory-records': `?scope=project&project=${PROJECT}`,
  '/memory-records/decisions': `?project=${PROJECT}`,
  '/memory-records/conflicts': `?project=${PROJECT}`,
  '/memory-records/untyped': `?project=${PROJECT}`,
  // p6-outputs.
  '/outputs': `?project=${PROJECT}`,
  '/outputs/thread': `?project=${PROJECT}&key=site:pages:matrix:preview`,
  // p8-outputs-folders.
  'GET /outputs/folders': `?project=${PROJECT}`,
  '/outputs/item-folders': `?project=${PROJECT}&key=site:pages:matrix:preview`,
  '/outputs/tree': `?project=${PROJECT}`,
  // p8-templates.
  '/template-suggestions': `?project=${PROJECT}`,
  // p8-uptime (method-qualified: the POST / PUT on the same path name the project in the body).
  'GET /uptime/monitors': `?project=${PROJECT}`,
  'GET /uptime/settings': `?project=${PROJECT}`,
  // p10-verify-health.
  'GET /deploy-health': `?project=${PROJECT}`,
  // p18-multi-project: workflows offered to a project.
  '/workflows/offers': `?project=${PROJECT}`,
};

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

async function probe(client: Client, method: Method, url: string) {
  return client.req(method, url, method === 'GET' || method === 'HEAD' ? undefined : {}, {
    'x-authz-probe': '1',
  });
}

describeIntegration('authorization matrix: every route × every role (integration)', () => {
  beforeAll(async () => {
    h = new Harness();
    await h.start({ authzProbe: true });
    const audit = new AuditLog(h.db.pool, h.clock.now);
    const jobs = new JobStore({ pool: h.db.pool, audit, clock: h.clock.now });
    const approvals = new ApprovalService({ pool: h.db.pool, audit, jobs, clock: h.clock.now });
    const context = new ContextStore({ pool: h.db.pool, audit, clock: h.clock.now });

    const people: [string, Role, Role | null][] = [
      ['owner', 'owner', 'owner'],
      ['admin', 'admin', 'admin'],
      ['operator-member', 'operator', 'operator'],
      ['operator-nonmember', 'operator', null],
      ['viewer-member', 'viewer', 'viewer'],
      ['viewer-nonmember', 'viewer', null],
      // Account role is the ceiling: an operator membership does not lift a viewer account.
      ['viewer-opmember', 'viewer', 'viewer'],
    ];
    for (const [name, account, inProject] of people) {
      const username = name.replace('-', '.');
      const id = await h.createUser(username, PW, account);
      if (account === 'operator' || account === 'viewer') {
        if (inProject === null) await h.grant(id, [OTHER], account);
        else await h.grant(id, [PROJECT], name === 'viewer-opmember' ? 'operator' : account);
      }
      const { secret } = await enroll(h, username, PW);
      personas.push({ name, account, inProject, client: await fullLogin(h, username, PW, secret) });
      fixtures.user ??= id;
    }

    // Half-authenticated sessions.
    await h.createUser('pending.user', PW, 'owner');
    await enroll(h, 'pending.user', PW);
    h.clock.advance(30_000);
    pending = h.client();
    expect(
      (await pending.req('POST', '/auth/login', { username: 'pending.user', password: PW })).statusCode,
    ).toBe(200);
    await h.createUser('enrolling.user', PW, 'owner');
    enrolling = h.client();
    expect(
      (await enrolling.req('POST', '/auth/login', { username: 'enrolling.user', password: PW })).statusCode,
    ).toBe(200);
    // p5-self-password: a temporary password still to be replaced.
    await h.createUser('changing.user', PW, 'owner');
    const changingSecret = (await enroll(h, 'changing.user', PW)).secret;
    await h.db.pool.query(
      "UPDATE users SET password_change_required = true WHERE username = 'changing.user'",
    );
    h.clock.advance(30_000);
    changing = h.client();
    await changing.req('POST', '/auth/login', { username: 'changing.user', password: PW });
    expect(
      (await changing.req('POST', '/auth/totp/verify', { code: h.code(changingSecret) })).json(),
    ).toMatchObject({ status: 'password_change_required' });

    // Resources in PROJECT.
    const creator: JobActor = { type: 'user', id: fixtures.user ?? '' };
    const { job } = await jobs.create({
      project: PROJECT,
      actor: creator,
      submit: true,
      spec: {
        runtime: 'codex',
        prompt: 'Matrix fixture',
        repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: 'rac/matrix' },
        sandboxProfile: 'container',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 3600 },
      },
    });
    fixtures.job = job.id;
    const grant = await jobs.acquireLease(job.id, 'worker-1', 3_600_000);
    const w: JobActor = { type: 'worker', id: 'worker-1' };
    const epoch = grant.lease.epoch;
    for (const ev of ['lease_acked', 'runtime_started', 'run_finished', 'verification_passed'] as const) {
      await jobs.transition(job.id, ev, { actor: w, epoch });
    }
    const ev = await approvals.evaluate({
      action: 'git.merge',
      jobId: job.id,
      summary: 'Matrix fixture merge',
      requestedBy: { type: 'system', id: 'integrator' },
    });
    if (ev.outcome !== 'pending') throw new Error('expected a pending approval');
    fixtures.approval = ev.requestId;
    const doc = await context.create(
      { id: fixtures.user ?? '', role: 'owner', mfaAt: h.clock.now() },
      { namespace: `project:${PROJECT}`, kind: 'instructions', title: 'Matrix', content: 'Use tabs.' },
    );
    fixtures.doc = doc.doc.id;
    fixtures.project = PROJECT;
    // p10-semantic-memory: a pending memory suggestion in PROJECT (row only).
    const suggestion = await h.db.pool.query<{ id: string }>(
      `INSERT INTO memory_suggestions (project, state, source, job_id, rule, title, content, fingerprint, created_at)
       VALUES ($1, 'pending', 'job', $2, 'marker', 'Matrix', 'Use tabs.', 'sha256:' || repeat('a', 64), now())
       RETURNING id`,
      [PROJECT, job.id],
    );
    fixtures.memorySuggestion = suggestion.rows[0]?.id ?? '';
    // p11-memory-layers: two typed records in PROJECT (the matrix doc and one more) and a pending conflict between them.
    const doc2 = await context.create(
      { id: fixtures.user ?? '', role: 'owner', mfaAt: h.clock.now() },
      { namespace: `project:${PROJECT}`, kind: 'instructions', title: 'Matrix 2', content: 'Use spaces.' },
    );
    await h.db.pool.query(
      `INSERT INTO memory_records (doc_id, type, scope, project, status, statement, author, created_at, updated_at)
       VALUES ($1, 'rule', $3, $4, 'active', 'Use tabs.', 'human', now(), now()),
              ($2, 'rule', $3, $4, 'active', 'Use spaces.', 'human', now(), now())`,
      [doc.doc.id, doc2.doc.id, `project:${PROJECT}`, PROJECT],
    );
    fixtures.memoryRecord = doc.doc.id;
    const conflict = await h.db.pool.query<{ id: string }>(
      `INSERT INTO memory_record_conflicts (project, scope, record_id, other_id, score, method, reason, state, created_at)
       VALUES ($1, $2, $3, $4, 0.9, 'lexical', 'different_choice', 'pending', now()) RETURNING id::text AS id`,
      [PROJECT, `project:${PROJECT}`, doc2.doc.id, doc.doc.id],
    );
    fixtures.memoryConflict = conflict.rows[0]?.id ?? '';
    const usage = new UsageStore({ pool: h.db.pool, audit, clock: h.clock.now });
    const budget = await usage.createBudget(
      { id: fixtures.user ?? '', role: 'owner', mfaAt: h.clock.now() },
      {
        name: 'Matrix',
        metric: 'tokens',
        limit: 1000,
        scopeType: 'project',
        scopeValue: PROJECT,
        window: 'day',
      },
      {},
    );
    fixtures.budget = budget.budget.id;
    fixtures.version = '1';
    // p4-dag: a workflow definition and a run in PROJECT (rows only; nothing is dispatched here).
    const wf = await h.db.pool.query<{ id: string }>(
      `INSERT INTO workflow_definitions (project, name, version, definition, definition_hash, created_by, created_at)
       VALUES ($1, 'matrix', 1, '{}', repeat('0', 64), 'fixture', now()) RETURNING id`,
      [PROJECT],
    );
    fixtures.workflow = wf.rows[0]?.id ?? '';
    const run = await h.db.pool.query<{ id: string }>(
      `INSERT INTO workflow_runs (definition_id, project, name, version, state, inputs, repository, created_by,
                                  created_at, updated_at)
       VALUES ($1, $2, 'matrix', 1, 'running', '{}', '{}', 'fixture', now(), now()) RETURNING id`,
      [fixtures.workflow, PROJECT],
    );
    fixtures.workflowRun = run.rows[0]?.id ?? '';
    // p18-multi-project: PROJECT attached a workflow OTHER owns (rows only).
    await h.db.pool.query(
      'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT DO NOTHING',
      [OTHER],
    );
    await h.db.pool.query(
      `INSERT INTO workflow_definitions (project, name, version, definition, definition_hash, created_by, created_at)
       VALUES ($1, 'matrix-shared', 1, '{}', repeat('0', 64), 'fixture', now())`,
      [OTHER],
    );
    const attached = await h.db.pool.query<{ id: string }>(
      `INSERT INTO workflow_attachments (project, owner_project, name, state, follow, version, created_by, created_at,
                                         updated_by, updated_at)
       VALUES ($1, $2, 'matrix-shared', 'enabled', 'auto', 1, 'fixture', now(), 'fixture', now()) RETURNING id`,
      [PROJECT, OTHER],
    );
    fixtures.workflowAttachment = attached.rows[0]?.id ?? '';
    // p5-composer / p6-automations: an active cron automation in PROJECT (never due during the test); the
    // /schedules aliases address the same row.
    const automation = await h.db.pool.query<{ id: string }>(
      `INSERT INTO automations (project, name, state, trigger_kind, trigger, cron, next_run_at, target_kind,
                                workflow_id, workflow_inputs, run_as, created_by, created_at, updated_at)
       VALUES ($1, 'matrix', 'active', 'cron', '{"kind":"cron","cron":"0 0 1 1 *"}', '0 0 1 1 *',
               now() + interval '300 days', 'workflow', $2, '{}', $3, $3, now(), now()) RETURNING id`,
      [PROJECT, fixtures.workflow, fixtures.user],
    );
    fixtures.schedule = automation.rows[0]?.id ?? '';
    fixtures.automation = fixtures.schedule;
    const automationRun = await h.db.pool.query<{ id: string }>(
      `INSERT INTO automation_runs (automation_id, project, trigger_kind, dedup_key, state, created_at, finished_at)
       VALUES ($1, $2, 'manual', 'manual:matrix', 'skipped', now(), now()) RETURNING id`,
      [fixtures.automation, PROJECT],
    );
    fixtures.automationRun = automationRun.rows[0]?.id ?? '';
    // p6-deploy-integrations: a refused ops action in PROJECT (row only; nothing is executed).
    const opsAction = await h.db.pool.query<{ id: string }>(
      `INSERT INTO ops_actions (project, kind, env, params, params_hash, target, diff, policy_decision, policy_reason,
         state, requested_by_type, requested_by_id, via, idempotency_key, created_at, updated_at, finished_at)
       VALUES ($1, 'coolify.deploy', 'preview', '{}', repeat('0', 64), '{}', '{}', 'refused', 'fixture', 'refused',
         'system', 'matrix', 'api', 'matrix-fixture', now(), now(), now()) RETURNING id`,
      [PROJECT],
    );
    fixtures.opsAction = opsAction.rows[0]?.id ?? '';
    // p6-outputs: a note on an output item and a note card in PROJECT (rows only).
    const outputItem = await h.db.pool.query<{ id: string }>(
      `INSERT INTO output_items (project, item_key, kind, created_at, updated_at)
       VALUES ($1, 'site:pages:matrix:preview', 'site', now(), now()) RETURNING id`,
      [PROJECT],
    );
    const itemNote = await h.db.pool.query<{ id: string }>(
      `INSERT INTO output_item_notes (item_id, project, author_id, body, created_at, updated_at)
       VALUES ($1, $2, $3, 'matrix', now(), now()) RETURNING id`,
      [outputItem.rows[0]?.id, PROJECT, fixtures.user],
    );
    fixtures.outputItemNote = itemNote.rows[0]?.id ?? '';
    const noteCard = await h.db.pool.query<{ id: string }>(
      `INSERT INTO output_notes (project, title, body, author_id, created_at, updated_at)
       VALUES ($1, 'Matrix', 'matrix', $2, now(), now()) RETURNING id`,
      [PROJECT, fixtures.user],
    );
    fixtures.outputNote = noteCard.rows[0]?.id ?? '';
    // p8-outputs-folders: a project folder in PROJECT (row only).
    const folder = await h.db.pool.query<{ id: string }>(
      `INSERT INTO output_folders (scope, project, depth, name, created_at, updated_at)
       VALUES ('project', $1, 1, 'Matrix', now(), now()) RETURNING id`,
      [PROJECT],
    );
    fixtures.outputFolder = folder.rows[0]?.id ?? '';
    // p8-templates: a template in PROJECT (rows only).
    const template = await h.db.pool.query<{ id: string }>(
      `INSERT INTO job_templates (project, title, state, current_version, source, created_at, updated_at)
       VALUES ($1, 'Matrix', 'active', 1, '{"kind":"manual"}', now(), now()) RETURNING id`,
      [PROJECT],
    );
    fixtures.template = template.rows[0]?.id ?? '';
    await h.db.pool.query(
      `INSERT INTO job_template_versions (template_id, version, prompt, parameters, defaults, created_at)
       VALUES ($1, 1, 'Matrix', '[]', '{"runtime":"codex"}', now())`,
      [fixtures.template],
    );
    // p8-uptime: a paused monitor in PROJECT (row only; never checked).
    const monitor = await h.db.pool.query<{ id: string }>(
      `INSERT INTO uptime_monitors (id, project, name, type, config, interval_sec, timeout_ms, retries, paused, status,
                                    next_check_at, created_by_type, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'Matrix', 'tcp', '{"host":"example.com","port":443}', 60, 5000, 1, true,
               'pending', now(), 'system', now(), now()) RETURNING id`,
      [PROJECT],
    );
    fixtures.monitor = monitor.rows[0]?.id ?? '';
    // p8-preview-tunnels: a closed preview in PROJECT (row only; nothing exists in Cloudflare).
    const preview = await h.db.pool.query<{ id: string }>(
      `INSERT INTO preview_tunnels (project, name, hostname, zone_id, zone_name, protection, state, opened_by_type,
         opened_by_id, expires_at, created_at, updated_at, closed_at, close_reason)
       VALUES ($1, 'matrix', 'matrix-abc.example.com', repeat('a', 32), 'example.com', 'none', 'closed', 'system',
         'matrix', now(), now(), now(), now(), 'fixture') RETURNING id`,
      [PROJECT],
    );
    fixtures.preview = preview.rows[0]?.id ?? '';
    // p15-services: a stopped service in PROJECT on a worker that does not exist (row only; never delivered).
    const service = await h.db.pool.query<{ id: string }>(
      `INSERT INTO services (id, project, worker_id, name, spec, desired, state, tunnel_mode, created_by_type,
         created_by_id, created_via, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'wrk_matrix', 'matrix', '{}', 'stopped', 'stopped', 'none', 'system', 'matrix',
         'api', now(), now()) RETURNING id`,
      [PROJECT],
    );
    fixtures.service = service.rows[0]?.id ?? '';
    // p19-ide W2: a stopped Tam IDE workspace in PROJECT of the first user on a worker that does not exist (row only).
    const ideWs = await h.db.pool.query<{ id: string }>(
      `INSERT INTO ide_workspaces (id, project, user_id, worker_id, name, source_kind, spec, desired, state,
         created_at, updated_at)
       VALUES (gen_random_uuid(), $1, (SELECT id FROM users ORDER BY created_at LIMIT 1), 'wrk_matrix', 'matrix',
         'files', '{}', 'stopped', 'stopped', now(), now()) RETURNING id`,
      [PROJECT],
    );
    fixtures.ideWorkspace = ideWs.rows[0]?.id ?? '';
    // p10-verify-health: a finished health check of that preview (row only).
    const health = await h.db.pool.query<{ id: string }>(
      `INSERT INTO deploy_health_checks (project, preview_id, kind, env, state, created_at, updated_at, finished_at)
       VALUES ($1, $2, 'tunnel', 'preview', 'skipped', now(), now(), now()) RETURNING id`,
      [PROJECT, fixtures.preview],
    );
    fixtures.deployHealth = health.rows[0]?.id ?? '';
    // p11-merge-pipeline: an integration of the job fixture (row only; never advanced here).
    const integration = await h.db.pool.query<{ id: string }>(
      `INSERT INTO integrations (id, project, source, root_job_id, branch, target_branch, repository_url, base_sha,
                                 order_mode, state, max_resolutions, max_fixes, created_by, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'coordinator', $2, 'int/0000aaaa', 'main', 'https://git.example.test/a.git',
               repeat('a', 40), 'dependency', 'needs_human', 3, 1, (SELECT id FROM users ORDER BY created_at LIMIT 1),
               now(), now())
       RETURNING id::text AS id`,
      [PROJECT, fixtures.job],
    );
    fixtures.integration = integration.rows[0]?.id ?? '';
    fixtures.workflowTemplate = 'content-production';
    // p19-ide W3: an id of the global extension allowlist (none exists: an allowed request answers 404 itself).
    fixtures.ideExtension = 'acme.matrix';
    fixtures.workflowAiThread = '00000000-0000-4000-8000-0000000000a1';
  });

  afterAll(async () => {
    await h.stop();
  });

  it('has an expectation for every catalogued action (new actions must be decided here)', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ACTION_NAMES].sort());
  });

  it('has a project fixture for every parameter of a project-scoped route', () => {
    const missing: string[] = [];
    for (const r of h.app.registeredRoutes) {
      if (r.action === undefined || !(r.action in EXPECTED)) continue;
      const { unresolved } = bindParams(r.url);
      if (EXPECTED[r.action as Action].perProject && unresolved.length > 0) {
        missing.push(`${r.method} ${r.url}: ${unresolved.join(', ')}`);
      }
    }
    expect(missing, 'add these parameters to bindParams()').toEqual([]);
  });

  it('every declared route answers each persona exactly as the policy says', async () => {
    const failures: string[] = [];
    let checked = 0;
    for (const r of h.app.registeredRoutes) {
      if (r.auth !== undefined && r.auth !== 'full') continue; // login steps: route-coverage test
      const action = r.action as Action | undefined;
      const key = `${r.method} ${r.url}`;
      if (action === undefined || !(action in EXPECTED)) {
        failures.push(`${key}: no authz declaration`);
        continue;
      }
      const method = r.method as Method;
      const bound = bindParams(r.url);
      const query = (QUERY_BOUND[`${r.method} ${r.url}`] ?? QUERY_BOUND[r.url])?.replace(
        ':job',
        fixtures.job ?? MISSING_ID,
      );
      const url = `${bound.path}${query ?? ''}`;
      const boundToProject = bound.bound || query !== undefined;

      for (const [label, client] of [
        ['unauthenticated', h.client()],
        ['mfa_pending', pending.clone()],
        ['enrollment', enrolling.clone()],
        ['password_change', changing.clone()],
      ] as const) {
        const res = await probe(client, method, url);
        if (res.statusCode !== 401) failures.push(`${key} ${label}: ${String(res.statusCode)} (want 401)`);
      }
      for (const p of personas) {
        const want = expected(action, p, boundToProject);
        const res = await probe(p.client, method, url);
        const got =
          res.statusCode === 204 && res.headers['x-authz'] === 'allowed'
            ? 'allow'
            : res.statusCode === 403
              ? 'forbidden'
              : res.statusCode === 404
                ? 'hidden'
                : `status ${String(res.statusCode)}`;
        if (got !== want) failures.push(`${key} as ${p.name}: got ${got}, want ${want}`);
        if (got === 'forbidden' && method !== 'HEAD') {
          expect(res.json<{ error: string }>().error).toBe('forbidden');
        }
      }
      checked += 1;
    }
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(40);
  }, 180_000); // ~80 routes × 10 personas; slow when the whole monorepo suite runs in parallel

  it('non-members get the same 404 for a hidden resource as for a missing one', async () => {
    const op = personas.find((p) => p.name === 'operator-nonmember');
    if (!op) throw new Error('persona missing');
    for (const [base, id] of [
      ['/jobs/', fixtures.job],
      ['/approvals/', fixtures.approval],
      ['/context/docs/', fixtures.doc],
    ] as const) {
      const hidden = await op.client.req('GET', `${base}${String(id)}`);
      const missing = await op.client.req('GET', `${base}${MISSING_ID}`);
      expect(hidden.statusCode, base).toBe(404);
      expect(missing.statusCode, base).toBe(404);
      expect(hidden.json(), base).toEqual(missing.json());
    }
  });
});
