import { readdir } from 'node:fs/promises';
import { normalizeVersion, type ToolInventoryEntry } from '@remyral/protocol';
import { locateBinary, pathFor } from '../probe/locate.js';
import { probeTools, readVersion } from '../probe/tools.js';
import type { System } from '../system/types.js';
import type { CustomManagedTool, ManagedTool } from './installer.js';

/**
 * Tool detection for the inventory (p5-machine-admin §2). Cheap by construction: PATH / well-known-path
 * lookups, at most one `--version` per tool with a short timeout, and on Windows / macOS browsers are read from
 * their install layout (version folder, Info.plist) without starting them. The result is cached by
 * {@link ToolInventory}; nothing here runs more than once per detection.
 */

export interface DetectDeps {
  readonly sys: System;
  /** Directory listing (tests inject a fake). */
  readonly readdir?: (path: string) => Promise<string[]>;
}

const VERSION_DIR = /^\d+\.\d+\.\d+\.\d+$/;

async function listDir(d: DetectDeps, path: string): Promise<string[]> {
  try {
    return await (d.readdir ?? ((p) => readdir(p)))(path);
  } catch {
    return [];
  }
}

/** Windows Chromium-based browsers keep `Application\<version>\` next to the executable. */
async function windowsBrowser(
  d: DetectDeps,
  name: 'chrome' | 'edge',
  candidates: readonly string[],
): Promise<ToolInventoryEntry> {
  const p = pathFor(d.sys);
  for (const exe of candidates) {
    if (!(await d.sys.isFile(exe))) continue;
    const versions = (await listDir(d, p.dirname(exe)))
      .filter((n) => VERSION_DIR.test(n))
      .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
    return {
      name,
      found: true,
      path: exe,
      source: 'system',
      ...(versions[0] === undefined ? {} : { version: versions[0] }),
    };
  }
  return { name, found: false, source: 'system' };
}

/** macOS: CFBundleShortVersionString of the app bundle (no process start). */
async function macBrowser(
  d: DetectDeps,
  name: 'chrome' | 'edge' | 'chromium',
  app: string,
  binary: string,
): Promise<ToolInventoryEntry> {
  const exe = `${app}/Contents/MacOS/${binary}`;
  if (!(await d.sys.isFile(exe))) return { name, found: false, source: 'system' };
  const plist = await d.sys.readText(`${app}/Contents/Info.plist`, 256 * 1024);
  const m =
    plist === null
      ? null
      : /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]{1,64})<\/string>/.exec(plist);
  return {
    name,
    found: true,
    path: exe,
    source: 'system',
    ...(m?.[1] === undefined ? {} : { version: m[1] }),
  };
}

/** Linux: the first launcher on PATH, `--version` ("Google Chrome 141.0.7390.65"). */
async function linuxBrowser(
  d: DetectDeps,
  name: 'chrome' | 'edge' | 'chromium',
  binaries: readonly string[],
): Promise<ToolInventoryEntry> {
  for (const b of binaries) {
    const path = await locateBinary(d.sys, b);
    if (path === null) continue;
    const v = await readVersion(d.sys, path, ['--version'], 8_000);
    // Browsers have four-part versions ("Google Chrome 141.0.7390.65").
    const version = v.exitCode === 0 ? /(\d+(?:\.\d+){1,3})/.exec(v.raw)?.[1] : undefined;
    return { name, found: true, path, source: 'system', ...(version === undefined ? {} : { version }) };
  }
  return { name, found: false, source: 'system' };
}

async function browsers(d: DetectDeps): Promise<ToolInventoryEntry[]> {
  const sys = d.sys;
  if (sys.platform === 'win32') {
    const roots = [
      sys.getEnv('ProgramFiles') ?? 'C:\\Program Files',
      sys.getEnv('ProgramFiles(x86)') ?? 'C:\\Program Files (x86)',
      ...(sys.getEnv('LOCALAPPDATA') === undefined ? [] : [sys.getEnv('LOCALAPPDATA') ?? '']),
    ];
    const p = pathFor(sys);
    return Promise.all([
      windowsBrowser(
        d,
        'chrome',
        roots.map((r) => p.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')),
      ),
      windowsBrowser(
        d,
        'edge',
        roots.map((r) => p.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
      ),
    ]);
  }
  if (sys.platform === 'darwin') {
    return Promise.all([
      macBrowser(d, 'chrome', '/Applications/Google Chrome.app', 'Google Chrome'),
      macBrowser(d, 'edge', '/Applications/Microsoft Edge.app', 'Microsoft Edge'),
      macBrowser(d, 'chromium', '/Applications/Chromium.app', 'Chromium'),
    ]);
  }
  return Promise.all([
    linuxBrowser(d, 'chrome', ['google-chrome', 'google-chrome-stable']),
    linuxBrowser(d, 'edge', ['microsoft-edge', 'microsoft-edge-stable']),
    linuxBrowser(d, 'chromium', ['chromium', 'chromium-browser']),
  ]);
}

async function ffmpeg(d: DetectDeps): Promise<ToolInventoryEntry> {
  const path = await locateBinary(d.sys, 'ffmpeg');
  if (path === null) return { name: 'ffmpeg', found: false, source: 'system' };
  const v = await readVersion(d.sys, path, ['-version'], 8_000);
  // "ffmpeg version 7.1.1-1ubuntu1 Copyright …" / "ffmpeg version n7.1 …"
  const m = /ffmpeg version n?([0-9][^\s]{0,40})/.exec(v.raw);
  return {
    name: 'ffmpeg',
    found: true,
    path,
    source: 'system',
    ...(m?.[1] === undefined ? {} : { version: m[1].slice(0, 64) }),
  };
}

/**
 * p8-preview-tunnels: a cloudflared on PATH (`cloudflared --version` → "cloudflared version 2026.10.3 (built …)").
 * The worker prefers its managed install (recipe) when present.
 */
export function parseCloudflaredVersion(raw: string): string | null {
  const m = /cloudflared version (\d{4}\.\d{1,2}\.\d{1,3})/.exec(raw);
  return m?.[1] ?? null;
}

async function cloudflared(d: DetectDeps): Promise<ToolInventoryEntry> {
  const path = await locateBinary(d.sys, 'cloudflared');
  if (path === null) return { name: 'cloudflared', found: false, source: 'system' };
  const v = await readVersion(d.sys, path, ['--version'], 8_000);
  const version = parseCloudflaredVersion(v.raw);
  return {
    name: 'cloudflared',
    found: true,
    path,
    source: 'system',
    ...(version === null ? {} : { version }),
  };
}

/**
 * p13-fleet-tools: a "system" hit whose path lies inside the worker's own tools dir is a worker-managed install that
 * happens to be on PATH (e.g. an operator added MinGit's `cmd` to the machine PATH). It is reported once, as managed.
 */
export function insideDir(path: string | undefined, dir: string | undefined, platform: string): boolean {
  if (path === undefined || dir === undefined || dir === '') return false;
  const norm = (p: string): string => {
    const s = platform === 'win32' ? p.replace(/\//g, '\\').toLowerCase() : p;
    const sep = platform === 'win32' ? '\\' : '/';
    return s.endsWith(sep) ? s : `${s}${sep}`;
  };
  return norm(path).startsWith(norm(dir));
}

/** Version of a custom install: its own version check against the installed entry (never a shell). */
async function customVersion(d: DetectDeps, c: CustomManagedTool): Promise<string | undefined> {
  if (c.checkArgs.length === 0) return undefined;
  const v = await readVersion(d.sys, c.entry, [...c.checkArgs], 8_000).catch(() => null);
  if (v?.exitCode !== 0) return undefined;
  return normalizeVersion(v.raw)?.slice(0, 64);
}

export interface DetectExtras {
  /** p13-fleet-tools: admin-defined installs (reported as managed, with their version check). */
  readonly custom?: readonly CustomManagedTool[];
  /** The worker's tools dir: system hits inside it are not reported twice. */
  readonly toolsRoot?: string;
}

/** Every system tool plus the worker-managed installs. Never throws (a failed section reports not found). */
export async function detectTools(
  d: DetectDeps,
  managed: readonly ManagedTool[],
  extras: DetectExtras = {},
): Promise<ToolInventoryEntry[]> {
  const [base, found, ff, cfd] = await Promise.all([
    probeTools(d.sys)
      .then((r) => r.tools)
      .catch(() => []),
    browsers(d).catch(() => [] as ToolInventoryEntry[]),
    ffmpeg(d).catch((): ToolInventoryEntry => ({ name: 'ffmpeg', found: false, source: 'system' })),
    cloudflared(d).catch((): ToolInventoryEntry => ({ name: 'cloudflared', found: false, source: 'system' })),
  ]);
  const out: ToolInventoryEntry[] = base.map((t) => ({
    name: t.name,
    found: t.found,
    source: 'system' as const,
    ...(t.version === undefined ? {} : { version: t.version.slice(0, 64) }),
    ...(t.path === undefined ? {} : { path: t.path.slice(0, 512) }),
    ...(t.details === undefined ? {} : { details: t.details }),
  }));
  out.push(...found, ff, cfd);
  // A system hit inside the worker's own tools dir is the managed install below: on the system it is "not found".
  for (let i = 0; i < out.length; i++) {
    const t = out[i];
    if (t?.found === true && insideDir(t.path, extras.toolsRoot, d.sys.platform)) {
      out[i] = { name: t.name, found: false, source: 'system' };
    }
  }
  for (const m of managed) {
    out.push({
      name: m.reportAs,
      found: true,
      version: m.version,
      path: m.entry.slice(0, 512),
      source: 'managed',
      details: { recipe: `${m.tool}@${m.version}`, installedAt: m.installedAt },
    });
  }
  const customs = await Promise.all(
    (extras.custom ?? []).map(async (c): Promise<ToolInventoryEntry> => {
      const detected = await customVersion(d, c).catch(() => undefined);
      return {
        name: c.name,
        found: true,
        version: (detected ?? c.version).slice(0, 64),
        path: c.entry.slice(0, 512),
        source: 'managed',
        details: { recipe: `custom:${c.name}@${c.version}`, custom: true, installedAt: c.installedAt },
      };
    }),
  );
  out.push(...customs);
  return out.slice(0, 64);
}
