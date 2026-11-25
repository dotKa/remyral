import { DEFAULT_RULES, Redactor } from '@remyral/observability';
import { fenceData, MAX_CHAT_MENTIONS } from '@remyral/protocol';
import { z } from 'zod';
import { rowContent } from '../blobs/registry.js';
import { authorize, projectRoleOf, roleAtLeast, type Subject, visibleProjects } from '../authz/model.js';
import type { Queryable } from '../db/pool.js';
import { jobTitle, titleColumns, titleOrDerived } from '../jobs/titles.js';
import type { OutputFolders } from '../outputs/folders.js';
import type { ChatCredentials } from './credentials.js';
import type { AuditRecorder } from '../audit/audit.js';
import type { CodeService } from '../code/service.js';
import { parseCodeRef } from '../code/reference.js';
import { likePattern, type OutputItem, type OutputsService } from '../outputs/service.js';

/**
 * `@` mentions in the ops chat (p8-chat-attachments-mentions, design note §3): the picker's search and the
 * send-time resolution of each mention into a fenced, size-bounded context block — always with the **current**
 * subject of the sender (reloaded per send), using the same actions as the console. Unreadable or unknown targets are
 * dropped with the same reason (no oracle). Mentioned content is data, never instructions.
 */

// p15-chat-vault: `credential` — a vault credential by reference (name, kind, hosts; never a value).
export const MENTION_TYPES = [
  'project',
  'thread',
  'output',
  'job',
  'worker',
  'folder',
  'credential',
  // p19-ide W1: lines of a file from the code viewer / diff ("Sohbete ekle"); never searched in the picker.
  'code',
] as const;
export type MentionType = (typeof MENTION_TYPES)[number];

export const MentionRef = z.strictObject({
  type: z.enum(MENTION_TYPES),
  id: z.string().min(1).max(320),
  project: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
    .optional(),
});
export type MentionRef = z.infer<typeof MentionRef>;
export const MentionRefs = z.array(MentionRef).max(MAX_CHAT_MENTIONS);

export interface MentionItem {
  readonly type: MentionType;
  readonly id: string;
  readonly project: string | null;
  readonly label: string;
  readonly detail: string | null;
}

/** What the sender's message keeps about a resolved mention (rendered as a chip). */
export interface MentionChip {
  readonly type: MentionType;
  readonly id: string;
  readonly project: string | null;
  readonly label: string;
}

export interface MentionDrop {
  readonly type: MentionType;
  readonly id: string;
  readonly reason: 'not_visible';
}

export interface ResolvedMentions {
  readonly blocks: string[];
  readonly chips: MentionChip[];
  readonly dropped: MentionDrop[];
}

/** One block's budget (characters of the fenced JSON). */
export const MAX_MENTION_BLOCK = 12 * 1024;
/** p19-ide W1: a `code` reference's block (≤ 24 KiB of lines plus JSON escaping). */
export const MAX_CODE_BLOCK = 32 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORKER_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

function clip(v: string | null | undefined, n: number): string | null {
  if (v === null || v === undefined) return null;
  return v.length > n ? `${v.slice(0, n)}…` : v;
}

export class ChatMentions {
  readonly #redactor = new Redactor({ rules: DEFAULT_RULES });

  constructor(
    private readonly deps: {
      readonly db: Queryable;
      readonly outputs?: () => OutputsService | null;
      /** p8-outputs-folders: own folders (project folders the caller can read, own personal folders). */
      readonly folders?: () => OutputFolders | null;
      /** p15-chat-vault: vault credentials (admins only; absent: no credential mentions). */
      readonly credentials?: () => ChatCredentials | null;
      /** p19-ide W1: `code` references (absent: dropped). */
      readonly code?: () => CodeService | null;
      /** p19-ide W1: `code.reference.send` (path and range, never the text). */
      readonly audit?: AuditRecorder;
    },
  ) {}

  #can(subject: Subject, action: string, project?: string): boolean {
    return authorize(subject, action, project === undefined ? null : { project }).allow;
  }

  /** Projects the subject may read outputs of (null = all). */
  #outputProjects(subject: Subject): readonly string[] | null {
    const visible = visibleProjects(subject);
    if (visible === null) return this.#can(subject, 'outputs.read', 'genel') ? null : [];
    return visible.filter((p) => this.#can(subject, 'outputs.read', p));
  }

  // ------------------------------------------------------------------------------------------------ search

  async search(subject: Subject, q: string, type?: MentionType): Promise<MentionItem[]> {
    const text = q.trim().slice(0, 100);
    const like = likePattern(text);
    const want = (t: MentionType): boolean => type === undefined || type === t;
    const per = type === undefined ? 5 : 20;
    const out: MentionItem[] = [];
    const db = this.deps.db;
    if (want('project')) {
      const visible = visibleProjects(subject);
      const { rows } = await db.query<{ id: string; name: string; kind: string }>(
        `SELECT id, name, kind FROM projects
          WHERE ($1::text[] IS NULL OR id = ANY($1)) AND (name ILIKE $2 OR id ILIKE $2)
          ORDER BY lower(name) LIMIT $3`,
        [visible === null ? null : [...visible], like, per * 2],
      );
      for (const r of rows.filter((x) => this.#can(subject, 'projects.read', x.id)).slice(0, per)) {
        out.push({ type: 'project', id: r.id, project: r.id, label: r.name, detail: r.kind });
      }
    }
    if (want('thread')) {
      const { rows } = await db.query<{ id: string; title: string; archived: boolean }>(
        `SELECT id::text AS id, title, archived_at IS NOT NULL AS archived FROM chat_threads
          WHERE user_id = $1 AND title ILIKE $2 ORDER BY archived_at IS NOT NULL, updated_at DESC LIMIT $3`,
        [subject.userId, like, per],
      );
      for (const r of rows) {
        out.push({
          type: 'thread',
          id: r.id,
          project: null,
          label: r.title,
          detail: r.archived ? 'archived' : null,
        });
      }
    }
    if (want('output')) {
      const svc = this.deps.outputs?.() ?? null;
      const projects = this.#outputProjects(subject);
      if (svc !== null && (projects === null || projects.length > 0)) {
        const { items } = await svc.list(projects, { ...(text === '' ? {} : { q: text }), limit: per });
        for (const i of items) {
          out.push({
            type: 'output',
            id: i.key,
            project: i.project,
            label: i.title ?? i.name,
            detail: `${i.type} · ${i.project}`,
          });
        }
      }
    }
    if (want('job') && roleAtLeast(subject.role, 'viewer')) {
      const visible = visibleProjects(subject);
      const idPrefix = /^[0-9a-f-]{4,36}$/.test(text) ? `${text}%` : null;
      const { rows } = await db.query<{
        id: string;
        project: string;
        state: string;
        title_stored: string | null;
        title_prompt: string | null;
      }>(
        `SELECT j.id::text AS id, j.project, j.state::text AS state, ${titleColumns()}
           FROM jobs j LEFT JOIN job_titles jt ON jt.job_id = j.id
          WHERE ($1::text[] IS NULL OR j.project = ANY($1))
            AND (j.spec->>'prompt' ILIKE $2 OR jt.title ILIKE $2 OR ($3::text IS NOT NULL AND j.id::text LIKE $3))
          ORDER BY j.created_at DESC LIMIT $4`,
        [visible === null ? null : [...visible], like, idPrefix, per * 2],
      );
      for (const r of rows.filter((x) => this.#can(subject, 'jobs.read', x.project)).slice(0, per)) {
        out.push({
          type: 'job',
          id: r.id,
          project: r.project,
          // p15-job-titles: the job's short title.
          label: titleOrDerived(r),
          detail: `${r.state} · ${r.project}`,
        });
      }
    }
    if (want('worker') && this.#can(subject, 'workers.read')) {
      const { rows } = await db.query<{ id: string; display_name: string; state: string }>(
        `SELECT id, display_name, state::text AS state FROM workers
          WHERE approved_at IS NOT NULL AND revoked_at IS NULL AND archived_at IS NULL
            AND (display_name ILIKE $1 OR id ILIKE $1)
          ORDER BY lower(display_name) LIMIT $2`,
        [like, per],
      );
      for (const r of rows) {
        out.push({ type: 'worker', id: r.id, project: null, label: r.display_name, detail: r.state });
      }
    }
    if (want('folder')) {
      const folders = this.deps.folders?.() ?? null;
      if (folders !== null) {
        for (const f of await folders.search(subject, text, per)) {
          out.push({
            type: 'folder',
            id: f.id,
            project: f.project,
            label: f.name,
            detail: f.scope === 'personal' ? 'my folder' : `folder · ${f.project ?? ''}`,
          });
        }
      }
    }
    if (want('credential')) {
      const creds = this.deps.credentials?.() ?? null;
      if (creds !== null) out.push(...(await creds.search(subject, text, per)));
    }
    // Five per type when mixed (seven types), twenty of one type.
    return out.slice(0, type === undefined ? 35 : 20);
  }

  // ------------------------------------------------------------------------------------------- resolution

  /**
   * Resolves each mention for `subject` (the sender, loaded now). Duplicates collapse; anything not readable is
   * dropped. `budget` bounds all blocks together (characters).
   */
  async resolve(subject: Subject, refs: readonly MentionRef[], budget: number): Promise<ResolvedMentions> {
    const blocks: string[] = [];
    const chips: MentionChip[] = [];
    const dropped: MentionDrop[] = [];
    const seen = new Set<string>();
    let left = budget;
    for (const ref of refs.slice(0, MAX_CHAT_MENTIONS)) {
      const key = `${ref.type}:${ref.project ?? ''}:${ref.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const r = await this.#one(subject, ref).catch(() => null);
      if (r === null) {
        dropped.push({ type: ref.type, id: ref.id, reason: 'not_visible' });
        continue;
      }
      // p19-ide W1: a code reference's label is its kind only (paths would lose their slashes in a fence label).
      const tag = ref.type === 'code' ? 'mention code reference' : `mention ${ref.type} ${r.chip.id}`;
      const max = ref.type === 'code' ? MAX_CODE_BLOCK : MAX_MENTION_BLOCK;
      let block = this.#redactor.redact(fenceData(tag, r.data));
      if (block.length > max) {
        block = this.#redactor.redact(
          fenceData(`${tag} (truncated)`, {
            truncated: true,
            preview: JSON.stringify(r.data).slice(0, max / 2),
          }),
        );
      }
      chips.push(r.chip);
      if (block.length > left) {
        blocks.push(
          fenceData(tag, {
            omitted: 'context size limit reached',
            type: ref.type,
            id: r.chip.id,
            label: r.chip.label,
          }),
        );
        continue;
      }
      left -= block.length;
      blocks.push(block);
    }
    return { blocks, chips, dropped };
  }

  async #one(subject: Subject, ref: MentionRef): Promise<{ chip: MentionChip; data: unknown } | null> {
    switch (ref.type) {
      case 'project':
        return this.#project(subject, ref.id);
      case 'thread':
        return this.#thread(subject, ref.id);
      case 'output':
        return ref.project === undefined ? null : this.#output(subject, ref.project, ref.id);
      case 'job':
        return this.#job(subject, ref.id);
      case 'worker':
        return this.#worker(subject, ref.id);
      case 'folder':
        return this.#folder(subject, ref.id);
      case 'credential':
        return (await this.deps.credentials?.()?.mention(subject, ref.id)) ?? null;
      case 'code':
        return ref.project === undefined ? null : this.#code(subject, ref.project, ref.id);
    }
  }

  /**
   * p19-ide W1 (docs/design/p19-ide.md §6): the referenced lines re-read now, as the sender, at the pinned commit (or
   * from the kept working file); redacted and capped by the code service. Audited without the text.
   */
  async #code(
    subject: Subject,
    project: string,
    id: string,
  ): Promise<{ chip: MentionChip; data: unknown } | null> {
    const parsed = parseCodeRef(id);
    const code = this.deps.code?.() ?? null;
    if (parsed === null || code === null) return null;
    const r = await code.reference(subject, project, parsed);
    if (r === null) return null;
    await this.deps.audit
      ?.record({
        actor: { type: 'user', id: subject.userId },
        action: 'code.reference.send',
        target: `project:${project}`,
        outcome: 'success',
        ip: null,
        userAgent: null,
        metadata: {
          source: parsed.source,
          ref: parsed.ref,
          path: parsed.path.slice(0, 300),
          lines: `${String(parsed.startLine)}-${String(parsed.endLine)}`,
        },
      })
      .catch(() => undefined);
    return { chip: { type: 'code', id: r.chip.id, project, label: r.chip.label }, data: r.data };
  }

  async #folder(subject: Subject, id: string): Promise<{ chip: MentionChip; data: unknown } | null> {
    if (!UUID.test(id)) return null;
    const folders = this.deps.folders?.() ?? null;
    if (folders === null) return null;
    const m = await folders.mention(subject, id);
    if (m === null) return null;
    return { chip: { type: 'folder', id, project: m.project, label: m.label }, data: m.data };
  }

  async #project(subject: Subject, id: string): Promise<{ chip: MentionChip; data: unknown } | null> {
    if (!this.#can(subject, 'projects.read', id)) return null;
    const { rows } = await this.deps.db.query<{
      id: string;
      name: string;
      kind: string;
      repository_url: string | null;
      base_branch: string | null;
    }>(
      `SELECT p.id, p.name, p.kind, g.repository_url, g.base_branch
         FROM projects p LEFT JOIN project_git_configs g ON g.project = p.id WHERE p.id = $1`,
      [id],
    );
    const p = rows[0];
    if (p === undefined) return null;
    let jobs: unknown[] = [];
    if (this.#can(subject, 'jobs.read', id)) {
      const { rows: j } = await this.deps.db.query<{
        id: string;
        state: string;
        title_stored: string | null;
        title_prompt: string | null;
      }>(
        `SELECT j.id::text AS id, j.state::text AS state, ${titleColumns()}
           FROM jobs j LEFT JOIN job_titles jt ON jt.job_id = j.id
          WHERE j.project = $1 ORDER BY j.created_at DESC LIMIT 5`,
        [id],
      );
      jobs = j.map((x) => ({ id: x.id, state: x.state, title: titleOrDerived(x) }));
    }
    return {
      chip: { type: 'project', id: p.id, project: p.id, label: p.name },
      data: {
        type: 'project',
        id: p.id,
        name: p.name,
        kind: p.kind,
        repository: p.repository_url,
        baseBranch: p.base_branch,
        yourRole: projectRoleOf(subject, p.id),
        latestJobs: jobs,
      },
    };
  }

  async #thread(subject: Subject, id: string): Promise<{ chip: MentionChip; data: unknown } | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.deps.db.query<{ title: string; updated_at: Date }>(
      'SELECT title, updated_at FROM chat_threads WHERE id = $1 AND user_id = $2',
      [id, subject.userId],
    );
    const t = rows[0];
    if (t === undefined) return null;
    const { rows: msgs } = await this.deps.db.query<{ role: string; content: string }>(
      `SELECT role, content FROM (
         SELECT seq, role, content FROM chat_messages
          WHERE thread_id = $1 AND role IN ('user', 'assistant') ORDER BY seq DESC LIMIT 8) m
       ORDER BY seq`,
      [id],
    );
    return {
      chip: { type: 'thread', id, project: null, label: t.title },
      data: {
        type: 'conversation',
        id,
        title: t.title,
        updatedAt: t.updated_at.toISOString(),
        recentMessages: msgs.map((m) => ({ role: m.role, text: clip(m.content, 1_500) })),
      },
    };
  }

  async #output(
    subject: Subject,
    project: string,
    key: string,
  ): Promise<{ chip: MentionChip; data: unknown } | null> {
    if (!this.#can(subject, 'outputs.read', project)) return null;
    const svc = this.deps.outputs?.() ?? null;
    if (svc === null) return null;
    const { items } = await svc.list([project], { project, key, limit: 1 });
    const item: OutputItem | undefined = items[0];
    if (item === undefined) return null;
    let notes: unknown[] = [];
    if (item.type !== 'note') {
      notes = (await svc.itemNotes(project, key).catch(() => [])).slice(-5).map((n) => ({
        author: n.author.username,
        text: clip(n.body, 1_000),
        at: n.createdAt,
      }));
    }
    const file = item.file;
    return {
      chip: { type: 'output', id: item.key, project: item.project, label: item.title ?? item.name },
      data: {
        type: 'output',
        itemType: item.type,
        key: item.key,
        project: item.project,
        name: item.name,
        title: item.title,
        tags: item.tags,
        jobId: item.jobId,
        createdAt: item.createdAt,
        ...(item.site === null
          ? {}
          : { site: { url: item.site.url, env: item.site.env, provider: item.site.provider } }),
        ...(file === null
          ? {}
          : {
              file: {
                mediaType: file.mediaType,
                sizeBytes: file.sizeBytes,
                removed: file.removed,
                ...(item.jobId !== null && file.source === 'workspace' && file.removed === null
                  ? {
                      inputArtifact: { jobId: item.jobId, artifactId: file.artifactId },
                      hint: 'Use draft_job.inputArtifacts with this jobId + artifactId to give the file to a job (workspace or repository project).',
                    }
                  : {}),
              },
            }),
        ...(item.note === null
          ? {}
          : { note: { text: clip(item.note.body, 4_000), links: item.note.links } }),
        ...(notes.length === 0 ? {} : { itemNotes: notes }),
      },
    };
  }

  async #job(subject: Subject, id: string): Promise<{ chip: MentionChip; data: unknown } | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.deps.db.query<{
      id: string;
      project: string;
      state: string;
      spec: Record<string, unknown>;
      created_at: Date;
      state_changed_at: Date;
    }>(
      `SELECT id::text AS id, project, state::text AS state, spec, created_at, state_changed_at FROM jobs WHERE id = $1`,
      [id],
    );
    const j = rows[0];
    if (j === undefined || !this.#can(subject, 'jobs.read', j.project)) return null;
    const { rows: s } = await this.deps.db.query<{ content: Buffer | null; blob_key: string | null }>(
      `SELECT content, blob_key FROM job_artifacts WHERE job_id = $1 AND kind = 'summary'
        ORDER BY created_at DESC LIMIT 1`,
      [id],
    );
    // p17-object-storage: the summary's bytes may be in the blob store (unreadable: no summary, not an error).
    const summary = s[0] === undefined ? null : await rowContent(s[0], 1024 * 1024).catch(() => null);
    const title = (await jobTitle(this.deps.db, id)) ?? id.slice(0, 8);
    return {
      chip: { type: 'job', id, project: j.project, label: title },
      data: {
        type: 'job',
        id,
        project: j.project,
        state: j.state,
        runtime: typeof j.spec.runtime === 'string' ? j.spec.runtime : null,
        title,
        prompt: clip(typeof j.spec.prompt === 'string' ? j.spec.prompt : null, 1_500),
        createdAt: j.created_at.toISOString(),
        stateChangedAt: j.state_changed_at.toISOString(),
        summary: clip(summary?.toString('utf8') ?? null, 2_000),
      },
    };
  }

  async #worker(subject: Subject, id: string): Promise<{ chip: MentionChip; data: unknown } | null> {
    if (!WORKER_ID.test(id) || !this.#can(subject, 'workers.read')) return null;
    const { rows } = await this.deps.db.query<{
      id: string;
      display_name: string;
      state: string;
      os: string | null;
      arch: string | null;
      runtimes: string[] | null;
    }>(
      `SELECT w.id, w.display_name, w.state::text AS state, w.facts->>'os' AS os, w.facts->>'arch' AS arch,
              (SELECT array_agg(r.runtime ORDER BY r.runtime) FROM worker_runtimes r
                WHERE r.worker_id = w.id AND r.present) AS runtimes
         FROM workers w
        WHERE w.id = $1 AND w.approved_at IS NOT NULL AND w.revoked_at IS NULL AND w.archived_at IS NULL`,
      [id],
    );
    const w = rows[0];
    if (w === undefined) return null;
    return {
      chip: { type: 'worker', id: w.id, project: null, label: w.display_name },
      data: {
        type: 'machine',
        id: w.id,
        name: w.display_name,
        state: w.state,
        os: w.os,
        arch: w.arch,
        runtimes: w.runtimes ?? [],
        hint: 'describe_worker gives the full picture.',
      },
    };
  }
}
