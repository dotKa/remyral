import { RUNTIME_PINS, type RuntimeKind, type ToolRecipeId } from '@remyral/protocol';

/**
 * p13-fleet-tools: the tools and runtimes the fleet view tracks, how each is found in a worker's reports and where the
 * master reads its latest version (docs/design/p13-fleet-tools.md §2). Feeds are public, unauthenticated JSON
 * endpoints on the hosts of `VERSION_FEED_HOSTS` only.
 */

export type FeedSource =
  | { readonly kind: 'npm'; readonly pkg: string }
  | { readonly kind: 'github'; readonly repo: string }
  | { readonly kind: 'nuget'; readonly pkg: string }
  | { readonly kind: 'node-lts' };

export interface CatalogEntry {
  readonly id: string;
  readonly kind: 'runtime' | 'tool';
  readonly label: string;
  /** Inventory names this item is reported as (tools). */
  readonly names: readonly string[];
  readonly recipe?: ToolRecipeId;
  readonly runtime?: RuntimeKind;
  readonly feed: FeedSource | null;
  readonly sourceUrl: string | null;
  /** The upstream release behind the recipe pin when the recipe version is not comparable with the feed. */
  readonly upstreamPinned?: string;
}

/**
 * The repository's Playwright pin (worker recipe `browser@1248` = Chromium revision 1248 of Playwright 1.64.1, the same revision as 1.64.0): the
 * browser feed is Playwright's npm version, compared with this.
 */
export const PLAYWRIGHT_PIN = '1.64.1';

const npm = (pkg: string): { feed: FeedSource; sourceUrl: string } => ({
  feed: { kind: 'npm', pkg },
  sourceUrl: `https://www.npmjs.com/package/${pkg}`,
});
const gh = (repo: string): { feed: FeedSource; sourceUrl: string } => ({
  feed: { kind: 'github', repo },
  sourceUrl: `https://github.com/${repo}/releases`,
});

export const CATALOG: readonly CatalogEntry[] = [
  // The standalone `claude` CLI's package (the adapter's agent SDK bundles the same CLI version).
  {
    id: 'claude-code',
    kind: 'runtime',
    label: 'Claude Code',
    names: [],
    runtime: 'claude-code',
    ...npm('@anthropic-ai/claude-code'),
  },
  { id: 'codex', kind: 'runtime', label: 'Codex', names: [], runtime: 'codex', ...npm('@openai/codex') },
  {
    id: 'pi',
    kind: 'runtime',
    label: 'Pi',
    names: [],
    runtime: 'pi',
    ...npm('@earendil-works/pi-coding-agent'),
  },
  {
    id: 'opencode',
    kind: 'runtime',
    label: 'OpenCode',
    names: [],
    runtime: 'opencode',
    ...npm('opencode-ai'),
  },
  { id: 'git', kind: 'tool', label: 'git', names: ['git'], recipe: 'git', ...gh('git-for-windows/git') },
  {
    id: 'python',
    kind: 'tool',
    label: 'Python',
    names: ['python'],
    recipe: 'python',
    feed: { kind: 'nuget', pkg: 'python' },
    sourceUrl: 'https://www.python.org/downloads/',
  },
  {
    id: 'node',
    kind: 'tool',
    label: 'Node.js',
    names: ['node'],
    feed: { kind: 'node-lts' },
    sourceUrl: 'https://nodejs.org/en/download',
  },
  { id: 'uv', kind: 'tool', label: 'uv', names: ['uv'], recipe: 'uv', ...gh('astral-sh/uv') },
  {
    id: 'browser',
    kind: 'tool',
    label: 'Playwright Chromium',
    names: ['playwright-chromium'],
    recipe: 'browser',
    upstreamPinned: PLAYWRIGHT_PIN,
    ...npm('playwright'),
  },
  {
    id: 'cloudflared',
    kind: 'tool',
    label: 'cloudflared',
    names: ['cloudflared'],
    recipe: 'cloudflared',
    ...gh('cloudflare/cloudflared'),
  },
  {
    id: 'ffmpeg',
    kind: 'tool',
    label: 'ffmpeg',
    names: ['ffmpeg'],
    recipe: 'ffmpeg',
    ...gh('GyanD/codexffmpeg'),
  },
  { id: 'docker', kind: 'tool', label: 'Docker', names: ['docker'], feed: null, sourceUrl: null },
];

export function runtimePin(runtime: RuntimeKind): string {
  return RUNTIME_PINS[runtime].version;
}

/** The URL a feed is read from (always on a `VERSION_FEED_HOSTS` host). */
export function feedUrl(f: FeedSource): string {
  switch (f.kind) {
    case 'npm':
      return `https://registry.npmjs.org/${f.pkg.replace('/', '%2F')}/latest`;
    case 'github':
      return `https://api.github.com/repos/${f.repo}/releases/latest`;
    case 'nuget':
      return `https://api.nuget.org/v3-flatcontainer/${f.pkg}/index.json`;
    case 'node-lts':
      return 'https://nodejs.org/dist/index.json';
  }
}

export function feedKey(f: FeedSource): string {
  switch (f.kind) {
    case 'npm':
      return `npm:${f.pkg}`;
    case 'github':
      return `github:${f.repo}`;
    case 'nuget':
      return `nuget:${f.pkg}`;
    case 'node-lts':
      return 'node-lts';
  }
}
