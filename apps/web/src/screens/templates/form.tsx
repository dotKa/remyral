import { isPriorityClass, type PriorityClass } from '../../api/queue';
import { type Candidate, type TemplateDefaults, type TemplateParameter } from '../../api/templates';

/**
 * `/jobs/templates/new` and `/jobs/templates/:id/edit` (p8-templates): the template editor — prompt with
 * `{{placeholders}}`, the parameter table (type, label, required, default, options, range), the run settings and a
 * live preview of the rendered prompt with sample values (the server renders it exactly as a run would). Opened
 * prefilled from a job (`?fromJob=`), a chat draft (`?fromDraft=`) or a suggestion (router state).
 */

export const RUNTIMES = ['claude-code', 'codex', 'opencode', 'pi'] as const;
export const SANDBOXES = ['container', 'runtime-sandbox', 'host-restricted', 'unconfined'] as const;
export const APPROVALS = ['ask-sensitive', 'ask-all', 'deny-sensitive', 'allow-all'] as const;

export type Meta = Record<string, Partial<TemplateParameter>>;

export interface Form {
  project: string;
  title: string;
  description: string;
  tags: string;
  prompt: string;
  runtime: string;
  modelProfile: string;
  sandboxProfile: string;
  approvalPolicy: string;
  maxDurationMin: string;
  deployTarget: '' | 'pages' | 'coolify';
  deployEnv: 'preview' | 'production';
  /** p10-verify-health: '' = the project's default. */
  verify: '' | 'off' | 'report' | 'gate';
  watch: boolean;
  /** p9-queue-priority: the class of the template's jobs (Normal is left out of the payload). */
  priorityClass: PriorityClass;
  changeNote: string;
}

export const EMPTY: Form = {
  project: '',
  title: '',
  description: '',
  tags: '',
  prompt: '',
  runtime: 'claude-code',
  modelProfile: '',
  sandboxProfile: '',
  approvalPolicy: '',
  maxDurationMin: '',
  deployTarget: '',
  deployEnv: 'preview',
  verify: '',
  watch: false,
  priorityClass: 'normal',
  changeNote: '',
};

export function formFromDefaults(d: TemplateDefaults): Partial<Form> {
  return {
    runtime: d.runtime,
    modelProfile: d.modelProfile ?? '',
    sandboxProfile: d.sandboxProfile ?? '',
    approvalPolicy: d.approvalPolicy ?? '',
    maxDurationMin:
      d.limits?.maxDurationSec === undefined ? '' : String(Math.round(d.limits.maxDurationSec / 60)),
    deployTarget: d.deployOnSuccess?.target ?? '',
    deployEnv: d.deployOnSuccess?.env ?? 'preview',
    verify: d.verify ?? '',
    watch: d.watch === true,
    priorityClass: isPriorityClass(d.priorityClass) ? d.priorityClass : 'normal',
  };
}

export function defaultsOf(f: Form): TemplateDefaults {
  const min = Number(f.maxDurationMin);
  return {
    runtime: f.runtime,
    ...(f.modelProfile.trim() === '' ? {} : { modelProfile: f.modelProfile.trim() }),
    ...(f.sandboxProfile === '' ? {} : { sandboxProfile: f.sandboxProfile }),
    ...(f.approvalPolicy === '' ? {} : { approvalPolicy: f.approvalPolicy }),
    ...(f.maxDurationMin.trim() !== '' && Number.isFinite(min) && min >= 1
      ? { limits: { maxDurationSec: Math.round(min * 60) } }
      : {}),
    ...(f.deployTarget === '' ? {} : { deployOnSuccess: { target: f.deployTarget, env: f.deployEnv } }),
    ...(f.verify === '' ? {} : { verify: f.verify }),
    ...(f.watch ? { watch: true } : {}),
    ...(f.priorityClass === 'normal' ? {} : { priorityClass: f.priorityClass }),
  };
}

export function metaOf(params: readonly TemplateParameter[]): Meta {
  const m: Meta = {};
  for (const p of params) {
    const { examples: _e, ...rest } = p;
    m[p.name] = rest;
  }
  return m;
}

/** Replaces every occurrence of a candidate's text with its placeholder. */
export function applyCandidate(prompt: string, c: Candidate): string {
  return prompt.split(c.text).join(`{{${c.name}}}`);
}
