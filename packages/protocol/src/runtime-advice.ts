import { z } from 'zod';
import { RuntimeKind } from './common.js';
import { type JobRole, jobRoleOf } from './routing.js';

/**
 * p11-runtime-advice (docs/design/p11-runtime-advice.md, ADR-0044): the deterministic job classifier (kind + area)
 * and the per-project runtime-advice settings. Pure and explainable — every classification lists the signals that
 * fired. No LLM, no I/O: the master runs it at submission (prompt, hints) and again when the job ends (the paths
 * its result touched).
 */

/** The work area of a job: which part of a project it touches. */
export const JOB_AREAS = ['frontend', 'backend', 'tests', 'docs', 'infra'] as const;
export const JobArea = z.enum(JOB_AREAS);
export type JobArea = z.infer<typeof JobArea>;

/** One area's path globs (`**` any depth, `*` within one segment, `?` one character; case-insensitive). */
export const AreaPathRule = z.strictObject({
  area: JobArea,
  globs: z.array(z.string().min(1).max(200)).min(1).max(30),
});
export type AreaPathRule = z.infer<typeof AreaPathRule>;

/**
 * Built-in path rules, checked in this order (first match wins per path): a test file under a frontend folder is
 * test work, a Markdown file under `infra/` is documentation. A project's own rules are checked before these.
 */
export const DEFAULT_AREA_RULES: readonly AreaPathRule[] = [
  {
    area: 'tests',
    globs: [
      '**/*.test.*',
      '**/*.spec.*',
      '**/*_test.*',
      '**/test_*.py',
      '**/test/**',
      '**/tests/**',
      '**/__tests__/**',
      '**/e2e/**',
      '**/cypress/**',
      '**/playwright/**',
    ],
  },
  { area: 'docs', globs: ['**/*.md', '**/*.mdx', '**/*.rst', '**/*.adoc', 'docs/**', '**/docs/**'] },
  {
    area: 'infra',
    globs: [
      '.github/**',
      '.gitlab-ci.yml',
      'infra/**',
      '**/infra/**',
      'deploy/**',
      '**/deploy/**',
      '**/Dockerfile*',
      '**/docker-compose*.yml',
      '**/docker-compose*.yaml',
      '**/compose*.yaml',
      '**/compose*.yml',
      '**/*.tf',
      '**/k8s/**',
      '**/helm/**',
      '**/nginx*.conf',
    ],
  },
  {
    area: 'frontend',
    globs: [
      '**/*.tsx',
      '**/*.jsx',
      '**/*.vue',
      '**/*.svelte',
      '**/*.css',
      '**/*.scss',
      '**/*.sass',
      '**/*.less',
      '**/*.html',
      '**/frontend/**',
      '**/client/**',
      '**/web/**',
      '**/components/**',
      '**/pages/**',
      '**/public/**',
    ],
  },
  {
    area: 'backend',
    globs: [
      '**/*.go',
      '**/*.py',
      '**/*.rb',
      '**/*.java',
      '**/*.kt',
      '**/*.rs',
      '**/*.php',
      '**/*.cs',
      '**/*.sql',
      '**/server/**',
      '**/backend/**',
      '**/api/**',
      '**/migrations/**',
    ],
  },
];

const globCache = new Map<string, RegExp>();

/** A glob as an anchored, case-insensitive regular expression (see {@link AreaPathRule}). */
export function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached !== undefined) return cached;
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? '';
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` = zero or more directories; a trailing `**` = anything.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  }
  const out = new RegExp(`^${re}$`, 'iu');
  if (globCache.size < 2000) globCache.set(glob, out);
  return out;
}

/** Normalises a repository path: forward slashes, no leading `./` or `/`. */
function normalisePath(p: string): string {
  return p.replace(/\\/gu, '/').replace(/^(?:\.\/|\/)+/u, '');
}

/** The area of one path by the project's rules, then the built-in ones (null: no rule matches). */
export function areaOfPath(path: string, projectRules: readonly AreaPathRule[] = []): JobArea | null {
  const p = normalisePath(path);
  for (const rules of [projectRules, DEFAULT_AREA_RULES]) {
    for (const r of rules) if (r.globs.some((g) => globToRegExp(g).test(p))) return r.area;
  }
  return null;
}

/**
 * Prompt keywords per area (English and Turkish). A trailing `*` matches word continuations (Turkish suffixes:
 * "testleri", "veritabanına"); otherwise the keyword must end at a word boundary ("ui" never matches "uint").
 */
const KEYWORDS: Readonly<Record<JobArea, readonly string[]>> = {
  frontend: [
    'frontend',
    'front-end',
    'front end',
    'ui',
    'ux',
    'css',
    'tailwind',
    'react',
    'vue',
    'svelte',
    'component*',
    'button*',
    'layout*',
    'responsive',
    'styling',
    'stylesheet*',
    'landing page',
    'dark mode',
    'modal*',
    'navbar',
    'arayüz*',
    'ön yüz*',
    'önyüz*',
    'buton*',
    'sayfa*',
    'bileşen*',
    'görünüm*',
    'tasarım*',
  ],
  backend: [
    'backend',
    'back-end',
    'back end',
    'api',
    'apis',
    'endpoint*',
    'database*',
    'sql',
    'migration*',
    'server-side',
    'webhook*',
    'cron',
    'queue worker*',
    'rest route*',
    'graphql',
    'sunucu tarafı*',
    'veritaban*',
    'uç nokta*',
    'arka uç*',
    'sorgu*',
  ],
  tests: [
    'test',
    'tests',
    'testing',
    'unit test*',
    'integration test*',
    'e2e',
    'end-to-end',
    'coverage',
    'vitest',
    'jest',
    'pytest',
    'playwright',
    'cypress',
    'flaky',
    'test yaz*',
    'testler*',
    'testi',
    'birim test*',
    'entegrasyon test*',
    'kapsam*',
  ],
  docs: [
    'docs',
    'documentation',
    'document the',
    'readme',
    'changelog',
    'guide',
    'tutorial',
    'adr',
    'design note*',
    'dokümantasyon*',
    'doküman*',
    'belgele*',
    'kılavuz*',
    'rehber*',
  ],
  infra: [
    'deploy*',
    'docker*',
    'ci',
    'ci/cd',
    'pipeline*',
    'github actions',
    'workflow file*',
    'kubernetes',
    'k8s',
    'terraform',
    'nginx',
    'traefik',
    'coolify',
    'helm',
    'infra',
    'infrastructure',
    'dağıtım*',
    'altyapı*',
    'yayına al*',
    'sunucu kurulum*',
  ],
};

const keywordCache = new Map<string, RegExp>();
function keywordRe(k: string): RegExp {
  const hit = keywordCache.get(k);
  if (hit !== undefined) return hit;
  const prefix = k.endsWith('*');
  const word = (prefix ? k.slice(0, -1) : k).replace(/[.+^${}()|[\]\\/*?]/gu, '\\$&');
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${word}${prefix ? '' : '(?![\\p{L}\\p{N}_])'}`, 'u');
  keywordCache.set(k, re);
  return re;
}

/** How much of a prompt the classifier reads. */
export const CLASSIFY_PROMPT_CHARS = 4000;

/** Where a signal came from (explainability: the job page lists them). */
export const SIGNAL_SOURCES = [
  'explicit',
  'touched-paths',
  'paths-hint',
  'file-types',
  'prompt',
  'template',
] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

export interface ClassificationSignal {
  readonly source: SignalSource;
  readonly area: JobArea;
  readonly weight: number;
  /** What fired: the keyword, the matched paths (at most a few), the template name. */
  readonly detail: string;
}

export interface ClassifyInput {
  readonly prompt?: string | undefined;
  readonly role?: string | undefined;
  readonly kind?: string | undefined;
  /** An explicit area (JobSpec.area): always wins. */
  readonly area?: string | undefined;
  /** Paths the job is told to own (sub-job `paths`, a template's hints). */
  readonly pathHints?: readonly string[] | undefined;
  /** Paths the job's result changed (known when it ended). */
  readonly touchedPaths?: readonly string[] | undefined;
  /** The job template's / automation's name (a weak keyword signal). */
  readonly templateName?: string | undefined;
  /** The project's own path rules (checked before the built-in ones). */
  readonly projectRules?: readonly AreaPathRule[] | undefined;
}

export interface JobClassification {
  readonly kind: JobRole | null;
  readonly kindSource: 'explicit' | 'inferred' | null;
  readonly area: JobArea | null;
  /** The strongest source behind the area (null: unclassified). */
  readonly areaSource: SignalSource | null;
  /** Total weight per area (only areas with a signal). */
  readonly scores: Readonly<Partial<Record<JobArea, number>>>;
  readonly signals: readonly ClassificationSignal[];
}

/** Weights (documented in the design note §2). */
export const CLASSIFIER_WEIGHTS = {
  /** Spread over the touched paths: the result is the strongest evidence. */
  touchedPaths: 6,
  /** Spread over the hinted paths. */
  pathHints: 4,
  /** Per file name with an extension mentioned in the prompt (at most 2 per area). */
  fileType: 1.5,
  /** Per prompt keyword (at most 3 per area). */
  keyword: 1,
  /** Per template / automation name keyword (at most 2). */
  template: 1,
  /** An area needs at least this much and a clear lead over the runner-up. */
  threshold: 2,
} as const;

const FILE_NAME = /(?<![\p{L}\p{N}_])[\w./-]*\.[a-z0-9]{1,8}(?![\p{L}\p{N}_])/giu;
const MAX_DETAIL_PATHS = 4;

function pathSignals(
  paths: readonly string[],
  source: 'touched-paths' | 'paths-hint',
  total: number,
  rules: readonly AreaPathRule[],
): ClassificationSignal[] {
  const by = new Map<JobArea, string[]>();
  let considered = 0;
  for (const raw of paths.slice(0, 500)) {
    const p = raw.trim();
    if (p === '') continue;
    considered += 1;
    const a = areaOfPath(p, rules);
    if (a !== null) by.set(a, [...(by.get(a) ?? []), p]);
  }
  if (considered === 0) return [];
  return [...by.entries()].map(([area, list]) => ({
    source,
    area,
    weight: round2((total * list.length) / considered),
    detail:
      `${String(list.length)} of ${String(considered)} paths: ${list.slice(0, MAX_DETAIL_PATHS).join(', ')}` +
      (list.length > MAX_DETAIL_PATHS ? ', …' : ''),
  }));
}

function keywordSignals(
  text: string,
  source: 'prompt' | 'template',
  weight: number,
  cap: number,
): ClassificationSignal[] {
  const lower = text.toLocaleLowerCase('tr').replace(/i̇/gu, 'i');
  const out: ClassificationSignal[] = [];
  for (const area of JOB_AREAS) {
    let n = 0;
    for (const k of KEYWORDS[area]) {
      if (n >= cap) break;
      if (keywordRe(k).test(lower)) {
        out.push({ source, area, weight, detail: k.replace(/\*$/u, '…') });
        n += 1;
      }
    }
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The classifier: kind from the existing routing heuristic (`jobRoleOf`), area from weighted signals — an explicit
 * area wins; otherwise touched paths, path hints, file names in the prompt, prompt keywords and the template name add
 * up per area, and the top area needs at least {@link CLASSIFIER_WEIGHTS.threshold} and more than 1.5× the runner-up
 * (else unclassified: no guess). Deterministic.
 */
export function classifyJob(input: ClassifyInput): JobClassification {
  const kind = jobRoleOf({ role: input.role, prompt: input.prompt, kind: input.kind });
  const rules = input.projectRules ?? [];
  const explicit = JobArea.safeParse(input.area);
  if (explicit.success) {
    return {
      kind: kind.role,
      kindSource: kind.source,
      area: explicit.data,
      areaSource: 'explicit',
      scores: { [explicit.data]: 100 },
      signals: [{ source: 'explicit', area: explicit.data, weight: 100, detail: 'set on the job' }],
    };
  }
  const prompt = (input.prompt ?? '').slice(0, CLASSIFY_PROMPT_CHARS);
  const signals: ClassificationSignal[] = [
    ...pathSignals(input.touchedPaths ?? [], 'touched-paths', CLASSIFIER_WEIGHTS.touchedPaths, rules),
    ...pathSignals(input.pathHints ?? [], 'paths-hint', CLASSIFIER_WEIGHTS.pathHints, rules),
  ];
  const files = new Map<JobArea, string[]>();
  for (const m of prompt.matchAll(FILE_NAME)) {
    const name = m[0];
    if (/^\d+(\.\d+)+$/u.test(name) || /^https?:/iu.test(name)) continue;
    const a = areaOfPath(name, rules);
    if (a === null) continue;
    const list = files.get(a) ?? [];
    if (list.length < 2 && !list.includes(name)) files.set(a, [...list, name]);
  }
  for (const [area, list] of files) {
    for (const name of list) {
      signals.push({ source: 'file-types', area, weight: CLASSIFIER_WEIGHTS.fileType, detail: name });
    }
  }
  if (prompt !== '') signals.push(...keywordSignals(prompt, 'prompt', CLASSIFIER_WEIGHTS.keyword, 3));
  if (input.templateName !== undefined && input.templateName !== '') {
    signals.push(...keywordSignals(input.templateName, 'template', CLASSIFIER_WEIGHTS.template, 2));
  }
  const scores: Partial<Record<JobArea, number>> = {};
  for (const s of signals) scores[s.area] = round2((scores[s.area] ?? 0) + s.weight);
  const ranked = (Object.entries(scores) as [JobArea, number][]).sort(
    (a, b) => b[1] - a[1] || JOB_AREAS.indexOf(a[0]) - JOB_AREAS.indexOf(b[0]),
  );
  const [top, second] = ranked;
  let area: JobArea | null = null;
  if (
    top !== undefined &&
    top[1] >= CLASSIFIER_WEIGHTS.threshold &&
    (second === undefined || top[1] > second[1] * 1.5)
  ) {
    area = top[0];
  }
  let areaSource: SignalSource | null = null;
  if (area !== null) {
    const order: readonly SignalSource[] = [
      'touched-paths',
      'paths-hint',
      'file-types',
      'prompt',
      'template',
    ];
    const mine = signals.filter((s) => s.area === area);
    areaSource = order.find((o) => mine.some((s) => s.source === o)) ?? null;
  }
  return { kind: kind.role, kindSource: kind.source, area, areaSource, scores, signals };
}

// ------------------------------------------------------------------------------------------------- settings

export const RUNTIME_ADVICE_MODES = ['off', 'advice', 'auto'] as const;
export const RuntimeAdviceMode = z.enum(RUNTIME_ADVICE_MODES);
export type RuntimeAdviceMode = z.infer<typeof RuntimeAdviceMode>;

export const RUNTIME_ADVICE_BOUNDS = {
  maxExplorationPct: 30,
  minMinSamples: 3,
  maxMinSamples: 100,
  minHalfLifeDays: 7,
  maxHalfLifeDays: 365,
  maxRerunWindowDays: 30,
  maxAreaRules: 10,
} as const;

/**
 * A project's runtime-advice settings (`runtime_advice_settings`; absent row = {@link RUNTIME_ADVICE_DEFAULTS}).
 * `advice` shows recommendations only; `auto` lets jobs submitted with runtime "auto" be routed by expected outcome.
 */
export const RuntimeAdviceSettings = z.strictObject({
  mode: RuntimeAdviceMode,
  /** Share of auto decisions (percent) that try an under-sampled runtime instead of the best one. */
  explorationPct: z.number().int().min(0).max(RUNTIME_ADVICE_BOUNDS.maxExplorationPct),
  /** Jobs a runtime needs in this project's area before its record counts. */
  minSamples: z
    .number()
    .int()
    .min(RUNTIME_ADVICE_BOUNDS.minMinSamples)
    .max(RUNTIME_ADVICE_BOUNDS.maxMinSamples),
  /** Runtimes auto mode may pick (empty = every current runtime). */
  allowedRuntimes: z.array(RuntimeKind).max(RuntimeKind.options.length),
  /** Auto mode may pick a runtime whose model bills per token (an API-key profile). */
  allowPaid: z.boolean(),
  /** Recency decay: an outcome this many days old counts half. */
  halfLifeDays: z
    .number()
    .int()
    .min(RUNTIME_ADVICE_BOUNDS.minHalfLifeDays)
    .max(RUNTIME_ADVICE_BOUNDS.maxHalfLifeDays),
  /** The same prompt submitted again within this many days marks the earlier job as corrected (not good). */
  rerunWindowDays: z.number().int().min(0).max(RUNTIME_ADVICE_BOUNDS.maxRerunWindowDays),
  /** The project's own path → area rules (checked before the built-in ones). */
  areaRules: z.array(AreaPathRule).max(RUNTIME_ADVICE_BOUNDS.maxAreaRules),
});
export type RuntimeAdviceSettings = z.infer<typeof RuntimeAdviceSettings>;

export const RUNTIME_ADVICE_DEFAULTS: RuntimeAdviceSettings = {
  mode: 'advice',
  explorationPct: 10,
  minSamples: 5,
  allowedRuntimes: [],
  allowPaid: false,
  halfLifeDays: 60,
  rerunWindowDays: 3,
  areaRules: [],
};

/** The runtime value a submission uses to ask auto mode to choose (never reaches a worker). */
export const AUTO_RUNTIME = 'auto';
