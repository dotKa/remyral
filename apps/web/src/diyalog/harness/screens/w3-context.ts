import type { ScreenRoutes } from './types';

/**
 * p12-diyalog wave 2 (W3) harness fixtures: Bağlam (`/context`, `/settings/context`). The global namespace has one
 * instructions document with three versions and a deleted one; a project namespace (mobil-app) has a reference
 * document; retention policies, deletion receipts, search settings and the new-project defaults. Also used by
 * apps/web/test/diyalog-w3-context.test.tsx.
 */

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const DAY = 24 * 60 * 60_000;

export const CTX_DOC = 'ctx_00000000000000000000000001';
export const CTX_DELETED = 'ctx_00000000000000000000000002';

export function ctxMeta(version: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version,
    title: `Kodlama kuralları v${String(version)}`,
    contentHash: String(version).repeat(64).slice(0, 64),
    sortOrder: 0,
    runtimes: null,
    changeNote: version === 1 ? null : `düzenleme ${String(version)}`,
    provenance: { type: 'user', userId: '00000000-0000-4000-8000-000000000001' },
    createdAt: iso((4 - version) * DAY),
    ...over,
  };
}

export function ctxDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CTX_DOC,
    namespace: 'global',
    kind: 'instructions',
    readRole: 'viewer',
    writeRole: 'operator',
    projectScope: 'namespace',
    projects: [],
    currentVersion: 3,
    createdBy: { type: 'user', id: '00000000-0000-4000-8000-000000000001' },
    createdAt: iso(4 * DAY),
    updatedAt: iso(DAY),
    deletedAt: null,
    deletedBy: null,
    deleteReason: null,
    purgeAfter: null,
    ...over,
  };
}

export const CTX_DOCS = {
  items: [
    { document: ctxDoc(), current: ctxMeta(3) },
    {
      document: ctxDoc({
        id: CTX_DELETED,
        kind: 'memory',
        currentVersion: 1,
        deletedAt: iso(2 * DAY),
        deletedBy: '00000000-0000-4000-8000-000000000001',
        deleteReason: 'eskidi',
        purgeAfter: new Date(NOW + 28 * DAY).toISOString(),
      }),
      current: ctxMeta(1, { title: 'Eski notlar', provenance: { type: 'agent', jobId: 'job_7f3a9c' } }),
    },
  ],
};

export const CTX_VERSIONS = {
  items: [ctxMeta(3), ctxMeta(2), ctxMeta(1, { provenance: { type: 'import', source: 'AGENTS.md' } })],
};

export const CTX_CONTENT: Readonly<Record<number, string>> = {
  1: 'TypeScript kullan.\n',
  2: 'TypeScript kullan.\nTestleri çalıştır.\n',
  3: 'Katı TypeScript kullan.\nTestleri çalıştır.\nSırları asla commit etme.\n',
};

export function ctxPolicy(namespace: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    namespace,
    explicit: true,
    version: 4,
    maxAgeDays: null,
    maxVersions: 20,
    legalHold: false,
    deleteRetentionDays: 30,
    memory: { enabled: true, maxBytes: 16384, maxPerJob: 5, maxPerHour: 20 },
    updatedAt: iso(3 * DAY),
    updatedBy: 'alex',
    ...over,
  };
}

export const CTX_RECEIPTS = {
  items: [
    {
      id: 'rcpt_1',
      occurredAt: iso(2 * DAY),
      action: 'delete',
      docId: CTX_DELETED,
      namespace: 'global',
      kind: 'memory',
      versions: [1],
      contentHashes: ['1'.repeat(64)],
      actor: { type: 'user', id: '00000000-0000-4000-8000-000000000001' },
      reason: 'eskidi',
      purgeAfter: new Date(NOW + 28 * DAY).toISOString(),
    },
    {
      id: 'rcpt_2',
      occurredAt: iso(9 * DAY),
      action: 'prune',
      docId: CTX_DOC,
      namespace: 'global',
      kind: 'instructions',
      versions: [0],
      contentHashes: ['0'.repeat(64)],
      actor: { type: 'system', id: null },
      reason: null,
      purgeAfter: null,
    },
  ],
};

export const CTX_SEARCH = {
  namespace: 'global',
  available: true,
  model: 'amazon.titan-embed-text-v2:0',
  provider: 'bedrock',
  dims: 1024,
  source: 'panel',
  region: 'eu-central-1',
  enabled: true,
  version: 2,
  indexed: 41,
  updatedAt: iso(DAY),
  updatedBy: 'alex',
  origin: 'explicit',
};

export const CTX_DEFAULTS = { projectCapture: true, memoryMode: 'rules', version: 1, backfilledAt: null };

export const ROUTES: ScreenRoutes = {
  '/context/docs': (u) => {
    const ns = u.searchParams.get('namespace') ?? 'global';
    if (ns === 'global') {
      const all = u.searchParams.get('includeDeleted') === 'true';
      return { items: all ? CTX_DOCS.items : CTX_DOCS.items.filter((d) => d.document.deletedAt === null) };
    }
    return {
      items: [
        {
          document: ctxDoc({ id: 'ctx_mobil', namespace: ns, kind: 'reference', currentVersion: 1 }),
          current: ctxMeta(1, { title: 'Mağaza yayın kontrol listesi' }),
        },
      ],
    };
  },
  [`/context/docs/${CTX_DOC}/versions`]: () => CTX_VERSIONS,
  [`/context/docs/${CTX_DOC}/versions/1`]: () => ({ ...ctxMeta(1), content: CTX_CONTENT[1] }),
  [`/context/docs/${CTX_DOC}/versions/2`]: () => ({ ...ctxMeta(2), content: CTX_CONTENT[2] }),
  [`/context/docs/${CTX_DOC}/versions/3`]: () => ({ ...ctxMeta(3), content: CTX_CONTENT[3] }),
  '/context/policies': (u, method) =>
    method === 'GET' ? { items: [ctxPolicy(u.searchParams.get('namespace') ?? 'global')] } : undefined,
  '/context/deletion-receipts': () => CTX_RECEIPTS,
  '/context/search/settings': (u, method) =>
    method === 'GET' ? { ...CTX_SEARCH, namespace: u.searchParams.get('namespace') ?? 'global' } : undefined,
  '/context/defaults': (_u, method) => (method === 'GET' ? CTX_DEFAULTS : undefined),
  '/memory-records': (_u, method) => (method === 'GET' ? { items: [] } : undefined),
  '/memory-records/conflicts': () => ({ items: [] }),
};
