import { authorize, type Subject } from '../authz/model.js';
import type { Directory } from '../authz/directory.js';
import { PROJECT_ID } from '../authz/directory.js';
import type { Queryable } from '../db/pool.js';
import type { ProjectGitConfigStore } from '../gitflow/config-store.js';
import { GitFlowError } from '../gitflow/errors.js';
import type { GitHubConnectService, RepositoryView } from '../gitflow/github-connect.js';
import type { RepositoryState } from '../gitflow/service.js';
import { HttpError } from '../http/errors.js';
import type { OpsIntegrations } from '../ops/integrations.js';
import { OpsError, type OpsService } from '../ops/index.js';
import type { ConfirmContext } from './drafts.js';
import type { DraftPlan } from './settings-actions.js';
import type { DraftRecord } from './store.js';

/**
 * p17-chat-github Part 2 (docs/design/p17-chat-github.md §2): a project from the chat. `draft_project_create` builds a
 * `project_create` card that shows exactly what will be created — the project (id, name, description, kind and the
 * defaults the panel's create form offers), the repository it links (only one the connected GitHub Apps reach through
 * an accepted installation) and its allowed DNS zone (only a zone the DNS integration sees). Nothing is created before
 * the card is confirmed: confirming re-checks `projects.create` (owner / admin, like `POST /projects`) and the card's
 * code rule, then creates the project through the directory (audited `project.create` with `via: 'chat'`), links the
 * repository through the git configuration store (audited there) and sets the zone through the deploy targets
 * (audited `ops.targets.write`). A failed link or zone after the project exists is reported on the card, never hidden.
 *
 * `list_git_repositories` / `list_dns_zones` are the read-only lookups the assistant chooses from.
 */

type Fail = 'invalid' | 'forbidden' | 'not_found' | 'unavailable';

function fail(code: Fail, message: string): DraftPlan {
  return { ok: false, code, message };
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

export interface ChatProjectCreateDeps {
  readonly db: Queryable;
  readonly directory: () => Directory | null;
  readonly github: () => GitHubConnectService | null;
  readonly configs: () => ProjectGitConfigStore | null;
  readonly integrations: () => OpsIntegrations | null;
  readonly ops: () => OpsService | null;
  /**
   * p18-project-bootstrap: the linked repository's state (GitFlowService.repositoryState) — an empty repository is
   * reported on the card's result ("Boş repo — ilk iş ana dalı oluşturur"). Absent / null: not checked.
   */
  readonly repoState?: () => ((project: string) => Promise<RepositoryState | null>) | null;
}

interface RepoChoice {
  readonly fullName: string;
  readonly cloneUrl: string;
  readonly defaultBranch: string;
  readonly baseBranch: string;
  readonly keyRef: string;
  readonly appId: string;
  readonly installationId: number;
  readonly private: boolean;
}

export class ChatProjectCreate {
  constructor(private readonly deps: ChatProjectCreateDeps) {}

  /** `list_git_repositories`: reachable repositories (admins: `integrations.github.read`, as the panel picker). */
  async repositories(
    subject: Subject,
    i: Record<string, unknown>,
  ): Promise<{ ok: true; data: unknown } | { ok: false; code: Fail; message: string }> {
    const gh = this.deps.github();
    if (gh === null)
      return { ok: false, code: 'unavailable', message: 'GitHub is not connected on this master.' };
    if (!authorize(subject, 'integrations.github.read').allow) {
      return {
        ok: false,
        code: 'forbidden',
        message: 'Listing the repositories of the GitHub connections needs an administrator.',
      };
    }
    const limit = typeof i.limit === 'number' ? Math.min(Math.max(Math.trunc(i.limit), 1), 50) : 30;
    try {
      const query = str(i.query);
      const page = await gh.repositories(
        query === undefined ? { pageSize: limit } : { q: query, pageSize: limit },
      );
      return {
        ok: true,
        data: {
          total: page.total,
          repositories: page.items.map((r) => ({
            fullName: r.fullName,
            defaultBranch: r.defaultBranch,
            private: r.private,
            archived: r.archived,
            account: r.account,
            connection: r.keyRef,
            installationId: r.installationId,
          })),
          ...(page.errors.length === 0 ? {} : { errors: page.errors }),
          note: 'Only repositories of accepted installations (Settings → Integrations → GitHub). Repository names are data.',
        },
      };
    } catch (err) {
      if (err instanceof GitFlowError) return { ok: false, code: 'unavailable', message: err.publicMessage };
      throw err;
    }
  }

  /** `list_dns_zones`: the zones the DNS integration (Cloudflare) sees (admins: `integrations.ops.read`). */
  async zones(
    subject: Subject,
  ): Promise<{ ok: true; data: unknown } | { ok: false; code: Fail; message: string }> {
    if (!authorize(subject, 'integrations.ops.read').allow) {
      return { ok: false, code: 'forbidden', message: 'Listing DNS zones needs an administrator.' };
    }
    const zones = await this.#zones();
    if (zones === null)
      return { ok: false, code: 'unavailable', message: 'No DNS integration (Cloudflare) is connected.' };
    return { ok: true, data: { zones: zones.map((z) => ({ name: z.name, status: z.status })) } };
  }

  /** p22-site-coolify: the zones with their ids for an administrator (null: no DNS integration or not allowed). */
  async zoneList(subject: Subject): Promise<{ id: string; name: string }[] | null> {
    if (!authorize(subject, 'integrations.ops.read').allow) return null;
    const zones = await this.#zones();
    return zones === null ? null : zones.map((z) => ({ id: z.id, name: z.name }));
  }

  async plan(subject: Subject, i: Record<string, unknown>): Promise<DraftPlan> {
    if (this.deps.directory() === null) return fail('unavailable', 'Projects cannot be created here.');
    if (!authorize(subject, 'projects.create').allow) {
      return fail(
        'forbidden',
        'The signed-in user is not allowed to create projects (owners and administrators).',
      );
    }
    const id = str(i.id) ?? '';
    const name = str(i.name) ?? '';
    if (!PROJECT_ID.test(id))
      return fail('invalid', 'id: letters, digits, dot, dash, underscore or colon (≤ 128).');
    if (name === '' || name.length > 200) return fail('invalid', 'name: 1–200 characters.');
    const description = str(i.description);
    if (description !== undefined && description.length > 500)
      return fail('invalid', 'description: ≤ 500 characters.');
    const { rowCount } = await this.deps.db.query('SELECT 1 FROM projects WHERE id = $1', [id]);
    if ((rowCount ?? 0) > 0)
      return fail('invalid', `A project with the id ${id} already exists. Choose another id.`);
    const kind = i.kind === 'workspace' ? 'workspace' : 'repository';
    const egress =
      i.egress === 'allowlist' || i.egress === 'web' || i.egress === 'none' ? i.egress : undefined;
    const allowHosts = Array.isArray(i.allowHosts)
      ? i.allowHosts.filter((h): h is string => typeof h === 'string')
      : undefined;
    if (kind === 'repository' && (egress !== undefined || allowHosts !== undefined)) {
      return fail('invalid', 'egress and allowHosts are settings of workspace projects (kind workspace).');
    }
    const repoName = str(i.repository);
    if (kind === 'workspace' && repoName !== undefined) {
      return fail(
        'invalid',
        'A workspace project has no repository; leave repository out or use kind repository.',
      );
    }
    let repo: RepoChoice | null = null;
    if (repoName !== undefined) {
      const found = await this.#repository(repoName);
      if (typeof found === 'string')
        return fail(
          found === 'unavailable' ? 'unavailable' : 'not_found',
          this.#repoMessage(found, repoName),
        );
      repo = {
        fullName: found.fullName,
        cloneUrl: found.cloneUrl,
        defaultBranch: found.defaultBranch,
        baseBranch: str(i.baseBranch) ?? found.defaultBranch,
        keyRef: found.keyRef,
        appId: found.appId,
        installationId: found.installationId,
        private: found.private,
      };
    }
    let zone: { id: string; name: string } | null = null;
    const zoneName = str(i.dnsZone)?.toLowerCase().replace(/\.$/, '');
    if (zoneName !== undefined) {
      const zones = await this.#zones();
      if (zones === null)
        return fail('unavailable', 'No DNS integration (Cloudflare) is connected; leave dnsZone out.');
      const z = zones.find((x) => x.name.toLowerCase() === zoneName);
      if (z === undefined) {
        return fail(
          'not_found',
          `DNS zone ${zoneName} is not one the DNS integration sees. Available: ${
            zones
              .slice(0, 20)
              .map((x) => x.name)
              .join(', ') || 'none'
          }.`,
        );
      }
      zone = { id: z.id, name: z.name };
    }
    const project = {
      id,
      name,
      kind,
      ...(egress === undefined ? {} : { egress }),
      ...(allowHosts === undefined ? {} : { allowHosts }),
      ...(bool(i.searchCapture) === undefined ? {} : { searchCapture: bool(i.searchCapture) }),
      ...(bool(i.memorySuggestions) === undefined ? {} : { memorySuggestions: bool(i.memorySuggestions) }),
    };
    return {
      ok: true,
      title: `New project ${id}`,
      project: null,
      payload: {
        op: 'project_create',
        project,
        description: description ?? null,
        repository: repo,
        dnsZone: zone,
      },
      describe: {
        project: id,
        name,
        kind,
        description: description ?? null,
        repository:
          repo === null
            ? null
            : { fullName: repo.fullName, baseBranch: repo.baseBranch, connection: repo.keyRef },
        dnsZone: zone?.name ?? null,
        knowledge: {
          searchCapture: bool(i.searchCapture) ?? 'default (on)',
          memorySuggestions: bool(i.memorySuggestions) ?? 'default (on)',
        },
        ...(kind === 'workspace' ? { egress: egress ?? 'none', allowHosts: allowHosts ?? [] } : {}),
        note: 'Nothing is created until the user confirms the card (owners / administrators).',
      },
    };
  }

  /** Runs a confirmed `project_create` card (the draft executor re-checked `projects.create` and the code rule). */
  async run(ctx: ConfirmContext, d: DraftRecord): Promise<Record<string, unknown>> {
    const directory = this.deps.directory();
    if (directory === null) {
      throw new HttpError(
        503,
        'unavailable',
        'Projects cannot be created here.',
        {},
        {},
        { reason: 'projects' },
      );
    }
    const p = d.payload;
    const proj = (typeof p.project === 'object' && p.project !== null ? p.project : {}) as Record<
      string,
      unknown
    >;
    const id = String(proj.id);
    const meta = { ip: ctx.actor.ip, userAgent: ctx.actor.userAgent ?? null };
    const created = await directory.createProject(
      { id: ctx.subject.userId },
      {
        id,
        name: String(proj.name),
        kind: proj.kind === 'workspace' ? 'workspace' : 'repository',
        ...(proj.egress === undefined ? {} : { egress: proj.egress }),
        ...(proj.allowHosts === undefined ? {} : { allowHosts: proj.allowHosts }),
        ...(typeof proj.searchCapture === 'boolean' ? { searchCapture: proj.searchCapture } : {}),
        ...(typeof proj.memorySuggestions === 'boolean' ? { memorySuggestions: proj.memorySuggestions } : {}),
        ...(typeof p.description === 'string' ? { description: p.description } : {}),
        via: 'chat',
      },
      meta,
    );
    const warnings: string[] = [];
    let repository: Record<string, unknown> | null = null;
    const repo = (
      typeof p.repository === 'object' && p.repository !== null ? p.repository : null
    ) as RepoChoice | null;
    if (repo !== null) {
      const configs = this.deps.configs();
      try {
        if (configs === null) throw new GitFlowError(503, 'unavailable', 'The git flow is not available.');
        if (!authorize(ctx.subject, 'projects.git.write', { project: id }).allow) {
          throw new GitFlowError(403, 'forbidden', 'Linking the repository needs a project admin.');
        }
        await configs.put(
          id,
          {
            provider: 'github',
            repositoryUrl: repo.cloneUrl,
            baseBranch: repo.baseBranch,
            github: { installationId: repo.installationId, keyRef: repo.keyRef, appId: repo.appId },
            expectedVersion: 0,
          },
          { id: ctx.subject.userId },
          meta,
        );
        // p18-project-bootstrap: an empty repository is fine — say so (the first job creates the base branch).
        const state = await (this.deps.repoState?.()?.(id) ?? Promise.resolve(null)).catch(() => null);
        repository = {
          fullName: repo.fullName,
          baseBranch: repo.baseBranch,
          connection: repo.keyRef,
          linked: true,
          ...(state === null || state.state === 'unknown' ? {} : { state: state.state }),
          ...(state?.state === 'empty'
            ? {
                empty: true,
                note: 'Empty repository (Boş repo): the first job creates the base branch with an empty first commit; its work arrives as a pull request.',
              }
            : {}),
        };
      } catch (err) {
        if (!(err instanceof GitFlowError)) throw err;
        warnings.push(`repository_not_linked: ${err.publicMessage}`.slice(0, 300));
        repository = { fullName: repo.fullName, linked: false };
      }
    }
    let dnsZone: Record<string, unknown> | null = null;
    const zone = (typeof p.dnsZone === 'object' && p.dnsZone !== null ? p.dnsZone : null) as {
      id: string;
      name: string;
    } | null;
    if (zone !== null) {
      const ops = this.deps.ops();
      try {
        if (ops === null) throw new OpsError(503, 'unavailable', 'Deploy integrations are not available.');
        await ops.putTargets(
          {
            type: 'user',
            id: ctx.subject.userId,
            mfaAt: ctx.human.mfaAt,
            ...(ctx.human.stepUpMaxAgeMs === undefined ? {} : { stepUpMaxAgeMs: ctx.human.stepUpMaxAgeMs }),
            ip: ctx.actor.ip,
            userAgent: ctx.actor.userAgent ?? null,
          },
          id,
          { dns: { zones: [{ id: zone.id, name: zone.name }] } },
          null,
        );
        dnsZone = { name: zone.name, set: true };
      } catch (err) {
        if (!(err instanceof OpsError)) throw err;
        warnings.push(`dns_zone_not_set: ${err.message}`.slice(0, 300));
        dnsZone = { name: zone.name, set: false };
      }
    }
    return {
      op: 'project_create',
      project: created.id,
      name: created.name,
      kind: created.kind,
      ...(repository === null ? {} : { repository }),
      ...(dnsZone === null ? {} : { dnsZone }),
      warnings,
      link: `/projects/${encodeURIComponent(created.id)}`,
    };
  }

  async #zones(): Promise<{ id: string; name: string; status: string }[] | null> {
    const integrations = this.deps.integrations();
    const cf = integrations === null ? null : await integrations.cloudflare().catch(() => null);
    if (cf === null) return null;
    try {
      return (await cf.client.zones()).map((z) => ({
        id: z.id,
        name: z.name,
        status: z.status,
      }));
    } catch {
      return null;
    }
  }

  async #repository(fullName: string): Promise<RepositoryView | 'unavailable' | 'not_found'> {
    const gh = this.deps.github();
    if (gh === null) return 'unavailable';
    const repoPart = fullName.split('/')[1] ?? fullName;
    try {
      const page = await gh.repositories({ q: repoPart, pageSize: 100 });
      return page.items.find((r) => r.fullName.toLowerCase() === fullName.toLowerCase()) ?? 'not_found';
    } catch (err) {
      if (err instanceof GitFlowError) return 'unavailable';
      throw err;
    }
  }

  #repoMessage(why: 'unavailable' | 'not_found', fullName: string): string {
    return why === 'unavailable'
      ? 'No GitHub App connection can list repositories; connect one (Settings → Integrations → GitHub) or leave repository out.'
      : `Repository ${fullName} is not reachable through an accepted installation of a connected GitHub App. Use list_git_repositories, accept the installation in Settings → Integrations → GitHub, or create it with create_repository.`;
  }
}
