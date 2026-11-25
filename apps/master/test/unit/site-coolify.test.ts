import { describe, expect, it } from 'vitest';
import type { Subject } from '../../src/authz/model.js';
import {
  ChatSiteCoolify,
  type ChatSiteCoolifyDeps,
  githubAppFor,
  publicIpv4,
  siteSlug,
  zoneOf,
} from '../../src/chat/site-coolify.js';
import type { ConfirmContext } from '../../src/chat/drafts.js';
import type { DraftRecord } from '../../src/chat/store.js';

/**
 * p22-site-coolify (docs/design/p22-site-coolify.md): a site upload goes live on Coolify from ONE card — the plan's
 * checks (domain and zone, a new project waits for the user, a taken repository name) and the run's order (project →
 * repository → files → Coolify project → application + deploy → DNS → a watch on the deploy), stopping at the first
 * step that fails and saying which.
 */

const owner: Subject = { userId: 'u-1', role: 'owner', projects: new Map() } as unknown as Subject;
const UPLOAD = '23e53e9f-54e9-4b53-86d9-dd8219d29f5d';

interface World {
  calls: string[];
  projectExists: boolean;
  repoTaken: boolean;
  servers: { uuid: string; name: string; ip: string | null }[];
  coolifyProjects: { uuid: string; name: string }[];
  failAt: string | null;
  watch: Record<string, unknown> | null;
}

function deps(w: World): ChatSiteCoolifyDeps {
  const failIf = (step: string): void => {
    if (w.failAt === step) throw new Error(`${step} refused`);
  };
  return {
    db: {
      query: (sql: string) => {
        if (sql.includes('FROM projects'))
          return Promise.resolve({ rows: [], rowCount: w.projectExists ? 1 : 0 });
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    } as never,
    clock: () => new Date('2026-11-05T10:00:00Z'),
    chatUploads: () =>
      ({
        planPublish: () =>
          Promise.resolve({
            ok: true,
            project: 'genel',
            facts: {
              id: UPLOAD,
              label: 'boxing-storyboard-static.zip',
              fileCount: 27,
              totalBytes: 46_745_903,
            },
          }),
      }) as never,
    siteUploads: () =>
      ({
        deployFiles: () => {
          w.calls.push('files:read');
          return Promise.resolve({
            files: [
              { path: 'index.html', content: Buffer.from('<h1>x</h1>'), contentType: 'text/html' },
              { path: 'media/a.png', content: Buffer.from([1, 2, 3]), contentType: 'image/png' },
            ],
            upload: {},
          });
        },
      }) as never,
    projects: () =>
      ({
        zoneList: () => Promise.resolve([{ id: 'z1', name: 'sites.example.com' }]),
        run: () => {
          w.calls.push('project');
          failIf('project');
          return Promise.resolve({ op: 'project_create', dnsZone: { set: true }, warnings: [] });
        },
      }) as never,
    repos: () =>
      ({
        plan: (_s: Subject, i: Record<string, unknown>) =>
          Promise.resolve({
            ok: true,
            title: 't',
            project: i.project ?? null,
            payload: { op: 'create_repository', request: { name: i.name, owner: 'example-org' } },
            describe: { owner: 'example-org', ...(w.repoTaken ? { linkOnly: true } : {}) },
          }),
        run: () => {
          w.calls.push('repository');
          failIf('repository');
          return Promise.resolve({
            fullName: 'example-org/boxing-storyboard',
            htmlUrl: 'https://github.com/example-org/boxing-storyboard',
            defaultBranch: 'main',
            linked: true,
          });
        },
      }) as never,
    gitConfig: () => () => Promise.resolve({ baseBranch: 'main' } as never),
    providers: () => () =>
      ({
        branchHead: () => Promise.resolve('a'.repeat(40)),
        commitFiles: (x: { files: unknown[] }) => {
          w.calls.push(`commit:${String(x.files.length)}`);
          failIf('files');
          return Promise.resolve('b'.repeat(40));
        },
        updateBranch: () => Promise.resolve('updated'),
      }) as never,
    coolify: () =>
      ({
        plan: (_s: Subject, tool: string, i: Record<string, unknown>) => {
          w.calls.push(`plan:${tool}`);
          return Promise.resolve({
            ok: true,
            title: tool,
            project: i.project ?? null,
            payload: { op: tool, i },
            describe: {},
          });
        },
        run: (_c: ConfirmContext, d: DraftRecord) => {
          const op = String(d.payload.op);
          w.calls.push(`run:${op}`);
          if (op === 'coolify_infra') {
            failIf('coolify_project');
            return Promise.resolve({ op: 'resource', uuid: 'cproj-new' });
          }
          failIf('application');
          return Promise.resolve({
            op: 'create_app',
            appUuid: 'app-1',
            name: 'boxing-storyboard',
            state: 'created',
            error: null,
            result: { deployActionId: 'act-deploy-1', deployState: 'deploying' },
          });
        },
      }) as never,
    coolifyApps: () =>
      ({
        options: () =>
          Promise.resolve({
            servers: w.servers,
            projects: w.coolifyProjects,
            githubApps: [
              { uuid: 'gh-public', name: 'Public GitHub', organization: null, isPublic: true },
              { uuid: 'gh-org', name: 'example-org-app', organization: 'example-org', isPublic: false },
              { uuid: 'gh-other', name: 'example-org', organization: null, isPublic: false },
            ],
          }),
      }) as never,
    ops: () =>
      ({
        preview: (_p: string, _k: string, params: Record<string, unknown>) => Promise.resolve({ params }),
        request: (_a: unknown, req: { params: Record<string, unknown> }) => {
          w.calls.push(`dns:${String(req.params.content)}:${String(req.params.proxied)}`);
          failIf('dns');
          return Promise.resolve({
            action: { id: 'act-dns-1', state: 'succeeded', policy: { decision: 'auto' } },
          });
        },
      }) as never,
    watches: () =>
      ({
        create: (caller: Record<string, unknown>, input: Record<string, unknown>) => {
          w.watch = { ...input, consent: caller.nextStepConsentAt };
          return Promise.resolve({ watch: { id: 'w-1' } });
        },
      }) as never,
  };
}

const world = (over: Partial<World> = {}): World => ({
  calls: [],
  projectExists: false,
  repoTaken: false,
  servers: [{ uuid: 'srv1', name: 'main', ip: '203.0.113.50' }],
  coolifyProjects: [],
  failAt: null,
  watch: null,
  ...over,
});

const ctx = {
  subject: owner,
  human: { id: 'u-1', mfaAt: null },
  actor: { type: 'user', id: 'u-1', ip: '127.0.0.1', userAgent: 'vitest' },
  direct: true,
} as unknown as ConfirmContext;

async function card(w: World, i: Record<string, unknown> = {}) {
  const svc = new ChatSiteCoolify(deps(w));
  const plan = await svc.plan(owner, {
    uploadId: UPLOAD,
    domain: 'boxing-storyboard.sites.example.com',
    ...i,
  });
  return { svc, plan };
}

describe('p22-site-coolify: helpers', () => {
  it('reads the site name, the zone, the GitHub App and a public address', () => {
    expect(siteSlug('Boxing_Storyboard.sites.example.com')).toBe('boxing-storyboard');
    expect(
      zoneOf('a.b.sites.example.com', [{ name: 'example.com' }, { name: 'sites.example.com' }])?.name,
    ).toBe('sites.example.com');
    expect(zoneOf('a.example.com', [{ name: 'sites.example.com' }])).toBeNull();
    const apps: { uuid: string; organization: string | null; isPublic: boolean }[] = [
      { uuid: 'p', organization: null, isPublic: true },
      { uuid: 'o', organization: 'Example-Org', isPublic: false },
      { uuid: 'x', organization: null, isPublic: false },
    ];
    expect(githubAppFor('example-org', apps)?.uuid).toBe('o');
    expect(githubAppFor('someone', apps)).toBeNull();
    expect(githubAppFor('someone', apps.slice(0, 1).concat(apps.slice(2)))?.uuid).toBe('x');
    expect(publicIpv4('203.0.113.50')).toBe('203.0.113.50');
    for (const ip of [
      '10.0.0.1',
      '172.20.1.1',
      '192.168.1.5',
      '127.0.0.1',
      '100.64.0.1',
      'host.docker.internal',
      null,
    ])
      expect(publicIpv4(ip)).toBeNull();
  });
});

describe('p22-site-coolify: the card', () => {
  it('a new project: one card that waits for the user, named after the site, proxy on', async () => {
    const { plan } = await card(world());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.propose).toBe(true);
    expect(plan.payload).toMatchObject({
      op: 'publish_site',
      uploadId: UPLOAD,
      domain: 'boxing-storyboard.sites.example.com',
      zone: { id: 'z1', name: 'sites.example.com' },
      name: 'boxing-storyboard',
      project: 'boxing-storyboard',
      newProject: true,
      repository: { owner: 'example-org', name: 'boxing-storyboard', private: true },
      proxied: true,
    });
  });

  it('refuses a domain outside the zones, the zone apex, a taken project or repository name', async () => {
    const outside = await card(world(), { domain: 'site.example.com' });
    expect(outside.plan.ok ? '' : outside.plan.message).toContain('not in a Cloudflare zone');
    const apex = await card(world(), { domain: 'sites.example.com' });
    expect(apex.plan.ok ? '' : apex.plan.message).toContain('subdomain');
    const taken = await card(world({ projectExists: true }));
    expect(taken.plan.ok ? '' : taken.plan.message).toContain('exists already');
    const repo = await card(world({ repoTaken: true }));
    expect(repo.plan.ok ? '' : repo.plan.message).toContain('never overwritten');
    const path = await card(world(), { domain: 'https://x.sites.example.com/' });
    expect(path.plan.ok && path.plan.payload.domain).toBe('x.sites.example.com');
  });
});

describe('p22-site-coolify: confirming it', () => {
  it('runs every step in order, points DNS at the server with the proxy on and watches the deploy', async () => {
    const w = world();
    const { svc, plan } = await card(w);
    if (!plan.ok) throw new Error(plan.message);
    const out = await svc.run(ctx, {
      id: 'd-1',
      threadId: 't-1',
      kind: 'coolify_change',
      payload: plan.payload,
    } as never);
    expect(out.stoppedAt).toBeUndefined();
    expect(w.calls).toEqual([
      'project',
      'repository',
      'files:read',
      'commit:2',
      'plan:coolify_infra',
      'run:coolify_infra',
      'plan:coolify_create_app',
      'run:coolify_create_app',
      'dns:203.0.113.50:true',
    ]);
    expect(out).toMatchObject({
      url: 'https://boxing-storyboard.sites.example.com',
      deployActionId: 'act-deploy-1',
      dnsActionId: 'act-dns-1',
      commit: 'b'.repeat(40),
    });
    expect((out.steps as { step: string }[]).map((s) => s.step)).toEqual([
      'project',
      'repository',
      'files',
      'coolify_project',
      'application',
      'dns',
      'watch',
    ]);
    // The application reads the private repository through the organization's GitHub App.
    expect(w.watch).toMatchObject({ target: 'ops_action', id: 'act-deploy-1' });
    expect(String(w.watch?.nextStep)).toContain('https://boxing-storyboard.sites.example.com');
    expect(w.watch?.consent).toBeInstanceOf(Date);
  });

  it('uses the Coolify project named like the project and an existing repository project', async () => {
    const w = world({ coolifyProjects: [{ uuid: 'cp-1', name: 'boxing-storyboard' }] });
    const { svc, plan } = await card(w, { proxied: false });
    if (!plan.ok) throw new Error(plan.message);
    await svc.run(ctx, {
      id: 'd-2',
      threadId: 't-1',
      kind: 'coolify_change',
      payload: plan.payload,
    } as never);
    expect(w.calls).not.toContain('run:coolify_infra');
    expect(w.calls.at(-1)).toBe('dns:203.0.113.50:false');
  });

  it('stops at the first step that fails and says which (nothing after it runs)', async () => {
    const w = world({ failAt: 'files' });
    const { svc, plan } = await card(w);
    if (!plan.ok) throw new Error(plan.message);
    const out = await svc.run(ctx, {
      id: 'd-3',
      threadId: 't-1',
      kind: 'coolify_change',
      payload: plan.payload,
    } as never);
    expect(out).toMatchObject({ stoppedAt: 'files', error: 'files refused' });
    expect(w.calls.some((c) => c.startsWith('plan:coolify'))).toBe(false);
    expect((out.steps as { step: string }[]).map((s) => s.step)).toEqual(['project', 'repository']);
  });

  it('without a public server address the DNS step says what to do instead', async () => {
    const w = world({ servers: [{ uuid: 'srv1', name: 'localhost', ip: 'host.docker.internal' }] });
    const { svc, plan } = await card(w);
    if (!plan.ok) throw new Error(plan.message);
    const out = await svc.run(ctx, {
      id: 'd-4',
      threadId: 't-1',
      kind: 'coolify_change',
      payload: plan.payload,
    } as never);
    expect(out).toMatchObject({ stoppedAt: 'dns', deployActionId: 'act-deploy-1' });
    expect(String(out.error)).toContain('draft_dns_change');
  });
});

describe('p22-site-coolify: the authenticator-code event', () => {
  it('is the project’s (new project) or the repository’s — never only the application’s', async () => {
    const { coolifyDraftEvent } = await import('../../src/security-policy/events.js');
    expect(coolifyDraftEvent({ op: 'publish_site', newProject: true })).toBe('projects.policy');
    expect(coolifyDraftEvent({ op: 'publish_site', newProject: false })).toBe('integrations.connections');
    expect(coolifyDraftEvent({ op: 'create_app' })).toBe('deploy.coolify');
  });
});
