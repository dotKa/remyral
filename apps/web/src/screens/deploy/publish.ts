import { DOMAIN_NAME, PAGES_PROJECT_NAME, type PublishOptions } from '../../api/deploy';

/**
 * p10-publish-bundle: "Publish to" — the Pages project (the target, a further one, or a new one the master creates if
 * it is missing), an optional custom domain and whether the master writes its CNAME. Shared by the Upload a site card
 * and the composer's "Deploy when done"; the master turns it into ONE approval for create → deploy → domain → CNAME.
 */

export const NEW_PROJECT = '__new__';

export interface PublishState {
  /** '' = the project's Pages target, a further project's name, or NEW_PROJECT. */
  readonly choice: string;
  readonly newName: string;
  readonly domain: string;
  readonly dns: 'auto' | 'skip';
}

export const EMPTY_PUBLISH: PublishState = { choice: '', newName: '', domain: '', dns: 'auto' };

/** Why the fields cannot be sent (null: fine). */
export function publishProblem(s: PublishState, target: string | null): string | null {
  if (s.choice === '' && target === null) return 'Choose a Pages project (or a new one).';
  if (s.choice === NEW_PROJECT && !PAGES_PROJECT_NAME.test(s.newName.trim())) {
    return 'New Pages project name: 1–58 lowercase letters, digits and hyphens, starting and ending with a letter or digit.';
  }
  const d = s.domain.trim().toLowerCase();
  if (d !== '' && !DOMAIN_NAME.test(d)) return 'The custom domain is not a valid host name.';
  return null;
}

/**
 * The publish fields to send (empty object: a plain deploy to the project's Pages target). The target is the
 * master's default, so it is never named.
 */
export function publishOptions(s: PublishState): PublishOptions {
  const domain = s.domain.trim().toLowerCase();
  const name = s.choice === NEW_PROJECT ? s.newName.trim() : s.choice !== '' ? s.choice : null;
  return {
    ...(name === null ? {} : { pagesProject: name }),
    ...(s.choice === NEW_PROJECT ? { createIfMissing: true } : {}),
    ...(domain === '' ? {} : { domain, dns: s.dns }),
  };
}

/** True when the options need the publish chain (a new project or a domain), not a plain deploy. */
export function needsPublish(o: PublishOptions): boolean {
  return o.createIfMissing === true || o.domain !== undefined;
}
