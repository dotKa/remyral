import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as ClaudeAgentSdk from '@anthropic-ai/claude-agent-sdk';
import { VersionMismatchError } from '../../errors.js';
import { readClaudeSdkPackageInfoNear } from './binary.js';
import { CLAUDE_CODE_CLI_PIN } from './pins.js';

/**
 * oss-sdk-external: the Claude Agent SDK is not part of the worker bundle (it is proprietary; esbuild keeps it
 * external, apps/worker/scripts/bundle.mjs). It is loaded at run time from the Claude Code runtime the machine
 * installed — the SDK package the worker-managed install (`npm ci` of the pin) lays down next to the CLI binary it
 * runs — so the JavaScript always matches the CLI version (also after a rollback, each version has its own
 * directory). Source checkouts and tests resolve it by package name from node_modules instead.
 */

export const CLAUDE_AGENT_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

export type ClaudeAgentSdkModule = typeof ClaudeAgentSdk;

export type ClaudeSdkLocation =
  | {
      /** The SDK package next to the CLI binary (worker-managed install, runtime images). */
      readonly source: 'runtime';
      readonly packageDir: string;
      readonly entry: string;
      readonly sdkVersion: string;
    }
  | {
      /** Resolved by package name from the loading module (source checkouts, tests). */
      readonly source: 'module';
      readonly entry: string;
    };

/** Test seams; the defaults are module resolution from this file and a real dynamic import. */
export interface ClaudeSdkLoaderDeps {
  /** The file the package name resolves to, or undefined when it does not resolve. */
  readonly resolveModule?: () => string | undefined;
  readonly importModule?: (specifier: string) => Promise<unknown>;
}

/** The SDK cannot be found or loaded on this machine: Claude Code is not usable here (ADR-0012 "not installed"). */
export class ClaudeSdkUnavailableError extends VersionMismatchError {
  constructor(
    readonly binary: string | undefined,
    detail?: string,
  ) {
    super('claude-code', CLAUDE_CODE_CLI_PIN, undefined);
    this.name = 'ClaudeSdkUnavailableError';
    this.message = claudeSdkMissingMessage(binary, detail);
  }
}

export function claudeSdkMissingMessage(binary: string | undefined, detail?: string): string {
  const where =
    binary === undefined
      ? 'no Claude Code binary is configured'
      : `no ${CLAUDE_AGENT_SDK_PACKAGE} package next to ${binary}`;
  return (
    `claude-code: the Claude Agent SDK could not be loaded (${where}${detail === undefined ? '' : `; ${detail}`}). ` +
    'Install Claude Code from Makineler → <makine> → Çalıştırıcılar (Machines → Runtimes), or point ' +
    'runtimes.claude-code.binary at the claude binary of an npm install of the Agent SDK pin.'
  );
}

function within(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/** The `.` target of an exports map for an ESM `import` (string, or a condition object). */
function exportsTarget(exports: unknown): string | undefined {
  const pick = (v: unknown): string | undefined => {
    if (typeof v === 'string') return v;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      for (const c of ['node', 'import', 'default']) {
        const t = pick(o[c]);
        if (t !== undefined) return t;
      }
    }
    return undefined;
  };
  if (typeof exports === 'string') return exports;
  if (exports === null || typeof exports !== 'object' || Array.isArray(exports)) return undefined;
  const o = exports as Record<string, unknown>;
  // A map of subpaths ("." …) or directly a condition object for ".".
  return Object.keys(o).some((k) => k.startsWith('.')) ? pick(o['.']) : pick(o);
}

/**
 * The SDK's main module inside `packageDir`, as its package.json declares it (`exports["."]`, else `main`, else
 * `index.js`). undefined when the file is missing or the declared path leaves the package directory.
 */
export function claudeSdkEntryFile(packageDir: string): string | undefined {
  let pkg: { exports?: unknown; main?: unknown };
  try {
    pkg = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8')) as typeof pkg;
  } catch {
    return undefined;
  }
  const declared =
    exportsTarget(pkg.exports) ?? (typeof pkg.main === 'string' && pkg.main !== '' ? pkg.main : 'index.js');
  const file = resolve(packageDir, ...declared.split('/'));
  return within(packageDir, file) && existsSync(file) ? file : undefined;
}

function nearBinary(binary: string): ClaudeSdkLocation | undefined {
  const info = readClaudeSdkPackageInfoNear(binary);
  const entry = info === undefined ? undefined : claudeSdkEntryFile(info.packageDir);
  return info === undefined || entry === undefined
    ? undefined
    : { source: 'runtime', packageDir: info.packageDir, entry, sdkVersion: info.sdkVersion };
}

function resolveByName(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve(CLAUDE_AGENT_SDK_PACKAGE);
  } catch {
    return undefined;
  }
}

/**
 * Where the SDK would be loaded from, without running any of its code: next to `binary` (the binary itself or,
 * for a symlink such as the images' /usr/local/bin/claude, its target), else by package name.
 */
export function locateClaudeSdk(
  binary: string | undefined,
  deps: ClaudeSdkLoaderDeps = {},
): ClaudeSdkLocation | undefined {
  const near = binary === undefined ? undefined : nearBinary(binary);
  if (near !== undefined) return near;
  const entry = (deps.resolveModule ?? resolveByName)();
  return entry === undefined ? undefined : { source: 'module', entry };
}

/** The import specifier of an SDK file: always a file:// URL (a Windows `C:\…` path is not a valid specifier). */
export function claudeSdkSpecifier(file: string, windows: boolean = process.platform === 'win32'): string {
  return pathToFileURL(file, { windows }).href;
}

const defaultImport = (specifier: string): Promise<unknown> =>
  // The literal stays an external import in the worker bundle (resolved from node_modules in source checkouts).
  specifier === CLAUDE_AGENT_SDK_PACKAGE ? import('@anthropic-ai/claude-agent-sdk') : import(specifier);

const caches = new WeakMap<
  (specifier: string) => Promise<unknown>,
  Map<string, Promise<ClaudeAgentSdkModule>>
>();

/**
 * Loads the Claude Agent SDK that belongs to `binary` (see {@link locateClaudeSdk}); one module per installed
 * version. Rejects with {@link ClaudeSdkUnavailableError} when it cannot be found or loaded (never cached, so a
 * later install is picked up).
 */
export function loadClaudeAgentSdk(
  binary: string | undefined,
  deps: ClaudeSdkLoaderDeps = {},
): Promise<ClaudeAgentSdkModule> {
  const location = locateClaudeSdk(binary, deps);
  if (location === undefined) return Promise.reject(new ClaudeSdkUnavailableError(binary));
  const specifier =
    location.source === 'runtime' ? claudeSdkSpecifier(location.entry) : CLAUDE_AGENT_SDK_PACKAGE;
  const importer = deps.importModule ?? defaultImport;
  let cache = caches.get(importer);
  if (cache === undefined) {
    cache = new Map();
    caches.set(importer, cache);
  }
  const hit = cache.get(specifier);
  if (hit !== undefined) return hit;
  const loading = importer(specifier).then(
    (m) => m as ClaudeAgentSdkModule,
    (err: unknown) => {
      cache.delete(specifier);
      throw new ClaudeSdkUnavailableError(
        binary,
        `loading ${location.entry} failed: ${err instanceof Error ? err.message.slice(0, 300) : 'error'}`,
      );
    },
  );
  cache.set(specifier, loading);
  return loading;
}
