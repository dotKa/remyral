import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_RULES, Redactor } from '@remyral/observability';
import {
  type AssistantAttachmentRef,
  attachmentMagicMatches,
  contentMatchesType,
  fenceData,
  InputName,
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_BINARY_BYTES,
  MAX_CHAT_MESSAGE_BYTES,
  MAX_CHAT_TEXT_BYTES,
  workspaceFileType,
} from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import type { RateLimiter } from '../auth/rate-limit.js';
import type { Pool, Queryable } from '../db/pool.js';
import { blobs, rowContent } from '../blobs/registry.js';
import { blobKeys } from '../blobs/store.js';
import { HttpError } from '../http/errors.js';
import { type PreparedInput, prepareInput, scanFile } from '../workspaces/service.js';
import { ScrubError, scrubImage } from './scrub.js';

/**
 * Ops chat attachments (p8-chat-attachments-mentions, design note §2): images, PDFs and small text files of chat
 * messages, stored per thread after the metadata scrub and the secret pass. Every read resolves the thread's owner
 * = the caller (another user's attachment is "not found", owners included — threads are private).
 */

export type AttachmentKind = 'image' | 'pdf' | 'text';

export interface AttachmentView {
  readonly id: string;
  readonly threadId: string;
  readonly messageId: string | null;
  readonly kind: AttachmentKind;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly scrubbed: string[];
  readonly createdAt: string;
  readonly url: string;
}

/** What a user message's meta keeps about an attachment. */
export interface AttachmentMeta {
  readonly id: string;
  readonly kind: AttachmentKind;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
}

export const MAX_ATTACHMENTS_PER_THREAD = 200;
export const UPLOADS_PER_10_MIN = 30;
export const UNSENT_TTL_MS = 24 * 60 * 60_000;

interface Row {
  id: string;
  thread_id: string;
  message_id: string | null;
  kind: AttachmentKind;
  name: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  scrubbed: string[];
  created_at: Date;
}

const COLS = `id::text AS id, thread_id::text AS thread_id, message_id::text AS message_id, kind, name, media_type,
  size_bytes, sha256, scrubbed, created_at`;

function view(r: Row): AttachmentView {
  return {
    id: r.id,
    threadId: r.thread_id,
    messageId: r.message_id,
    kind: r.kind,
    name: r.name,
    mediaType: r.media_type,
    sizeBytes: r.size_bytes,
    sha256: r.sha256,
    scrubbed: r.scrubbed,
    createdAt: r.created_at.toISOString(),
    url: `/api/chat/attachments/${r.id}/content`,
  };
}

export function attachmentMeta(a: AttachmentView): AttachmentMeta {
  return { id: a.id, kind: a.kind, name: a.name, mediaType: a.mediaType, sizeBytes: a.sizeBytes };
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** A browser-given file name made safe (`InputName` rules): unsafe characters → `_`, ≤ 100 characters. */
export function safeAttachmentName(raw: string): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(raw);
  const ext = m?.[1]?.toLowerCase() ?? '';
  let base = (m === null ? raw : raw.slice(0, -m[0].length))
    .replace(/[^A-Za-z0-9 ._()+-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[^A-Za-z0-9]+/, '')
    .trim();
  if (base === '') base = 'file';
  base = base.slice(0, Math.max(1, 99 - ext.length));
  return ext === '' ? base : `${base}.${ext}`;
}

const invalid = (msg: string): HttpError => new HttpError(400, 'invalid_attachment', msg);
const notFound = (): HttpError => new HttpError(404, 'attachment_not_found', 'Attachment not found.');

export class ChatAttachments {
  readonly #redactor = new Redactor({ rules: DEFAULT_RULES });

  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
      readonly limiter: RateLimiter;
    },
  ) {}

  /** Validates, scrubs and stores one upload of the caller's own thread (not archived). */
  async upload(
    userId: string,
    threadId: string,
    input: { readonly name: string; readonly contentBase64: string },
  ): Promise<AttachmentView> {
    const { rows: threads } = await this.deps.pool.query<{ archived_at: Date | null }>(
      'SELECT archived_at FROM chat_threads WHERE id = $1 AND user_id = $2',
      [threadId, userId],
    );
    const thread = threads[0];
    if (thread === undefined) throw new HttpError(404, 'thread_not_found', 'Conversation not found.');
    if (thread.archived_at !== null) {
      throw new HttpError(409, 'thread_archived', 'This conversation is archived.');
    }
    const name = InputName.safeParse(safeAttachmentName(input.name));
    const type = name.success ? workspaceFileType(name.data) : null;
    if (!name.success || type === null) {
      throw invalid(
        'File type not allowed (images: .png .jpg .webp .gif; .pdf; text: .txt .md .csv .json .yaml .log).',
      );
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.contentBase64)) throw invalid('contentBase64 is not base64.');
    let content: Buffer = Buffer.from(input.contentBase64, 'base64');
    if (content.length === 0) throw invalid(`${name.data}: the file is empty.`);
    const kind: AttachmentKind = type.text ? 'text' : type.mediaType === 'application/pdf' ? 'pdf' : 'image';
    const max = kind === 'text' ? MAX_CHAT_TEXT_BYTES : MAX_CHAT_BINARY_BYTES;
    if (content.length > max) {
      throw new HttpError(
        413,
        'attachment_too_large',
        `${name.data}: larger than ${String(Math.floor(max / 1024))} KiB.`,
        {},
        {},
        { name: name.data, maxKib: Math.floor(max / 1024) },
      );
    }
    const typeOk =
      kind === 'text'
        ? contentMatchesType(content, type.mediaType)
        : attachmentMagicMatches(content, type.mediaType);
    if (!typeOk) {
      throw invalid(
        `${name.data}: content does not match its type (${kind === 'text' ? 'UTF-8 text without NUL' : type.mediaType}).`,
      );
    }
    const hit = await this.deps.limiter.hit('chat-attachments', userId, UPLOADS_PER_10_MIN, 10 * 60_000);
    if (!hit.allowed) {
      throw new HttpError(
        429,
        'rate_limited',
        'Too many uploads; try again in a few minutes.',
        {
          'retry-after': String(Math.ceil(hit.retryAfterMs / 1000)),
        },
        {},
        { reason: 'uploads' },
      );
    }
    const scrubbed: string[] = [];
    if (kind === 'image') {
      try {
        const r = scrubImage(content, type.mediaType);
        content = r.data;
        scrubbed.push(...r.removed);
      } catch (err) {
        if (err instanceof ScrubError)
          throw invalid(`${name.data}: the image could not be read (${err.message}).`);
        throw err;
      }
    }
    if (kind === 'text') {
      const text = content.toString('utf8');
      const spans = this.#redactor.spans(text).length;
      if (spans > 0) {
        content = Buffer.from(this.#redactor.redact(text), 'utf8');
        scrubbed.push(`secrets:${String(spans)}`);
        if (content.length > MAX_CHAT_TEXT_BYTES) content = content.subarray(0, MAX_CHAT_TEXT_BYTES);
      }
    } else {
      const findings = scanFile(content, false);
      if (findings.length > 0) {
        await this.#audit(userId, threadId, 'denied', {
          name: name.data,
          rule: findings[0]?.rule ?? 'secret',
        });
        throw new HttpError(
          422,
          'attachment_secret_detected',
          `${name.data}: looks like it contains a secret (${findings[0]?.rule ?? 'secret'}); remove it and upload again.`,
          {},
          {},
          { name: name.data, rule: findings[0]?.rule ?? 'secret' },
        );
      }
    }
    const id = randomUUID();
    const now = this.deps.clock();
    // p17-object-storage-rest: the bytes go to the blob store (never Postgres); a row that is then refused (thread
    // full) leaves an unreferenced blob, which the blob GC removes.
    const key = await blobs().write(
      'chat-attachment',
      blobKeys.chatAttachment(threadId, id),
      content,
      type.mediaType,
    );
    const { rows } = await this.deps.pool.query<Row>(
      `INSERT INTO chat_attachments (id, thread_id, user_id, kind, name, media_type, size_bytes, sha256, scrubbed,
                                     content, blob_key, created_at)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $11
        WHERE (SELECT count(*) FROM chat_attachments WHERE thread_id = $2) < $12
       RETURNING ${COLS}`,
      [
        id,
        threadId,
        userId,
        kind,
        name.data,
        type.mediaType,
        content.length,
        sha256(content),
        scrubbed,
        key,
        now,
        MAX_ATTACHMENTS_PER_THREAD,
      ],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new HttpError(
        409,
        'too_many_attachments',
        `A conversation holds at most ${String(MAX_ATTACHMENTS_PER_THREAD)} attachments; start a new one.`,
        {},
        {},
        { max: MAX_ATTACHMENTS_PER_THREAD },
      );
    }
    await this.#audit(userId, threadId, 'success', {
      attachmentId: id,
      kind,
      mediaType: type.mediaType,
      sizeBytes: content.length,
      ...(scrubbed.length > 0 ? { scrubbed } : {}),
    });
    return view(row);
  }

  async #audit(
    userId: string,
    threadId: string,
    outcome: 'success' | 'denied',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record({
      actor: { type: 'user', id: userId },
      action: 'chat.attachment.upload',
      target: `chat-thread:${threadId}`,
      outcome,
      metadata,
    });
  }

  /** The bytes, for the thread's owner only. */
  async content(
    userId: string,
    id: string,
  ): Promise<{ name: string; mediaType: string; kind: AttachmentKind; content: Buffer }> {
    const { rows } = await this.deps.pool.query<{
      name: string;
      media_type: string;
      kind: AttachmentKind;
      content: Buffer | null;
      blob_key: string | null;
    }>(
      `SELECT a.name, a.media_type, a.kind, a.content, a.blob_key FROM chat_attachments a
         JOIN chat_threads t ON t.id = a.thread_id
        WHERE a.id = $1
          AND (t.user_id = $2
               -- p16-chat-complete: a reader of a shared conversation sees its sent files.
               OR (a.message_id IS NOT NULL AND EXISTS (
                     SELECT 1 FROM chat_thread_shares s WHERE s.thread_id = t.id AND s.user_id = $2)))`,
      [id, userId],
    );
    const r = rows[0];
    if (r === undefined) throw notFound();
    // Authorised above (the row query); the bytes are the legacy bytea or the blob.
    const content = await rowContent(r);
    if (content === null) throw notFound();
    return { name: r.name, mediaType: r.media_type, kind: r.kind, content };
  }

  /** Removes an unsent upload of the caller. */
  async remove(userId: string, id: string): Promise<void> {
    const { rows } = await this.deps.pool.query<{ message_id: string | null }>(
      `SELECT a.message_id::text AS message_id FROM chat_attachments a JOIN chat_threads t ON t.id = a.thread_id
        WHERE a.id = $1 AND t.user_id = $2`,
      [id, userId],
    );
    const r = rows[0];
    if (r === undefined) throw notFound();
    if (r.message_id !== null) {
      throw new HttpError(409, 'attachment_sent', 'The attachment was sent; it goes with the conversation.');
    }
    await this.deps.pool.query('DELETE FROM chat_attachments WHERE id = $1 AND message_id IS NULL', [id]);
  }

  /**
   * The unsent uploads `ids` of this thread by this user, in the given order (400 when one is not). Enforces the
   * per-message count and byte limits.
   */
  async pending(
    userId: string,
    threadId: string,
    ids: readonly string[],
    db: Queryable = this.deps.pool,
  ): Promise<AttachmentView[]> {
    if (ids.length === 0) return [];
    if (ids.length > MAX_CHAT_ATTACHMENTS) {
      throw invalid(`At most ${String(MAX_CHAT_ATTACHMENTS)} attachments per message.`);
    }
    if (new Set(ids).size !== ids.length) throw invalid('An attachment is listed twice.');
    const { rows } = await db.query<Row>(
      `SELECT ${COLS} FROM chat_attachments
        WHERE id = ANY($1::uuid[]) AND thread_id = $2 AND user_id = $3 AND message_id IS NULL
        FOR UPDATE`,
      [ids, threadId, userId],
    );
    const byId = new Map(rows.map((r) => [r.id, view(r)]));
    const out: AttachmentView[] = [];
    for (const id of ids) {
      const a = byId.get(id);
      if (a === undefined) throw invalid(`Attachment ${id} is not an unsent upload of this conversation.`);
      out.push(a);
    }
    const binary = out.filter((a) => a.kind !== 'text').reduce((n, a) => n + a.sizeBytes, 0);
    if (binary > MAX_CHAT_MESSAGE_BYTES) {
      throw new HttpError(
        413,
        'attachment_too_large',
        `Attachments exceed ${String(MAX_CHAT_MESSAGE_BYTES / 1024 / 1024)} MiB per message.`,
        {},
        {},
        { reason: 'message', maxMib: MAX_CHAT_MESSAGE_BYTES / 1024 / 1024 },
      );
    }
    return out;
  }

  async bind(db: Queryable, ids: readonly string[], messageId: string): Promise<void> {
    if (ids.length === 0) return;
    await db.query('UPDATE chat_attachments SET message_id = $2 WHERE id = ANY($1::uuid[])', [
      ids,
      messageId,
    ]);
  }

  /** Attachments of one message (for a dispatched turn). */
  async ofMessage(messageId: string): Promise<AttachmentView[]> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} FROM chat_attachments WHERE message_id = $1 ORDER BY created_at, id`,
      [messageId],
    );
    return rows.map(view);
  }

  /** Signed refs of the images / PDFs for the turn. */
  static refs(atts: readonly AttachmentView[]): AssistantAttachmentRef[] {
    return atts
      .filter((a): a is AttachmentView & { kind: 'image' | 'pdf' } => a.kind !== 'text')
      .map((a) => ({
        id: a.id,
        kind: a.kind,
        mediaType: a.mediaType as AssistantAttachmentRef['mediaType'],
        name: a.name,
        sizeBytes: a.sizeBytes,
        sha256: a.sha256,
      }));
  }

  /**
   * Fenced blocks of the text files plus the list of all attachments (ids for draft_job.chatAttachments).
   * `repoInputsRule` (p19-repo-job-inputs): the answering assistant advertises `assistant-repo-inputs-v1` (its prompt
   * already says attachments reach repository jobs too); false: the note says so itself (older assistant text said
   * "workspace projects only").
   */
  async contextBlocks(
    atts: readonly AttachmentView[],
    maxTextChars: number,
    opts: { readonly repoInputsRule?: boolean } = {},
  ): Promise<string[]> {
    if (atts.length === 0) return [];
    const blocks = [
      fenceData('attachments of this message', {
        note:
          opts.repoInputsRule === true
            ? 'Files the user attached. Images/PDFs are given to you as input; to hand files to a job (workspace or repository project) use draft_job.chatAttachments with these ids.'
            : 'Files the user attached. Images/PDFs are given to you as input; to hand files to a job use draft_job.chatAttachments with these ids — this works for workspace AND repository projects now (a repository job gets them read-only in a scratch in/ next to the checkout, never committed; older tool text saying "only for workspace projects" is outdated). Never refuse because the project is a repository project; if draft_job says the machines must be updated, tell the user that.',
        files: atts.map((a) => ({
          id: a.id,
          kind: a.kind,
          name: a.name,
          mediaType: a.mediaType,
          sizeBytes: a.sizeBytes,
        })),
      }),
    ];
    let budget = maxTextChars;
    for (const a of atts.filter((x) => x.kind === 'text')) {
      const { rows } = await this.deps.pool.query<{ content: Buffer | null; blob_key: string | null }>(
        'SELECT content, blob_key FROM chat_attachments WHERE id = $1',
        [a.id],
      );
      const row = rows[0];
      const bytes = row === undefined ? null : await rowContent(row);
      const text = this.#redactor.redact(bytes?.toString('utf8') ?? '');
      const cut = text.length > budget;
      const body = cut ? text.slice(0, Math.max(0, budget)) : text;
      budget -= body.length;
      blocks.push(
        fenceData(`attached file ${a.name}`, {
          name: a.name,
          mediaType: a.mediaType,
          ...(cut ? { truncated: true } : {}),
          text: body,
        }),
      );
      if (budget <= 0) break;
    }
    return blocks;
  }

  /** One slice of an attachment's bytes; null when there is no such attachment. */
  async slice(id: string, offset: number, length: number): Promise<{ data: Buffer; eof: boolean } | null> {
    const { rows } = await this.deps.pool.query<{
      part: Buffer | null;
      size: number;
      blob_key: string | null;
    }>(
      `SELECT substring(content FROM $2::int + 1 FOR $3::int) AS part, size_bytes AS size, blob_key
         FROM chat_attachments WHERE id = $1`,
      [id, offset, length],
    );
    const r = rows[0];
    if (r === undefined) return null;
    const data =
      r.blob_key !== null
        ? await blobs().range(r.blob_key, offset, Math.max(0, Math.min(length, r.size - offset)))
        : (r.part ?? Buffer.alloc(0));
    return { data, eof: offset + data.length >= r.size };
  }

  /** Removes unsent uploads older than a day. */
  async sweep(): Promise<number> {
    const r = await this.deps.pool.query(
      'DELETE FROM chat_attachments WHERE message_id IS NULL AND created_at < $1',
      [new Date(this.deps.clock().getTime() - UNSENT_TTL_MS)],
    );
    return r.rowCount ?? 0;
  }
}

/** Job inputs from attachments of `threadId` owned by `userId` (validated like composer uploads). */
export async function chatAttachmentInputs(
  db: Queryable,
  userId: string,
  threadId: string | null,
  ids: readonly string[],
  taken: ReadonlySet<string>,
): Promise<PreparedInput[]> {
  if (ids.length === 0) return [];
  if (threadId === null) throw invalid('Chat attachments can only be used from their conversation.');
  const { rows } = await db.query<{
    id: string;
    name: string;
    content: Buffer | null;
    blob_key: string | null;
  }>(
    `SELECT a.id::text AS id, a.name, a.content, a.blob_key FROM chat_attachments a
       JOIN chat_threads t ON t.id = a.thread_id
      WHERE a.id = ANY($1::uuid[]) AND a.thread_id = $2 AND t.user_id = $3 AND a.message_id IS NOT NULL`,
    [ids, threadId, userId],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const used = new Set(taken);
  const out: PreparedInput[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (r === undefined) {
      throw new HttpError(
        400,
        'invalid_inputs',
        `Chat attachment ${id} is not a sent file of this conversation.`,
        {},
        {},
        { reason: 'chat_attachment', id },
      );
    }
    let name = r.name;
    for (let n = 2; used.has(name); n += 1) {
      const m = /^(.*?)(\.[A-Za-z0-9]{1,10})$/.exec(r.name);
      name =
        m === null ? `${r.name}-${String(n)}` : `${(m[1] ?? 'file').slice(0, 90)}-${String(n)}${m[2] ?? ''}`;
    }
    used.add(name);
    const content = await rowContent(r);
    if (content === null) throw invalid(`Chat attachment ${id} is no longer stored.`);
    out.push(prepareInput(name, content, 'upload', null));
  }
  return out;
}
