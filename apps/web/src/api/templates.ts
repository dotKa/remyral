import { apiRequest, nullableStr, obj, type RequestOptions, ShapeError, str, strArray } from './client';

/**
 * p8-templates (docs/design/p8-templates.md): job templates — list, editor, versions, render, suggestions. Titles,
 * descriptions, prompts and example values are untrusted text: rendered as text only.
 */

type Opts = Omit<RequestOptions, 'body'>;
const enc = encodeURIComponent;

export const PARAM_TYPES = ['string', 'text', 'int', 'number', 'url', 'bool', 'enum', 'file'] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

export interface TemplateParameter {
  readonly name: string;
  readonly type: ParamType;
  readonly label?: string;
  readonly description?: string;
  readonly required?: boolean;
  readonly default?: string | number | boolean;
  readonly options?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly maxLength?: number;
  /** Suggestions only: each member's value. */
  readonly examples?: readonly string[];
}

export interface TemplateDefaults {
  readonly runtime: string;
  readonly modelProfile?: string;
  readonly sandboxProfile?: string;
  readonly approvalPolicy?: string;
  readonly baseRef?: string;
  readonly limits?: {
    readonly maxDurationSec?: number;
    readonly maxTokens?: number;
    readonly maxCostUsd?: number;
  };
  readonly deployOnSuccess?: {
    readonly target: 'pages' | 'coolify';
    readonly env?: 'preview' | 'production';
    readonly directory?: string;
  };
  readonly watch?: boolean;
  /** p10-verify-health: "Verify when done" of jobs run from the template (absent: the project's default). */
  readonly verify?: 'off' | 'report' | 'gate';
  /** p9-queue-priority: the queue class of jobs run from the template (absent: Normal). */
  readonly priorityClass?: 'urgent' | 'normal' | 'background';
}

export interface TemplateVersion {
  readonly version: number;
  readonly prompt: string;
  readonly parameters: readonly TemplateParameter[];
  readonly defaults: TemplateDefaults;
  readonly changeNote: string | null;
  readonly createdAt: string;
}

export interface TemplateStats {
  readonly runs: number;
  readonly finished: number;
  readonly succeeded: number;
  readonly successRate: number | null;
  readonly avgCostUsd: number | null;
  readonly avgDurationSec: number | null;
  readonly lastRunAt: string | null;
  readonly automations: number;
}

export interface Template {
  readonly id: string;
  readonly project: string | null;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly state: 'active' | 'archived';
  readonly version: number;
  readonly owner: string | null;
  readonly updatedAt: string;
  readonly current: TemplateVersion;
  readonly stats: TemplateStats;
  readonly canEdit: boolean;
  /**
   * p18-multi-project W4 (template library): `global`, `project` (its own project) or `shared` (another project shared
   * it with the listed / a readable project). Older masters: `global` / `project`.
   */
  readonly scope: 'global' | 'project' | 'shared';
  /** The projects it is shared to that the caller reads (`*` = every project). */
  readonly sharedTo: readonly string[];
  /** Shares to projects the caller cannot read (a count). */
  readonly sharedToHidden: number;
  /** The caller may change its shares. */
  readonly canShare: boolean;
  /** Hidden in the listed project (`?project=`). */
  readonly hidden: boolean;
}

export interface TemplateIssue {
  readonly code: string;
  readonly message: string;
  readonly param?: string;
}

export interface Candidate {
  readonly text: string;
  readonly type: ParamType;
  readonly name: string;
}

export interface Proposal {
  readonly project: string;
  readonly title: string;
  readonly prompt: string;
  readonly defaults: TemplateDefaults;
  readonly candidates: readonly Candidate[];
  readonly source: Record<string, unknown>;
}

export interface Suggestion {
  readonly id: string;
  readonly project: string;
  readonly title: string;
  readonly prompt: string;
  readonly parameters: readonly TemplateParameter[];
  readonly occurrences: number;
  readonly avgSimilarity: number;
  readonly lastSeenAt: string;
  readonly members: readonly {
    readonly kind: 'job' | 'draft';
    readonly id: string;
    readonly title: string;
    readonly createdAt: string;
  }[];
  readonly defaults: {
    readonly runtime: string | null;
    readonly modelProfile: string | null;
    readonly sandboxProfile: string | null;
    readonly approvalPolicy: string | null;
  };
}

function num(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  if (typeof v !== 'number') throw new ShapeError(`expected number at ${k}`);
  return v;
}
function numOrNull(o: Record<string, unknown>, k: string): number | null {
  const v = o[k];
  if (v === null) return null;
  if (typeof v !== 'number') throw new ShapeError(`expected number|null at ${k}`);
  return v;
}

function param(v: unknown): TemplateParameter {
  const o = obj(v);
  const type = str(o, 'type');
  if (!(PARAM_TYPES as readonly string[]).includes(type)) throw new ShapeError('parameter type');
  const d = o.default;
  return {
    name: str(o, 'name'),
    type: type as ParamType,
    ...(typeof o.label === 'string' ? { label: o.label } : {}),
    ...(typeof o.description === 'string' ? { description: o.description } : {}),
    ...(typeof o.required === 'boolean' ? { required: o.required } : {}),
    ...(typeof d === 'string' || typeof d === 'number' || typeof d === 'boolean' ? { default: d } : {}),
    ...(Array.isArray(o.options) ? { options: strArray(o, 'options') } : {}),
    ...(typeof o.min === 'number' ? { min: o.min } : {}),
    ...(typeof o.max === 'number' ? { max: o.max } : {}),
    ...(typeof o.maxLength === 'number' ? { maxLength: o.maxLength } : {}),
    ...(Array.isArray(o.examples) ? { examples: strArray(o, 'examples') } : {}),
  };
}

function defaults(v: unknown): TemplateDefaults {
  const o = obj(v);
  return { ...(o as object), runtime: str(o, 'runtime') };
}

function version(v: unknown): TemplateVersion {
  const o = obj(v);
  if (!Array.isArray(o.parameters)) throw new ShapeError('parameters');
  return {
    version: num(o, 'version'),
    prompt: str(o, 'prompt'),
    parameters: o.parameters.map(param),
    defaults: defaults(o.defaults),
    changeNote: nullableStr(o, 'changeNote'),
    createdAt: str(o, 'createdAt'),
  };
}

function template(v: unknown): Template {
  const o = obj(v);
  const s = obj(o.stats);
  const state = str(o, 'state');
  return {
    id: str(o, 'id'),
    project: nullableStr(o, 'project'),
    title: str(o, 'title'),
    description: str(o, 'description'),
    tags: strArray(o, 'tags'),
    state: state === 'archived' ? 'archived' : 'active',
    version: num(o, 'version'),
    owner: nullableStr(obj(o.owner), 'username'),
    updatedAt: str(o, 'updatedAt'),
    current: version(o.current),
    stats: {
      runs: num(s, 'runs'),
      finished: num(s, 'finished'),
      succeeded: num(s, 'succeeded'),
      successRate: numOrNull(s, 'successRate'),
      avgCostUsd: numOrNull(s, 'avgCostUsd'),
      avgDurationSec: numOrNull(s, 'avgDurationSec'),
      lastRunAt: nullableStr(s, 'lastRunAt'),
      automations: num(s, 'automations'),
    },
    canEdit: o.canEdit === true,
    scope:
      o.scope === 'shared' || o.scope === 'global' || o.scope === 'project'
        ? o.scope
        : o.project === null
          ? 'global'
          : 'project',
    sharedTo: Array.isArray(o.sharedTo) ? strArray(o, 'sharedTo') : [],
    sharedToHidden: typeof o.sharedToHidden === 'number' ? o.sharedToHidden : 0,
    canShare: o.canShare === true,
    hidden: o.hidden === true,
  };
}

function issues(v: unknown): TemplateIssue[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    const o = obj(x);
    return {
      code: str(o, 'code'),
      message: str(o, 'message'),
      ...(typeof o.param === 'string' ? { param: o.param } : {}),
    };
  });
}

function candidates(v: unknown): Candidate[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    const o = obj(x);
    return { text: str(o, 'text'), type: str(o, 'type') as ParamType, name: str(o, 'name') };
  });
}

export function listTemplates(
  filter: {
    readonly project?: string;
    readonly state?: 'active' | 'archived' | 'any';
    readonly q?: string;
    /** p18-multi-project W4 (with `project`): the templates hidden there too, or only them. */
    readonly hidden?: 'exclude' | 'include' | 'only';
  } = {},
  opts: Opts = {},
): Promise<Template[]> {
  const q = new URLSearchParams();
  if (filter.project) q.set('project', filter.project);
  if (filter.project && filter.hidden !== undefined) q.set('hidden', filter.hidden);
  if (filter.state) q.set('state', filter.state);
  if (filter.q) q.set('q', filter.q);
  const qs = q.toString();
  return apiRequest(
    'GET',
    `/templates${qs ? `?${qs}` : ''}`,
    (v) => {
      const items = obj(v).items;
      if (!Array.isArray(items)) throw new ShapeError('items');
      return items.map(template);
    },
    opts,
  );
}

/** p18-multi-project W4: `project` = the project the template is read in (a project it is shared to). */
const inProject = (project: string | undefined, sep: '?' | '&' = '?'): string =>
  project === undefined || project === '' ? '' : `${sep}project=${enc(project)}`;

export function getTemplate(id: string, opts: Opts = {}, project?: string): Promise<Template> {
  return apiRequest('GET', `/templates/${enc(id)}${inProject(project)}`, template, opts);
}

/** p18-multi-project W4: share a project template with listed projects or every project (`['*']`); [] withdraws. */
export function setTemplateShares(
  id: string,
  projects: readonly string[],
  opts: Opts = {},
): Promise<Template> {
  return apiRequest('PUT', `/templates/${enc(id)}/shares`, template, { ...opts, body: { projects } });
}

/** p18-multi-project W4: hide a global / shared template from a project's library (or show it again). */
export function setTemplateHidden(
  id: string,
  project: string,
  hidden: boolean,
  opts: Opts = {},
): Promise<Template> {
  return apiRequest('PUT', `/templates/${enc(id)}/hidden`, template, { ...opts, body: { project, hidden } });
}

export interface TemplateBody {
  readonly project?: string | null;
  readonly title: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly prompt: string;
  readonly parameters?: readonly TemplateParameter[];
  readonly defaults: TemplateDefaults;
  readonly changeNote?: string;
  readonly source?: Record<string, unknown>;
}

export function createTemplate(body: TemplateBody, opts: Opts = {}): Promise<Template> {
  return apiRequest('POST', '/templates', template, { ...opts, body });
}

export function updateTemplate(
  id: string,
  body: Omit<TemplateBody, 'project' | 'source'> & { readonly expectedVersion: number },
  opts: Opts = {},
): Promise<Template> {
  return apiRequest('PATCH', `/templates/${enc(id)}`, template, { ...opts, body });
}

export function setTemplateArchived(id: string, archived: boolean, opts: Opts = {}): Promise<Template> {
  return apiRequest('POST', `/templates/${enc(id)}/${archived ? 'archive' : 'restore'}`, template, opts);
}

/** `project`: "Projeye kopyala" — the copy's project (absent: the template's own project). */
export function duplicateTemplate(id: string, opts: Opts = {}, project?: string): Promise<Template> {
  return apiRequest('POST', `/templates/${enc(id)}/duplicate`, template, {
    ...opts,
    body: project === undefined ? {} : { project },
  });
}

export function templateVersions(id: string, opts: Opts = {}, project?: string): Promise<TemplateVersion[]> {
  return apiRequest(
    'GET',
    `/templates/${enc(id)}/versions${inProject(project)}`,
    (v) => {
      const items = obj(v).items;
      if (!Array.isArray(items)) throw new ShapeError('items');
      return items.map(version);
    },
    opts,
  );
}

export function templateDiff(
  id: string,
  from: number,
  to: number,
  opts: Opts = {},
  project?: string,
): Promise<string> {
  return apiRequest(
    'GET',
    `/templates/${enc(id)}/diff?from=${String(from)}&to=${String(to)}${inProject(project, '&')}`,
    (v) => str(obj(v), 'diff'),
    opts,
  );
}

export interface PreviewResult {
  readonly parameters: readonly TemplateParameter[];
  readonly issues: readonly TemplateIssue[];
  readonly valueIssues: readonly TemplateIssue[];
  readonly prompt: string | null;
  readonly candidates: readonly Candidate[];
}

export function previewTemplate(
  body: {
    readonly prompt: string;
    readonly parameters?: readonly TemplateParameter[];
    readonly values?: Readonly<Record<string, unknown>>;
    readonly title?: string;
  },
  opts: Opts = {},
): Promise<PreviewResult> {
  return apiRequest(
    'POST',
    '/templates/preview',
    (v) => {
      const o = obj(v);
      if (!Array.isArray(o.parameters)) throw new ShapeError('parameters');
      return {
        parameters: o.parameters.map(param),
        issues: issues(o.issues),
        valueIssues: issues(o.valueIssues),
        prompt: nullableStr(o, 'prompt'),
        candidates: candidates(o.candidates),
      };
    },
    { ...opts, body },
  );
}

export interface Rendered {
  readonly templateId: string;
  readonly version: number;
  readonly project: string;
  readonly prompt: string;
  readonly defaults: TemplateDefaults;
}

export function renderTemplate(
  id: string,
  values: Readonly<Record<string, string | number | boolean>>,
  project?: string,
  opts: Opts = {},
): Promise<Rendered> {
  return apiRequest(
    'POST',
    `/templates/${enc(id)}/render`,
    (v) => {
      const o = obj(v);
      return {
        templateId: str(o, 'templateId'),
        version: num(o, 'version'),
        project: str(o, 'project'),
        prompt: str(o, 'prompt'),
        defaults: defaults(o.defaults),
      };
    },
    { ...opts, body: { values, ...(project === undefined ? {} : { project }) } },
  );
}

export function automateTemplate(
  id: string,
  body: {
    readonly project?: string;
    readonly name: string;
    readonly trigger:
      { readonly kind: 'cron'; readonly cron: string } | { readonly kind: 'at'; readonly at: string };
    readonly values: Readonly<Record<string, string | number | boolean>>;
  },
  opts: Opts = {},
): Promise<{ automationId: string }> {
  return apiRequest(
    'POST',
    `/templates/${enc(id)}/automations`,
    (v) => ({ automationId: str(obj(v), 'automationId') }),
    { ...opts, body },
  );
}

function proposal(v: unknown): Proposal {
  const o = obj(v);
  return {
    project: str(o, 'project'),
    title: str(o, 'title'),
    prompt: str(o, 'prompt'),
    defaults: defaults(o.defaults),
    candidates: candidates(o.candidates),
    source: obj(o.source),
  };
}

export function proposalFromJob(jobId: string, opts: Opts = {}): Promise<Proposal> {
  return apiRequest('POST', '/templates/from-job', proposal, { ...opts, body: { jobId } });
}

export function proposalFromDraft(draftId: string, opts: Opts = {}): Promise<Proposal> {
  return apiRequest('POST', '/templates/from-draft', proposal, { ...opts, body: { draftId } });
}

export function listSuggestions(project?: string, opts: Opts = {}): Promise<Suggestion[]> {
  return apiRequest(
    'GET',
    `/template-suggestions${project ? `?project=${enc(project)}` : ''}`,
    (v) => {
      const items = obj(v).items;
      if (!Array.isArray(items)) throw new ShapeError('items');
      return items.map((x) => {
        const o = obj(x);
        const d = obj(o.defaults);
        if (!Array.isArray(o.parameters) || !Array.isArray(o.members)) throw new ShapeError('suggestion');
        return {
          id: str(o, 'id'),
          project: str(o, 'project'),
          title: str(o, 'title'),
          prompt: str(o, 'prompt'),
          parameters: o.parameters.map(param),
          occurrences: num(o, 'occurrences'),
          avgSimilarity: num(o, 'avgSimilarity'),
          lastSeenAt: str(o, 'lastSeenAt'),
          members: o.members.map((m) => {
            const mo = obj(m);
            return {
              kind: str(mo, 'kind') === 'draft' ? ('draft' as const) : ('job' as const),
              id: str(mo, 'id'),
              title: str(mo, 'title'),
              createdAt: str(mo, 'createdAt'),
            };
          }),
          defaults: {
            runtime: nullableStr(d, 'runtime'),
            modelProfile: nullableStr(d, 'modelProfile'),
            sandboxProfile: nullableStr(d, 'sandboxProfile'),
            approvalPolicy: nullableStr(d, 'approvalPolicy'),
          },
        };
      });
    },
    opts,
  );
}

export function suggestionFeedback(
  body: {
    readonly project: string;
    readonly suggestionId: string;
    readonly kind: 'dismissed' | 'not_similar';
    readonly members?: readonly string[];
  },
  opts: Opts = {},
): Promise<void> {
  return apiRequest('POST', '/template-suggestions/feedback', () => undefined, { ...opts, body });
}
