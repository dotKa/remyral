import { apiRequest, nullableStr, obj, type RequestOptions, ShapeError, str, strArray } from './client';

/**
 * p14-repo-egress (docs/design/p14-repo-egress.md): a repository project's network access for its jobs —
 * `none` (default: model APIs only) · `allowlist` (ready-made groups + custom hosts) · `web` (any public host on 443).
 * LAN / private / loopback / link-local / CGNAT / metadata addresses are refused in every mode by the worker's egress
 * proxy. Changing it needs a project admin and a fresh TOTP (audited by the master).
 */

export type RepoEgressMode = 'none' | 'allowlist' | 'web';
export type RepoEgressPreset = 'npm' | 'pypi' | 'crates' | 'go' | 'maven' | 'github' | 'gitlab';

/**
 * The hosts of each ready-made group — the same list as packages/protocol/src/repo-egress.ts (kept here so the console
 * bundle does not pull the protocol schemas; a test checks they match). The master expands them, never the console.
 */
export const REPO_EGRESS_PRESET_HOSTS: Readonly<Record<RepoEgressPreset, readonly string[]>> = {
  npm: ['registry.npmjs.org', 'registry.yarnpkg.com', 'repo.yarnpkg.com'],
  pypi: ['pypi.org', 'files.pythonhosted.org'],
  crates: ['crates.io', 'index.crates.io', 'static.crates.io'],
  go: ['proxy.golang.org', 'sum.golang.org'],
  maven: [
    'repo.maven.apache.org',
    'repo1.maven.org',
    'plugins.gradle.org',
    'services.gradle.org',
    'downloads.gradle.org',
  ],
  github: [
    'github.com',
    'api.github.com',
    'codeload.github.com',
    'raw.githubusercontent.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
  ],
  gitlab: ['gitlab.com'],
};
export const REGISTRY_PRESETS: readonly RepoEgressPreset[] = ['npm', 'pypi', 'crates', 'go', 'maven'];
export const CODE_HOST_PRESETS: readonly RepoEgressPreset[] = ['github', 'gitlab'];
const ALL_PRESETS: readonly string[] = [...REGISTRY_PRESETS, ...CODE_HOST_PRESETS];

/** At most this many custom hosts (master: `project_repo_egress.hosts`). */
export const MAX_REPO_EGRESS_HOSTS = 48;

export interface RepoEgress {
  readonly project: string;
  readonly kind: 'repository' | 'workspace';
  readonly mode: RepoEgressMode;
  readonly presets: readonly RepoEgressPreset[];
  readonly hosts: readonly string[];
  /** What jobs reach on top of the model APIs (presets expanded by the master). */
  readonly effective: { readonly mode: RepoEgressMode; readonly hosts: readonly string[] };
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  /** Active machines whose worker does not apply the setting yet. */
  readonly unsupportedWorkers: readonly { readonly id: string; readonly name: string }[];
}

type Opts = Pick<RequestOptions, 'signal'>;

function modeOf(v: string): RepoEgressMode {
  if (v !== 'none' && v !== 'allowlist' && v !== 'web') throw new ShapeError('unexpected egress mode');
  return v;
}

export function parseRepoEgress(body: unknown): RepoEgress {
  const b = obj(body);
  const kind = str(b, 'kind');
  const eff = obj(b.effective);
  const workers = Array.isArray(b.unsupportedWorkers) ? b.unsupportedWorkers : [];
  return {
    project: str(b, 'project'),
    kind: kind === 'workspace' ? 'workspace' : 'repository',
    mode: modeOf(str(b, 'mode')),
    presets: strArray(b, 'presets').filter((p): p is RepoEgressPreset => ALL_PRESETS.includes(p)),
    hosts: strArray(b, 'hosts'),
    effective: { mode: modeOf(str(eff, 'mode')), hosts: strArray(eff, 'hosts') },
    updatedAt: nullableStr(b, 'updatedAt'),
    updatedBy: nullableStr(b, 'updatedBy'),
    unsupportedWorkers: workers.map((w) => {
      const o = obj(w);
      return { id: str(o, 'id'), name: str(o, 'name') };
    }),
  };
}

export function getRepoEgress(project: string, opts: Opts = {}): Promise<RepoEgress> {
  return apiRequest('GET', `/projects/${encodeURIComponent(project)}/repo-egress`, parseRepoEgress, opts);
}

export function setRepoEgress(
  project: string,
  body: {
    readonly mode: RepoEgressMode;
    readonly presets: readonly RepoEgressPreset[];
    readonly hosts: readonly string[];
  },
  opts: Opts = {},
): Promise<RepoEgress> {
  return apiRequest('PUT', `/projects/${encodeURIComponent(project)}/repo-egress`, parseRepoEgress, {
    ...opts,
    body: { mode: body.mode, presets: [...body.presets], hosts: [...body.hosts] },
  });
}

/** Hosts a draft reaches on top of the model APIs (the master's expansion, for the live summary before saving). */
export function draftReach(
  mode: RepoEgressMode,
  presets: readonly RepoEgressPreset[],
  hosts: readonly string[],
): { mode: RepoEgressMode; hosts: string[] } {
  if (mode === 'none') return { mode, hosts: [] };
  const all = [...new Set([...presets.flatMap((p) => REPO_EGRESS_PRESET_HOSTS[p]), ...hosts])].sort();
  if (mode === 'web') return { mode, hosts: all };
  return all.length === 0 ? { mode: 'none', hosts: [] } : { mode, hosts: all };
}
