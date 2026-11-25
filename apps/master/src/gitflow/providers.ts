import type { ProjectGitConfig } from './config-store.js';
import type { FetchFn, GitHubAppAuth } from './github-app.js';
import { GitHubProvider } from './github-provider.js';
import { type HostConnectionSource, HostedProvider } from './hosted-provider.js';
import { LocalGitProvider } from './local-provider.js';
import { githubRepo } from './refs.js';
import type { ProviderFactory } from './service.js';
import { type GitProvider, ProviderError } from './types.js';

export interface ProviderFactoryOptions {
  /**
   * `keyRef` → GitHub App auth: `default` from GITHUB_APP_* (key file), `panel` from Settings → Integrations
   * (p5-github-connect). Read on every call: the panel entry appears, changes (key rotation) and disappears.
   */
  readonly githubApps: ReadonlyMap<string, GitHubAppAuth>;
  readonly githubFetch?: FetchFn;
  /** Plain git remotes: off unless the master enables them (AGENTS.md rule 1). */
  readonly plainGit: { readonly enabled: boolean; readonly cacheDir: string };
  /** p16-git-providers: GitLab / Bitbucket connections (absent: hosted providers are refused). */
  readonly gitHosts?: HostConnectionSource;
  readonly gitHostFetch?: FetchFn;
  /** Waits between asynchronous merge status reads (tests: 0). */
  readonly gitHostPollMs?: number;
}

/**
 * Production provider factory; instances are cached per project + configuration version + App credentials (a
 * rotated or reconnected panel App yields a new provider).
 */
export function createProviderFactory(opts: ProviderFactoryOptions): ProviderFactory {
  const cache = new Map<string, { version: number; auth: GitHubAppAuth | null; provider: GitProvider }>();
  return (config: ProjectGitConfig) => {
    const current = config.github === null ? null : (opts.githubApps.get(config.github.keyRef) ?? null);
    const hit = cache.get(config.project);
    if (hit !== undefined && hit.version === config.version && hit.auth === current) return hit.provider;
    let provider: GitProvider;
    if (config.provider === 'github') {
      const repo = githubRepo(config.repositoryUrl);
      const auth = config.github === null ? undefined : opts.githubApps.get(config.github.keyRef);
      if (
        repo === null ||
        config.github === null ||
        auth === undefined ||
        auth.appId !== config.github.appId
      ) {
        throw new ProviderError('GitHub App for this project is not configured on this master', false);
      }
      provider = new GitHubProvider({
        owner: repo.owner,
        repo: repo.repo,
        installationId: config.github.installationId,
        auth,
        ...(opts.githubFetch === undefined ? {} : { fetch: opts.githubFetch }),
      });
    } else if (config.provider === 'gitlab' || config.provider === 'bitbucket') {
      if (opts.gitHosts === undefined) {
        throw new ProviderError('GitLab / Bitbucket connections are not available on this master', false);
      }
      provider = new HostedProvider(config, {
        hosts: opts.gitHosts,
        ...(opts.gitHostFetch === undefined ? {} : { fetch: opts.gitHostFetch }),
        ...(opts.gitHostPollMs === undefined ? {} : { pollMs: opts.gitHostPollMs }),
      });
    } else {
      if (!opts.plainGit.enabled)
        throw new ProviderError('plain git remotes are disabled on this master', false);
      provider = new LocalGitProvider({ url: config.repositoryUrl, cacheDir: opts.plainGit.cacheDir });
    }
    cache.set(config.project, { version: config.version, auth: current, provider });
    return provider;
  };
}
