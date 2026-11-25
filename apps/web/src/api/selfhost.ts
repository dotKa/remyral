import { apiRequest, nullableStr, obj, type RequestOptions, ShapeError, str, strArray } from './client';

/**
 * p16-selfhost-onboarding (docs/design/p16-selfhost-onboarding.md): the first owner of a fresh install
 * (`/setup/status`, `/setup/owner`, public), the owners' setup wizard (`/onboarding*`) and the signed update feed
 * behind the "Güncelleme mevcut" banner (`/updates/status`, `/updates/check`).
 */

type Opts = Omit<RequestOptions, 'body'>;

// ---------------------------------------------------------------- setup (first owner)

export function getSetupStatus(opts: Opts = {}): Promise<{ readonly required: boolean }> {
  return apiRequest('GET', '/setup/status', (b) => ({ required: obj(b).required === true }), {
    ...opts,
    noSessionRetry: true,
  });
}

export function createFirstOwner(
  input: { readonly token: string; readonly username: string; readonly password: string },
  opts: Opts = {},
): Promise<{ readonly username: string }> {
  return apiRequest('POST', '/setup/owner', (b) => ({ username: str(obj(b), 'username') }), {
    ...opts,
    body: input,
    noSessionRetry: true,
  });
}

// ---------------------------------------------------------------- wizard

export const ONBOARDING_STEPS = [
  'account',
  // p17-memory-import: "Seni tanıyalım" — the owner's own AI assistant memory (optional).
  'about_you',
  'organisation',
  // p17-remyral-brand: the public address, TLS and access (read-only, self-hosted guidance).
  'domain',
  'security',
  'machine',
  'git',
  'integrations',
  'project',
  'sample_job',
  'done',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type StepState = 'todo' | 'done' | 'skipped';

export interface OnboardingStepView {
  readonly id: OnboardingStep;
  readonly state: StepState;
  readonly detected: boolean;
}
export interface Onboarding {
  readonly visible: boolean;
  readonly completedAt: string | null;
  readonly organisationName: string | null;
  readonly steps: readonly OnboardingStepView[];
  readonly progress: { readonly done: number; readonly total: number };
  readonly current: OnboardingStep;
}

const isStep = (v: unknown): v is OnboardingStep =>
  typeof v === 'string' && (ONBOARDING_STEPS as readonly string[]).includes(v);

export function parseOnboarding(body: unknown): Onboarding {
  const o = obj(body);
  const steps = Array.isArray(o.steps) ? o.steps : [];
  const progress = obj(o.progress);
  if (!isStep(o.current)) throw new ShapeError('expected a step at current');
  return {
    visible: o.visible === true,
    completedAt: nullableStr(o, 'completedAt'),
    organisationName: nullableStr(o, 'organisationName'),
    steps: steps.map((s) => {
      const x = obj(s);
      if (!isStep(x.id)) throw new ShapeError('expected a step id');
      const state = x.state === 'done' || x.state === 'skipped' ? x.state : 'todo';
      return { id: x.id, state, detected: x.detected === true };
    }),
    progress: { done: Number(progress.done ?? 0), total: Number(progress.total ?? 0) },
    current: o.current,
  };
}

export function getOnboarding(opts: Opts = {}): Promise<Onboarding> {
  return apiRequest('GET', '/onboarding', parseOnboarding, opts);
}
export function setOrganisation(name: string, opts: Opts = {}): Promise<Onboarding> {
  return apiRequest('PUT', '/onboarding/organisation', parseOnboarding, { ...opts, body: { name } });
}
export function markStep(step: OnboardingStep, state: StepState, opts: Opts = {}): Promise<Onboarding> {
  return apiRequest('PUT', `/onboarding/steps/${encodeURIComponent(step)}`, parseOnboarding, {
    ...opts,
    body: { state },
  });
}
export function completeOnboarding(opts: Opts = {}): Promise<Onboarding> {
  return apiRequest('POST', '/onboarding/complete', parseOnboarding, opts);
}
export function reopenOnboarding(opts: Opts = {}): Promise<Onboarding> {
  return apiRequest('POST', '/onboarding/reopen', parseOnboarding, opts);
}

// ---------------------------------------------------------------- update feed

export interface ReleaseInfo {
  readonly version: string;
  readonly publishedAt: string;
  readonly minWorkerVersion: string;
  readonly breaking: readonly string[];
  readonly summary: string;
  readonly notes: string;
}
export interface UpdateStatus {
  readonly configured: boolean;
  readonly currentVersion: string | null;
  readonly latest: ReleaseInfo | null;
  readonly updateAvailable: boolean;
  readonly newer: readonly ReleaseInfo[];
  readonly checkedAt: string | null;
  readonly error: string | null;
  readonly command: string | null;
}

function parseRelease(v: unknown): ReleaseInfo {
  const o = obj(v);
  return {
    version: str(o, 'version'),
    publishedAt: str(o, 'publishedAt'),
    minWorkerVersion: str(o, 'minWorkerVersion'),
    breaking: strArray(o, 'breaking'),
    summary: str(o, 'summary'),
    notes: str(o, 'notes'),
  };
}

export function parseUpdateStatus(body: unknown): UpdateStatus {
  const o = obj(body);
  return {
    configured: o.configured === true,
    currentVersion: nullableStr(o, 'currentVersion'),
    latest: o.latest === null || o.latest === undefined ? null : parseRelease(o.latest),
    updateAvailable: o.updateAvailable === true,
    newer: Array.isArray(o.newer) ? o.newer.map(parseRelease) : [],
    checkedAt: nullableStr(o, 'checkedAt'),
    error: nullableStr(o, 'error'),
    command: nullableStr(o, 'command'),
  };
}

export function getUpdateStatus(opts: Opts = {}): Promise<UpdateStatus> {
  return apiRequest('GET', '/updates/status', parseUpdateStatus, opts);
}
export function checkUpdates(opts: Opts = {}): Promise<UpdateStatus> {
  return apiRequest('POST', '/updates/check', parseUpdateStatus, opts);
}
