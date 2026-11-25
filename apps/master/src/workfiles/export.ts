import { createHash, randomUUID } from 'node:crypto';
import { scanText } from '@remyral/observability';
import { isWorkfilePath } from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import { authorize } from '../authz/model.js';
import type { Pool } from '../db/pool.js';
import type { ProjectGitConfig } from '../gitflow/config-store.js';
import { GitFlowError } from '../gitflow/errors.js';
import type { CreateRepoResult, GitHubRepoService } from '../gitflow/github-repos.js';
import { RepoError } from '../gitflow/github-repos.js';
import { repoHttpError } from '../gitflow/github-repo-routes.js';
import type { ProviderFactory } from '../gitflow/service.js';
import { ProviderError } from '../gitflow/types.js';
import { HttpError } from '../http/errors.js';
import type { SiteUploadService } from '../site-uploads/service.js';
import type { WorkfilesActor, WorkfilesService } from './service.js';

/**
 * p15-workspace-retention §6 "Repoya aktar": a job's kept files go into a repository — acting at once on the user's
 * command (console button or the assistant's `export_workfiles` in a turn the user started):
 *
 * - **branch + pull request** into a project's linked repository: one commit on top of the project's base branch (every
 *   other path unchanged) written with the provider's git data API (GitHub: blobs, tree with `base_tree`, commit — the
 *   master never checks the repository out, AGENTS.md rule 1), pointed to by a new branch `remyral/files-<job8>`
 *   (never an existing one, never forced), and a pull request into the base branch. Merging stays the project's git
 *   flow decision.
 * - **new private repository** (p15-github-create-repo): the repository is opened and linked to the project, then the
 *   files become its first commit on the default branch (a fast-forward of GitHub's README commit).
 * - **site upload** (deploy retry without regenerating): the files below a directory become a ready site upload of the
 *   project (p10-site-upload checks: types, sizes, secret scan), deployable from Deploy like any upload.
 *
 * Every file is scanned on the master before it leaves (vendor tokens, PEM, JWT, high-entropy values next to secret
 * words); one finding refuses the export naming the file, rule and line — never the value. Audited
 * (`workfiles.export`, `workfiles.site_upload`); the run pins the files while it reads them.
 */

export interface ExportInput {
  /** The project whose repository receives the files (a new repository is linked to it). */
  readonly project: string;
  /** Which part of the working directory: `out` (default), another sub-directory, or "" for everything except `in/`. */
  readonly directory?: string | undefined;
  /** Where the files go in the repository (default: its root). */
  readonly targetPath?: string | undefined;
  readonly branch?: string | undefined;
  readonly title?: string | undefined;
  readonly newRepository?:
    | { readonly name: string; readonly owner?: string | undefined; readonly private?: boolean | undefined }
    | undefined;
}

export interface ExportResult {
  readonly id: string;
  readonly mode: 'branch_pr' | 'new_repo';
  readonly project: string;
  readonly branch: string;
  readonly commit: string;
  readonly files: number;
  readonly bytes: number;
  readonly skipped: number;
  readonly pullRequest: { readonly number: number; readonly url: string } | null;
  readonly repository: { readonly fullName: string; readonly htmlUrl: string } | null;
}

export interface SiteUploadFromFilesResult {
  readonly id: string;
  readonly uploadId: string;
  readonly project: string;
  readonly files: number;
  readonly bytes: number;
  readonly skipped: number;
}

export interface WorkfilesExportDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly workfiles: WorkfilesService;
  readonly gitConfig: (project: string) => Promise<ProjectGitConfig | null>;
  readonly providers: ProviderFactory;
  readonly repos?: () => GitHubRepoService | null;
  readonly siteUploads?: () => SiteUploadService | null;
}

type Collected = Awaited<ReturnType<WorkfilesService['collect']>>;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

function normDir(d: string | undefined, fallback: string): string {
  const v = (d ?? fallback).trim().replace(/^\/+|\/+$/g, '');
  if (v !== '' && !isWorkfilePath(v)) {
    throw new HttpError(
      400,
      'invalid_request',
      'Invalid directory: a relative path.',
      {},
      {},
      {
        field: 'directory',
        rule: 'a relative path',
      },
    );
  }
  return v;
}

export class WorkfilesExport {
  constructor(private readonly deps: WorkfilesExportDeps) {}

  async #audit(
    actor: WorkfilesActor,
    action: string,
    jobId: string,
    outcome: 'success' | 'failure' | 'denied',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action,
      target: `job:${jobId}`,
      outcome,
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata,
    });
  }

  async #files(actor: WorkfilesActor, jobId: string, directory: string): Promise<Collected> {
    const c = await this.deps.workfiles.collect(actor.subject, jobId, directory);
    // Without a directory: everything except the inputs (`in/` holds what was given to the job, not its work).
    const files =
      directory === ''
        ? c.files.filter((f) => !f.path.startsWith('in/') && !f.path.startsWith('.git/'))
        : c.files;
    for (const f of files) {
      if (f.path.split('/').includes('.git')) {
        c.done();
        throw new HttpError(422, 'workfiles_refused', 'A .git path cannot be exported.');
      }
      const text = !f.content.includes(0);
      const findings = text
        ? scanText(f.content.toString('utf8'))
        : scanText(f.content.toString('latin1'), { highEntropy: false });
      const hit = findings[0];
      if (hit !== undefined) {
        c.done();
        throw new HttpError(
          422,
          'workfiles_secret_detected',
          `${f.path} looks like it contains a secret (${hit.rule}, line ${String(hit.line)}); nothing was exported.`,
          {},
          {},
          { file: f.path, rule: hit.rule, line: hit.line },
        );
      }
    }
    if (files.length === 0) {
      c.done();
      throw new HttpError(422, 'workfiles_empty', 'There are no files to export in that directory.');
    }
    return { ...c, files };
  }

  /** "Repoya aktar": a branch + pull request in the project's repository, or a new private repository. */
  async toRepository(
    actor: WorkfilesActor,
    jobId: string,
    input: ExportInput,
    via: 'api' | 'chat',
  ): Promise<ExportResult> {
    const project = input.project;
    if (!authorize(actor.subject, 'workfiles.manage', { project }).allow) {
      throw new HttpError(
        403,
        'workfiles_forbidden',
        'You may not push files into this project’s repository.',
        {},
        {},
        { reason: 'push' },
      );
    }
    const directory = normDir(input.directory, 'out');
    const target = normDir(input.targetPath, '');
    if (input.branch !== undefined && (!BRANCH.test(input.branch) || input.branch.includes('..'))) {
      throw new HttpError(
        400,
        'invalid_request',
        'Invalid branch: a branch name.',
        {},
        {},
        {
          field: 'branch',
          rule: 'a branch name',
        },
      );
    }
    let created: CreateRepoResult | null = null;
    if (input.newRepository !== undefined) {
      const repos = this.deps.repos?.() ?? null;
      if (repos === null)
        throw new HttpError(503, 'unavailable', 'GitHub is not available.', {}, {}, { reason: 'github' });
      if (
        !authorize(actor.subject, 'integrations.github.write').allow ||
        !authorize(actor.subject, 'projects.git.write', { project }).allow
      ) {
        throw new HttpError(
          403,
          'workfiles_forbidden',
          'Opening a repository and linking it to a project needs an administrator.',
          {},
          {},
          { reason: 'new_repo' },
        );
      }
      try {
        created = await repos.create(
          { userId: actor.userId, ip: actor.ip ?? null, userAgent: actor.userAgent ?? null },
          {
            name: input.newRepository.name,
            ...(input.newRepository.owner === undefined ? {} : { owner: input.newRepository.owner }),
            private: input.newRepository.private ?? true,
            autoInit: true,
            project,
            idempotencyKey: `workfiles-${createHash('sha256').update(`${jobId}\n${input.newRepository.name}`).digest('hex').slice(0, 40)}`,
          },
          via,
        );
      } catch (err) {
        if (err instanceof RepoError) throw repoHttpError(err);
        if (err instanceof GitFlowError) throw new HttpError(err.httpStatus, err.code, err.publicMessage);
        throw err;
      }
    }
    const config = await this.deps.gitConfig(project);
    if (config === null) {
      throw new HttpError(
        409,
        'workfiles_no_repository',
        'This project has no repository linked; link one (Projeler → Depo) or open a new one.',
      );
    }
    const provider = this.deps.providers(config);
    if (provider.commitFiles === undefined || provider.updateBranch === undefined) {
      throw new HttpError(
        409,
        'workfiles_export_unsupported',
        'This repository provider cannot receive files from Remyral.',
      );
    }
    const id = randomUUID();
    const now = this.deps.clock();
    const mode = created === null ? ('branch_pr' as const) : ('new_repo' as const);
    const view = await this.deps.workfiles.forJob(actor.subject, jobId);
    await this.deps.pool.query(
      `INSERT INTO workfile_exports (id, job_id, attempt_id, target_project, mode, state, directory, via, created_by,
                                     created_at)
       VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, $8, $9)`,
      [id, jobId, view.attemptId, project, mode, directory, via, actor.userId, now],
    );
    const fail = async (err: unknown): Promise<never> => {
      const message =
        err instanceof HttpError ? err.publicMessage : err instanceof Error ? err.message : 'failed';
      await this.deps.pool.query(
        `UPDATE workfile_exports SET state = 'failed', error = $2, finished_at = $3 WHERE id = $1`,
        [id, message.slice(0, 1000), this.deps.clock()],
      );
      await this.#audit(actor, 'workfiles.export', jobId, 'failure', {
        project,
        mode,
        error: message.slice(0, 300),
      });
      if (err instanceof HttpError) throw err;
      if (err instanceof ProviderError) {
        throw new HttpError(
          502,
          'workfiles_export_failed',
          'The repository refused the files.',
          {},
          {},
          { reason: 'refused' },
        );
      }
      throw err;
    };
    let collected: Collected | null = null;
    try {
      collected = await this.#files(actor, jobId, directory);
      const files = collected.files.map((f) => ({
        path: target === '' ? f.path : `${target}/${f.path}`,
        content: f.content,
      }));
      const base = config.baseBranch;
      const parent = await provider.branchHead(base);
      const title = (
        input.title ??
        `Files of job ${jobId.slice(0, 8)}${view.jobTitle === null ? '' : `: ${view.jobTitle}`}`
      ).slice(0, 200);
      const sha = await provider.commitFiles({ parent, files, message: title });
      let branch: string;
      let pullRequest: { number: number; url: string } | null = null;
      if (mode === 'new_repo') {
        branch = base;
        const r = await provider.updateBranch(base, sha, parent);
        if (r !== 'updated')
          throw new HttpError(
            409,
            'workfiles_export_failed',
            'The base branch moved; try again.',
            {},
            {},
            { reason: 'moved' },
          );
      } else {
        branch = await this.#freeBranch(provider, input.branch ?? `remyral/files-${jobId.slice(0, 8)}`);
        const r = await provider.updateBranch(branch, sha, null);
        if (r !== 'updated')
          throw new HttpError(
            409,
            'workfiles_export_failed',
            'That branch exists already.',
            {},
            {},
            { reason: 'exists' },
          );
        pullRequest = await provider.ensurePullRequest({
          headBranch: branch,
          targetBranch: base,
          title,
          body: [
            `Files kept from Remyral job ${jobId} (${view.outcome}, machine ${view.workerName ?? view.workerId}).`,
            '',
            `Directory: ${directory === '' ? '(all except in/)' : directory} → ${target === '' ? '(repository root)' : target}`,
            `${String(files.length)} file(s).`,
          ].join('\n'),
        });
      }
      const bytes = files.reduce((n, f) => n + f.content.length, 0);
      await this.deps.pool.query(
        `UPDATE workfile_exports SET state = 'succeeded', branch = $2, commit_sha = $3, pull_request_number = $4,
                pull_request_url = $5, repository_url = $6, files = $7, bytes = $8, finished_at = $9 WHERE id = $1`,
        [
          id,
          branch,
          sha,
          pullRequest?.number ?? null,
          pullRequest?.url ?? null,
          created?.htmlUrl ?? config.repositoryUrl,
          files.length,
          bytes,
          this.deps.clock(),
        ],
      );
      await this.#audit(actor, 'workfiles.export', jobId, 'success', {
        project,
        mode,
        branch,
        commit: sha,
        files: files.length,
        bytes,
        pullRequest: pullRequest?.number ?? null,
        via,
      });
      return {
        id,
        mode,
        project,
        branch,
        commit: sha,
        files: files.length,
        bytes,
        skipped: collected.skipped.length,
        pullRequest,
        repository: created === null ? null : { fullName: created.fullName, htmlUrl: created.htmlUrl },
      };
    } catch (err) {
      return await fail(err);
    } finally {
      collected?.done();
    }
  }

  async #freeBranch(
    provider: { branchHead(b: string): Promise<string | null> },
    wanted: string,
  ): Promise<string> {
    for (let i = 1; i <= 9; i++) {
      const name = i === 1 ? wanted : `${wanted}-${String(i)}`;
      if ((await provider.branchHead(name)) === null) return name;
    }
    throw new HttpError(
      409,
      'workfiles_export_failed',
      'No free branch name was found.',
      {},
      {},
      { reason: 'names' },
    );
  }

  /** Deploy retry from kept files: the files below `directory` as a ready site upload of the project. */
  async toSiteUpload(
    actor: WorkfilesActor,
    jobId: string,
    input: {
      readonly project: string;
      readonly directory?: string | undefined;
      readonly label?: string | undefined;
    },
  ): Promise<SiteUploadFromFilesResult> {
    const uploads = this.deps.siteUploads?.() ?? null;
    if (uploads === null)
      throw new HttpError(503, 'unavailable', 'Site uploads are not available.', {}, {}, { reason: 'site' });
    if (
      !authorize(actor.subject, 'workfiles.manage', { project: input.project }).allow ||
      !authorize(actor.subject, 'deploy.request', { project: input.project }).allow
    ) {
      throw new HttpError(
        403,
        'workfiles_forbidden',
        'You may not prepare a site of these files in this project.',
        {},
        {},
        { reason: 'site' },
      );
    }
    const directory = normDir(input.directory, 'out');
    const id = randomUUID();
    const view = await this.deps.workfiles.forJob(actor.subject, jobId);
    await this.deps.pool.query(
      `INSERT INTO workfile_exports (id, job_id, attempt_id, target_project, mode, state, directory, via, created_by,
                                     created_at)
       VALUES ($1, $2, $3, $4, 'site_upload', 'running', $5, 'api', $6, $7)`,
      [id, jobId, view.attemptId, input.project, directory, actor.userId, this.deps.clock()],
    );
    const c = await this.deps.workfiles
      .collect(actor.subject, jobId, directory)
      .catch(async (err: unknown) => {
        await this.deps.pool.query(
          `UPDATE workfile_exports SET state = 'failed', finished_at = $2 WHERE id = $1`,
          [id, this.deps.clock()],
        );
        throw err;
      });
    const ua = { userId: actor.userId, ip: actor.ip ?? null, userAgent: actor.userAgent ?? null };
    try {
      const files = c.files.map((f) => ({
        path: f.path,
        size: f.content.length,
        sha256: createHash('sha256').update(f.content).digest('hex'),
      }));
      const all = Buffer.concat(c.files.map((f) => f.content));
      const started = await uploads.start(ua, input.project, {
        files,
        label: (input.label ?? `Job ${jobId.slice(0, 8)} — kept files`).slice(0, 200),
      });
      for (let n = 0; n < started.partCount; n++) {
        const part = all.subarray(n * started.partSize, (n + 1) * started.partSize);
        await uploads.putPart(
          ua,
          input.project,
          started.id,
          n,
          part,
          createHash('sha256').update(part).digest('hex'),
        );
      }
      const done = await uploads.complete(ua, input.project, started.id);
      await this.deps.pool.query(
        `UPDATE workfile_exports SET state = 'succeeded', site_upload_id = $2, files = $3, bytes = $4, finished_at = $5
          WHERE id = $1`,
        [id, done.id, done.fileCount, done.totalBytes, this.deps.clock()],
      );
      await this.#audit(actor, 'workfiles.site_upload', jobId, 'success', {
        project: input.project,
        uploadId: done.id,
        files: done.fileCount,
        bytes: done.totalBytes,
      });
      return {
        id,
        uploadId: done.id,
        project: input.project,
        files: done.fileCount,
        bytes: done.totalBytes,
        skipped: c.skipped.length,
      };
    } catch (err) {
      await this.deps.pool.query(
        `UPDATE workfile_exports SET state = 'failed', error = $2, finished_at = $3 WHERE id = $1`,
        [id, (err instanceof HttpError ? err.publicMessage : 'failed').slice(0, 1000), this.deps.clock()],
      );
      await this.#audit(actor, 'workfiles.site_upload', jobId, 'failure', { project: input.project });
      throw err;
    } finally {
      c.done();
    }
  }
}
