import { z } from 'zod';
import { Sha256Hex } from './common.js';
import { type EffectiveTool, ToolVersion } from './tools.js';

/**
 * p13-fleet-tools (docs/design/p13-fleet-tools.md, ADR-0052): fleet-wide tool and runtime versions, admin-defined
 * ("custom") tool recipes and which install of a tool jobs actually use. Pure schemas and functions shared by the
 * master, the worker and (types only) the panel.
 *
 *  - **Effective tool** (`resolveEffectiveTools`): a machine may have git on PATH *and* a worker-managed MinGit. Jobs
 *    get the managed bin dirs in front of PATH (apps/worker/src/tools/tool-env.ts), so a found managed install wins;
 *    for git the worker's configured `gitBinary` wins over both. The panel shows that one as "Etkin".
 *  - **Version status** (`versionStatus`): installed vs the pin (runtime policy / release recipe) vs the latest
 *    version the master read from the official source.
 *  - **Custom recipes**: a download (allowlisted https host, mandatory SHA-256 and size, zip / tgz / raw) installed
 *    unprivileged into `<dataDir>/tools/custom/<name>/<version>/` by OPS_COMMAND `tool.install.custom`, or a package
 *    manager install (winget / brew / apt / dnf / npm -g / pipx) that runs as a machine-admin job with a fixed command
 *    list (every elevated command approved). No free-form command, path outside the install dir or URL host outside
 *    the allowlist is ever accepted — by the master, and again by the worker.
 */

export const CUSTOM_TOOLS_FEATURE = 'custom-tools-v1';

/** OS/arch pairs that have tool recipes (the worker's `RecipePlatform`). */
export const ToolPlatform = z.enum(['win32-x64', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']);
export type ToolPlatform = z.infer<typeof ToolPlatform>;

export function toolPlatform(os: string, arch: string): ToolPlatform | null {
  const p = ToolPlatform.safeParse(`${os}-${arch}`);
  return p.success ? p.data : null;
}

// ------------------------------------------------------------------------------------------ versions

/**
 * The comparable core of a version string: `v2.56.0.windows.2` → `2.56.0.2`, `n7.1` → `7.1`,
 * `2.1.296 (Claude Code)` → `2.1.296`, `7.1.1-1ubuntu1` → `7.1.1`. Null when there is no number.
 */
export function normalizeVersion(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = raw.trim().replace(/\.windows\./i, '.');
  const m = /(\d+(?:\.\d+){0,4})/.exec(s);
  return m?.[1] ?? null;
}

/** Numeric dotted comparison of two versions (after `normalizeVersion`); null when either has no number. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const x = normalizeVersion(a);
  const y = normalizeVersion(b);
  if (x === null || y === null) return null;
  const xs = x.split('.').map(Number);
  const ys = y.split('.').map(Number);
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const d = (xs[i] ?? 0) - (ys[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * - `not_found`: nothing installed (or not detected).
 * - `pin_differs`: a pin applies (runtime policy / release recipe) and the installed version is another one.
 * - `update_available`: the official source has a newer version than the installed one.
 * - `current`: matches the pin and nothing newer is known.
 * - `unknown`: installed, but neither a pin nor the latest version is known.
 */
export const VersionStatus = z.enum(['current', 'update_available', 'pin_differs', 'not_found', 'unknown']);
export type VersionStatus = z.infer<typeof VersionStatus>;

export function versionStatus(input: {
  readonly installed: string | null | undefined;
  readonly pinned?: string | null | undefined;
  readonly latest?: string | null | undefined;
}): VersionStatus {
  const installed = input.installed ?? null;
  if (installed === null || installed === '') return 'not_found';
  const pinned = input.pinned ?? null;
  if (pinned !== null && compareVersions(installed, pinned) !== 0) return 'pin_differs';
  const latest = input.latest ?? null;
  const newer = latest === null ? null : compareVersions(latest, installed);
  if (newer !== null && newer > 0) return 'update_available';
  if (pinned === null && newer === null) return 'unknown';
  return 'current';
}

// --------------------------------------------------------------------------------- effective tools

interface InventoryLike {
  readonly name: string;
  readonly found: boolean;
  readonly source: 'system' | 'managed';
  readonly version?: string | undefined;
  readonly path?: string | undefined;
}

/**
 * One entry per tool name that jobs can use. Order of precedence (what the worker does when it starts a runtime):
 * the configured `gitBinary` (git only) → the newest found worker-managed install (its bin dir is put in front of
 * PATH) → the first found system install. Names nothing is found for are left out.
 */
export function resolveEffectiveTools(
  tools: readonly InventoryLike[],
  opts: { readonly gitBinary?: string | undefined } = {},
): EffectiveTool[] {
  const names: string[] = [];
  for (const t of tools) if (!names.includes(t.name)) names.push(t.name);
  if (opts.gitBinary !== undefined && opts.gitBinary !== '' && !names.includes('git')) names.push('git');
  const out: EffectiveTool[] = [];
  for (const name of names) {
    if (name === 'git' && opts.gitBinary !== undefined && opts.gitBinary !== '') {
      const sys = tools.find((t) => t.name === 'git' && t.found && t.path === opts.gitBinary);
      out.push({
        name,
        source: 'config',
        path: opts.gitBinary.slice(0, 512),
        ...(sys?.version === undefined ? {} : { version: sys.version }),
      });
      continue;
    }
    const managed = tools.filter((t) => t.name === name && t.found && t.source === 'managed').at(-1);
    const chosen = managed ?? tools.find((t) => t.name === name && t.found && t.source === 'system');
    if (chosen === undefined) continue;
    out.push({
      name,
      source: chosen.source,
      ...(chosen.version === undefined ? {} : { version: chosen.version }),
      ...(chosen.path === undefined ? {} : { path: chosen.path }),
    });
  }
  return out.slice(0, 64);
}

// ----------------------------------------------------------------------------------- custom recipes

/**
 * Hosts a custom download recipe may name (the first URL; redirects are followed and the SHA-256 is the integrity
 * gate). Release artefact hosts of well-known projects only; extending the list is a release change (the worker
 * checks the same list).
 */
export const CUSTOM_TOOL_HOSTS: readonly string[] = [
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'registry.npmjs.org',
  'api.nuget.org',
  'www.python.org',
  'nodejs.org',
  'dl.google.com',
  'storage.googleapis.com',
  'cdn.playwright.dev',
  'download.docker.com',
  'releases.hashicorp.com',
  'static.rust-lang.org',
  'go.dev',
  'dl.k8s.io',
  'get.helm.sh',
];

export function isAllowedCustomToolUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    CUSTOM_TOOL_HOSTS.includes(url.hostname)
  );
}

/** Names of tools the platform detects or manages itself: a custom recipe may not shadow them. */
export const RESERVED_TOOL_NAMES: readonly string[] = [
  'git',
  'python',
  'python3',
  'pip',
  'pip3',
  'node',
  'npm',
  'npx',
  'uv',
  'docker',
  'podman',
  'wsl',
  'ffmpeg',
  'cloudflared',
  'chrome',
  'edge',
  'chromium',
  'playwright-chromium',
  'browser',
  'container',
  'claude',
  'claude-code',
  'codex',
  'pi',
  'opencode',
  'powershell',
  'pwsh',
  'cmd',
  'sh',
  'bash',
  'sudo',
  'remyral',
  'remyral-worker',
];

export const CustomToolName = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,31}$/, 'custom tool name')
  .refine((n) => !RESERVED_TOOL_NAMES.includes(n), 'reserved tool name');
export type CustomToolName = z.infer<typeof CustomToolName>;

/** A path inside the install dir: forward slashes, no `..` / `.` segment, no drive, no leading slash. */
export function isSafeRelativePath(p: string): boolean {
  if (p.length === 0 || p.length > 200) return false;
  if (!/^[A-Za-z0-9._ +@-]+(?:\/[A-Za-z0-9._ +@-]+)*$/.test(p)) return false;
  return p.split('/').every((s) => s !== '..' && s !== '.' && s.trim() === s);
}
const RelPath = z.string().refine(isSafeRelativePath, 'relative path inside the install dir');
/** One path segment (an archive's leading directory to strip). */
const Segment = z
  .string()
  .regex(/^[A-Za-z0-9._ +@-]{1,120}$/)
  .refine((s) => s !== '..' && s !== '.', 'segment');

export const MAX_CUSTOM_TOOL_BYTES = 1024 * 1024 * 1024;

export const CustomToolDownload = z.strictObject({
  url: z.string().max(2048).refine(isAllowedCustomToolUrl, 'download host not allowed'),
  sha256: Sha256Hex,
  size: z.number().int().min(1).max(MAX_CUSTOM_TOOL_BYTES),
  format: z.enum(['zip', 'tgz', 'raw']),
  /** Leading directory of the archive's entries to strip (zip only). */
  strip: Segment.optional(),
  /** The executable, relative to the install dir. */
  entry: RelPath,
});
export type CustomToolDownload = z.infer<typeof CustomToolDownload>;

export const PackageManager = z.enum(['winget', 'brew', 'apt', 'dnf', 'npm', 'pipx']);
export type PackageManager = z.infer<typeof PackageManager>;

const PACKAGE_ID: Readonly<Record<PackageManager, RegExp>> = {
  winget: /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,99}$/,
  brew: /^[a-z0-9][a-z0-9@._+-]{0,99}(?:\/[a-z0-9._-]{1,64}){0,2}$/,
  apt: /^[a-z0-9][a-z0-9.+-]{0,99}$/,
  dnf: /^[a-z0-9][a-z0-9.+_-]{0,99}$/,
  npm: /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,99}$/,
  pipx: /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/,
};

/** Which OS family a package manager works on (npm / pipx: any, as long as they are installed). */
const MANAGER_OS: Readonly<Record<PackageManager, readonly string[]>> = {
  winget: ['win32'],
  brew: ['darwin'],
  apt: ['linux'],
  dnf: ['linux'],
  npm: ['win32', 'linux', 'darwin'],
  pipx: ['win32', 'linux', 'darwin'],
};

export const CustomToolPackage = z.strictObject({
  manager: PackageManager,
  package: z.string().min(1).max(160),
});
export type CustomToolPackage = z.infer<typeof CustomToolPackage>;

export const CustomToolPlatformStep = z.discriminatedUnion('kind', [
  CustomToolDownload.extend({ kind: z.literal('download') }),
  CustomToolPackage.extend({ kind: z.literal('package') }),
]);
export type CustomToolPlatformStep = z.infer<typeof CustomToolPlatformStep>;

/** A version-check argument (`--version`, `-V`, `version`). */
const CheckArg = z.string().regex(/^-{0,2}[A-Za-z0-9][A-Za-z0-9._=:-]{0,31}$/, 'version check argument');
export const CustomToolCheck = z.strictObject({
  /** Executable name on PATH for package installs (download installs run their own `entry`). */
  binary: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
    .optional(),
  args: z.array(CheckArg).max(4).default(['--version']),
});
export type CustomToolCheck = z.infer<typeof CustomToolCheck>;

/** An admin-defined tool recipe (stored by the master, versioned by `version`). */
export const CustomToolRecipe = z.strictObject({
  name: CustomToolName,
  title: z.string().min(1).max(120),
  /** The version this recipe installs (reported in the inventory; also used for the package version when set). */
  version: ToolVersion,
  description: z.string().max(500).optional(),
  /** Pin the package manager to `version` (false: the manager's current version). */
  pinPackageVersion: z.boolean().default(true),
  platforms: z.partialRecord(ToolPlatform, CustomToolPlatformStep),
  check: CustomToolCheck,
});
export type CustomToolRecipe = z.infer<typeof CustomToolRecipe>;

export interface RecipeIssue {
  readonly path: string;
  readonly code: string;
}

/** Consistency rules beyond the schema (empty: valid). */
export function customToolRecipeIssues(r: CustomToolRecipe): RecipeIssue[] {
  const issues: RecipeIssue[] = [];
  const entries = Object.entries(r.platforms) as [ToolPlatform, CustomToolPlatformStep][];
  if (entries.length === 0) issues.push({ path: 'platforms', code: 'no_platform' });
  for (const [platform, step] of entries) {
    const os = platform.split('-')[0] ?? '';
    if (step.kind === 'package') {
      if (!MANAGER_OS[step.manager].includes(os)) {
        issues.push({ path: `platforms.${platform}.manager`, code: 'manager_not_for_os' });
      }
      if (!PACKAGE_ID[step.manager].test(step.package)) {
        issues.push({ path: `platforms.${platform}.package`, code: 'package_id_invalid' });
      }
      if (r.check.binary === undefined) issues.push({ path: 'check.binary', code: 'binary_required' });
    } else {
      if (step.strip !== undefined && step.format !== 'zip') {
        issues.push({ path: `platforms.${platform}.strip`, code: 'strip_zip_only' });
      }
      if (platform.startsWith('win32') && !/\.(exe|cmd|bat)$/i.test(step.entry)) {
        issues.push({ path: `platforms.${platform}.entry`, code: 'windows_entry_not_executable' });
      }
    }
  }
  return issues;
}

/** What travels in OPS_COMMAND `tool.install.custom`: one platform's download, never a command. */
export const CustomToolInstall = z.strictObject({
  name: CustomToolName,
  version: ToolVersion,
  download: CustomToolDownload,
  check: z.strictObject({ args: z.array(CheckArg).max(4) }),
});
export type CustomToolInstall = z.infer<typeof CustomToolInstall>;

/** The exact package-manager commands of a package step (built from validated ids only). */
export function customPackageCommands(
  step: CustomToolPackage,
  version: string | null,
): { readonly commands: readonly string[]; readonly shell: 'sh' | 'powershell' } {
  if (!PACKAGE_ID[step.manager].test(step.package)) throw new Error('package id invalid');
  if (version !== null && !ToolVersion.safeParse(version).success) throw new Error('version invalid');
  const p = step.package;
  switch (step.manager) {
    case 'winget':
      return {
        shell: 'powershell',
        commands: [
          `winget install --id ${p} --exact --silent --disable-interactivity --accept-package-agreements --accept-source-agreements${version === null ? '' : ` --version ${version}`}`,
        ],
      };
    case 'brew':
      // Homebrew refuses to run as root: the command runs as the logged-in console user.
      return {
        shell: 'sh',
        commands: [`sudo -u "$(stat -f %Su /dev/console)" -H brew install ${p}`],
      };
    case 'apt':
      return {
        shell: 'sh',
        commands: [
          'apt-get update',
          `DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${p}${version === null ? '' : `=${version}`}`,
        ],
      };
    case 'dnf':
      return { shell: 'sh', commands: [`dnf install -y ${p}${version === null ? '' : `-${version}`}`] };
    case 'npm':
      return { shell: 'sh', commands: [`npm install -g ${p}${version === null ? '' : `@${version}`}`] };
    case 'pipx':
      return { shell: 'sh', commands: [`pipx install ${p}${version === null ? '' : `==${version}`}`] };
  }
}

/**
 * The fixed prompt of the machine-admin job for a package step (the commands are built here from the stored, validated
 * recipe; the job's agent runs exactly these through admin_exec, each approved or auto-approved and signed).
 */
export function customPackagePrompt(r: CustomToolRecipe, platform: ToolPlatform): string {
  const step = r.platforms[platform];
  if (step?.kind !== 'package') throw new Error('no package step for this platform');
  const { commands, shell } = customPackageCommands(
    step,
    r.pinPackageVersion && r.version !== 'latest' ? r.version : null,
  );
  const verify = [r.check.binary ?? r.name, ...r.check.args].join(' ');
  const winShell = platform.startsWith('win32');
  return [
    `Install the custom tool "${r.title}" (${r.name} ${r.version}) on this machine with ${step.manager}, using the elevated`,
    `admin_exec tool (shell "${winShell ? 'powershell' : shell}"). Run exactly these commands, one admin_exec call each,`,
    'and nothing else:',
    ...commands.map((c) => `- \`${c}\``),
    `Finally verify with \`${verify}\` and record what was installed with machine_note.`,
    `If ${step.manager} is not available on this machine, stop and explain why; do not install it another way.`,
  ].join('\n');
}

// --------------------------------------------------------------------------------- version feeds

/**
 * Hosts the master reads "latest version" feeds from (no credentials, no cookies; responses are size- and
 * time-bounded). Shared so the design note, the master and its tests name one list.
 */
export const VERSION_FEED_HOSTS: readonly string[] = [
  'registry.npmjs.org',
  'api.github.com',
  'api.nuget.org',
  'nodejs.org',
];
