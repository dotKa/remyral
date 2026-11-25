import type { ScreenRoutes } from './types';

/**
 * p12-diyalog-w1 harness fixtures for the Templates screens: `/jobs/templates` (two templates + a suggestion),
 * `/jobs/templates/<T1>` (three versions, a diff), `/jobs/templates/new` (live preview).
 */

const NOW = Date.now();
const MIN = 60_000;
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

export const HARNESS_TEMPLATE = '7e3f0a11-2b4c-4d5e-8f60-718293a4b5c6';
const T2 = '7e3f0a11-2b4c-4d5e-8f60-000000000002';

const PROMPT_V3 = [
  'Analyse {{url:url}} for an audience of {{audience_count:int}} people.',
  'Tone: {{tone:enum(formal|casual)}}.',
  '',
  'Write the findings to out/report.md and a short summary in the chat.',
].join('\n');

const PARAMS = [
  { name: 'url', type: 'url', required: true, label: 'Site', description: 'The page to analyse' },
  { name: 'audience_count', type: 'int', required: true, default: 1000, label: 'Audience' },
  { name: 'tone', type: 'enum', options: ['formal', 'casual'], default: 'formal' },
];

function version(v: number, note: string | null, minAgo: number): Record<string, unknown> {
  return {
    version: v,
    prompt: PROMPT_V3,
    parameters: PARAMS,
    defaults: {
      runtime: 'claude-code',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 1800 },
      deployOnSuccess: { target: 'pages', env: 'preview' },
      verify: 'report',
      priorityClass: 'normal',
    },
    changeNote: note,
    createdBy: 'u1',
    createdAt: iso(minAgo * MIN),
  };
}

const TEMPLATES = [
  {
    id: HARNESS_TEMPLATE,
    project: 'vitrin-web',
    title: 'Landing page analizi',
    description: 'Kitle analizi ve açılış sayfası önerileri',
    tags: ['pazarlama', 'seo'],
    state: 'active',
    version: 3,
    owner: { id: 'u1', username: 'alex' },
    source: { kind: 'manual' },
    createdAt: iso(9 * 24 * 60 * MIN),
    updatedAt: iso(50 * MIN),
    current: version(3, 'Ton parametresi eklendi', 50),
    stats: {
      runs: 12,
      finished: 12,
      succeeded: 10,
      successRate: 0.83,
      avgCostUsd: 0.42,
      avgDurationSec: 610,
      lastRunAt: iso(3 * 60 * MIN),
      automations: 1,
    },
    canEdit: true,
  },
  {
    id: T2,
    project: null,
    title: 'Bağımlılık güncellemesi',
    description: '',
    tags: [],
    state: 'active',
    version: 1,
    owner: { id: 'u1', username: 'alex' },
    source: { kind: 'manual' },
    createdAt: iso(30 * 24 * 60 * MIN),
    updatedAt: iso(26 * 60 * MIN),
    current: {
      ...version(1, null, 26 * 60),
      prompt: 'Update {{package}} to the latest minor version and run the tests.',
      parameters: [{ name: 'package', type: 'string', required: true }],
    },
    stats: {
      runs: 0,
      finished: 0,
      succeeded: 0,
      successRate: null,
      avgCostUsd: null,
      avgDurationSec: null,
      lastRunAt: null,
      automations: 0,
    },
    canEdit: true,
  },
];

const SUGGESTION = {
  id: 'a'.repeat(32),
  project: 'mobil-app',
  title: 'Run an SEO audit of {{url}}',
  prompt: 'Run an SEO audit of {{url}} and report the top 5 issues.',
  parameters: [
    { name: 'url', type: 'url', required: true, examples: ['https://a.example', 'https://b.example'] },
  ],
  occurrences: 3,
  avgSimilarity: 0.94,
  lastSeenAt: iso(5 * 60 * MIN),
  members: [
    {
      kind: 'job',
      id: '9a1b2c3d-0000-4000-8000-000000000006',
      title: 'SEO audit a.example',
      createdAt: iso(1),
    },
    { kind: 'draft', id: '33333333-3333-4333-8333-333333333333', title: 'SEO', createdAt: iso(1) },
  ],
  defaults: { runtime: 'claude-code', modelProfile: null, sandboxProfile: null, approvalPolicy: null },
};

const DIFF = [
  '--- v2',
  '+++ v3',
  '@@ -1,3 +1,4 @@',
  ' Analyse {{url:url}} for an audience of {{audience_count:int}} people.',
  '+Tone: {{tone:enum(formal|casual)}}.',
  ' ',
  '-Write the findings to out/report.md.',
  '+Write the findings to out/report.md and a short summary in the chat.',
].join('\n');

export const ROUTES: ScreenRoutes = {
  '/templates': (url) => ({
    items: url.searchParams.get('state') === 'archived' ? [] : TEMPLATES,
  }),
  '/template-suggestions': () => ({ items: [SUGGESTION] }),
  [`/templates/${HARNESS_TEMPLATE}`]: () => TEMPLATES[0],
  [`/templates/${T2}`]: () => TEMPLATES[1],
  [`/templates/${HARNESS_TEMPLATE}/versions`]: () => ({
    items: [
      version(1, null, 9 * 24 * 60),
      version(2, 'Daha kısa istem', 3 * 24 * 60),
      version(3, 'Ton parametresi eklendi', 50),
    ],
  }),
  [`/templates/${HARNESS_TEMPLATE}/diff`]: () => ({ diff: DIFF }),
  '/templates/preview': () => ({
    parameters: [],
    issues: [],
    valueIssues: [],
    prompt: null,
    candidates: [],
  }),
};
