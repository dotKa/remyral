import { API_PREFIX, ApiError, apiRequest, obj, type RequestOptions, str } from './client';
import {
  type ChatMessage,
  type ChatThread,
  parseMessage,
  parseSharedThread,
  parseThread,
  type SharedThread,
} from './chat';

export type { SharedThread } from './chat';

/**
 * p16-chat-complete (docs/design/p16-chat-complete.md; apps/master/src/chat/complete-routes.ts): edit / regenerate /
 * retry, export, sharing and handing over a conversation.
 */

type Opts = Omit<RequestOptions, 'body'>;

const t = (id: string): string => `/chat/threads/${encodeURIComponent(id)}`;

/** What a replaced answer did (409 `turn_acted`): shown before the person confirms. */
export interface TurnEffects {
  readonly actions: number;
  readonly tools: readonly { readonly name: string; readonly summary: string }[];
  readonly cards: readonly {
    readonly id: string;
    readonly kind: string;
    readonly title: string;
    readonly state: string;
  }[];
}

/** The effects of a `turn_acted` refusal, or null for any other error. */
export function actedEffects(err: unknown): TurnEffects | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.code !== 'turn_acted') return null;
  const e = err.details.effects;
  if (typeof e !== 'object' || e === null) return { actions: 0, tools: [], cards: [] };
  const x = e as Record<string, unknown>;
  const list = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v)
      ? v.filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null)
      : [];
  const s = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    actions: typeof x.actions === 'number' ? x.actions : 0,
    tools: list(x.tools).map((i) => ({ name: s(i.name), summary: s(i.summary) })),
    cards: list(x.cards).map((i) => ({ id: s(i.id), kind: s(i.kind), title: s(i.title), state: s(i.state) })),
  };
}

export function editMessage(
  threadId: string,
  messageId: string,
  text: string,
  acknowledgeActions = false,
  opts: Opts = {},
): Promise<{ message: ChatMessage; turnId: string }> {
  return apiRequest(
    'POST',
    `${t(threadId)}/messages/${encodeURIComponent(messageId)}/edit`,
    (v) => {
      const o = obj(v);
      return { message: parseMessage(o.message), turnId: str(o, 'turnId') };
    },
    { ...opts, body: { text, ...(acknowledgeActions ? { acknowledgeActions: true } : {}) } },
  );
}

export interface RegenerateRequest {
  readonly messageId?: string;
  readonly runtime?: string;
  readonly model?: string;
  readonly mode?: 'regenerate' | 'retry';
  readonly acknowledgeActions?: boolean;
}

export function regenerate(threadId: string, req: RegenerateRequest = {}, opts: Opts = {}): Promise<string> {
  const { acknowledgeActions, ...rest } = req;
  return apiRequest('POST', `${t(threadId)}/regenerate`, (v) => str(obj(v), 'turnId'), {
    ...opts,
    body: { ...rest, ...(acknowledgeActions === true ? { acknowledgeActions: true } : {}) },
  });
}

/** The Markdown download (a same-origin GET with the session cookie). */
export function exportMarkdownUrl(threadId: string, lang: 'tr' | 'en'): string {
  return `${API_PREFIX}${t(threadId)}/export?format=markdown&lang=${lang}`;
}

export interface ExportLink {
  readonly label: string;
  readonly href: string;
}

export type ExportItem =
  | {
      readonly kind: 'message';
      readonly role: 'user' | 'assistant';
      readonly author: string;
      readonly at: string;
      readonly text: string;
      readonly attachments: readonly {
        readonly name: string;
        readonly kind: string;
        readonly sizeBytes: number | null;
      }[];
      readonly mentions: readonly string[];
      readonly regenerated: { readonly runtime: string | null; readonly model: string | null } | null;
      readonly edited: boolean;
    }
  | { readonly kind: 'tools'; readonly at: string; readonly names: readonly string[] }
  | { readonly kind: 'notice'; readonly at: string; readonly text: string; readonly error: boolean }
  | {
      readonly kind: 'card';
      readonly at: string;
      readonly cardKind: string;
      readonly title: string;
      readonly state: string;
      readonly decidedAt: string | null;
      readonly links: readonly ExportLink[];
      readonly restricted: boolean;
    };

export interface ExportDoc {
  readonly thread: { readonly id: string; readonly title: string; readonly owner: string };
  readonly exportedAt: string;
  readonly exportedBy: string;
  readonly access: 'owner' | 'reader';
  readonly omittedVersions: number;
  readonly items: readonly ExportItem[];
}

const LOCAL_OR_HTTPS = /^(\/(?!\/)[A-Za-z0-9/_?=&.%:-]{0,500}|https:\/\/[^\s<>"]{1,500})$/;

function parseItem(v: unknown): ExportItem | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const s = (k: string): string => (typeof o[k] === 'string' ? o[k] : '');
  const list = (k: string): Record<string, unknown>[] =>
    Array.isArray(o[k])
      ? (o[k] as unknown[]).filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null)
      : [];
  switch (o.kind) {
    case 'message': {
      const r = o.regenerated as Record<string, unknown> | null | undefined;
      return {
        kind: 'message',
        role: o.role === 'user' ? 'user' : 'assistant',
        author: s('author'),
        at: s('at'),
        text: s('text'),
        attachments: list('attachments').map((a) => ({
          name: typeof a.name === 'string' ? a.name : '',
          kind: typeof a.kind === 'string' ? a.kind : 'file',
          sizeBytes: typeof a.sizeBytes === 'number' ? a.sizeBytes : null,
        })),
        mentions: Array.isArray(o.mentions)
          ? o.mentions.filter((m): m is string => typeof m === 'string')
          : [],
        regenerated:
          typeof r === 'object' && r !== null
            ? {
                runtime: typeof r.runtime === 'string' ? r.runtime : null,
                model: typeof r.model === 'string' ? r.model : null,
              }
            : null,
        edited: o.edited === true,
      };
    }
    case 'tools':
      return {
        kind: 'tools',
        at: s('at'),
        names: Array.isArray(o.names) ? o.names.filter((n): n is string => typeof n === 'string') : [],
      };
    case 'notice':
      return { kind: 'notice', at: s('at'), text: s('text'), error: o.error === true };
    case 'card':
      return {
        kind: 'card',
        at: s('at'),
        cardKind: s('cardKind'),
        title: s('title'),
        state: s('state'),
        decidedAt: typeof o.decidedAt === 'string' ? o.decidedAt : null,
        links: list('links').flatMap((l) =>
          typeof l.label === 'string' && typeof l.href === 'string' && LOCAL_OR_HTTPS.test(l.href)
            ? [{ label: l.label, href: l.href }]
            : [],
        ),
        restricted: o.restricted === true,
      };
    default:
      return null;
  }
}

export function getExport(threadId: string, opts: Opts = {}): Promise<ExportDoc> {
  return apiRequest(
    'GET',
    `${t(threadId)}/export?format=json`,
    (v) => {
      const o = obj(v);
      const th = obj(o.thread);
      return {
        thread: { id: str(th, 'id'), title: str(th, 'title'), owner: str(th, 'owner') },
        exportedAt: str(o, 'exportedAt'),
        exportedBy: str(o, 'exportedBy'),
        access: o.access === 'reader' ? 'reader' : 'owner',
        omittedVersions: typeof o.omittedVersions === 'number' ? o.omittedVersions : 0,
        items: (Array.isArray(o.items) ? o.items : []).flatMap((i) => {
          const p = parseItem(i);
          return p === null ? [] : [p];
        }),
      };
    },
    opts,
  );
}

export function listSharedThreads(opts: Opts = {}): Promise<SharedThread[]> {
  return apiRequest(
    'GET',
    '/chat/shared',
    (v) => (Array.isArray(obj(v).items) ? (obj(v).items as unknown[]) : []).map(parseSharedThread),
    opts,
  );
}

export interface ShareUser {
  readonly id: string;
  readonly username: string;
}

export interface ShareEntry {
  readonly userId: string;
  readonly username: string;
  readonly grantedAt: string;
}

const users = (v: unknown): ShareUser[] =>
  (Array.isArray(obj(v).items) ? (obj(v).items as unknown[]) : []).map((i) => ({
    id: str(obj(i), 'id'),
    username: str(obj(i), 'username'),
  }));
const entries = (v: unknown): ShareEntry[] =>
  (Array.isArray(obj(v).items) ? (obj(v).items as unknown[]) : []).map((i) => ({
    userId: str(obj(i), 'userId'),
    username: str(obj(i), 'username'),
    grantedAt: str(obj(i), 'grantedAt'),
  }));

export function searchShareUsers(q: string, opts: Opts = {}): Promise<ShareUser[]> {
  return apiRequest('GET', `/chat/share/users?q=${encodeURIComponent(q)}`, users, opts);
}

export function listShares(threadId: string, opts: Opts = {}): Promise<ShareEntry[]> {
  return apiRequest('GET', `${t(threadId)}/shares`, entries, opts);
}

export function addShare(threadId: string, userId: string, opts: Opts = {}): Promise<ShareEntry[]> {
  return apiRequest('PUT', `${t(threadId)}/shares/${encodeURIComponent(userId)}`, entries, {
    ...opts,
    body: {},
  });
}

export function removeShare(threadId: string, userId: string, opts: Opts = {}): Promise<void> {
  return apiRequest('DELETE', `${t(threadId)}/shares/${encodeURIComponent(userId)}`, () => undefined, opts);
}

export function transferThread(
  threadId: string,
  userId: string,
  keepAccess: boolean,
  opts: Opts = {},
): Promise<ChatThread> {
  return apiRequest('POST', `${t(threadId)}/transfer`, parseThread, {
    ...opts,
    body: { userId, keepAccess },
  });
}
