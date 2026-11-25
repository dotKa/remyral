import type { System } from '../system/types.js';
import { checkBwrapNamespaces } from './bwrap.js';
import { locateBinary } from './locate.js';
import type { Problem, ToolReport } from './report.js';
import { extractVersion, firstLine, stripNuls } from './version.js';

export const VERSION_TIMEOUT_MS = 10_000;
const DAEMON_TIMEOUT_MS = 8_000;

/** Runs `<bin> <args>` and returns a parsed version string, or null. Never throws. */
export async function readVersion(
  sys: System,
  binary: string,
  args: readonly string[],
  timeoutMs = VERSION_TIMEOUT_MS,
): Promise<{ version: string | null; exitCode: number | null; timedOut: boolean; raw: string }> {
  const r = await sys.exec(binary, args, { timeoutMs });
  const raw = stripNuls(`${r.stdout}\n${r.stderr}`);
  const version = r.exitCode === 0 ? (extractVersion(raw) ?? (firstLine(raw) || null)) : null;
  return { version, exitCode: r.exitCode, timedOut: r.timedOut, raw };
}

async function simpleTool(
  sys: System,
  name: ToolReport['name'],
  binary: string,
  args: readonly string[],
): Promise<ToolReport> {
  const path = await locateBinary(sys, binary);
  if (!path) return { name, found: false };
  const v = await readVersion(sys, path, args);
  return {
    name,
    found: true,
    path,
    ...(v.version ? { version: v.version } : {}),
    ...(v.timedOut ? { details: { timedOut: true } } : {}),
  };
}

/** bubblewrap: version plus a real namespace check (handson 2026-10-13 finding 2). */
async function bubblewrapTool(sys: System): Promise<ToolReport> {
  const base = await simpleTool(sys, 'bubblewrap', 'bwrap', ['--version']);
  if (!base.found || base.path === undefined) return base;
  const check = await checkBwrapNamespaces((f, a, o) => sys.exec(f, a, o), base.path, sys.platform);
  return {
    ...base,
    details: { ...base.details, namespacesUsable: check.usable, namespaces: check.detail.slice(0, 256) },
  };
}

/** Docker: client version, daemon reachability and rootless mode. */
async function dockerTool(sys: System): Promise<ToolReport> {
  const base = await simpleTool(sys, 'docker', 'docker', ['--version']);
  if (!base.found || !base.path) return base;
  // `docker info` reports "name=rootless" in SecurityOptions for a rootless daemon
  // (Docker docs, rootless mode). Format string verified locally against Docker 29.7.
  const info = await sys.exec(base.path, ['info', '--format', '{{json .SecurityOptions}}'], {
    timeoutMs: DAEMON_TIMEOUT_MS,
  });
  const reachable = info.exitCode === 0;
  let rootless: boolean | null = null;
  if (reachable) {
    try {
      const options: unknown = JSON.parse(info.stdout.trim());
      if (Array.isArray(options))
        rootless = options.some((o) => typeof o === 'string' && o.includes('name=rootless'));
    } catch {
      rootless = null;
    }
  }
  return { ...base, details: { daemonReachable: reachable, rootless } };
}

/** Podman: version and rootless mode (`podman info` Host.Security.Rootless; UNVERIFIED locally, no podman on the dev Mac). */
async function podmanTool(sys: System): Promise<ToolReport> {
  const base = await simpleTool(sys, 'podman', 'podman', ['--version']);
  if (!base.found || !base.path) return base;
  const info = await sys.exec(base.path, ['info', '--format', '{{.Host.Security.Rootless}}'], {
    timeoutMs: DAEMON_TIMEOUT_MS,
  });
  const out = info.stdout.trim();
  const usable = info.exitCode === 0;
  const rootless = usable && (out === 'true' || out === 'false') ? out === 'true' : null;
  return { ...base, details: { daemonReachable: usable, rootless } };
}

/** Python 3: first interpreter that answers (informational; no runtime needs it since ADR-0023). */
async function pythonTool(sys: System): Promise<ToolReport> {
  const candidates: { binary: string; args: string[] }[] =
    sys.platform === 'win32'
      ? [
          { binary: 'python3', args: ['--version'] },
          { binary: 'python', args: ['--version'] },
          { binary: 'py', args: ['-3', '--version'] },
        ]
      : [
          { binary: 'python3', args: ['--version'] },
          { binary: 'python', args: ['--version'] },
        ];
  for (const c of candidates) {
    const path = await locateBinary(sys, c.binary);
    if (!path) continue;
    const v = await readVersion(sys, path, c.args);
    // Windows' Store alias "python3.exe" exists on PATH but fails without Python installed.
    if (!v.version?.startsWith('3.')) continue;
    return { name: 'python', found: true, path, version: v.version, details: { command: c.binary } };
  }
  return { name: 'python', found: false };
}

async function nodeTool(sys: System): Promise<ToolReport> {
  const path = await locateBinary(sys, 'node');
  return { name: 'node', found: true, ...(path ? { path } : {}), version: sys.nodeVersion };
}

/** `wsl --version` prints UTF-16LE on Windows; NULs are stripped before parsing (UNVERIFIED on our hosts). */
async function wslTool(sys: System): Promise<ToolReport> {
  return simpleTool(sys, 'wsl', 'wsl', ['--version']);
}

export async function probeTools(sys: System): Promise<{ tools: ToolReport[]; problems: Problem[] }> {
  const tasks: Promise<ToolReport>[] = [
    simpleTool(sys, 'git', 'git', ['--version']),
    dockerTool(sys),
    podmanTool(sys),
    pythonTool(sys),
    nodeTool(sys),
    simpleTool(sys, 'uv', 'uv', ['--version']),
  ];
  if (sys.platform === 'linux') tasks.push(bubblewrapTool(sys));
  if (sys.platform === 'win32') tasks.push(wslTool(sys));
  const tools = await Promise.all(tasks);

  const problems: Problem[] = [];
  const byName = new Map(tools.map((t) => [t.name, t]));
  if (!byName.get('git')?.found) {
    problems.push({
      code: 'tool.git_missing',
      severity: 'warning',
      message: 'git not found; every job runs in a git worktree.',
    });
  }
  for (const name of ['docker', 'podman'] as const) {
    const t = byName.get(name);
    if (
      t?.found &&
      t.details?.daemonReachable === true &&
      t.details.rootless === false &&
      sys.platform === 'linux'
    ) {
      problems.push({
        code: 'tool.container_rootful',
        severity: 'warning',
        message: `${name} daemon is rootful; ADR-0007 requires rootless Docker/Podman for the container profile.`,
      });
    }
  }
  if (sys.platform === 'linux' && !byName.get('bubblewrap')?.found) {
    problems.push({
      code: 'tool.bwrap_missing',
      severity: 'info',
      message:
        'bubblewrap (bwrap) not on PATH; Codex falls back to its bundled copy (needs unprivileged user namespaces).',
    });
  }
  return { tools, problems };
}
