import {
  ELEVATED_RECIPES,
  type ElevatedRecipe,
  elevatedRecipePrompt,
  type RecipeArtifact,
  type ToolRecipeId,
} from '@remyral/protocol';

export { elevatedRecipePrompt, type ElevatedRecipe };

/**
 * Tool install recipes shipped in this release (p5-machine-admin §2, ADR-0021). Versioned and checksummed: the
 * archive URL, SHA-256 and size come from here — the signed worker bundle — never from the panel or a job. The
 * checksums were computed on 2026-10-14 (bumped ones on 2026-10-26, p17-pin-bump) from the upstream artifacts and are re-checked by the opt-in online test
 * (`REMYRAL_ONLINE_TESTS=1`, apps/worker/test/tools-recipes.test.ts).
 *
 * - **Unprivileged** recipes download one archive into the worker-owned `<dataDir>/tools/<tool>/<version>/` and
 *   change nothing else on the machine (no PATH, no registry, no sudo).
 * - **Elevated** recipes (Linux distribution packages) are a fixed list of package-manager commands; the panel
 *   turns them into a machine-admin job, where each command is approved (or auto-approved) and signed.
 *
 * Bumping a version: update the entries below (URL, sha256, size), run the online test, note it in CHANGELOG.
 */

export type RecipePlatform = 'win32-x64' | 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64';

export interface ArchiveStep extends RecipeArtifact {
  /**
   * Download format (default `zip`). p8-preview-tunnels: `raw` — the download is the executable itself (copied to
   * `entry`, mode 0755); `tgz` — a gzip'ed tar extracted with the archive's own layout (no component stripped).
   */
  readonly format?: 'zip' | 'tgz' | 'raw';
  /** Directory (relative to the install dir) the archive is extracted into. */
  readonly into: string;
  /** Leading directory of the archive's entries to strip (none: keep the archive's own layout). */
  readonly strip?: string;
  /** The executable, relative to the install dir (checked after extraction, its SHA-256 recorded). */
  readonly entry: string;
  /** Extra marker files Playwright expects next to a browser it did not install itself. */
  readonly markers?: readonly string[];
  /** macOS app bundles contain relative symlinks (contained in the install dir). */
  readonly symlinks?: boolean;
  /**
   * Small launcher files written next to the extracted tree (relative to the install dir; ASCII), e.g. `pip.cmd`
   * for the NuGet Python, which ships pip as a module but no `Scripts\pip.exe`. Re-created when missing.
   */
  readonly shims?: readonly { readonly path: string; readonly content: string }[];
}

/** Windows launcher for a module of the managed Python (`python\Scripts\<name>.cmd` → `python.exe -m <module>`). */
function pythonModuleShim(name: string, module: string): { path: string; content: string } {
  return {
    path: `python/Scripts/${name}.cmd`,
    content: `@echo off\r\n"%~dp0..\\python.exe" -m ${module} %*\r\n`,
  };
}

export interface UnprivilegedRecipe {
  readonly tool: ToolRecipeId;
  readonly version: string;
  readonly elevated: false;
  /** Name the managed install is reported as in the inventory. */
  readonly reportAs: string;
  readonly title: string;
  readonly platforms: Readonly<Partial<Record<RecipePlatform, ArchiveStep>>>;
}

export type ToolRecipe = UnprivilegedRecipe | ElevatedRecipe;

/**
 * Playwright 1.64.1 (the repository's pin) uses Chromium revision 1248 = Chrome for Testing 156.0.8078.4 (unchanged from
 * 1.64.0: `playwright-core` browsers.json of both releases, p17-pin-bump).
 */
export const PLAYWRIGHT_CHROMIUM_REVISION = '1248';
const CFT = 'https://cdn.playwright.dev/builds/cft/156.0.8078.4';
const CHROMIUM_DIR = `chromium-${PLAYWRIGHT_CHROMIUM_REVISION}`;
const PW_MARKERS = [`${CHROMIUM_DIR}/INSTALLATION_COMPLETE`, `${CHROMIUM_DIR}/DEPENDENCIES_VALIDATED`];

/** p8-preview-tunnels: the pinned cloudflared release (`tunnel run --token-file` needs ≥ 2025.4.0). */
export const CLOUDFLARED_VERSION = '2026.10.3';
const CLOUDFLARED_BASE = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;

/**
 * p14-mcp-stdio (ADR-0054 P4): the pinned uv that installs PyPI MCP servers (`uv pip compile --generate-hashes`,
 * `uv pip sync --require-hashes --no-build`, `uv venv` with a uv-managed CPython inside the install dir). SHA-256 and
 * size are the GitHub release asset digests of 0.13.5 (GitHub API `assets[].digest`, read 2026-10-26; the macOS arm64
 * archive was downloaded and re-hashed, `uv --version` = `uv 0.13.5 (46776a95d 2026-10-21 aarch64-apple-darwin)`, and
 * ran `pip compile --generate-hashes` / `venv --python 3.13.16 --managed-python` / `pip sync --require-hashes`). uv
 * 0.13 made Python 3.15 its default; the MCP installs always name UV_PYTHON_VERSION, so that does not apply here.
 * The tar.gz archives hold `uv-<triple>/uv`; the Windows zip holds `uv.exe` at its root.
 */
export const UV_VERSION = '0.13.5';
const UV_BASE = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;
/** The CPython the pinned uv installs for PyPI MCP servers (`uv venv --python <it> --managed-python`). */
export const UV_PYTHON_VERSION = '3.13.16';

export const RECIPES: readonly ToolRecipe[] = [
  {
    tool: 'browser',
    version: PLAYWRIGHT_CHROMIUM_REVISION,
    elevated: false,
    reportAs: 'playwright-chromium',
    title: 'Playwright Chromium (Chrome for Testing 156.0.8078.4)',
    platforms: {
      'win32-x64': {
        url: `${CFT}/win64/chrome-win64.zip`,
        sha256: '220021ecfdad08c116fc71a153e65e3861ba841c531afc4f7acc7bd5d44b41db',
        size: 207073013,
        into: CHROMIUM_DIR,
        entry: `${CHROMIUM_DIR}/chrome-win64/chrome.exe`,
        markers: PW_MARKERS,
      },
      'linux-x64': {
        url: `${CFT}/linux64/chrome-linux64.zip`,
        sha256: '43fd31766c7533a02dda2ded5ad50c2f861cd5400be7509c0abad71129f79d79',
        size: 200345244,
        into: CHROMIUM_DIR,
        entry: `${CHROMIUM_DIR}/chrome-linux64/chrome`,
        markers: PW_MARKERS,
      },
      'linux-arm64': {
        url: `${CFT}/linux-arm64/chrome-linux-arm64.zip`,
        sha256: '910a12fff6170202195f72ef3d353801c7063d301ab80b1f51b77d791fda60ce',
        size: 199750508,
        into: CHROMIUM_DIR,
        entry: `${CHROMIUM_DIR}/chrome-linux-arm64/chrome`,
        markers: PW_MARKERS,
      },
      'darwin-arm64': {
        url: `${CFT}/mac-arm64/chrome-mac-arm64.zip`,
        sha256: '987d2f8499c87d21676f78178550cfcbfb1bb53786821e2cff46c5a7e99b58be',
        size: 194831853,
        into: CHROMIUM_DIR,
        entry: `${CHROMIUM_DIR}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
        markers: PW_MARKERS,
        symlinks: true,
      },
      'darwin-x64': {
        url: `${CFT}/mac-x64/chrome-mac-x64.zip`,
        sha256: '4e75da96830224185ddddc80012ad3732d6a29a4f92bac728c84c8e8ebd66c34',
        size: 205332100,
        into: CHROMIUM_DIR,
        entry: `${CHROMIUM_DIR}/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
        markers: PW_MARKERS,
        symlinks: true,
      },
    },
  },
  {
    tool: 'git',
    version: '2.56.0.3',
    elevated: false,
    reportAs: 'git',
    title: 'MinGit 2.56.0.3 (Git for Windows, portable)',
    platforms: {
      'win32-x64': {
        url: 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.3/MinGit-2.56.0.3-64-bit.zip',
        sha256: '2e5619966e588fde5f8122c5557cad50c0fbafcaed736689f40ec1dfb1d78ea7',
        size: 39854943,
        into: 'mingit',
        entry: 'mingit/cmd/git.exe',
      },
    },
  },
  {
    tool: 'python',
    version: '3.13.17',
    elevated: false,
    reportAs: 'python',
    title: 'CPython 3.13.17 (python.org NuGet package, with pip and venv)',
    platforms: {
      'win32-x64': {
        url: 'https://api.nuget.org/v3-flatcontainer/python/3.13.17/python.3.13.17.nupkg',
        sha256: 'dce409744b088f94c6e37ba41f8100c384c27e029e843237364c602d30d475e5',
        size: 14826465,
        into: 'python',
        strip: 'tools',
        entry: 'python/python.exe',
        // pip ships as a module only; `Scripts` (on the runtimes' PATH) gets launchers for it.
        shims: [pythonModuleShim('pip', 'pip'), pythonModuleShim('pip3', 'pip')],
      },
    },
  },
  {
    tool: 'ffmpeg',
    version: '9.0.2',
    elevated: false,
    reportAs: 'ffmpeg',
    title: 'FFmpeg 9.0.2 (gyan.dev essentials build, static)',
    platforms: {
      // gyan.dev's builds as published on its GitHub mirror (immutable release tag 9.0.2; the GitHub asset digest
      // matched the SHA-256 computed on 2026-10-14).
      'win32-x64': {
        url: 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip',
        sha256: '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba',
        size: 114768076,
        into: 'ffmpeg',
        strip: 'ffmpeg-9.0.2-essentials_build',
        entry: 'ffmpeg/bin/ffmpeg.exe',
      },
    },
  },
  {
    // p8-preview-tunnels (ADR-0032): the preview tunnel connector. Pins are the GitHub release asset digests of
    // 2026.10.3 (GitHub API `assets[].digest`, 2026-10-26; the darwin-arm64 archive was downloaded and re-hashed, it
    // holds `cloudflared` at its root and reports `cloudflared version 2026.10.3`). The macOS archives' checksums in the release notes differ:
    // they are re-signed after the notes are written — the asset digest is what is served.
    tool: 'cloudflared',
    version: CLOUDFLARED_VERSION,
    elevated: false,
    reportAs: 'cloudflared',
    title: `cloudflared ${CLOUDFLARED_VERSION} (Cloudflare Tunnel connector)`,
    platforms: {
      'linux-x64': {
        url: `${CLOUDFLARED_BASE}/cloudflared-linux-amd64`,
        sha256: '053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0',
        size: 40227721,
        format: 'raw',
        into: 'bin',
        entry: 'bin/cloudflared',
      },
      'linux-arm64': {
        url: `${CLOUDFLARED_BASE}/cloudflared-linux-arm64`,
        sha256: '89297ebfb9e8c99c0dc013a1140601453cf3798d8306c5591651f4a3f5210be8',
        size: 37652905,
        format: 'raw',
        into: 'bin',
        entry: 'bin/cloudflared',
      },
      // Archive layout (`cloudflared` at the root) UNVERIFIED until the online test runs.
      'darwin-x64': {
        url: `${CLOUDFLARED_BASE}/cloudflared-darwin-amd64.tgz`,
        sha256: '81b7b85f2376815c4f59b1aa323887b62e16ce8b67555c2e1577dc23f2a82000',
        size: 21823395,
        format: 'tgz',
        into: 'bin',
        entry: 'bin/cloudflared',
      },
      'darwin-arm64': {
        url: `${CLOUDFLARED_BASE}/cloudflared-darwin-arm64.tgz`,
        sha256: '1165d14b6f6360a3b8c283d7d1100024d6ec7cd9bc9e32519e96150645f3ec55',
        size: 19841881,
        format: 'tgz',
        into: 'bin',
        entry: 'bin/cloudflared',
      },
      'win32-x64': {
        url: `${CLOUDFLARED_BASE}/cloudflared-windows-amd64.exe`,
        sha256: '76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2',
        size: 55329336,
        format: 'raw',
        into: 'bin',
        entry: 'bin/cloudflared.exe',
      },
    },
  },
  {
    tool: 'uv',
    version: UV_VERSION,
    elevated: false,
    reportAs: 'uv',
    title: `uv ${UV_VERSION} (Astral; installs PyPI MCP servers)`,
    platforms: {
      'linux-x64': {
        url: `${UV_BASE}/uv-x86_64-unknown-linux-gnu.tar.gz`,
        sha256: 'f68d291c75783122dad58ab77def0e13f3233f358731db5d6d7e8715603b928f',
        size: 16682639,
        format: 'tgz',
        into: 'bin',
        entry: 'bin/uv-x86_64-unknown-linux-gnu/uv',
      },
      'linux-arm64': {
        url: `${UV_BASE}/uv-aarch64-unknown-linux-gnu.tar.gz`,
        sha256: '4bb69cf95ed13f23713bb7bc09f241896ea0c75b7c557e615a20604b82f9c403',
        size: 15914298,
        format: 'tgz',
        into: 'bin',
        entry: 'bin/uv-aarch64-unknown-linux-gnu/uv',
      },
      'darwin-x64': {
        url: `${UV_BASE}/uv-x86_64-apple-darwin.tar.gz`,
        sha256: 'b0f52b0e3945b4107d89024ea38e625683011fbfc05a0d98f9fa2d6dcee28c66',
        size: 17167423,
        format: 'tgz',
        into: 'bin',
        entry: 'bin/uv-x86_64-apple-darwin/uv',
      },
      'darwin-arm64': {
        url: `${UV_BASE}/uv-aarch64-apple-darwin.tar.gz`,
        sha256: '743f85035a1996ecb350659e01cd9faea9709829be09b1b4b03c73eaf3c9cd73',
        size: 14365303,
        format: 'tgz',
        into: 'bin',
        entry: 'bin/uv-aarch64-apple-darwin/uv',
      },
      'win32-x64': {
        url: `${UV_BASE}/uv-x86_64-pc-windows-msvc.zip`,
        sha256: 'a38b8d1902b7cfbc76b423ba1bb456f623f42064cdc72628b6075b89afd1019a',
        size: 15264056,
        into: 'uv',
        entry: 'uv/uv.exe',
      },
    },
  },
  ...ELEVATED_RECIPES,
];

export function recipePlatform(platform: string, arch: string): RecipePlatform | null {
  const key = `${platform}-${arch}`;
  return key === 'win32-x64' ||
    key === 'linux-x64' ||
    key === 'linux-arm64' ||
    key === 'darwin-x64' ||
    key === 'darwin-arm64'
    ? key
    : null;
}

/** The recipe for a tool + version, preferring the unprivileged one where this platform has it. */
export function findRecipe(tool: ToolRecipeId, version: string): ToolRecipe | null {
  return RECIPES.find((r) => r.tool === tool && r.version === version) ?? null;
}

/** The recipe a tool installs with on this platform (unprivileged when possible, else the Linux elevated one). */
export function defaultRecipe(tool: ToolRecipeId, platform: RecipePlatform | null): ToolRecipe | null {
  const own = RECIPES.find(
    (r): r is UnprivilegedRecipe =>
      r.tool === tool && !r.elevated && platform !== null && r.platforms[platform] !== undefined,
  );
  if (own !== undefined) return own;
  if (platform !== null && platform.startsWith('linux-')) {
    return RECIPES.find((r) => r.tool === tool && r.elevated) ?? null;
  }
  return null;
}

/** Why a recipe cannot run here (null: it can). */
export function unsupportedReason(recipe: ToolRecipe, platform: RecipePlatform | null): string | null {
  if (platform === null) return 'this OS/architecture has no recipes';
  if (recipe.elevated) {
    return platform.startsWith('linux-')
      ? null
      : 'only Linux distribution packages are scripted; ask a machine administration job instead';
  }
  return recipe.platforms[platform] === undefined
    ? `no ${recipe.title} build for ${platform}; ask a machine administration job instead`
    : null;
}

// ------------------------------------------------------------------------------------------ p17-update-channel

/** The Chrome for Testing build of the built-in browser recipe (the catalog names its own `build`). */
export const PLAYWRIGHT_CFT_BUILD = '156.0.8078.4';

const UV_TRIPLES: Readonly<Partial<Record<RecipePlatform, string>>> = {
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
};
const CHROME_ENTRIES: Readonly<Partial<Record<RecipePlatform, { dir: string; exe: string; mac: boolean }>>> =
  {
    'win32-x64': { dir: 'chrome-win64', exe: 'chrome.exe', mac: false },
    'linux-x64': { dir: 'chrome-linux64', exe: 'chrome', mac: false },
    'linux-arm64': { dir: 'chrome-linux-arm64', exe: 'chrome', mac: false },
    'darwin-arm64': {
      dir: 'chrome-mac-arm64',
      exe: 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      mac: true,
    },
    'darwin-x64': {
      dir: 'chrome-mac-x64',
      exe: 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      mac: true,
    },
  };

/** The archive layout of a recipe tool's asset (everything of an {@link ArchiveStep} but the source and its hash). */
export type RecipeLayout = Omit<ArchiveStep, 'url' | 'sha256' | 'size'>;

/**
 * p17-update-channel (ADR-0065): how a tool's asset is unpacked, as a function of the version — the same for the
 * built-in recipes above (a test pins that) and for version-catalog entries, whose source comes only from the
 * protocol's `toolAssetUrl` templates. Null: the tool has no build for this platform.
 */
export function recipeLayout(
  tool: ToolRecipeId,
  platform: RecipePlatform,
  version: string,
): RecipeLayout | null {
  switch (tool) {
    case 'browser': {
      const c = CHROME_ENTRIES[platform];
      if (c === undefined) return null;
      const dir = `chromium-${version}`;
      return {
        into: dir,
        entry: `${dir}/${c.dir}/${c.exe}`,
        markers: [`${dir}/INSTALLATION_COMPLETE`, `${dir}/DEPENDENCIES_VALIDATED`],
        ...(c.mac ? { symlinks: true } : {}),
      };
    }
    case 'git':
      return platform === 'win32-x64' ? { into: 'mingit', entry: 'mingit/cmd/git.exe' } : null;
    case 'python':
      return platform === 'win32-x64'
        ? {
            into: 'python',
            strip: 'tools',
            entry: 'python/python.exe',
            shims: [pythonModuleShim('pip', 'pip'), pythonModuleShim('pip3', 'pip')],
          }
        : null;
    case 'ffmpeg':
      return platform === 'win32-x64'
        ? {
            into: 'ffmpeg',
            strip: `ffmpeg-${version}-essentials_build`,
            entry: 'ffmpeg/bin/ffmpeg.exe',
          }
        : null;
    case 'cloudflared':
      if (platform === 'win32-x64') return { format: 'raw', into: 'bin', entry: 'bin/cloudflared.exe' };
      if (platform.startsWith('darwin-')) return { format: 'tgz', into: 'bin', entry: 'bin/cloudflared' };
      return { format: 'raw', into: 'bin', entry: 'bin/cloudflared' };
    case 'uv': {
      if (platform === 'win32-x64') return { into: 'uv', entry: 'uv/uv.exe' };
      const t = UV_TRIPLES[platform];
      return t === undefined ? null : { format: 'tgz', into: 'bin', entry: `bin/uv-${t}/uv` };
    }
  }
}

const REPORT_AS: Readonly<Record<ToolRecipeId, string>> = {
  browser: 'playwright-chromium',
  git: 'git',
  python: 'python',
  ffmpeg: 'ffmpeg',
  cloudflared: 'cloudflared',
  uv: 'uv',
};

/**
 * A recipe from a version-catalog entry: the asset URLs, hashes and sizes were already checked against the templates
 * (`checkVersionCatalog`); the layout is {@link recipeLayout}'s. Platforms without a layout are left out.
 */
export function catalogRecipe(
  tool: ToolRecipeId,
  version: string,
  assets: Readonly<Partial<Record<RecipePlatform, { url: string; sha256: string; size: number }>>>,
  verified: boolean,
): UnprivilegedRecipe {
  const platforms: Partial<Record<RecipePlatform, ArchiveStep>> = {};
  for (const [p, a] of Object.entries(assets) as [
    RecipePlatform,
    { url: string; sha256: string; size: number },
  ][]) {
    const layout = recipeLayout(tool, p, version);
    if (layout === null) continue;
    platforms[p] = { url: a.url, sha256: a.sha256, size: a.size, ...layout };
  }
  return {
    tool,
    version,
    elevated: false,
    reportAs: REPORT_AS[tool],
    title: `${tool} ${version} (version catalog${verified ? '' : ', unverified'})`,
    platforms,
  };
}
