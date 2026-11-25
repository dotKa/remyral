import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str, strArray } from './client';

/**
 * p10-semantic-defaults-chat (docs/design/p10-semantic-memory.md §12; apps/master/src/chat/routes.ts): conversations as
 * knowledge — "search my conversations", the thread's project and its sharing with project knowledge, the personal
 * settings, and the related items a turn used. Snippets come from conversations and documents: text only.
 */

type Opts = Omit<RequestOptions, 'body'>;

export type NotSharedReason = 'thread_off' | 'personal_off' | 'indexing_off' | 'capture_off' | 'no_access';

export interface ThreadKnowledge {
  readonly project: string | null;
  /** "Share with project knowledge" for this conversation. */
  readonly share: boolean;
  /** The personal setting (Settings → Chat). */
  readonly personalShare: boolean;
  readonly sharedWith: readonly string[];
  readonly notShared: readonly { readonly project: string; readonly reason: NotSharedReason }[];
  readonly suggestedProject: string | null;
  /** p10-chat-memory-suggestions: projects offering "Summarise this conversation for project memory". */
  readonly memorySummary: readonly string[];
  /** p18-multi-project W3: the working projects (primary first), each with its own sharing switch. */
  readonly projects: readonly ThreadProject[];
}

/** p18-multi-project W3: one working project of a conversation. */
export interface ThreadProject {
  readonly project: string;
  readonly name: string;
  readonly kind: 'repository' | 'workspace';
  /** The signed-in user's role there (null: no access any more — dropped at the next message). */
  readonly role: string | null;
  /** "Proje bilgisiyle paylaş" for this project. */
  readonly share: boolean;
  readonly primary: boolean;
}

/** Lenient: an entry that does not parse is left out (an older master sends none). */
export function parseThreadProjects(v: unknown): ThreadProject[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((m): ThreadProject[] => {
    if (m === null || typeof m !== 'object') return [];
    const x = m as Record<string, unknown>;
    if (typeof x.project !== 'string') return [];
    return [
      {
        project: x.project,
        name: typeof x.name === 'string' ? x.name : x.project,
        kind: x.kind === 'workspace' ? 'workspace' : 'repository',
        role: typeof x.role === 'string' ? x.role : null,
        share: x.share !== false,
        primary: x.primary === true,
      },
    ];
  });
}

export interface ChatKnowledgePrefs {
  readonly indexConversations: boolean;
  readonly shareProjects: boolean;
  readonly autoRelated: boolean;
  readonly version: number;
}

export interface OwnChatHit {
  readonly threadId: string;
  readonly threadTitle: string;
  readonly archived: boolean;
  readonly messageId: string;
  readonly seq: number;
  readonly author: 'user' | 'assistant';
  readonly attachmentName: string | null;
  readonly snippet: string;
  readonly at: string;
  /** p18-leftovers: the hit is a plan of the conversation (older masters: null). */
  readonly plan: { readonly id: string; readonly title: string } | null;
}

export interface OwnChatResult {
  readonly mode: 'semantic' | 'keyword';
  readonly fallbackReason: string | null;
  readonly items: readonly OwnChatHit[];
}

export type RelatedKind = 'own_chat' | 'project_chat' | 'context_doc' | 'job_summary';

export interface RelatedItem {
  readonly kind: RelatedKind;
  readonly id: string;
  readonly project: string | null;
  readonly title: string;
  readonly at: string | null;
  /** A console-relative link; null for another person's conversation (private). */
  readonly link: string | null;
}

export interface RelatedUse {
  readonly mode: 'semantic' | 'keyword';
  readonly items: readonly RelatedItem[];
}

const REASONS: readonly NotSharedReason[] = [
  'thread_off',
  'personal_off',
  'indexing_off',
  'capture_off',
  'no_access',
];
const KINDS: readonly RelatedKind[] = ['own_chat', 'project_chat', 'context_doc', 'job_summary'];
/** Only console-relative links are rendered (the master builds them; anything else is dropped). */
const LOCAL_LINK = /^\/(?!\/)[A-Za-z0-9/_.:=?&%-]{0,500}$/;

function bool(o: Record<string, unknown>, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new ShapeError(key);
  return v;
}

export function parseThreadKnowledge(v: unknown): ThreadKnowledge {
  const o = obj(v);
  const notShared = Array.isArray(o.notShared) ? o.notShared : [];
  return {
    project: nullableStr(o, 'project'),
    share: bool(o, 'share'),
    personalShare: bool(o, 'personalShare'),
    sharedWith: strArray(o, 'sharedWith'),
    notShared: notShared.flatMap((n) => {
      const x = obj(n);
      const reason = str(x, 'reason');
      return REASONS.includes(reason as NotSharedReason)
        ? [{ project: str(x, 'project'), reason: reason as NotSharedReason }]
        : [];
    }),
    suggestedProject: nullableStr(o, 'suggestedProject'),
    memorySummary: Array.isArray(o.memorySummary) ? strArray(o, 'memorySummary') : [],
    projects: parseThreadProjects(o.projects),
  };
}

function parsePrefs(v: unknown): ChatKnowledgePrefs {
  const o = obj(v);
  return {
    indexConversations: bool(o, 'indexConversations'),
    shareProjects: bool(o, 'shareProjects'),
    autoRelated: bool(o, 'autoRelated'),
    version: int(o, 'version'),
  };
}

function parseOwnHit(v: unknown): OwnChatHit {
  const o = obj(v);
  const author = str(o, 'author');
  return {
    threadId: str(o, 'threadId'),
    threadTitle: str(o, 'threadTitle'),
    archived: bool(o, 'archived'),
    messageId: str(o, 'messageId'),
    seq: int(o, 'seq'),
    author: author === 'assistant' ? 'assistant' : 'user',
    attachmentName: nullableStr(o, 'attachmentName'),
    snippet: str(o, 'snippet'),
    at: str(o, 'at'),
    plan: (() => {
      const p = o.plan;
      if (p === null || typeof p !== 'object') return null;
      const r = p as Record<string, unknown>;
      return typeof r.id === 'string' && typeof r.title === 'string' ? { id: r.id, title: r.title } : null;
    })(),
  };
}

/**
 * The related items a user message's turn used (`meta.related` of the user message), or null. Lenient: an item that
 * does not parse is left out; links that are not console-relative are dropped.
 */
export function relatedOf(meta: Record<string, unknown> | null): RelatedUse | null {
  const r = meta?.related;
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return null;
  const o = r as Record<string, unknown>;
  const items = (Array.isArray(o.items) ? o.items : []).slice(0, 20).flatMap((i): RelatedItem[] => {
    if (i === null || typeof i !== 'object') return [];
    const x = i as Record<string, unknown>;
    if (typeof x.id !== 'string' || typeof x.title !== 'string') return [];
    if (!KINDS.includes(x.kind as RelatedKind)) return [];
    const link = typeof x.link === 'string' && LOCAL_LINK.test(x.link) ? x.link : null;
    return [
      {
        kind: x.kind as RelatedKind,
        id: x.id,
        project: typeof x.project === 'string' ? x.project : null,
        title: x.title.slice(0, 200),
        at: typeof x.at === 'string' ? x.at : null,
        link,
      },
    ];
  });
  if (items.length === 0) return null;
  return { mode: o.mode === 'keyword' ? 'keyword' : 'semantic', items };
}

/** p12-diyalog-cmdk: one result of "search everywhere" (the command palette's AI search). */
export interface EverywhereHit {
  readonly kind: RelatedKind;
  readonly id: string;
  readonly project: string | null;
  readonly title: string;
  readonly snippet: string;
  readonly at: string | null;
  /** Console-relative link (null: not openable by the caller, e.g. another person's shared chat). */
  readonly link: string | null;
  readonly match: 'semantic' | 'keyword';
}

export interface EverywhereResult {
  readonly mode: 'semantic' | 'keyword';
  readonly fallbackReason: string | null;
  readonly projects: number;
  readonly items: readonly EverywhereHit[];
}

/**
 * p12-diyalog-cmdk: `GET /chat/search/everywhere` — by meaning (keyword fallback) across the caller's own
 * conversations and the knowledge of the projects they may read. Lenient: an item that does not parse is left out;
 * links that are not console-relative are dropped.
 */
export function searchEverywhere(q: string, opts: Opts = {}): Promise<EverywhereResult> {
  return apiRequest(
    'GET',
    `/chat/search/everywhere?q=${encodeURIComponent(q)}&limit=12`,
    (v) => {
      const o = obj(v);
      const items = (Array.isArray(o.items) ? o.items : []).flatMap((i): EverywhereHit[] => {
        if (i === null || typeof i !== 'object') return [];
        const x = i as Record<string, unknown>;
        if (typeof x.id !== 'string' || typeof x.title !== 'string') return [];
        if (!KINDS.includes(x.kind as RelatedKind)) return [];
        return [
          {
            kind: x.kind as RelatedKind,
            id: x.id,
            project: typeof x.project === 'string' ? x.project : null,
            title: x.title.slice(0, 200),
            snippet: typeof x.snippet === 'string' ? x.snippet.slice(0, 400) : '',
            at: typeof x.at === 'string' ? x.at : null,
            link: typeof x.link === 'string' && LOCAL_LINK.test(x.link) ? x.link : null,
            match: x.match === 'keyword' ? 'keyword' : 'semantic',
          },
        ];
      });
      return {
        mode: o.mode === 'keyword' ? 'keyword' : 'semantic',
        fallbackReason: nullableStr(o, 'fallbackReason'),
        projects: typeof o.projects === 'number' ? o.projects : 0,
        items,
      };
    },
    opts,
  );
}

export function searchMyChats(q: string, opts: Opts = {}): Promise<OwnChatResult> {
  return apiRequest(
    'GET',
    `/chat/search?q=${encodeURIComponent(q)}&limit=20`,
    (v) => {
      const o = obj(v);
      return {
        mode: o.mode === 'semantic' ? 'semantic' : 'keyword',
        fallbackReason: nullableStr(o, 'fallbackReason'),
        items: (Array.isArray(o.items) ? o.items : []).map(parseOwnHit),
      };
    },
    opts,
  );
}

export function getChatKnowledgePrefs(opts: Opts = {}): Promise<ChatKnowledgePrefs> {
  return apiRequest('GET', '/chat/knowledge/preferences', parsePrefs, opts);
}

export function putChatKnowledgePrefs(
  body: {
    indexConversations: boolean;
    shareProjects: boolean;
    autoRelated: boolean;
    expectedVersion: number;
  },
  opts: Opts = {},
): Promise<ChatKnowledgePrefs> {
  return apiRequest('PUT', '/chat/knowledge/preferences', parsePrefs, { ...opts, body });
}

export function setThreadKnowledge(
  threadId: string,
  patch: { project?: string | null; share?: boolean },
  opts: Opts = {},
): Promise<ThreadKnowledge> {
  return apiRequest('PUT', `/chat/threads/${encodeURIComponent(threadId)}/knowledge`, parseThreadKnowledge, {
    ...opts,
    body: patch,
  });
}

/**
 * p18-multi-project W3: `PUT /chat/threads/:id/projects` — the whole set of working projects, the first is the primary
 * (at most 8; projects the user can read), each with its "Proje bilgisiyle paylaş" switch.
 */
export function setThreadProjects(
  threadId: string,
  projects: readonly { readonly project: string; readonly share?: boolean }[],
  opts: Opts = {},
): Promise<ThreadProject[]> {
  return apiRequest(
    'PUT',
    `/chat/threads/${encodeURIComponent(threadId)}/projects`,
    (v) => parseThreadProjects(obj(v).projects),
    { ...opts, body: { projects } },
  );
}

/** p18-multi-project W3: at most this many working projects per conversation (the primary + 7). */
export const MAX_THREAD_PROJECTS = 8;

/** Why a search said "by keywords". */
export const CHAT_FALLBACK_TEXT: Readonly<Record<string, string>> = {
  unavailable: 'no embedding provider is configured',
  opted_out: 'you switched indexing of your conversations off',
  query_rejected: 'the query looks like it contains a secret, so it was not sent anywhere',
  provider_error: 'the embedding provider did not answer',
  rate_limited: 'too many searches in the last minute',
};

export const NOT_SHARED_TEXT: Readonly<Record<NotSharedReason, string>> = {
  thread_off: 'sharing is off for this conversation',
  personal_off: 'you switched sharing off in Settings → Chat',
  indexing_off: 'you switched indexing of your conversations off in Settings → Chat',
  capture_off: 'the project’s knowledge capture is off',
  no_access: 'you cannot read that project',
};
