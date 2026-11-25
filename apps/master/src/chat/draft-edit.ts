import { ApprovalPolicy, PriorityClass, RuntimeKind, SandboxProfile } from '@remyral/protocol';
import { z } from 'zod';
import type { DraftRecord } from './store.js';

/**
 * p12-diyalog-f3 (docs/design/p12-diyalog.md §11): editing a proposed job draft in place (`PATCH /chat/drafts/:id`).
 *
 * The edit never writes a payload by itself: the card's current settings plus the person's changes are turned back
 * into a `draft_job` input, checked against the tool's strict schema and rebuilt by the very `draft_job` path the
 * assistant uses (project role, project kind, full-access policy, deploy-on-success preview, input files, defaults,
 * placement, runtime advice). The rebuilt payload then replaces the draft's payload and hash. Confirming stays the
 * only way anything runs, with its own step-up and re-checks.
 */

const Project = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

export const DraftEditBody = z
  .strictObject({
    title: z.string().trim().min(1).max(200).optional(),
    project: Project.optional(),
    runtime: RuntimeKind.optional(),
    prompt: z.string().trim().min(1).max(32_000).optional(),
    priorityClass: PriorityClass.optional(),
    approvalPolicy: ApprovalPolicy.optional(),
    sandboxProfile: SandboxProfile.optional(),
    /** Pin to machines (ids or names, as draft_job.workers), or null to let placement choose. */
    workers: z.array(z.string().min(1).max(64)).min(1).max(16).nullable().optional(),
    /** null: no deploy when done. */
    deployOnSuccess: z.null().optional(),
    deployEnv: z.enum(['preview', 'production']).optional(),
    /** null: the project's default. */
    verifyOnSuccess: z.enum(['off', 'report', 'gate']).nullable().optional(),
    /** null: no input files. */
    inputs: z.null().optional(),
    /** p15-autonomy: the job's time limit (s), edited on the card. */
    maxDurationSec: z
      .number()
      .int()
      .min(60)
      .max(7 * 24 * 3600)
      .optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change.' });
export type DraftEdit = z.infer<typeof DraftEditBody>;

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const MODEL_PROFILE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DEPLOY_KEYS = [
  'target',
  'env',
  'directory',
  'pagesProject',
  'createIfMissing',
  'domain',
  'dns',
] as const;

/** The fields of an edit, for the audit and the note to the assistant. */
export function editedFields(e: DraftEdit): string[] {
  return Object.keys(e).sort();
}

/**
 * The `draft_job` input that rebuilds `d` with `e` applied (pure), the defaults the earlier version took from its
 * project and still takes, the class to keep and the template attribution (dropped with a project change).
 */
export function jobDraftInput(
  d: Pick<DraftRecord, 'title' | 'payload'>,
  e: DraftEdit,
): {
  input: Record<string, unknown>;
  inheritedDefaults: string[];
  priorityClass: PriorityClass;
  template: Record<string, unknown> | null;
} {
  const p = d.payload;
  const spec = rec(p.spec);
  const project = String(p.project);
  const target = e.project ?? project;
  const moved = target !== project;
  const runtime = e.runtime ?? (spec.runtime as string);
  const defaults = Array.isArray(rec(p.review).projectDefaults)
    ? (rec(p.review).projectDefaults as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  // A field the earlier card took from its project's defaults is taken again from the (new) project's defaults.
  const fromDefaults = (f: string): boolean => defaults.includes(f);
  const keep = (f: string): boolean => !(moved && fromDefaults(f));
  const input: Record<string, unknown> = {
    project: target,
    title: e.title ?? d.title,
    prompt: e.prompt ?? spec.prompt,
    runtime,
  };
  if (e.runtime === undefined && typeof spec.model === 'string' && MODEL_PROFILE.test(spec.model))
    input.modelProfile = spec.model;
  const repo = rec(spec.repository);
  if (!moved && typeof repo.baseRef === 'string') input.baseRef = repo.baseRef;
  const sandbox = e.sandboxProfile ?? (keep('sandboxProfile') ? spec.sandboxProfile : undefined);
  if (sandbox !== undefined) input.sandboxProfile = sandbox;
  const approval = e.approvalPolicy ?? (keep('approvalPolicy') ? spec.approvalPolicy : undefined);
  if (approval !== undefined) input.approvalPolicy = approval;
  const req = rec(spec.requirements);
  if (Array.isArray(req.os)) input.os = req.os;
  if (Array.isArray(req.arch)) input.arch = req.arch;
  if (e.workers !== undefined) {
    if (e.workers !== null) input.workers = e.workers;
  } else if (Array.isArray(req.workers)) input.workers = req.workers;
  if (keep('limits')) {
    const l = rec(spec.limits);
    for (const k of ['maxDurationSec', 'maxTokens', 'maxCostUsd'] as const)
      if (l[k] !== undefined) input[k] = l[k];
  }
  if (e.maxDurationSec !== undefined) input.maxDurationSec = e.maxDurationSec;
  if (e.inputs !== null) {
    if (typeof p.continueFrom === 'string') input.continueFrom = p.continueFrom;
    if (Array.isArray(p.inputArtifacts)) input.inputArtifacts = p.inputArtifacts;
    if (Array.isArray(p.chatAttachments)) input.chatAttachments = p.chatAttachments;
  }
  if (e.deployOnSuccess !== null && p.deployOnSuccess !== undefined && p.deployOnSuccess !== null) {
    const src = rec(p.deployOnSuccess);
    const dos: Record<string, unknown> = {};
    for (const k of DEPLOY_KEYS) if (src[k] !== undefined) dos[k] = src[k];
    if (e.deployEnv !== undefined) dos.env = e.deployEnv;
    input.deployOnSuccess = dos;
  }
  const verify = e.verifyOnSuccess === undefined ? p.verifyOnSuccess : e.verifyOnSuccess;
  if (verify === 'off' || verify === 'report' || verify === 'gate') input.verifyOnSuccess = verify;
  const cls = PriorityClass.safeParse(e.priorityClass ?? p.priorityClass);
  const template = moved ? null : p.template === undefined ? null : rec(p.template);
  const inherited = defaults.filter(
    (f) =>
      !moved &&
      !(f === 'sandboxProfile' && e.sandboxProfile !== undefined) &&
      !(f === 'approvalPolicy' && e.approvalPolicy !== undefined) &&
      !(f === 'runtime' && e.runtime !== undefined) &&
      !(f === 'limits' && e.maxDurationSec !== undefined),
  );
  return {
    input,
    inheritedDefaults: inherited,
    priorityClass: cls.success ? cls.data : 'normal',
    template,
  };
}
