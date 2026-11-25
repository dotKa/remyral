import { apiRequest, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * p10-chat-organize (docs/design/p10-chat-organize.md; apps/master/src/chat/organize-routes.ts): the caller's own
 * pins, groups, tags and starred messages, and the chat sidebar's read model. Labels, links and snippets come from
 * conversations (partly model-written): render them as text only.
 */

type Opts = Omit<RequestOptions, 'body'>;

export const TAG_COLORS = [
  'gray',
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export interface ChatGroup {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly collapsed: boolean;
  readonly threadCount: number;
}

export interface ChatTag {
  readonly id: string;
  readonly name: string;
  readonly color: TagColor;
  readonly threadCount: number;
}

export interface ChatOrganize {
  readonly groups: readonly ChatGroup[];
  readonly tags: readonly ChatTag[];
  /** Pinned conversations that are not archived. */
  readonly pinned: number;
}

export const EMPTY_ORGANIZE: ChatOrganize = { groups: [], tags: [], pinned: 0 };

export const ASSET_KINDS = ['starred', 'media', 'links', 'files', 'jobs'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export interface ChatAsset {
  readonly kind: AssetKind;
  readonly key: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly messageId: string | null;
  readonly seq: number | null;
  readonly createdAt: string;
  readonly label: string;
  readonly detail: string | null;
  /** Same-origin content URL (`/api/…`) or, for links, the external http(s) URL. */
  readonly url: string | null;
  /** Console page (job, run, automation, deploy, monitor). */
  readonly href: string | null;
  readonly domain: string | null;
  readonly mediaType: string | null;
  readonly sizeBytes: number | null;
  readonly role: 'user' | 'assistant' | null;
  readonly source: 'attachment' | 'artifact' | null;
  readonly draftKind: string | null;
  readonly draftState: string | null;
  readonly state: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Console-relative only (never an absolute or protocol-relative URL). */
const LOCAL = /^\/(?!\/)[A-Za-z0-9/_.:=?&%-]{0,500}$/;

const s = (o: Record<string, unknown>, k: string): string | null => {
  const v = o[k];
  return typeof v === 'string' ? v : null;
};
const n = (o: Record<string, unknown>, k: string): number | null => {
  const v = o[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

function isColor(v: unknown): v is TagColor {
  return typeof v === 'string' && (TAG_COLORS as readonly string[]).includes(v);
}

export function parseGroup(v: unknown): ChatGroup {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    name: str(o, 'name'),
    position: n(o, 'position') ?? 0,
    collapsed: o.collapsed === true,
    threadCount: n(o, 'threadCount') ?? 0,
  };
}

export function parseTag(v: unknown): ChatTag {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    name: str(o, 'name'),
    color: isColor(o.color) ? o.color : 'gray',
    threadCount: n(o, 'threadCount') ?? 0,
  };
}

/** The `organize` summary of a thread-list answer; absent or malformed (older master) → null. */
export function parseOrganize(v: unknown): ChatOrganize | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.groups) || !Array.isArray(o.tags)) return null;
  try {
    return {
      groups: o.groups.map(parseGroup),
      tags: o.tags.map(parseTag),
      pinned: typeof o.pinned === 'number' ? o.pinned : 0,
    };
  } catch {
    return null;
  }
}

/** Only http(s) survives for links; content URLs must be same-origin API paths. */
function safeUrl(kind: AssetKind, url: string | null): string | null {
  if (url === null) return null;
  if (kind === 'links') {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
    } catch {
      return null;
    }
  }
  return url.startsWith('/api/') && LOCAL.test(url) ? url : null;
}

export function parseAsset(v: unknown): ChatAsset {
  const o = obj(v);
  const kind = o.kind;
  if (typeof kind !== 'string' || !(ASSET_KINDS as readonly string[]).includes(kind)) {
    throw new ShapeError('kind');
  }
  const k = kind as AssetKind;
  const messageId = s(o, 'messageId');
  const href = s(o, 'href');
  const role = o.role === 'user' || o.role === 'assistant' ? o.role : null;
  const source = o.source === 'attachment' || o.source === 'artifact' ? o.source : null;
  return {
    kind: k,
    key: str(o, 'key'),
    threadId: str(o, 'threadId'),
    threadTitle: s(o, 'threadTitle') ?? '',
    messageId: messageId !== null && UUID.test(messageId) ? messageId : null,
    seq: n(o, 'seq'),
    createdAt: str(o, 'createdAt'),
    label: str(o, 'label'),
    detail: s(o, 'detail'),
    url: safeUrl(k, s(o, 'url')),
    href: href !== null && LOCAL.test(href) ? href : null,
    domain: s(o, 'domain'),
    mediaType: s(o, 'mediaType'),
    sizeBytes: n(o, 'sizeBytes'),
    role,
    source,
    draftKind: s(o, 'draftKind'),
    draftState: s(o, 'draftState'),
    state: s(o, 'state'),
  };
}

const enc = encodeURIComponent;

export function getOrganize(opts: Opts = {}): Promise<ChatOrganize> {
  return apiRequest('GET', '/chat/organize', (v) => parseOrganize(v) ?? EMPTY_ORGANIZE, opts);
}

export function pinThread(threadId: string, pinned: boolean, opts: Opts = {}): Promise<string | null> {
  return apiRequest('PUT', `/chat/threads/${enc(threadId)}/pin`, (v) => s(obj(v), 'pinnedAt'), {
    ...opts,
    body: { pinned },
  });
}

export function moveThreadToGroup(threadId: string, groupId: string | null, opts: Opts = {}): Promise<void> {
  return apiRequest('PUT', `/chat/threads/${enc(threadId)}/group`, () => undefined, {
    ...opts,
    body: { groupId },
  });
}

export function setThreadTags(
  threadId: string,
  tagIds: readonly string[],
  opts: Opts = {},
): Promise<string[]> {
  return apiRequest(
    'PUT',
    `/chat/threads/${enc(threadId)}/tags`,
    (v) => {
      const ids = obj(v).tagIds;
      return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
    },
    { ...opts, body: { tagIds: [...tagIds] } },
  );
}

export function createGroup(name: string, opts: Opts = {}): Promise<ChatGroup> {
  return apiRequest('POST', '/chat/groups', parseGroup, { ...opts, body: { name } });
}

export function updateGroup(
  id: string,
  patch: { name?: string; collapsed?: boolean; position?: number },
  opts: Opts = {},
): Promise<ChatGroup> {
  return apiRequest('PATCH', `/chat/groups/${enc(id)}`, parseGroup, { ...opts, body: patch });
}

export function deleteGroup(id: string, opts: Opts = {}): Promise<void> {
  return apiRequest('DELETE', `/chat/groups/${enc(id)}`, () => undefined, opts);
}

export function createTag(name: string, color: TagColor, opts: Opts = {}): Promise<ChatTag> {
  return apiRequest('POST', '/chat/tags', parseTag, { ...opts, body: { name, color } });
}

export function updateTag(
  id: string,
  patch: { name?: string; color?: TagColor },
  opts: Opts = {},
): Promise<ChatTag> {
  return apiRequest('PATCH', `/chat/tags/${enc(id)}`, parseTag, { ...opts, body: patch });
}

export function deleteTag(id: string, opts: Opts = {}): Promise<void> {
  return apiRequest('DELETE', `/chat/tags/${enc(id)}`, () => undefined, opts);
}

export function starMessage(messageId: string, starred: boolean, opts: Opts = {}): Promise<boolean> {
  return apiRequest('PUT', `/chat/messages/${enc(messageId)}/star`, (v) => obj(v).starred === true, {
    ...opts,
    body: { starred },
  });
}

/** One page of the sidebar: one conversation (`threadId`) or all the caller's conversations (null). */
export function listAssets(
  kind: AssetKind,
  threadId: string | null,
  cursor: string | null = null,
  opts: Opts = {},
): Promise<{ items: ChatAsset[]; nextCursor: string | null }> {
  const p = new URLSearchParams({ kind });
  if (cursor !== null) p.set('cursor', cursor);
  const path = threadId === null ? '/chat/assets' : `/chat/threads/${enc(threadId)}/assets`;
  return apiRequest(
    'GET',
    `${path}?${p.toString()}`,
    (v) => {
      const o = obj(v);
      const items = Array.isArray(o.items)
        ? o.items.flatMap((i) => {
            try {
              return [parseAsset(i)];
            } catch {
              return [];
            }
          })
        : [];
      return { items, nextCursor: typeof o.nextCursor === 'string' ? o.nextCursor : null };
    },
    opts,
  );
}
