import { z } from 'zod';

/**
 * p6-outputs (docs/design/p6-outputs.md): item keys, limits and the input rules of the Outputs read model.
 *
 * Item keys address what a job produced, independent of any metadata row:
 *  - `site:<target>:<env>` — the live site of a project's deploy target (`pages:<pages project>` or
 *    `coolify:<hash of the resource uuids>`) in one environment; p8-preview-tunnels: an open preview link
 *    `site:tunnel:<tunnel id without dashes>:preview`;
 *  - `file:<job uuid>:<artifact id>` — a stored workspace output (`out/` file or the run summary);
 *  - `run:<job uuid>:<artifact id>` — a run artifact the worker reported (e.g. `attempt.diff`), metadata only;
 *  - `note:<uuid>` — a free-standing note card (list responses only; notes have their own routes).
 */

export type ItemType = 'site' | 'file' | 'note';
export type MetaKind = 'site' | 'file' | 'run';

export const ITEM_KEY = /^(site|file|run):[A-Za-z0-9_.:+-]{1,300}$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const FILE_KEY = new RegExp(`^file:(${UUID}):(ws-[a-z0-9-]{1,100})$`);
const RUN_KEY = new RegExp(`^run:(${UUID}):([A-Za-z0-9_.:-]{1,128})$`);
const SITE_KEY =
  /^site:(pages:[a-z0-9][a-z0-9-]{0,57}|pages:unknown|coolify:[0-9a-f]{16}|tunnel:[0-9a-f]{32}):(preview|production)$/;

export type ParsedKey =
  | { readonly kind: 'site'; readonly target: string; readonly env: 'preview' | 'production' }
  | { readonly kind: 'file' | 'run'; readonly jobId: string; readonly artifactId: string };

/** The parts of an item key, or null when it is not one. */
export function parseItemKey(key: string): ParsedKey | null {
  if (!ITEM_KEY.test(key)) return null;
  const f = FILE_KEY.exec(key);
  if (f?.[1] !== undefined && f[2] !== undefined) return { kind: 'file', jobId: f[1], artifactId: f[2] };
  const r = RUN_KEY.exec(key);
  if (r?.[1] !== undefined && r[2] !== undefined) return { kind: 'run', jobId: r[1], artifactId: r[2] };
  const s = SITE_KEY.exec(key);
  if (s?.[1] !== undefined && (s[2] === 'preview' || s[2] === 'production')) {
    return { kind: 'site', target: s[1], env: s[2] };
  }
  return null;
}

export const LIMITS = {
  /** Items per list page. */
  pageMax: 100,
  /** Deepest offset a list may ask for (keyset paging is not needed at this scale). */
  offsetMax: 10_000,
  titleMax: 200,
  tagsMax: 20,
  tagMax: 40,
  noteMax: 20_000,
  notesPerItem: 500,
  notesPerProject: 2_000,
  linksMax: 20,
  linkMax: 2_048,
  /** Characters of a note card's body in list responses (the card route returns all of it). */
  excerptChars: 2_000,
  /** Multi-select download. */
  zipFilesMax: 100,
  zipBytesMax: 50 * 1024 * 1024,
  /** Search text. */
  queryMax: 200,
} as const;

/** Per-user request budgets on top of the central read/write classes (p7-rate-limit). */
export const RATE = {
  write: { max: 60, windowMs: 60_000 },
  zip: { max: 10, windowMs: 60_000 },
} as const;

/** A tag: letters/digits first, then letters, digits, space, `_ . -` (trimmed, at most 40 characters). */
export const Tag = z
  .string()
  .transform((t) => t.trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(LIMITS.tagMax)
      .regex(/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u, 'tag: letters, digits, space, _ . -'),
  );

export const Tags = z
  .array(Tag)
  .max(LIMITS.tagsMax)
  .transform((tags) => [...new Set(tags)]);

/** An https link of a note card (no credentials in the URL, no other scheme). */
export const HttpsLink = z
  .string()
  .max(LIMITS.linkMax)
  .refine((s) => {
    try {
      const u = new URL(s);
      return u.protocol === 'https:' && u.username === '' && u.password === '' && u.hostname !== '';
    } catch {
      return false;
    }
  }, 'an https:// link without credentials');

export const Title = z
  .string()
  .max(LIMITS.titleMax)
  .transform((t) => t.trim());

/** Markdown text (rendered as text by the console; never HTML). NUL is not allowed in Postgres text. */
export const NoteBody = z
  .string()
  .max(LIMITS.noteMax)
  .refine((s) => !s.includes('\u0000'), 'no NUL characters');

export const ItemMetaUpdate = z.strictObject({
  project: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
  key: z.string().regex(ITEM_KEY),
  /** null or empty: back to the item's own name. */
  title: Title.nullable().optional(),
  tags: Tags.optional(),
  pinned: z.boolean().optional(),
});
export type ItemMetaUpdate = z.infer<typeof ItemMetaUpdate>;

export const NoteCardInput = z.strictObject({
  project: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
  title: Title.pipe(z.string().min(1)),
  body: NoteBody.default(''),
  tags: Tags.default([]),
  links: z.array(HttpsLink).max(LIMITS.linksMax).default([]),
  pinned: z.boolean().default(false),
});
export type NoteCardInput = z.infer<typeof NoteCardInput>;

export const NoteCardPatch = z.strictObject({
  title: Title.pipe(z.string().min(1)).optional(),
  body: NoteBody.optional(),
  tags: Tags.optional(),
  links: z.array(HttpsLink).max(LIMITS.linksMax).optional(),
  pinned: z.boolean().optional(),
});
export type NoteCardPatch = z.infer<typeof NoteCardPatch>;

/** How the console previews a file (decided by the master from the media type and the item's source). */
export type PreviewKind = 'markdown' | 'text' | 'json' | 'csv' | 'tsv' | 'image' | 'pdf' | 'diff' | 'none';

const RASTER = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function previewKindOf(
  mediaType: string | null,
  name: string,
  source: 'workspace' | 'run',
): PreviewKind {
  if (source === 'run') return name === 'attempt.diff' ? 'diff' : 'none';
  switch (mediaType) {
    case 'text/markdown':
      return 'markdown';
    case 'application/json':
      return 'json';
    case 'text/csv':
      return 'csv';
    case 'text/tab-separated-values':
      return 'tsv';
    case 'text/plain':
    case 'text/yaml':
      return 'text';
    case 'application/pdf':
      return 'pdf';
    default:
      return mediaType !== null && RASTER.has(mediaType) ? 'image' : 'none';
  }
}
