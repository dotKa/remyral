/**
 * `/jobs` (p6-ui-jobs): every job as one full-width table — state, title (first line of the prompt),
 * project, runtime, machine, when it was created, how long it took and what it cost — with a compact filter
 * bar whose values live in the URL (`?state=FAILED` links work), "New job" as the page's primary action and
 * "Run again" on finished rows. A row opens `/jobs/:id`. The first page refreshes itself every few seconds
 * while the tab is visible. Titles come from prompts: untrusted text, rendered as text only.
 */

/** The default workspace project (migration 0033): the "General" quick action opens the composer on it. */
export const GENEL = 'genel';
