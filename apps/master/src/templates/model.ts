import {
  ApprovalPolicy,
  RuntimeKind,
  RuntimeModelId,
  SandboxProfile,
  PriorityClass,
} from '@remyral/protocol';
import { z } from 'zod';
import { TemplateParameter } from './params.js';

/** p8-templates (docs/design/p8-templates.md §2): what a template is and what a caller may send. */

export const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_TEMPLATE_PROMPT = 64 * 1024;
export const TEMPLATE_STATES = ['active', 'archived'] as const;
export type TemplateState = (typeof TEMPLATE_STATES)[number];

/**
 * The run settings of a template (§2.2). They are the template's policy: a run takes them as they are (the project's
 * defaults fill what is left out, exactly like the composer) and a parameter can never set or change one.
 */
export const TemplateDefaults = z.strictObject({
  runtime: RuntimeKind,
  // p15-model-picker: a model profile id or a model id of the runtime model catalog (it becomes the job's `model`).
  modelProfile: RuntimeModelId.optional(),
  sandboxProfile: SandboxProfile.optional(),
  approvalPolicy: ApprovalPolicy.optional(),
  baseRef: z.string().min(1).max(255).optional(),
  limits: z
    .strictObject({
      maxDurationSec: z
        .number()
        .int()
        .min(60)
        .max(7 * 24 * 3600)
        .optional(),
      maxTokens: z.number().int().min(1).optional(),
      maxCostUsd: z.number().min(0).optional(),
    })
    .optional(),
  deployOnSuccess: z
    .strictObject({
      target: z.enum(['pages', 'coolify']),
      env: z.enum(['preview', 'production']).optional(),
      directory: z.string().max(300).optional(),
    })
    .optional(),
  /** p10-verify-health: "Verify when done" of jobs run from the template (absent: the project's default). */
  verify: z.enum(['off', 'report', 'gate']).optional(),
  /** Chat runs: watch what confirming the card creates and tell the user when it finished. */
  watch: z.boolean().optional(),
  /** p9-queue-priority: the queue class of jobs run from the template (absent: Normal). */
  priorityClass: PriorityClass.optional(),
});
export type TemplateDefaults = z.infer<typeof TemplateDefaults>;

const Tags = z
  .array(
    z
      .string()
      .trim()
      .regex(/^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,39}$/u, 'tag'),
  )
  .max(16);

export const TemplateSource = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manual') }),
  z.strictObject({ kind: z.literal('job'), id: z.string().regex(UUID) }),
  z.strictObject({ kind: z.literal('draft'), id: z.string().regex(UUID) }),
  z.strictObject({
    kind: z.literal('suggestion'),
    id: z.string().regex(/^[0-9a-f]{32}$/),
    members: z
      .array(z.string().regex(/^(job|draft):[0-9a-f-]{36}$/))
      .max(50)
      .optional(),
  }),
  z.strictObject({ kind: z.literal('duplicate'), id: z.string().regex(UUID) }),
]);
export type TemplateSource = z.infer<typeof TemplateSource>;

const Content = {
  prompt: z.string().min(1).max(MAX_TEMPLATE_PROMPT),
  parameters: z.array(TemplateParameter).max(30),
  defaults: TemplateDefaults,
};

export const TemplateInput = z.strictObject({
  /** null / absent = global (admin). */
  project: z.string().regex(PROJECT).nullable().optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).optional(),
  tags: Tags.optional(),
  ...Content,
  parameters: Content.parameters.optional(),
  changeNote: z.string().trim().max(500).optional(),
  source: TemplateSource.optional(),
});
export type TemplateInput = z.infer<typeof TemplateInput>;

export const TemplatePatch = z.strictObject({
  /** The version the editor started from; a content change on another version is a conflict (409). */
  expectedVersion: z.number().int().min(1),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(4000).optional(),
  tags: Tags.optional(),
  prompt: Content.prompt.optional(),
  parameters: Content.parameters.optional(),
  defaults: TemplateDefaults.optional(),
  changeNote: z.string().trim().max(500).optional(),
});
export type TemplatePatch = z.infer<typeof TemplatePatch>;

export class TemplateError extends Error {
  override readonly name = 'TemplateError';
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 503,
    readonly code: string,
    message: string,
    readonly issues: readonly {
      readonly code: string;
      readonly message: string;
      readonly param?: string;
    }[] = [],
  ) {
    super(message);
  }
}

export interface TemplateStats {
  readonly runs: number;
  readonly finished: number;
  readonly succeeded: number;
  /** succeeded / finished; null before the first finished run. */
  readonly successRate: number | null;
  readonly avgCostUsd: number | null;
  readonly avgDurationSec: number | null;
  readonly lastRunAt: string | null;
  readonly automations: number;
}

export interface TemplateVersionView {
  readonly version: number;
  readonly prompt: string;
  readonly parameters: TemplateParameter[];
  readonly defaults: TemplateDefaults;
  readonly changeNote: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export interface TemplateView {
  readonly id: string;
  readonly project: string | null;
  readonly title: string;
  readonly description: string;
  readonly tags: string[];
  readonly state: TemplateState;
  readonly version: number;
  readonly owner: { readonly id: string | null; readonly username: string | null };
  readonly source: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly current: TemplateVersionView;
  readonly stats: TemplateStats;
  /** The caller may change it (operator+ in its project; admin for a global one). */
  readonly canEdit: boolean;
  /**
   * p18-multi-project W4 (template library): where it comes from for the caller — `global`, `project` (its own
   * project: the listed project, or one the caller reads) or `shared` (shared to the listed / a readable project).
   */
  readonly scope: 'global' | 'project' | 'shared';
  /** The projects it is shared to that the caller reads ('*' = every project). */
  readonly sharedTo: string[];
  /** Shares to projects the caller cannot read (a count). */
  readonly sharedToHidden: number;
  /** The caller may change its shares (`templates.share` in its project; a global template has none). */
  readonly canShare: boolean;
  /** Hidden in the listed project (with a project filter / `?project=`). */
  readonly hidden: boolean;
}

/** p18-multi-project W4: `PUT /templates/:id/shares` — listed projects or ['*'] (every project); [] withdraws. */
export const TemplateShares = z.strictObject({
  projects: z.array(z.union([z.literal('*'), z.string().regex(PROJECT)])).max(200),
});
export type TemplateShares = z.infer<typeof TemplateShares>;

/** p18-multi-project W4: `PUT /templates/:id/hidden` — hide (or show again) a global / shared template in a project. */
export const TemplateHidden = z.strictObject({
  project: z.string().regex(PROJECT),
  hidden: z.boolean(),
});
export type TemplateHidden = z.infer<typeof TemplateHidden>;
