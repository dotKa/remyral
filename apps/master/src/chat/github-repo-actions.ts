import { createHash } from 'node:crypto';
import { authorize, type Subject } from '../authz/model.js';
import { GitFlowError } from '../gitflow/errors.js';
import { type CreateRepoInput, type GitHubRepoService, RepoError } from '../gitflow/github-repos.js';
import { repoHttpError } from '../gitflow/github-repo-routes.js';
import type { ChatHostRepo } from './host-repo-actions.js';
import { HttpError } from '../http/errors.js';
import type { ConfirmContext } from './drafts.js';
import type { DraftPlan } from './settings-actions.js';
import type { DraftRecord } from './store.js';

/**
 * p15-github-create-repo (docs/design/p15-github-create-repo.md §6): the assistant's `create_repository`. The master
 * checks the request first — the owner (the only one that can create when left out), the method, the project link and
 * the name: an existing repository is refused with its address (no card), so the assistant offers that repository
 * (`useExisting: true` links it) instead of a duplicate. The card (`github_repo`) holds the validated request; in a
 * turn the user started it runs at once (p15-chat-execute-default) through the draft executor — the user's role
 * re-checked (`integrations.github.write`, plus `projects.git.write` on a linked project), the security policy's code
 * rule of event `integrations.connections`, audited — unless the assistant proposed it.
 */

export interface GitHubRepoCallContext {
  readonly threadId: string;
  readonly turnId: string;
}

function fail(code: 'invalid' | 'forbidden' | 'not_found' | 'unavailable', message: string): DraftPlan {
  return { ok: false, code, message };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/** The same request in the same turn gets the same key (a retried tool call replays instead of creating twice). */
export function repoCreationKey(
  ctx: GitHubRepoCallContext | undefined,
  request: CreateRepoInput,
): string | undefined {
  if (ctx === undefined) return undefined;
  const canon = JSON.stringify(request, Object.keys(request).sort());
  const h = createHash('sha256')
    .update(`${ctx.threadId}\n${ctx.turnId}\n${canon}`)
    .digest('hex')
    .slice(0, 48);
  return `chat-${h}`;
}

export class ChatGitHubRepo {
  constructor(
    private readonly deps: {
      readonly repos: () => GitHubRepoService | null;
      /** p16-git-providers: `provider: gitlab | bitbucket` (absent: GitHub only). */
      readonly hosted?: () => ChatHostRepo | null;
    },
  ) {}

  async plan(subject: Subject, i: Record<string, unknown>, ctx?: GitHubRepoCallContext): Promise<DraftPlan> {
    if (i.provider === 'gitlab' || i.provider === 'bitbucket') {
      const hosted = this.deps.hosted?.() ?? null;
      if (hosted === null) return fail('unavailable', 'GitLab / Bitbucket is not available on this master.');
      return hosted.plan(subject, i);
    }
    const svc = this.deps.repos();
    if (svc === null)
      return fail('unavailable', 'GitHub repository creation is not available on this master.');
    if (!authorize(subject, 'integrations.github.write').allow) {
      return fail(
        'forbidden',
        'The signed-in user is not allowed to open GitHub repositories (administrators only).',
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
    }
    const name = str(i.name) ?? '';
    const template = str(i.gitignoreTemplate);
    const ownerIn = str(i.owner);
    const replaceLink = bool(i.replaceLink);
    const description = str(i.description);
    const request: CreateRepoInput = {
      name,
      ...(ownerIn === undefined ? {} : { owner: ownerIn }),
      ...(description === undefined ? {} : { description }),
      private: bool(i.private) ?? true,
      autoInit: bool(i.autoInit) ?? true,
      ...(template === undefined ? {} : { gitignoreTemplate: template }),
      ...(project === undefined ? {} : { project }),
      ...(replaceLink === true ? { replaceLink: true } : {}),
      ...(bool(i.useExisting) === true ? { useExisting: true } : {}),
    };
    let checked: Awaited<ReturnType<GitHubRepoService['check']>>;
    try {
      checked = await svc.check(request);
    } catch (err) {
      if (err instanceof GitFlowError) {
        return fail(err.httpStatus === 404 ? 'not_found' : 'invalid', err.publicMessage);
      }
      throw err;
    }
    const owner = checked.owner;
    const idempotencyKey = repoCreationKey(ctx, { ...request, owner: owner.login });
    const full = {
      ...request,
      owner: owner.login,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    };
    const linkOnly = checked.exists !== null;
    return {
      ok: true,
      title: linkOnly
        ? `Link ${owner.login}/${name}${project === undefined ? '' : ` to ${project}`}`
        : `New ${request.private === false ? 'public' : 'private'} GitHub repository ${owner.login}/${name}`,
      project: project ?? null,
      payload: {
        op: 'create_repository',
        project: project ?? null,
        request: full,
        // Shown on the card (the request itself is what runs).
        method: owner.method,
        ...(checked.currentLink === null || replaceLink !== true
          ? {}
          : { replacesRepository: checked.currentLink }),
      },
      describe: {
        owner: owner.login,
        ownerType: owner.type,
        name,
        private: request.private !== false,
        method: owner.method,
        autoInit: request.autoInit !== false,
        gitignoreTemplate: template ?? null,
        project: project ?? null,
        ...(checked.currentLink === null ? {} : { replacesRepository: checked.currentLink }),
        ...(linkOnly ? { existing: checked.exists?.htmlUrl, linkOnly: true } : {}),
      },
    };
  }

  /** Runs a confirmed `github_repo` card (the draft executor re-checked the confirming user's role). */
  async run(ctx: ConfirmContext, d: DraftRecord): Promise<Record<string, unknown>> {
    if (d.payload.op === 'create_hosted_repository') {
      const hosted = this.deps.hosted?.() ?? null;
      if (hosted === null) {
        throw new HttpError(
          503,
          'unavailable',
          'GitLab / Bitbucket is not available.',
          {},
          {},
          { reason: 'git_host' },
        );
      }
      return hosted.run(ctx, d);
    }
    const svc = this.deps.repos();
    if (svc === null) {
      throw new HttpError(503, 'unavailable', 'GitHub is not available.', {}, {}, { reason: 'github' });
    }
    const p = d.payload;
    const request = (typeof p.request === 'object' && p.request !== null ? p.request : {}) as CreateRepoInput;
    if (
      request.project !== undefined &&
      !authorize(ctx.subject, 'projects.git.write', { project: request.project }).allow
    ) {
      throw new HttpError(
        403,
        'project_git_forbidden',
        'Linking a repository to this project needs a project admin.',
      );
    }
    try {
      const out = await svc.create(
        { userId: ctx.subject.userId, ip: ctx.actor.ip, userAgent: ctx.actor.userAgent },
        request,
        'chat',
      );
      return {
        op: 'create_repository',
        created: out.created,
        fullName: out.fullName,
        htmlUrl: out.htmlUrl,
        cloneUrl: out.cloneUrl,
        defaultBranch: out.defaultBranch,
        private: out.private,
        project: out.project,
        linked: out.linked,
        warnings: [...out.warnings],
        ...(out.project === null
          ? {}
          : { link: `/projects/${encodeURIComponent(out.project)}?tab=repository` }),
      };
    } catch (err) {
      if (err instanceof RepoError) throw repoHttpError(err);
      if (err instanceof GitFlowError) {
        throw new HttpError(err.httpStatus, err.code, err.publicMessage);
      }
      throw err;
    }
  }
}
