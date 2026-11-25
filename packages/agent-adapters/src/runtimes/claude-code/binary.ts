import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const SDK_NAME = '@anthropic-ai/claude-agent-sdk';

export interface ClaudeSdkPackageInfo {
  /** `version` of the installed `@anthropic-ai/claude-agent-sdk`. */
  readonly sdkVersion: string;
  /** `claudeCodeVersion` the SDK declares it bundles. */
  readonly claudeCodeVersion: string | undefined;
  /** Directory of the SDK package (resolution base for the platform binary). */
  readonly packageDir: string;
}

/** Reads the SDK's own package.json (no code from the SDK is executed). */
export function readClaudeSdkPackageInfo(): ClaudeSdkPackageInfo {
  const require = createRequire(import.meta.url);
  const entry = require.resolve(SDK_NAME);
  const packageDir = dirname(entry);
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    version?: unknown;
    claudeCodeVersion?: unknown;
  };
  return {
    sdkVersion: typeof pkg.version === 'string' ? pkg.version : 'unknown',
    claudeCodeVersion: typeof pkg.claudeCodeVersion === 'string' ? pkg.claudeCodeVersion : undefined,
    packageDir,
  };
}

/**
 * The SDK package next to a given Claude Code binary: a worker-managed install (p5-remote-ops) lays out
 * `<root>/node_modules/@anthropic-ai/claude-agent-sdk-<os>-<arch>/claude[.exe]` beside
 * `<root>/node_modules/@anthropic-ai/claude-agent-sdk/package.json`. The worker's single-file bundle cannot
 * resolve the SDK by module resolution, so the version comes from the install it actually runs.
 */
export function readClaudeSdkPackageInfoNear(binaryPath: string): ClaudeSdkPackageInfo | undefined {
  // oss-sdk-external: a symlinked CLI (the runtime images' /usr/local/bin/claude) is looked up at its target too.
  const candidates = [binaryPath];
  try {
    const real = realpathSync(binaryPath);
    if (real !== binaryPath) candidates.push(real);
  } catch {
    // a missing binary: only the given path
  }
  for (const candidate of candidates) {
    const packageDir = join(dirname(dirname(candidate)), 'claude-agent-sdk');
    const file = join(packageDir, 'package.json');
    if (!existsSync(file)) continue;
    let pkg: { name?: unknown; version?: unknown; claudeCodeVersion?: unknown };
    try {
      pkg = JSON.parse(readFileSync(file, 'utf8')) as typeof pkg;
    } catch {
      continue;
    }
    if (pkg.name !== SDK_NAME) continue;
    return {
      sdkVersion: typeof pkg.version === 'string' ? pkg.version : 'unknown',
      claudeCodeVersion: typeof pkg.claudeCodeVersion === 'string' ? pkg.claudeCodeVersion : undefined,
      packageDir,
    };
  }
  return undefined;
}

function prefersMusl(): boolean {
  if (process.platform !== 'linux') return false;
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
  return report.header?.glibcVersionRuntime === undefined;
}

/**
 * Candidate package specifiers of the platform binary, in the order the SDK
 * 0.3.296 tries them (`sdk.mjs`: `@anthropic-ai/claude-agent-sdk-<os>-<arch>[-musl]/claude[.exe]`).
 */
export function claudeBinaryCandidates(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl: boolean = prefersMusl(),
): string[] {
  const ext = platform === 'win32' ? '.exe' : '';
  const base = `${SDK_NAME}-`;
  const names =
    platform === 'linux'
      ? musl
        ? [`${base}linux-${arch}-musl`, `${base}linux-${arch}`]
        : [`${base}linux-${arch}`, `${base}linux-${arch}-musl`]
      : [`${base}${platform}-${arch}`];
  return names.map((n) => `${n}/claude${ext}`);
}

/**
 * Absolute path of the native Claude Code binary bundled with the pinned SDK,
 * or undefined if the platform package is missing (e.g. installed with
 * `--omit=optional`). The adapter always passes this path explicitly
 * (`pathToClaudeCodeExecutable`) so a global `claude` is never picked up.
 */
export function resolveBundledClaudeBinary(info: ClaudeSdkPackageInfo): string | undefined {
  const require = createRequire(join(info.packageDir, 'package.json'));
  for (const spec of claudeBinaryCandidates()) {
    try {
      const path = require.resolve(spec);
      if (existsSync(path)) return path;
    } catch {
      // next candidate
    }
  }
  return undefined;
}
