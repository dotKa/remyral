/**
 * p15-coolify-create (docs/design/p15-coolify-create.md §4): sensible defaults for a new Coolify application from the
 * project's repository — which build pack, which port, a publish directory — read from the file names at the root of
 * the branch and, when present, `package.json` (scripts and dependency names only).
 *
 * The repository is untrusted (ADR-0010): nothing read here is executed, followed or shown as an instruction; the
 * suggestion only pre-fills the wizard, which the administrator confirms. Reads go to the fixed host `api.github.com`
 * (the skill-import rules: https, `redirect: 'error'`, no cookies, 10 s, ≤ 512 KiB, ≤ 3 requests), anonymously for a
 * public repository and with the panel GitHub App's read-only installation token for a private one.
 */

export type BuildPack = 'nixpacks' | 'railpack' | 'static' | 'dockerfile' | 'dockercompose';

export interface BuildSuggestion {
  readonly buildPack: BuildPack;
  /** `ports_exposes` (comma-separated); null for Docker Compose (the compose file decides). */
  readonly ports: string | null;
  /** Nixpacks: serve the build output as a static site. */
  readonly isStatic: boolean;
  readonly publishDirectory: string | null;
  readonly dockerfileLocation: string | null;
  readonly composeLocation: string | null;
  /** What the suggestion is based on (file names), for the wizard's hint. */
  readonly basis: readonly string[];
  /** How the files were read: `repository` (GitHub) or `none` (no repository / not readable → plain defaults). */
  readonly source: 'repository' | 'none';
}

export const DEFAULT_SUGGESTION: BuildSuggestion = {
  buildPack: 'nixpacks',
  ports: '3000',
  isStatic: false,
  publishDirectory: null,
  dockerfileLocation: null,
  composeLocation: null,
  basis: [],
  source: 'none',
};

const COMPOSE_FILES = ['docker-compose.yaml', 'docker-compose.yml', 'compose.yaml', 'compose.yml'];
const STATIC_TOOLS = ['vite', 'react-scripts', '@angular/cli', 'astro', 'parcel', '@vue/cli-service'];
const SERVER_HINTS = [
  'next',
  'express',
  'fastify',
  '@nestjs/core',
  'koa',
  'hono',
  '@remix-run/serve',
  'nuxt',
];

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Pure: the suggestion for a repository root. Order: Dockerfile → Compose → package.json (a static front-end build
 * without a server: Nixpacks static, `dist` / `build`; otherwise Nixpacks on 3000) → a plain `index.html` (static on
 * 80) → Nixpacks defaults.
 */
export function suggestBuild(files: readonly string[], packageJson: unknown): BuildSuggestion {
  const names = new Set(files);
  const lower = new Map(files.map((f) => [f.toLowerCase(), f]));
  const dockerfile = names.has('Dockerfile') ? 'Dockerfile' : (lower.get('dockerfile') ?? null);
  if (dockerfile !== null) {
    return {
      ...DEFAULT_SUGGESTION,
      buildPack: 'dockerfile',
      ports: '3000',
      dockerfileLocation: `/${dockerfile}`,
      basis: [dockerfile],
      source: 'repository',
    };
  }
  const compose = COMPOSE_FILES.find((f) => names.has(f)) ?? null;
  if (compose !== null) {
    return {
      ...DEFAULT_SUGGESTION,
      buildPack: 'dockercompose',
      ports: null,
      composeLocation: `/${compose}`,
      basis: [compose],
      source: 'repository',
    };
  }
  if (names.has('package.json')) {
    const pkg = obj(packageJson);
    const scripts = obj(pkg.scripts);
    const deps = new Set([...Object.keys(obj(pkg.dependencies)), ...Object.keys(obj(pkg.devDependencies))]);
    const hasStart = typeof scripts.start === 'string' || typeof scripts.serve === 'string';
    const server = SERVER_HINTS.some((d) => deps.has(d));
    const tool = STATIC_TOOLS.find((d) => deps.has(d)) ?? null;
    if (tool !== null && !server && typeof scripts.build === 'string' && !hasStart) {
      const dir = tool === 'react-scripts' ? 'build' : 'dist';
      return {
        ...DEFAULT_SUGGESTION,
        buildPack: 'nixpacks',
        ports: '80',
        isStatic: true,
        publishDirectory: `/${dir}`,
        basis: ['package.json', tool],
        source: 'repository',
      };
    }
    return { ...DEFAULT_SUGGESTION, basis: ['package.json'], source: 'repository' };
  }
  if (names.has('index.html')) {
    return {
      ...DEFAULT_SUGGESTION,
      buildPack: 'static',
      ports: '80',
      basis: ['index.html'],
      source: 'repository',
    };
  }
  return { ...DEFAULT_SUGGESTION, source: files.length > 0 ? 'repository' : 'none' };
}

export type GitHubFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Where the root listing comes from (absent: defaults only). */
export interface RepoLayoutSource {
  /** The root file names and the parsed package.json (null when absent), or null when the branch is not readable. */
  root(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<{ files: string[]; packageJson: unknown } | null>;
}

const GITHUB_API = 'https://api.github.com';
const MAX_BYTES = 512 * 1024;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;

/** `https://github.com/<owner>/<repo>[.git]` (or `git@github.com:owner/repo.git`) → owner / repo; else null. */
export function githubOwnerRepo(url: string): { owner: string; repo: string } | null {
  const m =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim()) ??
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url.trim());
  if (m === null) return null;
  const owner = m[1] ?? '';
  const repo = m[2] ?? '';
  return OWNER.test(owner) && REPO.test(repo) ? { owner, repo } : null;
}

async function bounded(res: Response): Promise<string | null> {
  const len = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(len) && len > MAX_BYTES) return null;
  const text = await res.text();
  return text.length > MAX_BYTES ? null : text;
}

export class GitHubRepoLayout implements RepoLayoutSource {
  constructor(
    private readonly deps: {
      readonly fetch: GitHubFetch;
      /** The panel GitHub App's read-only installation token for a repository, or null. */
      readonly token?: ((owner: string, repo: string) => Promise<string | null>) | null;
    },
  ) {}

  async #get(path: string, token: string | null, raw = false): Promise<Response | null> {
    try {
      return await this.deps.fetch(`${GITHUB_API}${path}`, {
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        headers: {
          accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          'user-agent': 'remyral-master (coolify build suggestion)',
          'x-github-api-version': '2022-11-28',
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return null;
    }
  }

  async root(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<{ files: string[]; packageJson: unknown } | null> {
    if (!OWNER.test(owner) || !REPO.test(repo) || !BRANCH.test(branch)) return null;
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents`;
    const q = `?ref=${encodeURIComponent(branch)}`;
    let token: string | null = null;
    let res = await this.#get(`${base}/${q}`, null);
    if (res !== null && res.status === 404 && this.deps.token != null) {
      token = await this.deps.token(owner, repo).catch(() => null);
      if (token !== null) res = await this.#get(`${base}/${q}`, token);
    }
    if (res?.status !== 200) return null;
    const text = await bounded(res);
    if (text === null) return null;
    let listing: unknown;
    try {
      listing = JSON.parse(text) as unknown;
    } catch {
      return null;
    }
    if (!Array.isArray(listing)) return null;
    const files = listing
      .map((e) => obj(e))
      .filter((e) => e.type === 'file' && typeof e.name === 'string')
      .map((e) => String(e.name).slice(0, 200))
      .slice(0, 500);
    let packageJson: unknown = null;
    if (files.includes('package.json')) {
      const p = await this.#get(`${base}/package.json${q}`, token, true);
      if (p?.status === 200) {
        const body = await bounded(p);
        try {
          packageJson = body === null ? null : (JSON.parse(body) as unknown);
        } catch {
          packageJson = null;
        }
      }
    }
    return { files, packageJson };
  }
}
