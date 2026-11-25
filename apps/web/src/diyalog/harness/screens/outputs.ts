import type { ScreenRoutes } from './types';

/** p12-diyalog Faz 4 harness fixtures for the Çıktılar screen. Return undefined to fall through to the base fixtures. */

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const JOB = '7c1e09ab-4b2f-4c1d-9a3e-5f6a7b8c9d0e';
const JOB2 = '2b9d4c11-8e3a-4f6b-a1c2-0d9e8f7a6b5c';

function file(name: string, media: string, size: number, msAgo: number, over: Record<string, unknown> = {}) {
  const id = `ws-${name.replace(/[^a-z0-9]+/gi, '-')}`;
  return {
    key: `file:${JOB}:${id}`,
    type: 'file',
    project: 'vitrin-web',
    title: null,
    name,
    tags: [],
    pinned: false,
    noteCount: 0,
    jobId: JOB,
    createdAt: iso(msAgo),
    site: null,
    file: {
      source: 'workspace',
      artifactId: id,
      kind: 'output',
      mediaType: media,
      sizeBytes: size,
      sha256: 'a'.repeat(64),
      redacted: false,
      removed: null,
      expiresAt: null,
      download: `/jobs/${JOB}/artifacts/${id}`,
      preview: media === 'text/markdown' ? 'markdown' : media === 'application/json' ? 'json' : 'text',
    },
    note: null,
    uptime: null,
    health: null,
    ...over,
  };
}

const SITE = {
  key: 'site:pages:vitrin-web:production',
  type: 'site',
  project: 'vitrin-web',
  title: 'Vitrin — mağaza vitrini',
  name: 'vitrin-web',
  tags: ['lansman', 'ekim'],
  pinned: true,
  noteCount: 2,
  jobId: JOB2,
  createdAt: iso(92 * MIN),
  site: {
    url: 'https://vitrin-web.pages.dev',
    env: 'production',
    provider: 'pages',
    target: 'pages:vitrin-web',
    opsActionId: '5d1c2b3a-4e5f-4a6b-9c8d-7e6f5a4b3c2d',
    opsKind: 'pages.deploy',
    deployedAt: iso(92 * MIN),
    protection: null,
    expiresAt: null,
  },
  file: null,
  note: null,
  uptime: {
    status: 'up',
    uptime24h: 99.93,
    monitors: [
      {
        id: 'm-1',
        name: 'vitrin-web',
        type: 'http',
        status: 'up',
        paused: false,
        uptime24h: 99.93,
        detail: null,
        lastCheckAt: iso(MIN),
      },
    ],
  },
  health: null,
};

const PREVIEW = {
  ...SITE,
  key: `site:tunnel:${JOB}`,
  title: null,
  name: 'odeme-api önizleme',
  project: 'odeme-api',
  tags: [],
  pinned: false,
  noteCount: 0,
  jobId: JOB,
  createdAt: iso(14 * MIN),
  site: {
    ...SITE.site,
    url: 'https://odeme-7c1e.trycloudflare.com',
    env: 'preview',
    provider: 'tunnel',
    protection: 'none',
    expiresAt: iso(-46 * MIN),
  },
  uptime: null,
};

const NOTE = {
  key: 'note:3f2e1d0c-9b8a-4c7d-8e6f-5a4b3c2d1e0f',
  type: 'note',
  project: 'vitrin-web',
  title: 'Lansman kontrol listesi',
  name: 'Lansman kontrol listesi',
  tags: ['lansman'],
  pinned: false,
  noteCount: 0,
  jobId: null,
  createdAt: iso(3 * 60 * MIN),
  site: null,
  file: null,
  note: {
    id: '3f2e1d0c-9b8a-4c7d-8e6f-5a4b3c2d1e0f',
    body: 'Ödeme sayfası erişilebilirlik turunu bitir.\nGörselleri sıkıştır, Lighthouse 95 üstü.',
    bodyTruncated: false,
    links: [],
    author: { id: 'u1', username: 'alex' },
    updatedAt: iso(3 * 60 * MIN),
  },
  uptime: null,
  health: null,
};

const ITEMS = [
  SITE,
  PREVIEW,
  file('rapor-erisilebilirlik.md', 'text/markdown', 18_420, 20 * MIN, {
    title: 'Erişilebilirlik raporu',
    pinned: true,
    noteCount: 1,
  }),
  file('lighthouse.json', 'application/json', 312_004, 25 * MIN),
  NOTE,
  file('build.log', 'text/plain', 1_204_551, 6 * 60 * MIN, {
    jobId: JOB2,
    key: `file:${JOB2}:ws-build-log`,
    project: 'mobil-app',
  }),
];

const FOLDER_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SUB_ID = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const FOLDER = {
  id: FOLDER_ID,
  scope: 'project',
  project: 'vitrin-web',
  parentId: null,
  depth: 1,
  name: 'Lansman raporları',
  note: 'Ekim lansmanı öncesi **son kontroller**: erişilebilirlik, Lighthouse ve ödeme akışı.',
  tags: ['lansman', 'rapor'],
  pinned: true,
  itemCount: 3,
  childCount: 1,
  createdBy: { id: 'u1', username: 'alex' },
  createdAt: iso(3 * 24 * 60 * MIN),
  updatedAt: iso(60 * MIN),
  writable: true,
  ancestors: [],
};

const node = (n: Record<string, unknown>): Record<string, unknown> => ({
  count: null,
  hasChildren: false,
  folderId: null,
  jobId: null,
  pinned: false,
  ...n,
});

export const ROUTES: ScreenRoutes = {
  '/projects': () => ({
    items: ['vitrin-web', 'mobil-app', 'odeme-api'].map((id) => ({
      id,
      name: id,
      kind: 'repo',
      createdAt: iso(30 * 24 * 60 * MIN),
      createdBy: null,
      members: 3,
      myRole: 'owner',
    })),
  }),
  '/outputs': (u) => {
    const type = u.searchParams.get('type');
    const pinned = u.searchParams.get('pinned') === 'true';
    const key = u.searchParams.get('key');
    const folder = u.searchParams.get('folder');
    const items = ITEMS.filter(
      (i) =>
        (type === null || i.type === type) &&
        (!pinned || i.pinned) &&
        (key === null || i.key === key) &&
        (folder === null || i.type === 'file'),
    );
    return { items, total: items.length };
  },
  '/outputs/tree': (u) => {
    const project = u.searchParams.get('project');
    const path = u.searchParams.get('path') ?? '';
    if (project === null)
      return path === 'personal'
        ? { nodes: [], total: 0 }
        : {
            nodes: [
              node({ project: null, path: 'personal', kind: 'personal', label: 'My folders', count: 2 }),
              node({
                project: 'vitrin-web',
                path: '',
                kind: 'project',
                label: 'vitrin-web',
                hasChildren: true,
              }),
              node({
                project: 'mobil-app',
                path: '',
                kind: 'project',
                label: 'mobil-app',
                hasChildren: true,
              }),
              node({
                project: 'odeme-api',
                path: '',
                kind: 'project',
                label: 'odeme-api',
                hasChildren: true,
              }),
            ],
            total: 4,
          };
    if (path === 'folders' || path === `folder:${FOLDER_ID}`) {
      const top = path === 'folders';
      return {
        nodes: [
          node({
            project,
            path: `folder:${top ? FOLDER_ID : SUB_ID}`,
            kind: 'folder',
            label: top ? 'Lansman raporları' : 'Haftalık',
            count: top ? 3 : 1,
            hasChildren: top,
            folderId: top ? FOLDER_ID : SUB_ID,
            pinned: top,
          }),
        ],
        total: 1,
      };
    }
    if (path !== '') return { nodes: [], total: 0 };
    return {
      nodes: [
        node({ project, path: 'folders', kind: 'folders', label: 'Folders', count: 1, hasChildren: true }),
        node({ project, path: 'sites', kind: 'sites', label: 'Sites', count: 1 }),
        node({ project, path: 'notes', kind: 'notes', label: 'Notes', count: 1 }),
        node({
          project,
          path: `job:${JOB}`,
          kind: 'job',
          label: 'Ödeme sayfası erişilebilirlik turu',
          count: 3,
          hasChildren: true,
          jobId: JOB,
        }),
      ],
      total: 4,
    };
  },
  [`/outputs/folders/${FOLDER_ID}`]: () => FOLDER,
  '/outputs/folders': () => ({ items: [FOLDER] }),
  '/outputs/item-folders': () => ({ items: [FOLDER] }),
  '/outputs/thread': () => ({
    items: [
      {
        id: '5e4d3c2b-1a09-4f8e-9d7c-6b5a4c3d2e1f',
        body: 'Skor **94**: görseller sıkıştırılınca 95 üstüne çıkar.',
        author: { id: 'u1', username: 'alex' },
        createdAt: iso(18 * MIN),
        updatedAt: iso(18 * MIN),
      },
    ],
  }),
  // A JSON file: the harness answers every path as JSON, so this preview is the honest one to show.
  [`/jobs/${JOB}/artifacts/ws-lighthouse-json`]: () => ({
    categories: { performance: 0.94, accessibility: 0.98, seo: 1 },
    audits: { 'largest-contentful-paint': { numericValue: 1840, unit: 'ms' } },
  }),
};
