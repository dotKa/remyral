import type { DeployOnSuccessRequest } from '../../api/composer';
import { type DeployTargets } from '../../api/deploy';
import { NEW_PROJECT, publishOptions, publishProblem, type PublishState } from '../deploy/publish';

/**
 * p6-deploy-on-success (ADR-0030): the composer's "Deploy when done" choice. Off by default. Only the targets the
 * project has configured (Project → Deploy) are offered; production only where a project admin allowed auto-deploy
 * to production on success. Submitting the job is the approval (production asks for a fresh authenticator code).
 *
 * p10-publish-bundle: for Pages, "Publish to" adds the Pages project (the target, a further one or a new one created
 * if missing) and an optional custom domain with its CNAME — the whole chain is approved once, at submission.
 */

export type DeployTarget = 'pages' | 'coolify';
export type DeployEnvChoice = 'preview' | 'production';

export interface DeployChoice {
  readonly enabled: boolean;
  readonly target: DeployTarget;
  readonly env: DeployEnvChoice;
  readonly directory: string;
  /** p10-publish-bundle: Pages only — where to publish (absent: the Pages target, no domain). */
  readonly publish?: PublishState;
}

export const NO_DEPLOY: DeployChoice = { enabled: false, target: 'pages', env: 'preview', directory: 'site' };

const DIRECTORY = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}(\/[A-Za-z0-9_][A-Za-z0-9._-]{0,63}){0,3}$/;

/** Why the choice cannot be sent, or null. */
export function deployError(c: DeployChoice): string | null {
  if (!c.enabled || c.target !== 'pages') return null;
  const d = c.directory.trim();
  if (d === '' || !DIRECTORY.test(d) || d.split('/').some((s) => s === '..' || s === '.')) {
    return 'A relative directory such as site or dist.';
  }
  // The Pages target exists whenever Pages is offered, so only the new name / the domain can be wrong.
  return c.publish === undefined ? null : publishProblem(c.publish, 'target');
}

/** The request body field, or undefined when off. */
export function deployRequest(c: DeployChoice): DeployOnSuccessRequest | undefined {
  if (!c.enabled) return undefined;
  return {
    target: c.target,
    env: c.env,
    ...(c.target === 'pages' ? { directory: c.directory.trim() } : {}),
    ...(c.target === 'pages' && c.publish !== undefined ? publishOptions(c.publish) : {}),
  };
}

/** p10-publish-bundle: a stored / prefilled publish request as the form's state (`{}` when there is none). */
export function publishStateOf(
  p: {
    readonly pagesProject?: string | null;
    readonly createIfMissing?: boolean;
    readonly domain?: string | null;
    readonly dns?: 'auto' | 'skip';
  } | null,
): { readonly publish?: PublishState } {
  if (p === null) return {};
  const name = p.pagesProject ?? null;
  return {
    publish: {
      choice: name === null ? '' : p.createIfMissing === true ? NEW_PROJECT : name,
      newName: p.createIfMissing === true && name !== null ? name : '',
      domain: p.domain ?? '',
      dns: p.dns === 'skip' ? 'skip' : 'auto',
    },
  };
}

/** Which targets / environments the project's deploy configuration offers. */
export function deployOptions(t: DeployTargets | null): {
  readonly pages: boolean;
  readonly coolify: { readonly preview: boolean; readonly production: boolean };
  readonly productionAllowed: boolean;
} {
  const has = (e: { uuids: readonly string[]; tags: readonly string[] } | null | undefined): boolean =>
    e !== null && e !== undefined && (e.uuids.length > 0 || e.tags.length > 0);
  return {
    pages: t?.pages != null,
    coolify: { preview: has(t?.coolify?.preview), production: has(t?.coolify?.production) },
    productionAllowed: t?.policy.autoDeployProductionOnSuccess === true,
  };
}

/** p10-verify-health: "Verify when done" — '' = the project's default (Project → Deploy → Verification & health). */
export type VerifyChoice = '' | 'off' | 'report' | 'gate';

export function verifyChoiceOf(v: unknown): VerifyChoice {
  return v === 'off' || v === 'report' || v === 'gate' ? v : '';
}
