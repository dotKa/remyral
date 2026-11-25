/** The integrations routes (p14-web-perf: a module of its own, so routing code does not pull the page's chunk in). */

/** Top-level navigation to the master page that posts the GitHub App manifest (injectable for tests). */
export type Navigate = (url: string) => void;

export const INTEGRATIONS_PATH = '/settings/integrations';
export const GITHUB_CALLBACK_PATH = '/settings/integrations/github/callback';
export const GITHUB_INSTALLED_PATH = '/settings/integrations/github/installed';
