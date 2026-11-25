import type { GitHostConnectionView } from '@remyral/protocol';
import { authorize, type Subject } from '../authz/model.js';
import type { ProjectGitConfigStore } from '../gitflow/config-store.js';
import { GitFlowError } from '../gitflow/errors.js';
import type { GitHostService } from '../gitflow/git-hosts.js';
import { HttpError } from '../http/errors.js';
import type { ConfirmContext } from './drafts.js';
import type { DraftPlan } from './settings-actions.js';
import type { DraftRecord } from './store.js';

/**
 * p16-git-providers (docs/design/p16-git-providers.md §7): `create_repository` with `provider: gitlab | bitbucket`. The
 * master picks the connection (the only one of that kind, or the one the user named), refuses tokens that cannot
 * create repositories (GitLab project tokens, Bitbucket repository tokens) before a card exists, and the confirmed
 * card (`github_repo`, op `create_hosted_repository`) opens a private repository with the connection's token and links
 * it to the project (`integrations.githosts.write`, plus `projects.git.write` for the link — re-checked at confirm).
 */

function fail(code: 'invalid' | 'forbidden' | 'not_found' | 'unavailable', message: string): DraftPlan {
  return { ok: false, code, message };
}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

export class ChatHostRepo {
  constructor(
    private readonly deps: {
      readonly hosts: () => GitHostService | null;
      readonly configs: () => ProjectGitConfigStore | null;
    },
  ) {}

  async plan(subject: Subject, i: Record<string, unknown>): Promise<DraftPlan> {
    const hosts = this.deps.hosts();
    const kind = i.provider === 'bitbucket' ? 'bitbucket' : 'gitlab';
    const label = kind === 'gitlab' ? 'GitLab' : 'Bitbucket';
    if (hosts === null) return fail('unavailable', `${label} is not available on this master.`);
    if (!authorize(subject, 'integrations.githosts.write').allow) {
      return fail(
        'forbidden',
        `The signed-in user may not open ${label} repositories (administrators only).`,
      );
    }
    const project = str(i.project);
    if (project !== undefined) {
      const d = authorize(subject, 'projects.git.write', { project });
      if (!d.allow) {
        return d.reason === 'not_visible'
          ? fail('not_found', `Project ${project} not found.`)
          : fail(
              'forbidden',
              `The signed-in user may not change the repository of project ${project} (project admin).`,
            );
      }
      const current = await this.deps.configs()?.get(project);
      if (current !== null && current !== undefined && i.replaceLink !== true) {
        return fail(
          'invalid',
          `Project ${project} already uses ${current.repositoryUrl}; pass replaceLink: true only when the user wants it switched.`,
        );
      }
    }
    const name = str(i.name) ?? '';
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name.startsWith('.')) {
      return fail(
        'invalid',
        'Repository names use letters, digits, ".", "_" and "-" (ask the user for one).',
      );
    }
    const all = (await hosts.list()).filter((c) => c.kind === kind && c.usable);
    const wanted = str(i.connection);
    const matches =
      wanted === undefined
        ? all
        : all.filter((c) => c.id === wanted || c.label.toLowerCase() === wanted.toLowerCase());
    if (matches.length === 0) {
      return fail(
        'not_found',
        all.length === 0
          ? `No ${label} connection exists: an administrator connects one in Ayarlar → Entegrasyonlar → ${label}.`
          : `No ${label} connection named ${wanted ?? ''}; the connections are: ${all.map((c) => c.label).join(', ')}.`,
      );
    }
    if (matches.length > 1) {
      return fail(
        'invalid',
        `Several ${label} connections exist; ask which one: ${matches.map((c) => c.label).join(', ')}.`,
      );
    }
    const conn = matches[0] as GitHostConnectionView;
    if (
      (kind === 'gitlab' && conn.tokenKind === 'project') ||
      (kind === 'bitbucket' && conn.tokenKind === 'repository')
    ) {
      return fail(
        'invalid',
        `The ${label} connection "${conn.label}" uses a ${conn.tokenKind} token, which cannot create repositories; a ${kind === 'gitlab' ? 'group' : 'workspace or project'} access token can.`,
      );
    }
    const namespace = kind === 'gitlab' ? (str(i.owner) ?? conn.scope) : (conn.scope.split('/')[0] ?? '');
    const description = str(i.description);
    const request = {
      name,
      owner: namespace,
      private: i.private !== false,
      ...(description === undefined ? {} : { description }),
      ...(project === undefined ? {} : { project }),
      ...(i.replaceLink === true ? { replaceLink: true } : {}),
    };
    return {
      ok: true,
      title: `New ${request.private ? 'private' : 'public'} ${label} repository ${namespace === '' ? '' : `${namespace}/`}${name}`,
      project: project ?? null,
      payload: {
        op: 'create_hosted_repository',
        provider: kind,
        connectionId: conn.id,
        connection: conn.label,
        project: project ?? null,
        request,
      },
      describe: {
        provider: kind,
        connection: conn.label,
        owner: namespace,
        name,
        private: request.private,
        project: project ?? null,
      },
    };
  }

  async run(ctx: ConfirmContext, d: DraftRecord): Promise<Record<string, unknown>> {
    const hosts = this.deps.hosts();
    const configs = this.deps.configs();
    if (hosts === null || configs === null) {
      throw new HttpError(
        503,
        'unavailable',
        'GitLab / Bitbucket is not available.',
        {},
        {},
        { reason: 'git_host' },
      );
    }
    if (!authorize(ctx.subject, 'integrations.githosts.write').allow) {
      throw new HttpError(
        403,
        'forbidden',
        'Opening a repository with a GitLab / Bitbucket connection needs an administrator.',
        {},
        {},
        { reason: 'git_host_repo' },
      );
    }
    const p = d.payload;
    const r = (typeof p.request === 'object' && p.request !== null ? p.request : {}) as Record<
      string,
      unknown
    >;
    const project = str(r.project);
    if (project !== undefined && !authorize(ctx.subject, 'projects.git.write', { project }).allow) {
      throw new HttpError(
        403,
        'project_git_forbidden',
        'Linking a repository to this project needs a project admin.',
      );
    }
    const connectionId = str(p.connectionId) ?? '';
    const actor = { userId: ctx.subject.userId, ip: ctx.actor.ip, userAgent: ctx.actor.userAgent };
    const kind = p.provider === 'bitbucket' ? 'bitbucket' : 'gitlab';
    const repo = await hosts.createRepository(actor, connectionId, {
      name: str(r.name) ?? '',
      private: r.private !== false,
      ...(str(r.description) === undefined ? {} : { description: str(r.description) ?? '' }),
      ...(kind === 'gitlab' && str(r.owner) !== undefined ? { namespace: str(r.owner) ?? '' } : {}),
    });
    let linked = false;
    const warnings: string[] = [];
    if (project !== undefined) {
      const current = await configs.get(project);
      if (current !== null && r.replaceLink !== true) {
        warnings.push(`Project ${project} already uses ${current.repositoryUrl}; it was not switched.`);
      } else {
        try {
          await configs.put(
            project,
            {
              expectedVersion: current?.version ?? 0,
              provider: kind,
              repositoryUrl: repo.cloneUrl,
              baseBranch: repo.defaultBranch ?? 'main',
              hostConnectionId: connectionId,
            },
            { id: ctx.subject.userId },
            { ip: ctx.actor.ip, userAgent: ctx.actor.userAgent },
          );
          linked = true;
        } catch (err) {
          if (!(err instanceof GitFlowError)) throw err;
          warnings.push(`The repository was opened but not linked: ${err.publicMessage}`);
        }
      }
    }
    return {
      op: 'create_hosted_repository',
      provider: kind,
      created: repo.created,
      fullName: repo.fullPath,
      htmlUrl: repo.webUrl,
      cloneUrl: repo.cloneUrl,
      defaultBranch: repo.defaultBranch,
      private: repo.private,
      project: project ?? null,
      linked,
      warnings,
      ...(project === undefined ? {} : { link: `/projects/${encodeURIComponent(project)}?tab=repository` }),
    };
  }
}
