import { createHash } from 'node:crypto';
import { authorize, type Subject } from '../authz/model.js';
import type { Queryable } from '../db/pool.js';
import type { ProjectGitConfig } from '../gitflow/config-store.js';
import type { ProviderFactory } from '../gitflow/service.js';
import { HttpError } from '../http/errors.js';
import type { CoolifyAppService } from '../ops/coolify-apps.js';
import { OpsError } from '../ops/model.js';
import type { OpsService } from '../ops/service.js';
import type { SiteUploadService } from '../site-uploads/service.js';
import type { ChatCoolify } from './coolify-actions.js';
import type { ConfirmContext } from './drafts.js';
import type { ChatGitHubRepo } from './github-repo-actions.js';
import type { ChatProjectCreate } from './project-create-actions.js';
import type { DraftPlan } from './settings-actions.js';
import type { ChatSiteUploads } from './site-uploads.js';
import type { DraftRecord } from './store.js';
import type { ChatWatchService } from './watches.js';

/**
 * p22-site-coolify (docs/design/p22-site-coolify.md): deploying a dropped .zip must be one step, not a long chain the
 * assistant can break half-way. A static site dropped into the chat goes live on
 * Coolify under a domain from ONE card — instead of a copy job, a project card, a repository export, a Coolify project,
 * an application and a DNS record the assistant had to chain (and could lose on the way).
 *
 * `publish_site_coolify` builds a `coolify_change` card (op `publish_site`) from what the master checked now: the
 * upload (the user's, ready, index.html at its root), the domain and its Cloudflare zone, the repository project (a new
 * one named after the site, or an existing repository project), a free GitHub repository name. Confirming runs the
 * existing steps in order, each with its own checks and audit — the project (only from a confirmed card: a new
 * project makes the card always wait for the user), the private repository linked to it, the upload's files as one
 * commit on its base branch, the Coolify project, the application with the domain and its first deploy, the DNS
 * record (Cloudflare proxy on unless the user says otherwise) — and leaves a watch on the deploy whose next step
 * checks the site. What ran is in the result, also when a later step stops (the card says where).
 */

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

function fail(code: 'invalid' | 'forbidden' | 'not_found' | 'unavailable', message: string): DraftPlan {
  return { ok: false, code, message };
}

/** A public IPv4 (a DNS A record may point at it): not private, loopback, link-local, CGNAT or reserved. */
export function publicIpv4(ip: string | null | undefined): string | null {
  if (ip === null || ip === undefined || !IPV4.test(ip)) return null;
  const [a = 0, b = 0] = ip.split('.').map(Number);
  if (a === 10 || a === 127 || a === 0 || a >= 224) return null;
  if (a === 172 && b >= 16 && b <= 31) return null;
  if (a === 192 && b === 168) return null;
  if (a === 169 && b === 254) return null;
  if (a === 100 && b >= 64 && b <= 127) return null;
  return ip;
}

/** The site's name from its domain: the first label, as a project / repository / application name. */
export function siteSlug(domain: string): string {
  const first = domain.split('.')[0] ?? '';
  return first
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

/** The Cloudflare zone a domain belongs to (the longest zone that is the domain or a parent of it). */
export function zoneOf<Z extends { readonly name: string }>(domain: string, zones: readonly Z[]): Z | null {
  let best: Z | null = null;
  for (const z of zones) {
    const n = z.name.toLowerCase().replace(/\.$/, '');
    if ((domain === n || domain.endsWith(`.${n}`)) && (best === null || n.length > best.name.length))
      best = z;
  }
  return best;
}

/** The Coolify GitHub App that can read a repository of `owner` (its organization, else the only private one). */
export function githubAppFor<
  A extends { readonly uuid: string; readonly organization: string | null; readonly isPublic: boolean },
>(owner: string, apps: readonly A[]): A | null {
  const org = apps.filter((a) => !a.isPublic && a.organization?.toLowerCase() === owner.toLowerCase());
  if (org.length === 1) return org[0] ?? null;
  const priv = apps.filter((a) => !a.isPublic);
  return priv.length === 1 ? (priv[0] ?? null) : null;
}

export interface ChatSiteCoolifyDeps {
  readonly db: Queryable;
  readonly clock: () => Date;
  readonly chatUploads: () => ChatSiteUploads | null;
  readonly siteUploads: () => SiteUploadService | null;
  readonly projects: () => ChatProjectCreate | null;
  readonly repos: () => ChatGitHubRepo | null;
  readonly gitConfig: () => ((project: string) => Promise<ProjectGitConfig | null>) | null;
  readonly providers: () => ProviderFactory | null;
  readonly coolify: () => ChatCoolify | null;
  readonly coolifyApps: () => CoolifyAppService | null;
  readonly ops: () => OpsService | null;
  readonly watches: () => ChatWatchService | null;
}

/** One step of the publish, as the result lists it. */
interface Step {
  readonly step: 'project' | 'repository' | 'files' | 'coolify_project' | 'application' | 'dns' | 'watch';
  readonly ok: boolean;
  readonly detail: Record<string, unknown>;
}

export class ChatSiteCoolify {
  constructor(private readonly deps: ChatSiteCoolifyDeps) {}

  /** The card of a publish_site_coolify call, or a refusal saying what to fix. `propose`: a new project waits. */
  async plan(
    subject: Subject,
    i: Record<string, unknown>,
  ): Promise<DraftPlan & { readonly propose?: boolean }> {
    const uploads = this.deps.chatUploads();
    const projects = this.deps.projects();
    if (
      uploads === null ||
      projects === null ||
      this.deps.coolifyApps() === null ||
      this.deps.repos() === null
    )
      return fail('unavailable', 'Publishing on Coolify is not available on this master.');
    const up = await uploads.planPublish(subject, { uploadId: i.uploadId });
    if (!up.ok) return up;
    const domain = (str(i.domain) ?? '')
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/\.$/, '');
    if (!HOST.test(domain)) return fail('invalid', 'domain: a host name like site.example.com (no path).');
    const zones = await projects.zoneList(subject);
    if (zones === null || zones.length === 0)
      return fail(
        'unavailable',
        'No DNS integration (Cloudflare) is connected, so the domain cannot be pointed.',
      );
    const zone = zoneOf(domain, zones);
    if (zone === null)
      return fail(
        'not_found',
        `${domain} is not in a Cloudflare zone the DNS integration sees. Zones: ${zones
          .slice(0, 20)
          .map((z) => z.name)
          .join(', ')}.`,
      );
    if (domain === zone.name.toLowerCase())
      return fail('invalid', 'Publish under a subdomain (name.zone), not the zone apex itself.');
    const name = (str(i.name) ?? siteSlug(domain)).toLowerCase();
    if (!SLUG.test(name))
      return fail(
        'invalid',
        'name: lowercase letters, digits and hyphens (the project, repository and app name).',
      );
    // The repository project: an existing one the user names, else a new one with the site's name.
    const existing = str(i.project);
    let project: string;
    let newProject: boolean;
    if (existing !== undefined) {
      const { rows } = await this.deps.db.query<{ kind: string }>('SELECT kind FROM projects WHERE id = $1', [
        existing,
      ]);
      if (rows[0] === undefined || !authorize(subject, 'projects.read', { project: existing }).allow)
        return fail('not_found', `Project ${existing} not found.`);
      if (rows[0].kind !== 'repository')
        return fail(
          'invalid',
          `${existing} is a workspace project; leave project out to open a new one for the site.`,
        );
      if (!authorize(subject, 'deploy.coolify.manage', { project: existing }).allow)
        return fail('forbidden', `create Coolify applications in project ${existing} (project admin)`);
      const { rowCount } = await this.deps.db.query('SELECT 1 FROM project_git_configs WHERE project = $1', [
        existing,
      ]);
      if ((rowCount ?? 0) > 0)
        return fail(
          'invalid',
          `${existing} already has a repository; publish this site as its own project (leave project out), or put the files into that repository with a job.`,
        );
      project = existing;
      newProject = false;
    } else {
      if (!authorize(subject, 'projects.create').allow)
        return fail('forbidden', 'create the project for the site (owners and administrators)');
      const { rowCount } = await this.deps.db.query('SELECT 1 FROM projects WHERE id = $1', [name]);
      if ((rowCount ?? 0) > 0)
        return fail(
          'invalid',
          `A project named ${name} exists already: pass project: "${name}" to use it (when it has no repository yet) or another name.`,
        );
      project = name;
      newProject = true;
    }
    if (!authorize(subject, 'integrations.github.write').allow)
      return fail('forbidden', 'open the GitHub repository for the site (administrators)');
    // The repository name must be free (a repository of that name is never overwritten).
    const repoCheck = await this.deps.repos()?.plan(subject, { name, private: i.private !== false });
    if (repoCheck === undefined || !repoCheck.ok)
      return repoCheck ?? fail('unavailable', 'GitHub is not available.');
    if (repoCheck.payload.op !== 'create_repository' || repoCheck.describe.linkOnly === true)
      return fail(
        'invalid',
        `A GitHub repository named ${name} exists already; choose another name (name: …) — an existing repository is never overwritten.`,
      );
    const owner = typeof repoCheck.describe.owner === 'string' ? repoCheck.describe.owner : '';
    const proxied = i.proxied !== false;
    const facts = up.facts;
    return {
      ok: true,
      title: `Publish ${facts.label ?? 'site'} on Coolify at ${domain}`.slice(0, 200),
      project: newProject ? null : project,
      ...(newProject ? { propose: true } : {}),
      payload: {
        op: 'publish_site',
        uploadId: facts.id,
        uploadProject: up.project,
        domain,
        zone: { id: zone.id, name: zone.name },
        name,
        project,
        newProject,
        repository: { owner, name, private: i.private !== false },
        proxied,
        idempotencyKey: createHash('sha256')
          .update(`${facts.id}\n${domain}\n${name}`)
          .digest('hex')
          .slice(0, 40),
      },
      describe: {
        site: facts.label ?? facts.id,
        files: facts.fileCount,
        sizeBytes: facts.totalBytes,
        url: `https://${domain}`,
        project: newProject ? `${project} (new)` : project,
        repository: `${owner}/${name} (${i.private === false ? 'public' : 'private'}, new)`,
        coolify: 'a static application with the domain, production, first deploy',
        dns: `A ${domain} → the Coolify server (Cloudflare proxy ${proxied ? 'on' : 'off'})`,
        steps: [
          ...(newProject ? ['project'] : []),
          'repository',
          'files (one commit)',
          'Coolify project (when missing)',
          'application + deploy',
          'DNS',
        ],
        note: newProject
          ? 'A new project is created only when the user confirms this card.'
          : 'Runs the steps in order; what ran is listed on the result.',
      },
    };
  }

  /** Runs a confirmed `publish_site` card: every step with its own checks, in order; stops at the first failure. */
  async run(ctx: ConfirmContext, d: DraftRecord): Promise<Record<string, unknown>> {
    const p = d.payload;
    const domain = String(p.domain);
    const project = String(p.project);
    const name = String(p.name);
    const zone = p.zone as { id: string; name: string };
    const repo = p.repository as { owner: string; name: string; private: boolean };
    const steps: Step[] = [];
    const done = (step: Step['step'], detail: Record<string, unknown>): void => {
      steps.push({ step, ok: true, detail });
    };
    const sub = (
      kind: DraftRecord['kind'],
      payload: Record<string, unknown>,
      proj: string | null,
    ): DraftRecord => ({ ...d, kind, payload, project: proj });
    const finish = (
      stoppedAt: Step['step'] | null,
      error: string | null,
      extra: Record<string, unknown> = {},
    ) => ({
      op: 'publish_site',
      url: `https://${domain}`,
      project,
      steps,
      ...(stoppedAt === null ? {} : { stoppedAt, error }),
      ...extra,
      link: `/projects/${encodeURIComponent(project)}?tab=deploy`,
    });
    const why = (err: unknown): string =>
      (err instanceof HttpError ? err.publicMessage : err instanceof Error ? err.message : 'failed').slice(
        0,
        500,
      );

    // 1. The project (a new one only from this confirmed card), with the domain's zone allowed for DNS.
    if (p.newProject === true) {
      const projects = this.deps.projects();
      if (projects === null) return finish('project', 'Projects cannot be created here.');
      try {
        const out = await projects.run(
          ctx,
          sub(
            'project_create',
            {
              op: 'project_create',
              project: { id: project, name, kind: 'repository' },
              description: `Static site ${domain}`,
              repository: null,
              dnsZone: zone,
            },
            null,
          ),
        );
        done('project', { project, dnsZone: out.dnsZone ?? null, warnings: out.warnings ?? [] });
      } catch (err) {
        return finish('project', why(err));
      }
    }

    // 2. The private repository, linked to the project.
    const repos = this.deps.repos();
    if (repos === null) return finish('repository', 'GitHub is not available.');
    try {
      const plan = await repos.plan(ctx.subject, {
        name: repo.name,
        owner: repo.owner,
        private: repo.private,
        autoInit: true,
        project,
      });
      if (!plan.ok) return finish('repository', plan.message);
      if (plan.describe.linkOnly === true)
        return finish('repository', `A repository named ${repo.owner}/${repo.name} exists already.`);
      const out = await repos.run(
        ctx,
        sub(
          'github_repo',
          {
            ...plan.payload,
            request: {
              ...(plan.payload.request as object),
              idempotencyKey: `site-${String(p.idempotencyKey)}`,
            },
          },
          project,
        ),
      );
      if (out.linked !== true)
        return finish('repository', 'The repository was created but could not be linked to the project.');
      done('repository', { fullName: out.fullName, htmlUrl: out.htmlUrl, defaultBranch: out.defaultBranch });
    } catch (err) {
      return finish('repository', why(err));
    }

    // 3. The upload's files as one commit on the base branch.
    let commit: string;
    try {
      const uploads = this.deps.siteUploads();
      const gitConfig = this.deps.gitConfig();
      const providers = this.deps.providers();
      if (uploads === null || gitConfig === null || providers === null)
        return finish('files', 'Not available.');
      if (!authorize(ctx.subject, 'deploy.read', { project: String(p.uploadProject) }).allow)
        return finish('files', 'The site upload is not readable for the confirming user.');
      const got = await uploads.deployFiles(String(p.uploadProject), String(p.uploadId));
      if (got === null)
        return finish('files', 'The site upload is gone or incomplete; drop the .zip into the chat again.');
      const config = await gitConfig(project);
      if (config === null) return finish('files', 'The project has no repository linked.');
      const provider = providers(config);
      if (provider.commitFiles === undefined || provider.updateBranch === undefined)
        return finish('files', 'This repository provider cannot receive files from Remyral.');
      const base = config.baseBranch;
      const parent = await provider.branchHead(base);
      commit = await provider.commitFiles({
        parent,
        files: got.files.map((f) => ({ path: f.path, content: f.content })),
        message: `Site ${domain} (${String(got.files.length)} files from the chat)`,
      });
      const moved = await provider.updateBranch(base, commit, parent);
      if (moved !== 'updated') return finish('files', 'The base branch moved meanwhile; try again.');
      done('files', { branch: base, commit, files: got.files.length });
    } catch (err) {
      return finish('files', why(err));
    }

    // 4. The Coolify project named like the project (created when missing), and the server's public address.
    const coolify = this.deps.coolify();
    const apps = this.deps.coolifyApps();
    if (coolify === null || apps === null) return finish('coolify_project', 'Coolify is not available.');
    let coolifyProject: string;
    let serverIp: string | null;
    let githubApp: string | null;
    try {
      const opts = await apps.options(project, { env: 'production' });
      const servers = (opts.servers ?? []) as { uuid: string; name: string; ip: string | null }[];
      if (servers.length !== 1)
        return finish(
          'coolify_project',
          `Coolify has ${String(servers.length)} servers; create the application with coolify_create_app naming the server.`,
        );
      serverIp = publicIpv4(servers[0]?.ip);
      const apps0 = (opts.githubApps ?? []) as {
        uuid: string;
        name: string;
        organization: string | null;
        isPublic: boolean;
      }[];
      githubApp = repo.private ? (githubAppFor(repo.owner, apps0)?.uuid ?? null) : null;
      if (repo.private && githubApp === null)
        return finish(
          'coolify_project',
          `No single Coolify GitHub App can read ${repo.owner}'s repositories (${apps0.map((a) => a.name).join(', ') || 'none'}); create the application with coolify_create_app naming githubApp.`,
        );
      const named = ((opts.projects ?? []) as { uuid: string; name: string }[]).filter(
        (x) => x.name.toLowerCase() === project.toLowerCase(),
      );
      if (named.length === 1 && named[0] !== undefined) {
        coolifyProject = named[0].uuid;
        done('coolify_project', { name: project, uuid: coolifyProject, created: false });
      } else {
        const plan = await coolify.plan(ctx.subject, 'coolify_infra', {
          op: 'project_create',
          name: project,
        });
        if (!plan.ok) return finish('coolify_project', plan.message);
        const out = await coolify.run(ctx, sub('coolify_change', plan.payload, plan.project));
        if (typeof out.uuid !== 'string')
          return finish('coolify_project', 'Coolify did not return the new project.');
        coolifyProject = out.uuid;
        done('coolify_project', { name: project, uuid: coolifyProject, created: true });
      }
    } catch (err) {
      return finish('coolify_project', why(err instanceof OpsError ? new Error(err.message) : err));
    }

    // 5. The application with the domain, linked to the project's production target, and its first deploy.
    let deployActionId: string | null;
    try {
      const plan = await coolify.plan(
        ctx.subject,
        'coolify_create_app',
        {
          project,
          env: 'production',
          coolifyProject,
          name: project,
          source: repo.private
            ? { type: 'repository', access: 'github_app', githubApp }
            : { type: 'repository', access: 'public' },
          domains: [`https://${domain}`],
          deploy: true,
        },
        { threadId: d.threadId, turnId: null } as never,
      );
      if (!plan.ok) return finish('application', plan.message);
      const out = await coolify.run(ctx, sub('coolify_change', plan.payload, project));
      const result = (out.result ?? {}) as Record<string, unknown>;
      deployActionId = typeof result.deployActionId === 'string' ? result.deployActionId : null;
      if (typeof out.error === 'string') return finish('application', out.error);
      done('application', {
        appUuid: out.appUuid,
        name: out.name,
        state: out.state,
        deployActionId,
        deployState: result.deployState ?? null,
      });
    } catch (err) {
      return finish('application', why(err instanceof OpsError ? new Error(err.message) : err));
    }

    // 6. The DNS record (the project's deploy policy decides; it may wait for an approval).
    const ops = this.deps.ops();
    if (ops === null) return finish('dns', 'Deploy integrations are not available.', { deployActionId });
    if (serverIp === null)
      return finish(
        'dns',
        'The Coolify server has no public IPv4 address in Coolify; point the DNS with draft_dns_change (A record to the server address).',
        { deployActionId },
      );
    let dnsActionId: string;
    try {
      const params = {
        zone: zone.name,
        type: 'A',
        name: domain,
        content: serverIp,
        ttl: 1,
        proxied: p.proxied !== false,
      };
      const preview = await ops.preview(project, 'dns.upsert', params);
      const out = await ops.request(
        {
          type: 'user',
          id: ctx.subject.userId,
          mfaAt: ctx.human.mfaAt,
          ...(ctx.human.stepUpMaxAgeMs === undefined ? {} : { stepUpMaxAgeMs: ctx.human.stepUpMaxAgeMs }),
          ip: ctx.actor.ip,
          userAgent: ctx.actor.userAgent,
        },
        {
          project,
          kind: 'dns.upsert',
          params: preview.params,
          idempotencyKey: `site-dns-${String(p.idempotencyKey)}`,
        } as never,
        'chat',
        {},
      );
      dnsActionId = out.action.id;
      done('dns', {
        record: `A ${domain} → ${serverIp}`,
        proxied: p.proxied !== false,
        actionId: out.action.id,
        state: out.action.state,
        policy: out.action.policy.decision,
      });
    } catch (err) {
      return finish('dns', why(err instanceof OpsError ? new Error(err.message) : err), { deployActionId });
    }

    // 7. A watch on the deploy: when it ends, the assistant checks the site and tells the user.
    const watches = this.deps.watches();
    if (watches !== null && deployActionId !== null) {
      try {
        const w = await watches.create(
          {
            userId: ctx.subject.userId,
            subject: ctx.subject,
            threadId: d.threadId,
            turnId: null,
            nextStepConsentAt: this.deps.clock(),
          },
          {
            target: 'ops_action',
            id: deployActionId,
            nextStep: `Check that https://${domain} answers (deploy_status / coolify_deploy_logs when it failed) and tell the user the live link in one short message.`,
          },
        );
        done('watch', { watchId: w.watch.id, on: 'the deploy ends' });
      } catch {
        // The deploy announces itself in the console either way.
      }
    }
    return finish(null, null, { deployActionId, dnsActionId, commit });
  }
}
