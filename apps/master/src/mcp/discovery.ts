import {
  MCP_TRANSPORT_RUNTIMES,
  McpLiteralValue,
  McpSecretFormat,
  McpServerId,
  mcpEgressHostProblem,
  mcpUrlProblem,
  NPM_PACKAGE_NAME,
  PYPI_PACKAGE_NAME,
  pypiNormalize,
  type RuntimeKind,
} from '@remyral/protocol';
import { HttpError } from '../http/errors.js';
import { type McpFetch, npmInfo, pypiInfo } from './stdio.js';

/**
 * p14-mcp-chat (ADR-0054 P5, docs/design/p14-mcp-skills.md §4.1, §4.2, §15): research MCP servers as DATA.
 *
 * The master reads registry JSON from a compiled list of hosts — the official MCP Registry, the npm registry (+ its
 * download counts) and PyPI — over https, without redirects, credentials, cookies or a body, with a 10 s timeout and a
 * 4 MiB answer cap. It never downloads a package, never runs or connects to a server, and never follows a link it
 * read. Everything it returns (names, descriptions, READMEs' summaries) is **untrusted third-party text**: the chat
 * fences it, the console renders it as text, and nothing in it can choose a tool, a permission, a host or a token.
 *
 * `resolve` turns ONE reference (registry name / npm / PyPI package / https URL) into a pinned proposal: exact version,
 * the registry's integrity of the top-level package, the bin, secret slots (names + why, never values), the hosts,
 * warnings (typosquat-looking names, very new packages, few downloads, deprecated entries) and findings (values the
 * registry wanted that the spec rules refuse). The proposal's facts are what the card shows and what a confirmation
 * signs — never the assistant's text.
 */

/** The only hosts discovery talks to (compiled; SSRF guard). */
export const MCP_DISCOVERY_HOSTS: readonly string[] = [
  'registry.modelcontextprotocol.io',
  'registry.npmjs.org',
  'api.npmjs.org',
  'pypi.org',
];
export const MCP_REGISTRY_API = 'https://registry.modelcontextprotocol.io/v0.1';

export type McpDiscoverySource = 'registry' | 'npm' | 'pypi';
export const MCP_DISCOVERY_SOURCES: readonly McpDiscoverySource[] = ['registry', 'npm', 'pypi'];

export type McpWarningCode =
  'typosquat' | 'scope_mismatch' | 'new_package' | 'low_downloads' | 'deprecated' | 'no_repository';

export interface McpWarning {
  readonly code: McpWarningCode;
  /** typosquat / scope_mismatch: the popular package the name resembles. */
  readonly similarTo?: string;
  /** new_package: days since the first release. */
  readonly days?: number;
  /** low_downloads: last week's downloads (npm). */
  readonly weekly?: number;
  /** deprecated: the registry status. */
  readonly status?: string;
}

export interface McpSearchResult {
  readonly source: McpDiscoverySource;
  /** What propose_mcp_install / the preview route takes with the same source. */
  readonly ref: string;
  readonly name: string;
  readonly title: string | null;
  readonly version: string | null;
  /** Untrusted text, ≤ 600 characters. */
  readonly description: string;
  readonly transport: 'stdio' | 'http' | 'sse' | null;
  readonly packages: { manager: 'npm' | 'pypi'; name: string; version: string }[];
  readonly remoteUrl: string | null;
  readonly repository: string | null;
  readonly publishedAt: string | null;
  readonly downloadsWeekly: number | null;
  readonly warnings: McpWarning[];
}

export interface McpSearchOutput {
  readonly sources: { source: McpDiscoverySource; error: string | null }[];
  readonly results: McpSearchResult[];
}

export type McpFindingCode =
  | 'header_dropped'
  | 'env_dropped'
  | 'env_needs_value'
  | 'arguments_required'
  | 'bin_guessed'
  | 'bin_chosen'
  | 'format_dropped'
  | 'sse_runtimes'
  | 'no_egress_hosts'
  | 'egress_suggested'
  | 'windows_egress'
  | 'stdio_package_chosen';

export interface McpFinding {
  readonly code: McpFindingCode;
  /** The header / env / bin / package the finding is about (registry text, untrusted). */
  readonly name?: string;
  readonly detail?: string;
}

export type McpValueInput = string | { secret: string; format?: string };

/** The exact body `McpService.publish` takes (the card shows it, the confirmation signs it). */
export interface McpProposalPublish {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly version: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly url?: string;
  readonly package?: {
    manager: 'npm' | 'pypi';
    name: string;
    version: string;
    integrity: string;
    bin: string;
    args?: string[];
    env?: Record<string, McpValueInput>;
  };
  readonly headers?: Record<string, McpValueInput>;
  readonly secrets: { slot: string; why: string }[];
  readonly egressHosts: string[];
  readonly runtimes: RuntimeKind[];
  readonly source: { kind: 'url' | 'npm' | 'pypi' | 'registry'; ref: string; registry?: string };
}

export interface McpResolved {
  readonly sourceKind: 'registry' | 'npm' | 'pypi' | 'url';
  readonly ref: string;
  /** The exact upstream version that was pinned (package version, registry version or null for a bare URL). */
  readonly pinnedVersion: string | null;
  readonly publish: Omit<McpProposalPublish, 'id' | 'version'>;
  readonly suggestedId: string;
  /** npm: every bin of the package; PyPI: [] (the JSON API does not list console scripts). */
  readonly bins: string[];
  /** PyPI: the release file whose sha256 is pinned. */
  readonly file: string | null;
  readonly license: string | null;
  readonly repository: string | null;
  readonly publishedAt: string | null;
  readonly downloadsWeekly: number | null;
  readonly warnings: McpWarning[];
  readonly findings: McpFinding[];
  /** Hosts the assistant / admin suggested (validated) — shown as a suggestion, not as registry facts. */
  readonly egressSuggested: string[];
}

export interface McpResolveInput {
  readonly kind: 'registry' | 'npm' | 'pypi' | 'url';
  readonly ref: string;
  readonly version?: string | undefined;
  readonly bin?: string | undefined;
  readonly egressHosts?: readonly string[] | undefined;
  readonly runtimes?: readonly RuntimeKind[] | undefined;
}

/**
 * Popular MCP packages (2026-10): names that a typosquat would imitate. A name within a small edit distance of one of
 * these (but not equal), or the same package name under another npm scope, gets a warning on the card.
 */
export const POPULAR_MCP_PACKAGES: Readonly<Record<'npm' | 'pypi', readonly string[]>> = {
  npm: [
    '@modelcontextprotocol/server-filesystem',
    '@modelcontextprotocol/server-github',
    '@modelcontextprotocol/server-everything',
    '@modelcontextprotocol/server-memory',
    '@modelcontextprotocol/server-puppeteer',
    '@modelcontextprotocol/server-brave-search',
    '@modelcontextprotocol/server-slack',
    '@modelcontextprotocol/server-postgres',
    '@modelcontextprotocol/server-sequential-thinking',
    '@modelcontextprotocol/server-gitlab',
    '@modelcontextprotocol/server-google-maps',
    '@modelcontextprotocol/inspector',
    '@playwright/mcp',
    '@upstash/context7-mcp',
    '@notionhq/notion-mcp-server',
    '@supabase/mcp-server-supabase',
    '@stripe/mcp',
    '@sentry/mcp-server',
    '@cloudflare/mcp-server-cloudflare',
    '@azure/mcp',
    '@browsermcp/mcp',
    '@heroku/mcp-server',
    'chrome-devtools-mcp',
    'firecrawl-mcp',
    'mcp-remote',
    'figma-developer-mcp',
    'tavily-mcp',
    'exa-mcp-server',
  ],
  pypi: [
    'mcp',
    'fastmcp',
    'mcp-server-time',
    'mcp-server-fetch',
    'mcp-server-git',
    'mcp-server-sqlite',
    'mcp-server-qdrant',
    'mcp-server-motherduck',
    'awslabs.aws-documentation-mcp-server',
    'awslabs.core-mcp-server',
    'mcp-atlassian',
    'serena-agent',
    'markitdown-mcp',
    'zen-mcp-server',
  ],
};

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 4 * 1024 * 1024;
const CACHE_MS = 15 * 60_000;
const MAX_CACHE = 200;
const REQUESTS_PER_MINUTE = 30;
const NEW_PACKAGE_DAYS = 30;
const LOW_DOWNLOADS_WEEKLY = 100;
const MAX_DESCRIPTION = 600;
const EXACT_VERSION = /^[0-9][0-9A-Za-z.+!-]{0,63}$/;
const REGISTRY_NAME = /^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/;
const FORMAT_TEXT = /^[A-Za-z0-9 ._:/=+-]{0,64}$/;
const RESERVED_STDIO_ENV =
  /^(PATH|HOME|USERPROFILE|TMP|TEMP|TMPDIR|NODE_OPTIONS|NODE_PATH|NODE_USE_ENV_PROXY|NODE_EXTRA_CA_CERTS|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PYTHONUSERBASE|HTTPS?_PROXY|NO_PROXY|ALL_PROXY|SSL_CERT_FILE|REQUESTS_CA_BUNDLE|(LD|DYLD)_[A-Z0-9_]*|REMYRAL_[A-Z0-9_]*|UV_[A-Z0-9_]*|NPM_CONFIG_[A-Z0-9_]*)$/;
const ALL_RUNTIMES: readonly RuntimeKind[] = ['claude-code', 'codex', 'pi', 'opencode'];

class FetchError extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? 'unreachable' : `HTTP ${String(status)}`);
  }
}

/** Plain text of untrusted registry content: no control characters, collapsed spaces, clipped. */
export function untrustedText(v: unknown, max = MAX_DESCRIPTION): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').trim();
  const s = t.replace(/\s{2,}/g, ' ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Optimal-string-alignment distance (insert, delete, substitute, swap neighbours), bounded. */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = d[i] as number[];
      const prev = d[i - 1] as number[];
      let v = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, ((d[i - 2] as number[])[j - 2] as number) + 1);
      }
      row[j] = v;
    }
  }
  return (d[a.length] as number[])[b.length] as number;
}

function unscoped(name: string): string {
  return name.includes('/') ? (name.split('/').pop() ?? name) : name;
}

function scopeOf(name: string): string | null {
  return name.startsWith('@') && name.includes('/') ? (name.split('/')[0] ?? null) : null;
}

/** `server-github`, `server_github`, `Server.GitHub` → `server-github` (what a reader sees as "the same name"). */
function nameKey(name: string): string {
  return pypiNormalize(name.toLowerCase());
}

/**
 * Does this package name imitate a popular one? Same unscoped name under another scope (or without the scope), or a
 * name 1–2 edits away (1 for short names). An exact popular name is never a warning.
 */
export function typosquatOf(manager: 'npm' | 'pypi', name: string): McpWarning | null {
  const n = name.toLowerCase();
  const popular = POPULAR_MCP_PACKAGES[manager];
  if (popular.some((p) => (manager === 'pypi' ? nameKey(p) === nameKey(n) : p === n))) return null;
  for (const p of popular) {
    // Generic names (`@stripe/mcp`, `@heroku/mcp-server`) are not one project's name: no scope warning for those.
    const distinctive = unscoped(p).length >= 6 && !['mcp-server', 'server'].includes(unscoped(p));
    if (
      manager === 'npm' &&
      distinctive &&
      scopeOf(p) !== null &&
      unscoped(p) === unscoped(n) &&
      scopeOf(p) !== scopeOf(n)
    ) {
      // A scope one or two edits from the real one (`@modelcontextprotoco1`) is a typosquat, another one a mismatch.
      const near = scopeOf(n) !== null && editDistance(scopeOf(n) ?? '', scopeOf(p) ?? '', 2) <= 2;
      return { code: near ? 'typosquat' : 'scope_mismatch', similarTo: p };
    }
  }
  for (const p of popular) {
    const a = manager === 'npm' ? n : nameKey(n);
    const b = manager === 'npm' ? p : nameKey(p);
    // Very short popular names (`mcp`) would match half the index: only names of five characters or more.
    if (b.length < 5) continue;
    const limit = b.length >= 10 ? 2 : 1;
    const dFull = editDistance(a, b, limit);
    // Same scope, a near name (`@modelcontextprotocol/server-githbu`), or a near scope (`@modelcontextprotoco1/…`).
    if (dFull > 0 && dFull <= limit) return { code: 'typosquat', similarTo: p };
    if (manager === 'npm' && scopeOf(p) !== null && scopeOf(n) !== null) {
      const sa = scopeOf(n) ?? '';
      const sb = scopeOf(p) ?? '';
      if (sa !== sb && editDistance(sa, sb, 2) <= 2 && unscoped(n) === unscoped(p)) {
        return { code: 'typosquat', similarTo: p };
      }
    }
  }
  return null;
}

/** Warnings from facts the registry reported (age, downloads, repository, status). */
export function factWarnings(input: {
  readonly manager: 'npm' | 'pypi' | null;
  readonly name: string | null;
  readonly createdAt: string | null;
  readonly downloadsWeekly: number | null;
  readonly repository: string | null;
  readonly status?: string | null;
  readonly now: Date;
}): McpWarning[] {
  const out: McpWarning[] = [];
  if (input.manager !== null && input.name !== null) {
    const t = typosquatOf(input.manager, input.name);
    if (t !== null) out.push(t);
  }
  if (input.createdAt !== null) {
    const at = Date.parse(input.createdAt);
    if (Number.isFinite(at)) {
      const days = Math.floor((input.now.getTime() - at) / 86_400_000);
      if (days < NEW_PACKAGE_DAYS) out.push({ code: 'new_package', days: Math.max(0, days) });
    }
  }
  if (input.downloadsWeekly !== null && input.downloadsWeekly < LOW_DOWNLOADS_WEEKLY) {
    out.push({ code: 'low_downloads', weekly: input.downloadsWeekly });
  }
  if (input.status !== undefined && input.status !== null && input.status !== 'active') {
    out.push({ code: 'deprecated', status: input.status.slice(0, 32) });
  }
  if (input.manager !== null && input.repository === null) out.push({ code: 'no_repository' });
  return out;
}

/** A catalog id from a registry / package / host name (`io.github.acme/files-mcp` → `files-mcp`). */
export function suggestServerId(name: string): string | null {
  let base = unscoped(name.toLowerCase())
    .replace(/^mcp[-_.]server[-_.]/, '')
    .replace(/[-_.]mcp[-_.]server$/, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '');
  if (base.length < 2) base = `mcp-${base}`.replace(/-+$/, '');
  base = base.slice(0, 32).replace(/-+$/, '');
  if (McpServerId.safeParse(base).success) return base;
  const prefixed = `mcp-${base}`.slice(0, 32).replace(/-+$/, '');
  return McpServerId.safeParse(prefixed).success ? prefixed : null;
}

/** A secret slot name from a registry variable / header name (`GITHUB_TOKEN` → `github_token`). */
export function slotName(name: string): string | null {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '')
    .slice(0, 32)
    .replace(/_+$/, '');
  return /^[a-z][a-z0-9_]{0,31}$/.test(s) ? s : null;
}

function unpinnable(message: string, reason: string): HttpError {
  return new HttpError(422, 'mcp_unpinnable_source', message, {}, {}, { reason });
}

export interface McpDiscoveryDeps {
  readonly clock: () => Date;
  /** Registry fetch (tests); default the global fetch. */
  readonly fetch?: McpFetch | null;
}

export class McpDiscovery {
  readonly #cache = new Map<string, { at: number; value: unknown }>();
  readonly #budget = new Map<string, number[]>();

  constructor(private readonly d: McpDiscoveryDeps) {}

  /** 30 registry reads per user per minute (search and resolve share it). */
  #charge(userId: string, n = 1): void {
    const now = this.d.clock().getTime();
    const recent = (this.#budget.get(userId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length + n > REQUESTS_PER_MINUTE) {
      throw new HttpError(
        429,
        'rate_limited',
        'Too many registry lookups; try again in a minute.',
        { 'retry-after': '60' },
        {},
        { reason: 'mcp_lookup' },
      );
    }
    this.#budget.set(userId, [...recent, ...Array.from({ length: n }, () => now)]);
  }

  /** One GET of registry JSON from a compiled host: https, no redirects, no credentials, 10 s, 4 MiB. */
  async #get(url: string): Promise<unknown> {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !MCP_DISCOVERY_HOSTS.includes(u.hostname) || u.port !== '') {
      throw new Error(`host not allowed: ${u.hostname}`);
    }
    const fetch: McpFetch = this.d.fetch ?? ((x, i) => globalThis.fetch(x, i));
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        signal,
        redirect: 'error',
        credentials: 'omit',
        headers: { accept: 'application/json' },
      });
    } catch {
      throw new FetchError(null);
    }
    if (!res.ok) throw new FetchError(res.status);
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_BYTES) throw new FetchError(413);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.byteLength > MAX_BYTES) throw new FetchError(413);
    try {
      return JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      throw new FetchError(502);
    }
  }

  async #cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = this.d.clock().getTime();
    const hit = this.#cache.get(key);
    if (hit !== undefined && now - hit.at < CACHE_MS) return hit.value as T;
    const value = await load();
    if (this.#cache.size >= MAX_CACHE) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    this.#cache.set(key, { at: now, value });
    return value;
  }

  // ------------------------------------------------------------------------------------------------- search

  async search(
    userId: string,
    input: {
      readonly q: string;
      readonly source?: McpDiscoverySource | undefined;
      readonly perSource?: number;
    },
  ): Promise<McpSearchOutput> {
    const q = input.q.trim().slice(0, 200);
    if (q.length < 2) {
      throw new HttpError(
        400,
        'invalid_request',
        'Search for at least two characters.',
        {},
        {},
        { reason: 'q' },
      );
    }
    const n = Math.min(Math.max(input.perSource ?? 10, 1), 10);
    const sources = input.source === undefined ? MCP_DISCOVERY_SOURCES : [input.source];
    this.#charge(userId, sources.length);
    const out = await Promise.all(
      sources.map(async (s) => {
        try {
          const results = await this.#cached(`${s}:${q.toLowerCase()}:${String(n)}`, () =>
            s === 'registry'
              ? this.#searchRegistry(q, n)
              : s === 'npm'
                ? this.#searchNpm(q, n)
                : this.#searchPypi(q, n),
          );
          return { source: s, error: null, results };
        } catch (err) {
          return {
            source: s,
            error: err instanceof FetchError ? err.message : 'unavailable',
            results: [] as McpSearchResult[],
          };
        }
      }),
    );
    return {
      sources: out.map((o) => ({ source: o.source, error: o.error })),
      results: out.flatMap((o) => o.results),
    };
  }

  async #searchRegistry(q: string, n: number): Promise<McpSearchResult[]> {
    const body = rec(
      await this.#get(
        `${MCP_REGISTRY_API}/servers?search=${encodeURIComponent(q)}&version=latest&limit=${String(n)}`,
      ),
    );
    const now = this.d.clock();
    const out: McpSearchResult[] = [];
    for (const item of arr(body.servers).slice(0, n)) {
      const entry = registryEntry(item);
      if (entry === null) continue;
      const pkg = entry.packages[0] ?? null;
      out.push({
        source: 'registry',
        ref: entry.name,
        name: entry.name,
        title: entry.title,
        version: entry.version,
        description: entry.description,
        transport: entry.transport,
        packages: entry.packages.map((p) => ({ manager: p.manager, name: p.name, version: p.version })),
        remoteUrl: entry.remote?.url ?? null,
        repository: entry.repository,
        publishedAt: entry.publishedAt,
        downloadsWeekly: null,
        warnings: [
          ...(pkg === null
            ? []
            : [typosquatOf(pkg.manager, pkg.name)].filter((w): w is McpWarning => w !== null)),
          ...factWarnings({
            manager: null,
            name: null,
            createdAt: entry.publishedAt,
            downloadsWeekly: null,
            repository: entry.repository,
            status: entry.status,
            now,
          }),
        ],
      });
    }
    return out;
  }

  async #searchNpm(q: string, n: number): Promise<McpSearchResult[]> {
    const body = rec(
      await this.#get(
        `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(`${q} mcp`)}&size=${String(n)}`,
      ),
    );
    const now = this.d.clock();
    const out: McpSearchResult[] = [];
    for (const o of arr(body.objects).slice(0, n)) {
      const r = rec(o);
      const p = rec(r.package);
      const name = str(p.name);
      if (name === null || !NPM_PACKAGE_NAME.test(name)) continue;
      const weekly = typeof rec(r.downloads).weekly === 'number' ? (rec(r.downloads).weekly as number) : null;
      const repository = repoUrl(rec(p.links).repository);
      out.push({
        source: 'npm',
        ref: name,
        name,
        title: null,
        version: str(p.version),
        description: untrustedText(p.description),
        transport: 'stdio',
        packages: str(p.version) === null ? [] : [{ manager: 'npm', name, version: str(p.version) ?? '' }],
        remoteUrl: null,
        repository,
        publishedAt: str(p.date),
        downloadsWeekly: weekly,
        warnings: factWarnings({
          manager: 'npm',
          name,
          createdAt: null,
          downloadsWeekly: weekly,
          repository,
          now,
        }),
      });
    }
    return out;
  }

  /** PyPI has no search API: exact-name lookups of the query and the usual MCP name shapes. */
  async #searchPypi(q: string, n: number): Promise<McpSearchResult[]> {
    const base = q
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (base === '' || !PYPI_PACKAGE_NAME.test(base)) return [];
    const names = [
      ...new Set([base, `mcp-server-${base}`, `${base}-mcp`, `mcp-${base}`, `${base}-mcp-server`]),
    ]
      .filter((x) => PYPI_PACKAGE_NAME.test(x) && x.length <= 100)
      .slice(0, Math.min(5, n));
    const now = this.d.clock();
    const found = await Promise.all(
      names.map(async (name) => {
        try {
          return {
            name,
            body: rec(await this.#get(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`)),
          };
        } catch (err) {
          if (err instanceof FetchError && err.status === 404) return null;
          throw err;
        }
      }),
    );
    const out: McpSearchResult[] = [];
    for (const f of found) {
      if (f === null) continue;
      const info = rec(f.body.info);
      const name = str(info.name) ?? f.name;
      const repository = pypiRepo(info);
      const createdAt = pypiFirstUpload(f.body.releases);
      out.push({
        source: 'pypi',
        ref: name,
        name,
        title: null,
        version: str(info.version),
        description: untrustedText(info.summary),
        transport: 'stdio',
        packages:
          str(info.version) === null ? [] : [{ manager: 'pypi', name, version: str(info.version) ?? '' }],
        remoteUrl: null,
        repository,
        publishedAt: createdAt,
        downloadsWeekly: null,
        warnings: factWarnings({ manager: 'pypi', name, createdAt, downloadsWeekly: null, repository, now }),
      });
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ resolve

  /** One reference → a pinned proposal (or `mcp_unpinnable_source` / `mcp_package_not_found` / registry errors). */
  async resolve(userId: string, input: McpResolveInput): Promise<McpResolved> {
    this.#charge(userId, input.kind === 'url' ? 0 : 3);
    const hosts = this.#hosts(input.egressHosts);
    try {
      switch (input.kind) {
        case 'url':
          return this.#fromUrl(input, hosts);
        case 'npm':
          return await this.#fromNpm(input.ref, input.version, input, hosts, null);
        case 'pypi':
          return await this.#fromPypi(input.ref, input.version, input, hosts, null);
        case 'registry':
          return await this.#fromRegistry(input, hosts);
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err instanceof FetchError && err.status === 404) {
        throw new HttpError(
          404,
          'mcp_package_not_found',
          `${input.ref}${input.version === undefined ? '' : ` ${input.version}`} was not found in the registry.`,
          {},
          {},
          { name: input.ref, version: input.version ?? 'latest' },
        );
      }
      throw new HttpError(
        502,
        'mcp_registry_unavailable',
        'The registry did not answer; try again later.',
        {},
        {},
        { manager: input.kind },
      );
    }
  }

  /** The assistant's / admin's host suggestions: each a valid DNS host (never `*`, an IP or an internal name). */
  #hosts(list: readonly string[] | undefined): string[] {
    const out: string[] = [];
    for (const h of list ?? []) {
      const host = h.trim().toLowerCase();
      const problem = mcpEgressHostProblem(host);
      if (problem !== null) {
        throw new HttpError(
          422,
          'mcp_egress_invalid',
          `Egress host ${host.slice(0, 80)} is not allowed: ${problem}.`,
          {},
          {},
          { host: host.slice(0, 80), detail: problem },
        );
      }
      if (!out.includes(host)) out.push(host);
    }
    return out.slice(0, 16);
  }

  #runtimes(transport: 'stdio' | 'http' | 'sse', wanted: readonly RuntimeKind[] | undefined): RuntimeKind[] {
    const can = MCP_TRANSPORT_RUNTIMES[transport];
    const list = (wanted === undefined || wanted.length === 0 ? ALL_RUNTIMES : wanted).filter((r) =>
      can.includes(r),
    );
    if (list.length === 0) {
      throw unpinnable(`None of the chosen runtimes can use a ${transport} MCP server.`, 'runtimes');
    }
    return [...new Set(list)];
  }

  #fromUrl(input: McpResolveInput, hosts: string[]): McpResolved {
    const url = input.ref.trim();
    const problem = mcpUrlProblem(url);
    if (problem !== null || /[{}]/.test(url)) {
      throw unpinnable(
        `The URL cannot be used: ${problem ?? 'template variables are not supported'}.`,
        'url',
      );
    }
    const host = new URL(url).hostname;
    const findings: McpFinding[] = [{ code: 'windows_egress' }];
    if (hosts.length > 0) findings.push({ code: 'egress_suggested', detail: hosts.join(', ') });
    return {
      sourceKind: 'url',
      ref: url,
      pinnedVersion: null,
      suggestedId:
        suggestServerId(host.split('.').find((l) => l !== 'mcp' && l !== 'www') ?? host) ?? 'remote',
      publish: {
        title: host.slice(0, 120),
        description: '',
        transport: 'http',
        url,
        secrets: [],
        egressHosts: hosts,
        runtimes: this.#runtimes('http', input.runtimes),
        source: { kind: 'url', ref: url.slice(0, 512) },
      },
      bins: [],
      file: null,
      license: null,
      repository: null,
      publishedAt: null,
      downloadsWeekly: null,
      warnings: [],
      findings,
      egressSuggested: hosts,
    };
  }

  async #fromNpm(
    name: string,
    version: string | undefined,
    input: McpResolveInput,
    hosts: string[],
    reg: RegistryEntry | null,
  ): Promise<McpResolved> {
    if (!NPM_PACKAGE_NAME.test(name) || name.length > 214)
      throw unpinnable('Invalid npm package name.', 'name');
    if (version !== undefined && !EXACT_VERSION.test(version)) {
      throw unpinnable('An exact version is needed.', 'version');
    }
    const path = name.replace('/', '%2f');
    const manifest = rec(
      await this.#get(`https://registry.npmjs.org/${path}/${encodeURIComponent(version ?? 'latest')}`),
    );
    const pinned = str(manifest.version);
    if (pinned === null || !EXACT_VERSION.test(pinned))
      throw unpinnable('The registry has no version.', 'version');
    const info = npmInfo(manifest, { name, version: pinned });
    if (info === null)
      throw unpinnable('The registry answer has no sha512 integrity for this version.', 'integrity');
    const findings: McpFinding[] = [];
    let bin: string;
    if (input.bin !== undefined && info.bins.includes(input.bin)) bin = input.bin;
    else if (info.bins.length === 1) bin = info.bins[0] ?? '';
    else if (info.bins.length > 1) {
      bin = info.bins.find((b) => b === unscoped(name)) ?? info.bins[0] ?? '';
      findings.push({ code: 'bin_chosen', name: bin, detail: info.bins.join(', ') });
    } else
      throw unpinnable(`${name} ${pinned} has no executable (bin); it cannot run as a local server.`, 'bin');
    // Age and downloads: best effort (a huge packument or a missing count only means "unknown").
    const [createdAt, weekly] = await Promise.all([
      this.#get(`https://registry.npmjs.org/${path}`)
        .then((d) => str(rec(rec(d).time).created))
        .catch(() => null),
      this.#get(`https://api.npmjs.org/downloads/point/last-week/${name}`)
        .then((d) => (typeof rec(d).downloads === 'number' ? (rec(d).downloads as number) : null))
        .catch(() => null),
    ]);
    return this.#stdio('npm', name, pinned, info.integrity, bin, info, input, hosts, reg, findings, {
      createdAt,
      weekly,
      repository: repoUrl(manifest.repository),
    });
  }

  async #fromPypi(
    name: string,
    version: string | undefined,
    input: McpResolveInput,
    hosts: string[],
    reg: RegistryEntry | null,
  ): Promise<McpResolved> {
    if (!PYPI_PACKAGE_NAME.test(name)) throw unpinnable('Invalid PyPI project name.', 'name');
    if (version !== undefined && !EXACT_VERSION.test(version)) {
      throw unpinnable('An exact version is needed.', 'version');
    }
    const project = rec(await this.#get(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`));
    const latest = str(rec(project.info).version);
    const pinned = version ?? latest;
    if (pinned === null) throw unpinnable('The registry has no version.', 'version');
    const body =
      pinned === latest
        ? project
        : rec(
            await this.#get(
              `https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(pinned)}/json`,
            ),
          );
    const info = pypiInfo(body, { name, version: pinned });
    if (info === null) {
      throw unpinnable(
        `${name} ${pinned} has no wheel with a sha256 (source builds are never run).`,
        'wheel',
      );
    }
    const findings: McpFinding[] = [];
    const bin = input.bin ?? pypiNormalize(str(rec(project.info).name) ?? name);
    if (input.bin === undefined) findings.push({ code: 'bin_guessed', name: bin });
    return this.#stdio('pypi', name, pinned, info.integrity, bin, info, input, hosts, reg, findings, {
      createdAt: pypiFirstUpload(project.releases),
      weekly: null,
      repository: pypiRepo(rec(project.info)),
    });
  }

  #stdio(
    manager: 'npm' | 'pypi',
    name: string,
    version: string,
    integrity: string,
    bin: string,
    info: { license: string | null; description: string | null; file: string | null; bins: string[] },
    input: McpResolveInput,
    hosts: string[],
    reg: RegistryEntry | null,
    findings: McpFinding[],
    facts: { createdAt: string | null; weekly: number | null; repository: string | null },
  ): McpResolved {
    const env: Record<string, McpValueInput> = {};
    const secrets: { slot: string; why: string }[] = [];
    const pkg = reg?.packages.find((p) => p.manager === manager && p.name === name) ?? null;
    for (const v of pkg?.env ?? []) {
      const r = registryValue(v, 'env', secrets, findings);
      if (r !== null) env[r.name] = r.value;
    }
    if (pkg?.argumentsRequired === true) findings.push({ code: 'arguments_required' });
    if (hosts.length > 0) findings.push({ code: 'egress_suggested', detail: hosts.join(', ') });
    else findings.push({ code: 'no_egress_hosts' });
    findings.push({ code: 'windows_egress' });
    const repository = facts.repository ?? reg?.repository ?? null;
    return {
      sourceKind: reg === null ? manager : 'registry',
      ref: reg === null ? name : reg.name,
      pinnedVersion: version,
      suggestedId: suggestServerId(reg?.name ?? name) ?? 'mcp-server',
      publish: {
        title: (reg?.title ?? name).slice(0, 120),
        description: untrustedText(reg?.description ?? info.description ?? '', 1024),
        transport: 'stdio',
        package: {
          manager,
          name,
          version,
          integrity,
          bin,
          ...(Object.keys(env).length === 0 ? {} : { env }),
        },
        secrets,
        egressHosts: hosts,
        runtimes: this.#runtimes('stdio', input.runtimes),
        source:
          reg === null
            ? {
                kind: manager,
                ref: `${name}@${version}`.slice(0, 512),
                registry: manager === 'npm' ? 'registry.npmjs.org' : 'pypi.org',
              }
            : {
                kind: 'registry',
                ref: `${reg.name}@${reg.version ?? version}`.slice(0, 512),
                registry: 'registry.modelcontextprotocol.io',
              },
      },
      bins: info.bins,
      file: info.file,
      license: info.license,
      repository,
      publishedAt: facts.createdAt,
      downloadsWeekly: facts.weekly,
      warnings: factWarnings({
        manager,
        name,
        createdAt: facts.createdAt,
        downloadsWeekly: facts.weekly,
        repository,
        status: reg?.status ?? null,
        now: this.d.clock(),
      }),
      findings,
      egressSuggested: hosts,
    };
  }

  async #fromRegistry(input: McpResolveInput, hosts: string[]): Promise<McpResolved> {
    if (!REGISTRY_NAME.test(input.ref) || input.ref.length > 200) {
      throw unpinnable('Invalid MCP Registry server name.', 'name');
    }
    if (input.version !== undefined && !EXACT_VERSION.test(input.version)) {
      throw unpinnable('An exact version is needed.', 'version');
    }
    const body = await this.#get(
      `${MCP_REGISTRY_API}/servers/${encodeURIComponent(input.ref)}/versions/${encodeURIComponent(input.version ?? 'latest')}`,
    );
    const entry = registryEntry(body);
    if (entry?.name !== input.ref) throw unpinnable('The registry answer names another server.', 'registry');
    // A local package first (it runs inside the job sandbox); otherwise the remote endpoint.
    const pkg = entry.packages.find((p) => p.transport === 'stdio') ?? null;
    if (pkg !== null) {
      const resolved =
        pkg.manager === 'npm'
          ? await this.#fromNpm(pkg.name, pkg.version, input, hosts, entry)
          : await this.#fromPypi(pkg.name, pkg.version, input, hosts, entry);
      if (entry.packages.length > 1) {
        return {
          ...resolved,
          findings: [
            ...resolved.findings,
            { code: 'stdio_package_chosen', name: `${pkg.manager}:${pkg.name}` },
          ],
        };
      }
      return resolved;
    }
    const remote = entry.remote;
    if (remote === null) {
      throw unpinnable(
        'This registry entry has no npm / PyPI package and no remote endpoint the platform can run.',
        'no_package',
      );
    }
    const problem = mcpUrlProblem(remote.url);
    if (problem !== null || /[{}]/.test(remote.url)) {
      throw unpinnable(
        `The remote URL cannot be used: ${problem ?? 'template variables are not supported'}.`,
        'url',
      );
    }
    const findings: McpFinding[] = [];
    const secrets: { slot: string; why: string }[] = [];
    const headers: Record<string, McpValueInput> = {};
    for (const h of remote.headers) {
      const r = registryValue(h, 'header', secrets, findings);
      if (r !== null) headers[r.name] = r.value;
    }
    if (remote.transport === 'sse') findings.push({ code: 'sse_runtimes' });
    if (hosts.length > 0) findings.push({ code: 'egress_suggested', detail: hosts.join(', ') });
    findings.push({ code: 'windows_egress' });
    return {
      sourceKind: 'registry',
      ref: entry.name,
      pinnedVersion: entry.version,
      suggestedId: suggestServerId(entry.name) ?? 'remote',
      publish: {
        title: (entry.title ?? entry.name).slice(0, 120),
        description: untrustedText(entry.description, 1024),
        transport: remote.transport,
        url: remote.url,
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
        secrets,
        egressHosts: hosts,
        runtimes: this.#runtimes(remote.transport, input.runtimes),
        source: {
          kind: 'registry',
          ref: `${entry.name}@${entry.version ?? 'latest'}`.slice(0, 512),
          registry: 'registry.modelcontextprotocol.io',
        },
      },
      bins: [],
      file: null,
      license: null,
      repository: entry.repository,
      publishedAt: entry.publishedAt,
      downloadsWeekly: null,
      warnings: factWarnings({
        manager: null,
        name: null,
        createdAt: entry.publishedAt,
        downloadsWeekly: null,
        repository: entry.repository,
        status: entry.status,
        now: this.d.clock(),
      }),
      findings,
      egressSuggested: hosts,
    };
  }
}

// ---------------------------------------------------------------------------------------------- registry JSON

interface RegistryValue {
  readonly name: string;
  readonly description: string;
  readonly isSecret: boolean;
  readonly isRequired: boolean;
  readonly value: string | null;
}

interface RegistryEntry {
  readonly name: string;
  readonly title: string | null;
  readonly description: string;
  readonly version: string | null;
  readonly repository: string | null;
  readonly status: string | null;
  readonly publishedAt: string | null;
  readonly transport: 'stdio' | 'http' | 'sse' | null;
  readonly packages: {
    manager: 'npm' | 'pypi';
    name: string;
    version: string;
    transport: string;
    env: RegistryValue[];
    argumentsRequired: boolean;
  }[];
  readonly remote: { transport: 'http' | 'sse'; url: string; headers: RegistryValue[] } | null;
}

function registryValues(list: unknown): RegistryValue[] {
  return arr(list)
    .slice(0, 32)
    .flatMap((x) => {
      const v = rec(x);
      const name = str(v.name);
      if (name === null) return [];
      return [
        {
          name: name.slice(0, 80),
          description: untrustedText(v.description, 200),
          isSecret: v.isSecret === true,
          isRequired: v.isRequired === true,
          value: str(v.value) ?? str(v.default),
        },
      ];
    });
}

/** One `{server, _meta}` item of the MCP Registry (schema 2025-09 / 2025-12), or null when it is not usable. */
function registryEntry(item: unknown): RegistryEntry | null {
  const s = rec(rec(item).server);
  const meta = rec(rec(rec(item)._meta)['io.modelcontextprotocol.registry/official']);
  const name = str(s.name);
  if (name === null || !REGISTRY_NAME.test(name)) return null;
  const status = str(meta.status);
  if (status === 'deleted') return null;
  const packages: RegistryEntry['packages'] = [];
  for (const p of arr(s.packages)) {
    const r = rec(p);
    const type = str(r.registryType) ?? str(r.registry_type) ?? str(r.registry_name);
    const id = str(r.identifier) ?? str(r.name);
    const version = str(r.version);
    const base = str(r.registryBaseUrl) ?? str(r.registry_base_url);
    if ((type !== 'npm' && type !== 'pypi') || id === null || version === null) continue;
    // Only the public registries the installers use (a custom registry base cannot be pinned by the master).
    if (
      base !== null &&
      !['https://registry.npmjs.org', 'https://pypi.org'].includes(base.replace(/\/+$/, ''))
    ) {
      continue;
    }
    const args = [...arr(r.packageArguments), ...arr(r.runtimeArguments)];
    packages.push({
      manager: type,
      name: id,
      version,
      transport: str(rec(r.transport).type) ?? 'stdio',
      env: registryValues(r.environmentVariables ?? r.environment_variables),
      argumentsRequired: args.some((a) => rec(a).isRequired === true),
    });
  }
  let remote: RegistryEntry['remote'] = null;
  for (const t of arr(s.remotes)) {
    const r = rec(t);
    const type = str(r.type) ?? str(r.transport_type);
    const url = str(r.url);
    if (url === null) continue;
    if (type === 'streamable-http' || type === 'sse') {
      remote = { transport: type === 'sse' ? 'sse' : 'http', url, headers: registryValues(r.headers) };
      if (type === 'streamable-http') break;
    }
  }
  const stdio = packages.some((p) => p.transport === 'stdio');
  return {
    name,
    title: str(s.title) === null ? null : untrustedText(s.title, 120),
    description: untrustedText(s.description),
    version: str(s.version),
    repository: repoUrl(rec(s.repository).url),
    status,
    publishedAt: str(meta.publishedAt) ?? str(meta.published_at),
    transport: stdio ? 'stdio' : (remote?.transport ?? null),
    packages,
    remote,
  };
}

/**
 * A registry header / env variable → a spec value: secrets become slots (`{secret, format}`), literal values only when
 * the spec rules accept them (no `$`, braces, quotes, backslashes, leading `!` — no runtime substitution can be
 * triggered by registry text); anything else is left out with a finding the card shows.
 */
function registryValue(
  v: RegistryValue,
  where: 'header' | 'env',
  secrets: { slot: string; why: string }[],
  findings: McpFinding[],
): { name: string; value: McpValueInput } | null {
  const nameOk =
    where === 'header'
      ? /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(v.name)
      : /^[A-Z][A-Z0-9_]{0,63}$/.test(v.name) && !RESERVED_STDIO_ENV.test(v.name);
  const dropped = where === 'header' ? 'header_dropped' : 'env_dropped';
  if (!nameOk) {
    findings.push({ code: dropped, name: v.name, detail: 'name' });
    return null;
  }
  if (v.isSecret) {
    const placeholder = v.value === null ? null : /\{([A-Za-z0-9_-]{1,64})\}/.exec(v.value);
    const slot = slotName(placeholder?.[1] ?? v.name);
    if (slot === null || secrets.some((s) => s.slot === slot) || secrets.length >= 16) {
      findings.push({ code: dropped, name: v.name, detail: 'slot' });
      return null;
    }
    secrets.push({ slot, why: v.description.slice(0, 200) });
    let format: string | undefined;
    if (placeholder !== null && v.value !== null) {
      const f = v.value.replace(placeholder[0], '{}');
      if (f !== '{}') {
        const parts = f.split('{}');
        if (
          parts.length === 2 &&
          parts.every((p) => FORMAT_TEXT.test(p)) &&
          McpSecretFormat.safeParse(f).success
        ) {
          format = f;
        } else findings.push({ code: 'format_dropped', name: v.name });
      }
    }
    return { name: v.name, value: format === undefined ? { secret: slot } : { secret: slot, format } };
  }
  if (v.value === null) {
    if (v.isRequired) findings.push({ code: 'env_needs_value', name: v.name });
    return null;
  }
  if (!McpLiteralValue.safeParse(v.value).success) {
    findings.push({ code: dropped, name: v.name, detail: 'value' });
    return null;
  }
  return { name: v.name, value: v.value };
}

function repoUrl(v: unknown): string | null {
  const raw = typeof v === 'string' ? v : str(rec(v).url);
  if (raw === null) return null;
  const s = raw.replace(/^git\+/, '').replace(/\.git$/, '');
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? `${u.origin}${u.pathname}`.slice(0, 300) : null;
  } catch {
    return null;
  }
}

function pypiRepo(info: Record<string, unknown>): string | null {
  const urls = rec(info.project_urls);
  for (const k of ['Source', 'Repository', 'source', 'repository', 'Code', 'GitHub', 'Homepage']) {
    const r = repoUrl(urls[k]);
    if (r !== null) return r;
  }
  return repoUrl(info.home_page);
}

function pypiFirstUpload(releases: unknown): string | null {
  let first: number | null = null;
  for (const files of Object.values(rec(releases))) {
    for (const f of arr(files)) {
      const t = Date.parse(str(rec(f).upload_time_iso_8601) ?? str(rec(f).upload_time) ?? '');
      if (Number.isFinite(t) && (first === null || t < first)) first = t;
    }
  }
  return first === null ? null : new Date(first).toISOString();
}
