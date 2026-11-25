/**
 * p12-diyalog-parity: harness fixtures for the conversation list, a conversation and the details panel — pins, a
 * group, tags, unread counts, an archived conversation, the knowledge bar, a watch, starred messages and assets.
 * `chatRoutes(base)` takes the ops conversation of fixtures.ts (no import cycle).
 */

import { PLAN_REVIEW_THREAD_ID, PLAN_THREAD_ID, planRoutes, planThreadDetail } from './planFixtures';

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const DAY = 86_400_000;

interface Base {
  readonly thread: { readonly id: string; readonly title: string };
  readonly messages: readonly unknown[];
  readonly drafts: readonly unknown[];
}

/** p12-diyalog-w4: an empty conversation; the archived one is `…d8` (`?path=/chat/<id>`: the locked composer). */
export const EMPTY_ID = '0c1d2e3f-0000-4000-8000-0000000000d9';
export const ARCHIVED_ID = '0c1d2e3f-0000-4000-8000-0000000000d8';
/** p12-mention-badges: a conversation whose messages carry every mention type and an unresolved one. */
export const MENTIONS_ID = '0c1d2e3f-0000-4000-8000-0000000000da';
/**
 * p12-chat-scroll-anchor: a long conversation read up to seq 18 of 24 (`?path=/chat/<…d4>`): it opens with answer #20
 * at the top under the "Okunmamış mesajlar" divider. Its read mark is not kept here, so it opens that way every time.
 */
export const UNREAD_ID = '0c1d2e3f-0000-4000-8000-0000000000d4';
const UNREAD_READ_SEQ = 18;
const UNREAD_MESSAGES = Array.from({ length: 24 }, (_, i) => {
  const seq = i + 1;
  const user = seq % 2 === 1;
  return {
    id: `${UNREAD_ID}-m${String(seq)}`,
    seq,
    role: user ? 'user' : 'assistant',
    content: user
      ? `pebble-pi ölçümü ${String((seq + 1) / 2)}: şimdi ne durumda?`
      : `Ölçüm ${String(seq / 2)}: SD kart yazma hızı ${String(8 + seq)} MB/s, CPU sıcaklığı ${String(55 + seq)} °C.\n\n` +
        '- Swap kullanımı arttı\n- Disk kuyruğu uzun\n\n```sh\niostat -x 5 3\n```',
    meta: null,
    turnId: null,
    createdAt: new Date(NOW - (3 * 60 - seq * 5) * MIN).toISOString(),
  };
});

const MENTION_JOB = '7c1e09ab-4b2f-4c1d-9a3e-5f6a7b8c9d0e';

const MENTION_MESSAGES = [
  {
    id: `${MENTIONS_ID}-m1`,
    seq: 1,
    role: 'user',
    content:
      '@mobil-app projesinde @Vitest 5’e geç işi neden @kestrel-mac üzerinde bekliyor? @vitest-uyarilari.txt dosyasına ve @Deploy notları klasörüne de bak.',
    meta: {
      mentions: [
        { type: 'project', id: 'mobil-app', project: 'mobil-app', label: 'mobil-app' },
        { type: 'job', id: MENTION_JOB, project: 'mobil-app', label: 'Vitest 5’e geç' },
        { type: 'worker', id: 'w2', project: null, label: 'kestrel-mac' },
        { type: 'output', id: 'file:j1:vitest', project: 'mobil-app', label: 'vitest-uyarilari.txt' },
        {
          type: 'folder',
          id: '0c1d2e3f-0000-4000-8000-0000000000fa',
          project: null,
          label: 'Deploy notları',
        },
      ],
    },
    turnId: null,
    createdAt: iso(50 * MIN),
  },
  {
    id: `${MENTIONS_ID}-m2`,
    seq: 2,
    role: 'assistant',
    content:
      'İş kuyrukta: kestrel-mac şu an başka bir işi bitiriyor. @mobil-app için ayrıca bir onay bekleniyor.',
    meta: null,
    turnId: null,
    createdAt: iso(49 * MIN),
  },
  {
    id: `${MENTIONS_ID}-m3`,
    seq: 3,
    role: 'user',
    content:
      'Geçen haftaki @Login testindeki yarış koşulu sohbetiyle aynı mı? Eski @ridge-kurulum işi de vardı.',
    meta: {
      mentions: [
        {
          type: 'thread',
          id: '0c1d2e3f-0000-4000-8000-0000000000d7',
          project: null,
          label: 'Login testindeki yarış koşulu',
        },
        { type: 'job', id: 'silinmis-is', project: null, label: 'ridge-kurulum' },
      ],
    },
    turnId: null,
    createdAt: iso(20 * MIN),
  },
];

const G1 = '0c1d2e3f-0000-4000-8000-0000000000e1';
const TAG_URGENT = '0c1d2e3f-0000-4000-8000-0000000000f1';
const TAG_INFRA = '0c1d2e3f-0000-4000-8000-0000000000f2';

const ORGANIZE = {
  groups: [{ id: G1, name: 'Deploy’lar', position: 0, collapsed: false, threadCount: 2 }],
  tags: [
    { id: TAG_URGENT, name: 'acil', color: 'red', threadCount: 1 },
    { id: TAG_INFRA, name: 'altyapı', color: 'teal', threadCount: 2 },
  ],
  pinned: 1,
};

function thread(
  id: string,
  title: string,
  msAgo: number,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    title,
    archived: false,
    createdAt: iso(msAgo + 30 * MIN),
    updatedAt: iso(msAgo),
    unreadCount: 0,
    pinnedAt: null,
    groupId: null,
    tagIds: [],
    ...over,
  };
}

export function chatRoutes(base: Base): Readonly<Record<string, (url: URL) => unknown>> {
  const ops = thread(base.thread.id, base.thread.title, 2 * MIN, { tagIds: [TAG_INFRA] });
  const pinned = thread('0c1d2e3f-0000-4000-8000-0000000000d1', 'Haftalık kapasite planı', 3 * DAY, {
    pinnedAt: iso(DAY),
  });
  const grouped = [
    thread('0c1d2e3f-0000-4000-8000-0000000000d2', 'vitrin-web production yayını', 40 * MIN, {
      groupId: G1,
      tagIds: [TAG_URGENT],
      unreadCount: 2,
    }),
    thread('0c1d2e3f-0000-4000-8000-0000000000d3', 'Önizleme tünelleri kapanıyor', 2 * DAY, {
      groupId: G1,
      tagIds: [TAG_INFRA],
    }),
  ];
  const rest = [
    ops,
    thread('0c1d2e3f-0000-4000-8000-0000000000d4', 'pebble-pi neden yavaş?', 3 * 60 * MIN, {
      unreadCount: 3,
    }),
    thread('0c1d2e3f-0000-4000-8000-0000000000d5', 'Codex limit penceresi', 26 * 60 * MIN),
    thread('0c1d2e3f-0000-4000-8000-0000000000d6', 'Android build cache temizliği', 4 * DAY),
    thread('0c1d2e3f-0000-4000-8000-0000000000d7', 'Login testindeki yarış koşulu', 12 * DAY),
    // p12-diyalog-w4: an empty conversation (`?path=/chat/<…d9>`): the empty state's suggestions.
    thread(EMPTY_ID, 'Yeni sohbet', 5 * MIN),
    thread(MENTIONS_ID, 'Bahsetme rozetleri', 15 * MIN),
    // p18-plan-mode: an executing plan (`chat-plan`) and a plan in review in plan mode (`chat-plan-review`).
    thread(PLAN_THREAD_ID, 'Sürüm 2.4 yayını', MIN),
    thread(PLAN_REVIEW_THREAD_ID, 'Sürüm 2.4 — plan incelemesi', 18 * MIN),
  ];
  const archived = [
    thread(ARCHIVED_ID, 'Eski ridge-lnx-03 kurulumu', 30 * DAY, {
      archived: true,
    }),
  ];
  const all = [...rest, pinned, ...grouped];
  const detail = (t: Record<string, unknown>, own: boolean): unknown =>
    t.id === PLAN_THREAD_ID || t.id === PLAN_REVIEW_THREAD_ID ? planThreadDetail(t) : plainDetail(t, own);
  const plainDetail = (t: Record<string, unknown>, own: boolean): unknown => ({
    thread: t,
    messages: own
      ? base.messages
      : t.id === EMPTY_ID
        ? []
        : t.id === MENTIONS_ID
          ? MENTION_MESSAGES
          : t.id === UNREAD_ID
            ? UNREAD_MESSAGES
            : [
                {
                  id: `${String(t.id)}-m1`,
                  seq: 1,
                  role: 'user',
                  content: `${String(t.title)} — durum ne?`,
                  meta: null,
                  turnId: null,
                  createdAt: iso(50 * MIN),
                },
                {
                  id: `${String(t.id)}-m2`,
                  seq: 2,
                  role: 'assistant',
                  content: 'Kısaca: her şey yolunda, bir şey değişirse bu sohbete yazarım.',
                  meta: null,
                  turnId: null,
                  createdAt: iso(49 * MIN),
                },
              ],
    drafts: own ? base.drafts : [],
    turn: null,
    watches: own
      ? [
          {
            id: 'w-1',
            threadId: t.id,
            target: { kind: 'job', id: 'j1' },
            label: 'Vitest 5’e geç',
            project: 'mobil-app',
            conditions: ['finished'],
            repeat: 'once',
            state: 'active',
            endReason: null,
            fireCount: 0,
            check: null,
            lastFiredAt: null,
            createdAt: iso(10 * MIN),
            expiresAt: iso(-DAY),
            link: '/jobs/j1',
          },
        ]
      : [],
    knowledge: {
      project: own ? 'mobil-app' : null,
      share: true,
      personalShare: true,
      sharedWith: own ? ['mobil-app'] : [],
      notShared: [],
      suggestedProject: own ? null : 'vitrin-web',
      memorySummary: [],
      // p18-multi-project W3: the working projects (the harness's own conversation works on two).
      projects: own
        ? [
            {
              project: 'mobil-app',
              name: 'Mobil uygulama',
              kind: 'repository',
              role: 'owner',
              share: true,
              primary: true,
            },
            {
              project: 'vitrin-web',
              name: 'Vitrin web',
              kind: 'repository',
              role: 'owner',
              share: false,
              primary: false,
            },
          ]
        : [],
    },
    starred: own ? ['m5'] : [],
  });
  const asset = (kind: string, key: string, label: string, over: Record<string, unknown> = {}) => ({
    kind,
    key,
    threadId: base.thread.id,
    threadTitle: base.thread.title,
    messageId: 'm5',
    seq: 5,
    createdAt: iso(68 * MIN),
    label,
    detail: null,
    url: null,
    href: null,
    domain: null,
    mediaType: null,
    sizeBytes: null,
    role: 'assistant',
    source: null,
    draftKind: null,
    draftState: null,
    state: null,
    ...over,
  });
  const assets: Record<string, unknown[]> = {
    starred: [asset('starred', 's1', 'Sabahtan beri 37 iş bitti, 31’i başarılı. Senden 2 karar bekliyor.')],
    media: [],
    links: [
      asset('links', 'l1', 'vitest.dev', {
        url: 'https://vitest.dev/guide/migration',
        domain: 'vitest.dev',
      }),
    ],
    files: [
      asset('files', 'f1', 'vitest-uyarilari.txt', { detail: 'text/plain', sizeBytes: 18_432, role: 'user' }),
    ],
    jobs: [
      asset('jobs', 'j1', 'Vitest 5’e geç ve deprecation uyarılarını temizle', {
        draftKind: 'job',
        draftState: 'confirmed',
        state: 'RUNNING',
        href: '/jobs/j1',
        detail: 'mobil-app · Claude Code',
      }),
    ],
  };
  const routes: Record<string, (url: URL) => unknown> = {
    '/chat/status': () => ({
      enabled: true,
      available: true,
      code: null,
      message: null,
      worker: { id: 'w2', name: 'kestrel-mac', online: true },
      runtime: 'claude-code',
      model: 'claude-sonnet-4-5',
      fallback: false,
      limit: null,
      limits: { turnsPerUserPer10Min: 30, userDailyTokens: 2_000_000 },
      input: { images: 'supported', pdf: true, mentions: true, reason: null },
      // p18-plan-mode: the answering machine has the plan tools.
      plan: true,
    }),
    ...planRoutes(),
    '/chat/threads': (url) => {
      const p = url.searchParams;
      if (p.get('limit') === '1') return { items: [ops], nextCursor: null, organize: ORGANIZE };
      if (p.get('pinned') === 'true') return { items: [pinned], nextCursor: null, organize: ORGANIZE };
      if (p.get('group') === G1) return { items: grouped, nextCursor: null, organize: ORGANIZE };
      if (p.get('archived') === 'true') return { items: archived, nextCursor: null, organize: ORGANIZE };
      const tag = p.get('tag');
      const q = (p.get('q') ?? '').toLocaleLowerCase('tr-TR');
      const items = all.filter(
        (t) =>
          (tag === null || (t.tagIds as string[]).includes(tag)) &&
          (q === '' || String(t.title).toLocaleLowerCase('tr-TR').includes(q)),
      );
      return { items, nextCursor: null, organize: ORGANIZE };
    },
    // p12-diyalog-w4: search by meaning (type 3+ letters in the list search).
    '/chat/search': (url) => {
      const q = (url.searchParams.get('q') ?? '').trim();
      if (q.length < 3) return { mode: 'semantic', fallbackReason: null, items: [] };
      const hit = (t: Record<string, unknown>, snippet: string, n: number) => ({
        threadId: t.id,
        threadTitle: t.title,
        archived: t.archived,
        messageId: `${String(t.id)}-m${String(n)}`,
        seq: n,
        author: 'assistant',
        attachmentName: null,
        snippet,
        at: iso(n * DAY),
      });
      return {
        mode: 'semantic',
        fallbackReason: null,
        items: [
          hit(grouped[0] ?? ops, 'Production yayını için DNS kaydı hazır; onay bekliyor.', 1),
          hit(rest[2] ?? ops, 'Codex 5 saatlik penceresi %88 dolu, 2 saat 41 dk sonra sıfırlanır.', 2),
          hit(archived[0] ?? ops, 'ridge-lnx-03 için kurulum betiği eski Docker sürümünü kullanıyordu.', 3),
        ],
      };
    },
    // p12-diyalog-cmdk: the command palette's server search (`@`) and its AI search (by meaning).
    '/chat/mentions': (url) => {
      const q = (url.searchParams.get('q') ?? '').toLocaleLowerCase('tr-TR');
      const items = [
        { type: 'worker', id: 'atlas-win-01', project: null, label: 'atlas-win-01', detail: 'Windows · x64' },
        { type: 'worker', id: 'kestrel-mac', project: null, label: 'kestrel-mac', detail: 'macOS · arm64' },
        { type: 'output', id: 'vitrin-site', project: 'vitrin-web', label: 'Vitrin sitesi', detail: 'Pages' },
      ].filter((i) => q === '' || i.label.toLocaleLowerCase('tr-TR').includes(q));
      return { items };
    },
    '/chat/search/everywhere': (url) => {
      const q = (url.searchParams.get('q') ?? '').trim();
      if (q.length < 3) return { mode: 'semantic', fallbackReason: null, projects: 0, items: [] };
      return {
        mode: 'semantic',
        fallbackReason: null,
        projects: 3,
        items: [
          {
            kind: 'own_chat',
            id: 'm-ev-1',
            project: null,
            title: String((grouped[0] ?? ops).title),
            snippet: 'Production yayını için DNS kaydı hazır; onay bekliyor.',
            at: iso(2 * DAY),
            link: `/chat/${String((grouped[0] ?? ops).id)}`,
            score: 0.81,
            match: 'semantic',
          },
          {
            kind: 'job_summary',
            id: '7f3a9c2e-1d4b-4e8f-9a6c-2b5d8e1f4a7c',
            project: 'odeme-api',
            title: 'Ödeme API: flaky entegrasyon testleri onarıldı',
            snippet: 'İki test zamanlamaya bağlıydı; sahte saatle sabitlendi.',
            at: iso(3 * DAY),
            link: '/jobs/7f3a9c2e-1d4b-4e8f-9a6c-2b5d8e1f4a7c',
            score: 0.74,
            match: 'semantic',
          },
          {
            kind: 'context_doc',
            id: 'doc-deploy',
            project: 'vitrin-web',
            title: 'Deploy kuralları (hafıza)',
            snippet: 'Production deploy’ları hafta içi 10:00–16:00 arasında, onayla.',
            at: iso(9 * DAY),
            link: '/settings/context?namespace=project%3Avitrin-web',
            score: 0.66,
            match: 'semantic',
          },
          {
            kind: 'project_chat',
            id: 'm-ev-4',
            project: 'mobil-app',
            title: 'mobil-app: sürüm notları',
            snippet: 'TestFlight yüklemesi öncesi build numarası artırılmalı.',
            at: iso(12 * DAY),
            link: null,
            score: 0.21,
            match: 'keyword',
          },
        ],
      };
    },
    // The Diyalog notification bell.
    '/notifications': () => ({
      items: [
        {
          id: 'n-1',
          kind: 'approval.requested',
          severity: 'warning',
          title: 'Onay bekleniyor: mobil-app',
          body: 'Vitest 5 işi bir komut için onay istiyor (yüksek risk).',
          link: '/approvals',
          createdAt: iso(4 * MIN),
          readAt: null,
        },
        {
          id: 'n-2',
          kind: 'job.failed',
          severity: 'critical',
          title: 'İş başarısız: Android build cache temizliği',
          body: 'pebble-pi üzerinde disk doldu.',
          link: '/jobs',
          createdAt: iso(26 * MIN),
          readAt: iso(20 * MIN),
        },
      ],
      unreadCount: 1,
      nextCursor: null,
    }),
    // The rail's server clock (`GET /api/time`).
    '/time': () => ({ now: new Date().toISOString() }),
    '/chat/assets': (url) => ({ items: assets[url.searchParams.get('kind') ?? ''] ?? [], nextCursor: null }),
  };
  for (const t of [...all, ...archived]) {
    const id = String(t.id);
    const own = id === base.thread.id;
    routes[`/chat/threads/${id}`] = () => detail(t, own);
    // p9-chat-unread: the read position (the harness keeps none: read through the newest message).
    routes[`/chat/threads/${id}/read`] = () => {
      const msgs = (detail(t, own) as { messages: readonly { seq: number }[] }).messages;
      return {
        threadId: id,
        lastReadSeq: id === UNREAD_ID ? UNREAD_READ_SEQ : (msgs.at(-1)?.seq ?? 0),
        lastReadAt: iso(0),
        unreadCount: id === UNREAD_ID ? 3 : 0,
      };
    };
    routes[`/chat/threads/${id}/assets`] = (url) => ({
      items: own ? (assets[url.searchParams.get('kind') ?? ''] ?? []) : [],
      nextCursor: null,
    });
  }
  return routes;
}
