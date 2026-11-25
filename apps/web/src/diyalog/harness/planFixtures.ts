/**
 * p18-plan-mode: harness fixtures for the plan panel (`?path=/chat/<id>`) — an executing plan with live progress and one
 * waiting decision (`chat-plan`, with the details open: `chat-plan-details`), and a plan in review in plan mode with two
 * decisions, its plan card and a planning proposal (`chat-plan-review`). W3: the executing plan in edit mode
 * (`chat-plan-edit`) and its history with the diff of the latest change (`chat-plan-history`). p18-plan-autonomy: the
 * executing plan runs autonomously ("Otonom" chip); the smoke item waits for the person's retry card ("Senden bekleniyor").
 */

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;

export const PLAN_THREAD_ID = '0c1d2e3f-0000-4000-8000-0000000000b1';
export const PLAN_REVIEW_THREAD_ID = '0c1d2e3f-0000-4000-8000-0000000000b2';
const PLAN_ID = '0c1d2e3f-0000-4000-8000-0000000000c1';
const REVIEW_PLAN_ID = '0c1d2e3f-0000-4000-8000-0000000000c2';
const DECISION_ID = '0c1d2e3f-0000-4000-8000-0000000000c3';
const D2 = '0c1d2e3f-0000-4000-8000-0000000000c4';
const D3 = '0c1d2e3f-0000-4000-8000-0000000000c5';

interface ItemSeed {
  readonly key: string;
  readonly phase: number;
  readonly phaseTitle: string;
  readonly title: string;
  readonly activeTitle?: string;
  readonly status: string;
  readonly owner: string;
  readonly project?: string;
  readonly links?: readonly { kind: string; id: string; label?: string }[];
  readonly note?: string;
  readonly decisionOpen?: boolean;
  readonly estimate?: string | number;
  /** p18-plan-autonomy: the item waits for the person's card. */
  readonly awaitsUser?: boolean;
  readonly failures?: number;
}

function items(seeds: readonly ItemSeed[]): unknown[] {
  const pos = new Map<number, number>();
  return seeds.map((s) => {
    const p = pos.get(s.phase) ?? 0;
    pos.set(s.phase, p + 1);
    return {
      key: s.key,
      phase: s.phase,
      phaseTitle: s.phaseTitle,
      position: p,
      title: s.title,
      activeTitle: s.activeTitle ?? null,
      detail: null,
      status: s.status,
      owner: s.owner,
      project: s.project ?? null,
      dependsOn: [],
      estimate: s.estimate ?? null,
      links: (s.links ?? []).map((l) => ({ ...l })),
      note: s.note ?? null,
      statusBy: 'derived',
      decisionOpen: s.decisionOpen === true,
      awaitsUser: s.awaitsUser === true,
      failures: s.failures ?? 0,
    };
  });
}

const decision = (id: string, prompt: string, item: string | null, state = 'pending'): unknown => ({
  id,
  itemKey: item,
  prompt,
  kind: 'single',
  options: [
    { label: 'preview', description: 'Önce önizleme ortamında doğrula' },
    { label: 'production', description: 'Doğrudan yayına al' },
  ],
  recommended: 'preview',
  rationale: 'Önce önizlemede doğrulamak geri dönüşü kolaylaştırır.',
  state,
  answers: null,
  answer: null,
  createdAt: iso(9 * MIN),
});

function plan(id: string, threadId: string, over: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    threadId,
    title: 'Sürüm 2.4 yayını',
    goal: 'Sürüm 2.4’ü testleri geçmiş halde production’a çıkarmak.',
    assumptions: ['Staging ortamı hazır', 'Changelog sürüm notundan üretilir'],
    risks: ['Flaky login testi'],
    state: 'executing',
    version: 3,
    rev: 41,
    approvedVersion: 3,
    autonomous: true,
    stalled: null,
    createdAt: iso(40 * MIN),
    updatedAt: iso(MIN),
    closedAt: null,
    phases: [
      { index: 0, title: 'Hazırlık' },
      { index: 1, title: 'Uygulama' },
      { index: 2, title: 'Yayın' },
    ],
    lastChange: {
      version: 3,
      author: 'assistant',
      reason: 'Smoke test eklendi',
      added: 2,
      removed: 1,
      changed: 0,
      moved: 1,
    },
    ...over,
  };
}

const EXEC_ITEMS: ItemSeed[] = [
  {
    key: 'analiz',
    phase: 0,
    phaseTitle: 'Hazırlık',
    title: 'Değişiklikleri incele',
    status: 'done',
    owner: 'assistant',
  },
  {
    key: 'bagimlilik',
    phase: 0,
    phaseTitle: 'Hazırlık',
    title: 'Bağımlılıkları güncelle',
    status: 'done',
    owner: 'job',
    project: 'mobil-app',
  },
  {
    key: 'ortam',
    phase: 0,
    phaseTitle: 'Hazırlık',
    title: 'Staging ortamını kontrol et',
    status: 'done',
    owner: 'assistant',
  },
  {
    key: 'testler',
    phase: 1,
    phaseTitle: 'Uygulama',
    title: 'Testleri düzelt',
    status: 'done',
    owner: 'job',
    project: 'mobil-app',
    links: [{ kind: 'job', id: '7c1e09ab-4b2f-4c1d-9a3e-5f6a7b8c9d0e', label: 'İş #41' }],
  },
  {
    key: 'changelog',
    phase: 1,
    phaseTitle: 'Uygulama',
    title: 'Changelog yaz',
    activeTitle: 'Changelog yazılıyor',
    status: 'in_progress',
    owner: 'assistant',
    estimate: 30,
  },
  {
    key: 'etiket',
    phase: 1,
    phaseTitle: 'Uygulama',
    title: 'Sürüm etiketi koy',
    status: 'pending',
    owner: 'user',
    estimate: 'S',
  },
  {
    key: 'smoke',
    phase: 1,
    phaseTitle: 'Uygulama',
    title: 'Smoke testlerini çalıştır',
    status: 'in_progress',
    owner: 'job',
    project: 'mobil-app',
    links: [
      { kind: 'job', id: '7c1e09ab-4b2f-4c1d-9a3e-5f6a7b8c9d0f' },
      { kind: 'draft', id: '7c1e09ab-4b2f-4c1d-9a3e-5f6a7b8c9d10', label: 'Smoke testleri (yeniden)' },
    ],
    failures: 1,
    awaitsUser: true,
  },
  {
    key: 'deploy',
    phase: 2,
    phaseTitle: 'Yayın',
    title: 'Production deploy taslağı',
    status: 'pending',
    owner: 'workflow',
    project: 'vitrin-web',
    decisionOpen: true,
    estimate: 'M',
  },
  {
    key: 'duyuru',
    phase: 2,
    phaseTitle: 'Yayın',
    title: 'Sürüm duyurusunu yayınla',
    status: 'pending',
    owner: 'assistant',
    estimate: 15,
  },
];

export const EXEC_PLAN = plan(PLAN_ID, PLAN_THREAD_ID, {
  items: items(EXEC_ITEMS),
  decisions: [decision(DECISION_ID, 'Deploy ortamı?', 'deploy')],
  progress: { done: 4, total: 9, skipped: 0, remainingMinutes: 285 },
});

export const REVIEW_PLAN = plan(REVIEW_PLAN_ID, PLAN_REVIEW_THREAD_ID, {
  state: 'in_review',
  version: 2,
  rev: 7,
  approvedVersion: null,
  lastChange: {
    version: 2,
    author: 'assistant',
    reason: 'Smoke test eklendi',
    added: 1,
    removed: 0,
    changed: 1,
    moved: 0,
  },
  items: items(
    EXEC_ITEMS.map(({ note: _note, ...i }) => ({
      ...i,
      status: 'pending',
      links: [],
      decisionOpen: i.key === 'deploy',
    })),
  ),
  decisions: [decision(D2, 'Deploy ortamı?', 'deploy'), decision(D3, 'Sürüm notu hangi dilde olsun?', null)],
  progress: { done: 0, total: 9, skipped: 0, remainingMinutes: 645 },
});

const question = (id: string, planId: string, prompt: string, item: string | null): unknown => ({
  id,
  source: 'assistant',
  jobId: null,
  threadId: null,
  project: null,
  title: null,
  questions: [
    {
      id: 'q1',
      prompt,
      kind: 'single',
      options: [
        { label: 'preview', description: 'Önce önizleme ortamında doğrula' },
        { label: 'production', description: 'Doğrudan yayına al' },
      ],
      recommended: 'preview',
      rationale: 'Önce önizlemede doğrulamak geri dönüşü kolaylaştırır.',
    },
  ],
  state: 'pending',
  createdAt: iso(9 * MIN),
  deadlineAt: null,
  closedAt: null,
  closeReason: null,
  answers: null,
  answeredBy: null,
  answeredAt: null,
  planId,
  planItemKey: item,
});

const msg = (
  id: string,
  seq: number,
  role: string,
  content: string,
  meta: unknown,
  ago: number,
): unknown => ({
  id,
  seq,
  role,
  content,
  meta,
  turnId: null,
  createdAt: iso(ago),
});

export function planThreadDetail(t: Record<string, unknown>): unknown {
  const review = t.id === PLAN_REVIEW_THREAD_ID;
  const id = String(t.id);
  const messages = review
    ? [
        msg(`${id}-1`, 1, 'user', '2.4 sürümünü yayına hazırla', null, 30 * MIN),
        msg(
          `${id}-2`,
          2,
          'tool',
          'plan_propose: suggested planning first',
          {
            name: 'plan_propose',
            isError: false,
            proposal: { reason: 'Deploy, test ve sürüm notu birlikte: önce bir plan çıkaralım.' },
          },
          29 * MIN,
        ),
        msg(
          `${id}-3`,
          3,
          'assistant',
          'Bu iş birkaç adım ve karar içeriyor; önce planlayayım mı?',
          null,
          29 * MIN,
        ),
        msg(`${id}-4`, 4, 'user', 'Evet, önce planla.', { origin: 'user', planMode: true }, 20 * MIN),
        msg(
          `${id}-5`,
          5,
          'tool',
          'plan_create: plan v1',
          { name: 'plan_create', isError: false, planId: REVIEW_PLAN_ID, planVersion: 1 },
          19 * MIN,
        ),
        msg(
          `${id}-6`,
          6,
          'tool',
          'plan_ask_decision: ok',
          { name: 'plan_ask_decision', isError: false, questionId: D2 },
          19 * MIN,
        ),
        msg(
          `${id}-7`,
          7,
          'assistant',
          'Planı hazırladım: 3 aşama, 9 madde. **2 karar** bekliyor — öneriler kartlarda.',
          null,
          18 * MIN,
        ),
      ]
    : [
        msg(`${id}-1`, 1, 'user', 'Sürüm 2.4’ü yayına hazırla, önce planla', null, 45 * MIN),
        msg(`${id}-2`, 2, 'assistant', 'Plan onaylandı; maddeler sırayla ilerliyor.', null, 40 * MIN),
        msg(
          `${id}-3`,
          3,
          'user',
          'Onaylı plan v3 — sıradaki madde: Changelog yaz (changelog). Planı sürdür.',
          { origin: 'plan', plan: { id: PLAN_ID, next: 'changelog' } },
          3 * MIN,
        ),
        msg(
          `${id}-4`,
          4,
          'tool',
          'plan_set_status: ok',
          { name: 'plan_set_status', isError: false },
          3 * MIN,
        ),
        msg(
          `${id}-5`,
          5,
          'assistant',
          'Changelog’u yazıyorum; smoke testleri zaman aşımına uğradı, sonra bakacağım.',
          null,
          2 * MIN,
        ),
      ];
  return {
    thread: t,
    messages,
    drafts: [],
    turn: null,
    watches: [],
    knowledge: null,
    starred: [],
    questions: review
      ? [
          question(D2, REVIEW_PLAN_ID, 'Deploy ortamı?', 'deploy'),
          question(D3, REVIEW_PLAN_ID, 'Sürüm notu hangi dilde olsun?', null),
        ]
      : [question(DECISION_ID, PLAN_ID, 'Deploy ortamı?', 'deploy')],
    plan: review ? { mode: iso(21 * MIN), active: REVIEW_PLAN } : { mode: null, active: EXEC_PLAN },
  };
}

/* p18-plan-mode W3: the history of the executing plan — v1 (assistant), v2 (the person's edits), v3 (assistant) — the
   diff between any two of them and an earlier, cancelled plan of the conversation (`chat-plan-history`). */
const VERSIONS = {
  versions: [
    {
      version: 3,
      author: 'assistant',
      reason: 'Smoke test eklendi',
      createdAt: iso(25 * MIN),
      items: 9,
      added: 1,
      removed: 1,
      changed: 1,
      moved: 0,
    },
    {
      version: 2,
      author: 'user',
      reason: null,
      createdAt: iso(33 * MIN),
      items: 9,
      added: 1,
      removed: 0,
      changed: 1,
      moved: 1,
    },
    {
      version: 1,
      author: 'assistant',
      reason: null,
      createdAt: iso(40 * MIN),
      items: 8,
      added: 0,
      removed: 0,
      changed: 0,
      moved: 0,
    },
  ],
};

const shape = (key: string, over: Record<string, unknown> = {}): Record<string, unknown> => {
  const seed = EXEC_ITEMS.find((i) => i.key === key);
  return {
    key,
    phase: seed?.phase ?? 0,
    phaseTitle: seed?.phaseTitle ?? 'Hazırlık',
    position: 0,
    title: seed?.title ?? key,
    activeTitle: seed?.activeTitle ?? null,
    detail: null,
    owner: seed?.owner ?? 'assistant',
    project: seed?.project ?? null,
    dependsOn: [],
    estimate: seed?.estimate ?? null,
    ...over,
  };
};

const vmeta = (v: number): Record<string, unknown> => {
  const x = VERSIONS.versions.find((y) => y.version === v);
  return {
    version: v,
    author: x?.author ?? 'assistant',
    reason: x?.reason ?? null,
    createdAt: x?.createdAt ?? iso(0),
  };
};

function planDiff(from: number, to: number): unknown {
  const items: unknown[] = [];
  const decisions: unknown[] = [];
  if (from <= 1 && to >= 2) {
    items.push(
      { key: 'duyuru', change: 'added', fields: [], moved: false, before: null, after: shape('duyuru') },
      {
        key: 'etiket',
        change: 'changed',
        fields: ['title', 'owner'],
        moved: true,
        before: shape('etiket', { title: 'Etiket koy', owner: 'assistant', phase: 2, phaseTitle: 'Yayın' }),
        after: shape('etiket'),
      },
    );
  }
  if (from <= 2 && to >= 3) {
    items.push(
      { key: 'smoke', change: 'added', fields: [], moved: false, before: null, after: shape('smoke') },
      {
        key: 'changelog',
        change: 'changed',
        fields: ['estimate'],
        moved: false,
        before: shape('changelog', { estimate: 'M' }),
        after: shape('changelog'),
      },
      {
        key: 'manuel',
        change: 'removed',
        fields: [],
        moved: false,
        before: shape('manuel', { title: 'Elle regresyon turu', phase: 1, phaseTitle: 'Uygulama' }),
        after: null,
      },
    );
    decisions.push({
      id: DECISION_ID,
      itemKey: 'deploy',
      prompt: 'Deploy ortamı?',
      change: 'asked',
      answer: null,
    });
  }
  return {
    added: [],
    removed: [],
    changed: [],
    moved: [],
    goalChanged: false,
    titleChanged: false,
    from: vmeta(from),
    to: vmeta(to),
    items,
    decisions,
  };
}

export function planRoutes(): Readonly<Record<string, (url: URL) => unknown>> {
  return {
    [`/chat/plans/${PLAN_ID}`]: () => EXEC_PLAN,
    [`/chat/plans/${REVIEW_PLAN_ID}`]: () => REVIEW_PLAN,
    [`/chat/plans/${PLAN_ID}/versions`]: () => VERSIONS,
    [`/chat/plans/${PLAN_ID}/diff`]: (url) =>
      planDiff(Number(url.searchParams.get('from') ?? 2), Number(url.searchParams.get('to') ?? 3)),
    [`/chat/threads/${PLAN_THREAD_ID}/plans`]: () => ({
      active: EXEC_PLAN,
      mode: null,
      history: [
        {
          id: '0c1d2e3f-0000-4000-8000-0000000000c9',
          title: 'Sürüm 2.3 düzeltmesi',
          state: 'done',
          version: 2,
          done: 5,
          total: 5,
          createdAt: iso(3 * 24 * 60 * MIN),
          closedAt: iso(2 * 24 * 60 * MIN),
        },
      ],
    }),
  };
}
