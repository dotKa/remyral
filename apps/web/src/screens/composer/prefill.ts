import { APPROVAL_POLICIES, type Draft, RUNTIMES, SANDBOX_PROFILES } from './draft';

/**
 * Composer prefill (p5-first-live-fixes "Run again", p5-chat-ux "Edit in composer"): turns a job spec — a
 * finished job's stored spec, or a chat draft's payload — into composer fields. The spec is data from the
 * master (and, for chat drafts, from a model): every field is type-checked and unknown values are dropped, so
 * the composer's own validation and the master stay authoritative. A fresh work branch is kept (re-using the
 * previous run's branch would collide with its pushed changes).
 */

export interface ComposerPrefill {
  readonly project: string;
  readonly spec: Readonly<Record<string, unknown>>;
  /** p5-ops-chat-next: a chat job draft's "continue from" job (workspace projects). */
  readonly continueFrom?: string;
  /** p8-templates: filled from this template version (the submission is attributed to it). */
  readonly template?: { readonly id: string; readonly version: number; readonly title: string };
  /** p8-templates: the template's "deploy when done" setting (the composer's switch starts on it). */
  readonly deployOnSuccess?: {
    readonly target: 'pages' | 'coolify';
    readonly env?: 'preview' | 'production';
    readonly directory?: string;
  };
  /** p10-verify-health: the template's "Verify when done" (the composer's choice starts on it). */
  readonly verify?: 'off' | 'report' | 'gate';
}

/** Router state key used to hand a prefill to `/jobs/new` (never put in the URL: prompts can be large). */
export interface PrefillState {
  readonly prefill: ComposerPrefill;
}

export function isPrefillState(v: unknown): v is PrefillState {
  if (typeof v !== 'object' || v === null || !('prefill' in v)) return false;
  const p = v.prefill;
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof (p as { project?: unknown }).project === 'string' &&
    typeof (p as { spec?: unknown }).spec === 'object' &&
    (p as { spec?: unknown }).spec !== null
  );
}

const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown, max = 1024): string | undefined {
  return typeof v === 'string' && v.length <= max ? v : undefined;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

function strings(v: unknown, max: number): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.length <= 128).slice(0, max);
  return out.length > 0 ? out : undefined;
}

function num(v: unknown): string | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? String(v) : undefined;
}

/** Composer fields from a prefill; only fields that are present and well-formed are returned. */
export function draftFromPrefill(p: ComposerPrefill): Partial<Draft> {
  const spec = p.spec;
  const repo = rec(spec.repository);
  const limits = rec(spec.limits);
  const req = rec(spec.requirements);
  const out: Partial<Draft> = { mode: 'job' };
  if (PROJECT.test(p.project)) out.project = p.project;
  const set = <K extends keyof Draft>(k: K, v: Draft[K] | undefined): void => {
    if (v !== undefined) out[k] = v;
  };
  set('runtime', oneOf(spec.runtime, RUNTIMES));
  set('runtimeVersion', str(spec.runtimeVersion, 64));
  set('model', str(spec.model, 128));
  // p6-quota-scheduling: fallback runtimes and the off-peak deferral carry over to "Run again".
  if (Array.isArray(spec.fallbacks)) {
    const fb = spec.fallbacks.flatMap((f: unknown) => {
      const r = oneOf(rec(f).runtime, RUNTIMES);
      return r === undefined ? [] : [r];
    });
    if (fb.length > 0) out.fallbacks = fb.slice(0, 3);
  }
  if (spec.deferrable === true) out.deferrable = true;
  // p22-output-delivery: "run again" keeps a job's delivery to Outputs.
  if (spec.delivery === 'outputs') out.delivery = 'outputs';
  set('prompt', str(spec.prompt, 256 * 1024));
  set('repoUrl', str(repo.url));
  set('baseRef', str(repo.baseRef, 255));
  set('sandboxProfile', oneOf(spec.sandboxProfile, SANDBOX_PROFILES));
  set('approvalPolicy', oneOf(spec.approvalPolicy, APPROVAL_POLICIES));
  set('sourceTrust', oneOf(spec.sourceTrust, ['trusted', 'untrusted'] as const));
  const dur = typeof limits.maxDurationSec === 'number' ? limits.maxDurationSec : undefined;
  if (dur !== undefined && Number.isFinite(dur) && dur >= 60)
    out.maxDurationMin = String(Math.ceil(dur / 60));
  set('maxCostUsd', num(limits.maxCostUsd));
  set('maxTokens', num(limits.maxTokens));
  set('maxTurns', num(limits.maxTurns));
  if (typeof spec.priority === 'number' && Number.isInteger(spec.priority))
    out.priority = String(spec.priority);
  set('os', strings(req.os, 3));
  set('arch', strings(req.arch, 2));
  set('workers', strings(req.workers, 16));
  const tools = strings(req.tools, 16);
  if (tools !== undefined) out.tools = tools.join(', ');
  if (typeof p.continueFrom === 'string' && UUID_RE.test(p.continueFrom)) out.continueFrom = p.continueFrom;
  return out;
}

/** p8-templates: the template a prefill came from, when well-formed (else null). */
export function templateOfPrefill(
  p: ComposerPrefill,
): { readonly id: string; readonly version: number; readonly title: string } | null {
  const t = p.template;
  if (t === undefined || typeof t !== 'object') return null;
  if (typeof t.id !== 'string' || !UUID_RE.test(t.id)) return null;
  if (typeof t.version !== 'number' || !Number.isInteger(t.version) || t.version < 1) return null;
  return {
    id: t.id,
    version: t.version,
    title: typeof t.title === 'string' ? t.title.slice(0, 200) : 'Template',
  };
}
