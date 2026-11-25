import { parseSource, type ProviderSource } from './bedrock';
import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * Typed wrappers for the optional semantic search (apps/master/src/search, docs/design/p6-vector.md):
 * the per-namespace capture consent, reindex and the project-scoped search. Consent changes and reindex
 * need a fresh step-up: callers run them through `useStepUp().run`.
 */

type Opts = Omit<RequestOptions, 'body'>;

export interface SearchSettings {
  readonly namespace: string;
  readonly available: boolean;
  readonly model: string | null;
  /** p10-semantic-memory: provider label (`bedrock`, `http`, `local-hash`) and vector length, when known. */
  readonly provider: string | null;
  readonly dims: number | null;
  /** p10-bedrock-integration-panel: where the provider is configured, and its Bedrock region. */
  readonly source: ProviderSource | null;
  readonly region: string | null;
  readonly enabled: boolean;
  readonly version: number;
  readonly indexed: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  /**
   * p10-semantic-defaults-chat: where the setting came from — `explicit`, `create` (the create-project form),
   * `platform_default` (switched on for existing projects by the platform default); null when never set.
   */
  readonly origin: 'explicit' | 'create' | 'platform_default' | null;
}

/** p10-semantic-defaults-chat: a conversation someone shared with the project. */
export interface ChatProvenance {
  readonly author: 'user' | 'assistant';
  readonly ownerName: string;
  readonly seq: number;
  readonly at: string;
  /** Only for your own conversation (nobody else can open it). */
  readonly threadId: string | null;
}

export interface SearchHit {
  readonly type: 'context_doc' | 'job_summary' | 'chat_message';
  readonly id: string;
  readonly namespace: string;
  readonly title: string;
  readonly snippet: string;
  readonly version: string;
  readonly score: number;
  readonly chat?: ChatProvenance;
}

export interface ReindexResult {
  readonly indexedDocs: number;
  readonly indexedJobs: number;
  readonly removed: number;
}

function bool(o: Record<string, unknown>, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new ShapeError(`expected boolean at ${key}`);
  return v;
}

function num(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ShapeError(`expected number at ${key}`);
  return v;
}

export function parseSettings(v: unknown): SearchSettings {
  const o = obj(v);
  return {
    namespace: str(o, 'namespace'),
    available: bool(o, 'available'),
    model: nullableStr(o, 'model'),
    provider: typeof o.provider === 'string' ? o.provider : null,
    dims: typeof o.dims === 'number' && Number.isInteger(o.dims) ? o.dims : null,
    source: parseSource(o.source),
    region: typeof o.region === 'string' ? o.region : null,
    enabled: bool(o, 'enabled'),
    version: int(o, 'version'),
    indexed: int(o, 'indexed'),
    updatedAt: nullableStr(o, 'updatedAt'),
    updatedBy: nullableStr(o, 'updatedBy'),
    origin:
      o.origin === 'explicit' || o.origin === 'create' || o.origin === 'platform_default' ? o.origin : null,
  };
}

function parseChat(v: unknown): ChatProvenance | undefined {
  if (v === undefined || v === null) return undefined;
  const o = obj(v);
  return {
    author: o.author === 'assistant' ? 'assistant' : 'user',
    ownerName: str(o, 'ownerName'),
    seq: int(o, 'seq'),
    at: str(o, 'at'),
    threadId: nullableStr(o, 'threadId'),
  };
}

function parseHit(v: unknown): SearchHit {
  const o = obj(v);
  const type = str(o, 'type');
  if (type !== 'context_doc' && type !== 'job_summary' && type !== 'chat_message') {
    throw new ShapeError('unexpected hit type');
  }
  const chat = parseChat(o.chat);
  return {
    type,
    id: str(o, 'id'),
    namespace: str(o, 'namespace'),
    title: str(o, 'title'),
    snippet: str(o, 'snippet'),
    version: str(o, 'version'),
    score: num(o, 'score'),
    ...(chat === undefined ? {} : { chat }),
  };
}

/** p10-semantic-defaults-chat: the project knowledge defaults for new projects (admin). */
export interface KnowledgeDefaults {
  readonly projectCapture: boolean;
  readonly memoryMode: 'off' | 'rules' | 'assisted';
  readonly version: number;
  readonly backfilledAt: string | null;
}

function parseDefaults(v: unknown): KnowledgeDefaults {
  const o = obj(v);
  const mode = str(o, 'memoryMode');
  return {
    projectCapture: bool(o, 'projectCapture'),
    memoryMode: mode === 'assisted' ? 'assisted' : mode === 'rules' ? 'rules' : 'off',
    version: int(o, 'version'),
    backfilledAt: nullableStr(o, 'backfilledAt'),
  };
}

export function getKnowledgeDefaults(opts: Opts = {}): Promise<KnowledgeDefaults> {
  return apiRequest('GET', '/context/defaults', parseDefaults, opts);
}

export function putKnowledgeDefaults(
  body: { projectCapture: boolean; memoryMode: KnowledgeDefaults['memoryMode']; expectedVersion: number },
  opts: Opts = {},
): Promise<KnowledgeDefaults> {
  return apiRequest('PUT', '/context/defaults', parseDefaults, { ...opts, body });
}

const enc = encodeURIComponent;

export function getSearchSettings(namespace: string, opts: Opts = {}): Promise<SearchSettings> {
  return apiRequest('GET', `/context/search/settings?namespace=${enc(namespace)}`, parseSettings, opts);
}

export function setSearchConsent(
  body: { readonly namespace: string; readonly enabled: boolean; readonly expectedVersion: number },
  opts: Opts = {},
): Promise<SearchSettings> {
  return apiRequest('PUT', '/context/search/settings', parseSettings, { ...opts, body });
}

export function reindexSearch(namespace: string, opts: Opts = {}): Promise<ReindexResult> {
  return apiRequest(
    'POST',
    '/context/search/reindex',
    (v) => {
      const o = obj(v);
      return {
        indexedDocs: int(o, 'indexedDocs'),
        indexedJobs: int(o, 'indexedJobs'),
        removed: int(o, 'removed'),
      };
    },
    { ...opts, body: { namespace } },
  );
}

export function searchContext(project: string, q: string, opts: Opts = {}): Promise<SearchHit[]> {
  return apiRequest(
    'GET',
    `/context/search?project=${enc(project)}&q=${enc(q)}&limit=20`,
    (v) => {
      const list = obj(v).items;
      if (!Array.isArray(list)) throw new ShapeError('expected items');
      return list.map(parseHit);
    },
    opts,
  );
}

/** p10-semantic-memory: how a search was answered, and why not by meaning. */
export type SearchMode = 'semantic' | 'keyword';
export type FallbackReason =
  'unavailable' | 'not_enabled' | 'query_rejected' | 'provider_error' | 'rate_limited';

export interface FoundContext {
  readonly mode: SearchMode;
  readonly fallbackReason: FallbackReason | null;
  readonly items: readonly SearchHit[];
}

const REASONS: readonly FallbackReason[] = [
  'unavailable',
  'not_enabled',
  'query_rejected',
  'provider_error',
  'rate_limited',
];

/** What a keyword fallback means, for a hint next to the results. */
export const FALLBACK_TEXT: Readonly<Record<FallbackReason, string>> = {
  unavailable: 'no embedding provider is configured',
  not_enabled: 'semantic search is off for this project',
  query_rejected: 'the query looks like it contains a secret, so it was not sent to the provider',
  provider_error: 'the embedding provider did not answer',
  rate_limited: 'too many searches by meaning this minute',
};

/**
 * p10-semantic-memory: search by meaning where the project allows it, else by keywords (never sent anywhere).
 * `type` narrows to documents or job summaries.
 */
export function findContext(
  project: string,
  q: string,
  options: { readonly type?: SearchHit['type']; readonly limit?: number } = {},
  opts: Opts = {},
): Promise<FoundContext> {
  const extra = `${options.type === undefined ? '' : `&type=${options.type}`}&limit=${String(options.limit ?? 20)}`;
  return apiRequest(
    'GET',
    `/context/search?project=${enc(project)}&q=${enc(q)}&fallback=keyword${extra}`,
    (v) => {
      const o = obj(v);
      const list = o.items;
      if (!Array.isArray(list)) throw new ShapeError('expected items');
      const mode = o.mode === 'keyword' ? 'keyword' : 'semantic';
      const reason = REASONS.find((r) => r === o.fallbackReason) ?? null;
      return { mode, fallbackReason: reason, items: list.map(parseHit) };
    },
    opts,
  );
}
