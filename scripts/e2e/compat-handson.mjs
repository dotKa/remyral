#!/usr/bin/env node
/* global fetch, setTimeout, AbortSignal */
// Credential-free hands-on runtime checks (p0-compat-handson; docs/compat/handson-2026-10-13.md).
// No model is ever called and no credential is read or needed. Every server binds 127.0.0.1 and gets a
// random per-run secret; every runtime runs with a throw-away HOME/XDG directory, so the user's own
// runtime configuration and logins are never touched.
//
//   node scripts/e2e/compat-handson.mjs [--json] [--only claude-code,codex,pi,opencode]
//     env CLAUDE_SDK_DIR=<npm prefix with @anthropic-ai/claude-agent-sdk>   (optional SDK resolution check)
//
// Runs on macOS and Linux (also inside infra/dev/docker-worker Dockerfile.runtimes). Exit 0 unless a
// check FAILs; SKIPPED / UNSUPPORTED are not failures.
import { Buffer } from 'node:buffer';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { arch, homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({
  options: { json: { type: 'boolean', default: false }, only: { type: 'string' } },
});
const ONLY = opts.only ? new Set(opts.only.split(',')) : null;
const PINS = {
  'claude-code': '2.1.296',
  codex: '0.162.1',
  pi: '1.1.0',
  opencode: '1.19.0',
};
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A request id containing raw U+2028 and U+2029 (must survive an LF-only JSONL splitter). */
const SEP_ID = `d${String.fromCharCode(0x2028)}x${String.fromCharCode(0x2029)}y`;
const SCRATCH = mkdtempSync(join(tmpdir(), 'remyral-compat-'));

function record(runtime, check, status, evidence) {
  results.push({ runtime, check, status, evidence: String(evidence).replace(/\s+/g, ' ').slice(0, 300) });
  if (!opts.json)
    process.stderr.write(
      `${status.padEnd(11)} ${runtime.padEnd(11)} ${check} — ${String(evidence).slice(0, 160)}\n`,
    );
}
async function guarded(runtime, check, fn) {
  try {
    await fn();
  } catch (err) {
    record(runtime, check, 'FAIL', err instanceof Error ? err.message : String(err));
  }
}

/** Isolated environment: own HOME + XDG dirs, PATH kept, nothing else that could carry a credential. */
function isolatedEnv(extra = {}) {
  const home = mkdtempSync(join(SCRATCH, 'home-'));
  const keep = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'UV_TOOL_DIR', 'UV_PYTHON_INSTALL_DIR'];
  const env = Object.fromEntries(
    keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]),
  );
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_STATE_HOME: join(home, '.local/state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    ...extra,
  };
}

function exec(file, args, { env = isolatedEnv(), cwd = SCRATCH, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env, cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr });
      },
    );
  });
}
function which(name) {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const p = join(dir, name);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return null;
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}
async function httpStatus(url, headers = {}) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    return { status: r.status, body: await r.text() };
  } catch (err) {
    return { status: 0, body: err instanceof Error ? err.message : String(err) };
  }
}
async function waitHttp(url, child, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null) return false;
    if ((await httpStatus(url)).status > 0) return true;
    await sleep(300);
  }
  return false;
}
/** Which local address a TCP port listens on (Linux: /proc/net/tcp{,6}; macOS: lsof). */
async function listenAddrs(port) {
  if (platform() === 'linux') {
    const addrs = [];
    for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
      if (!existsSync(f)) continue;
      for (const line of readFileSync(f, 'utf8').split('\n').slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 4 || cols[3] !== '0A') continue; // LISTEN
        const [hex, p] = cols[1].split(':');
        if (parseInt(p, 16) !== port) continue;
        if (hex.length === 8)
          addrs.push(
            hex
              .match(/../g)
              .reverse()
              .map((b) => parseInt(b, 16))
              .join('.'),
          );
        else
          addrs.push(
            hex === '0'.repeat(32)
              ? '[::]'
              : hex === '00000000000000000000000001000000'
                ? '[::1]'
                : `[${hex}]`,
          );
      }
    }
    return addrs;
  }
  const r = await exec('lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN'], { env: process.env });
  return [...r.stdout.matchAll(/TCP (\S+):\d+ \(LISTEN\)/g)].map((m) => m[1]);
}
/** Starts a server process in its own process group; `stop()` kills the whole group. */
function startServer(file, args, env) {
  const child = spawn(file, args, { env, cwd: SCRATCH, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  return {
    child,
    output: () => out,
    async stop() {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* gone */
      }
      for (let i = 0; i < 30 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    },
  };
}
function versionOf(text) {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;
}
async function versionCheck(runtime, bin) {
  const r = await exec(bin, ['--version']);
  const v = versionOf(r.stdout + r.stderr);
  record(
    runtime,
    'version equals pin',
    v === PINS[runtime] ? 'PASS' : 'FAIL',
    `\`--version\` → ${String(v)} (pin ${PINS[runtime]})`,
  );
  return v;
}
function needsCreds(runtime, items) {
  for (const i of items)
    record(
      runtime,
      i,
      'SKIPPED-needs-credentials',
      'needs a model/provider key; out of scope (no credentials)',
    );
}

// ------------------------------------------------------------------ Claude Code
async function claudeCode() {
  const R = 'claude-code';
  const bin = which('claude');
  if (!bin) return record(R, 'installed', 'FAIL', '`claude` not on PATH');
  await versionCheck(R, bin);
  await guarded(R, '--help flags (permission modes, permission prompt tool, --bare)', async () => {
    const h = (await exec(bin, ['--help'])).stdout;
    const modes = /--permission-mode <mode>[^(]*\(choices: ([^)]*)\)/.exec(h)?.[1] ?? null;
    const flags = ['--permission-mode', '--permission-prompt-tool', '--bare', '--setting-sources'].filter(
      (f) => h.includes(f),
    );
    record(
      R,
      '--help flags (permission modes, permission prompt tool, --bare)',
      flags.length >= 3 && modes ? 'PASS' : 'FAIL',
      `flags: ${flags.join(' ')}; modes: ${String(modes)}`,
    );
  });
  const sdkDir = process.env.CLAUDE_SDK_DIR;
  if (sdkDir) {
    await guarded(R, 'Agent SDK resolves the platform binary package', () => {
      const scope = join(sdkDir, 'node_modules/@anthropic-ai');
      const pkgs = readdirSync(scope).filter((p) => p.startsWith('claude-agent-sdk'));
      const os = platform() === 'darwin' ? 'darwin' : platform() === 'win32' ? 'win32' : 'linux';
      const want = `claude-agent-sdk-${os}-${arch()}`;
      const sdk = JSON.parse(readFileSync(join(scope, 'claude-agent-sdk/package.json'), 'utf8'));
      const ok = pkgs.includes(want) && sdk.version === '0.3.296' && sdk.claudeCodeVersion === PINS[R];
      record(
        R,
        'Agent SDK resolves the platform binary package',
        ok ? 'PASS' : 'FAIL',
        `sdk ${String(sdk.version)} claudeCodeVersion ${String(sdk.claudeCodeVersion)}; packages: ${pkgs.join(', ')}`,
      );
    });
  } else {
    record(R, 'Agent SDK resolves the platform binary package', 'SKIPPED', 'CLAUDE_SDK_DIR not set');
  }
  needsCreds(R, [
    'API-key auth / startup()',
    'scoped cwd + settingSources:[]',
    'canUseTool approvals, streaming, interrupt, resume',
    'Bash sandbox (fails closed without bwrap / network allowlist)',
  ]);
}

// ------------------------------------------------------------------ Codex
async function appServerHandshake(bin) {
  const ws = mkdtempSync(join(SCRATCH, 'codex-ws-'));
  const env = isolatedEnv({ CODEX_HOME: mkdtempSync(join(SCRATCH, 'codex-home-')) });
  const child = spawn(bin, ['app-server'], { env, cwd: ws, stdio: ['pipe', 'pipe', 'pipe'] });
  const responses = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined) responses.set(msg.id, msg);
      } catch {
        /* ignore */
      }
    }
  });
  const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
  const wait = async (id, ms = 20_000) => {
    const until = Date.now() + ms;
    while (!responses.has(id) && Date.now() < until && child.exitCode === null) await sleep(100);
    return responses.get(id) ?? null;
  };
  try {
    send({
      method: 'initialize',
      id: 1,
      params: { clientInfo: { name: 'remyral-compat', title: null, version: '0.0.0' } },
    });
    const init = await wait(1);
    send({ method: 'initialized' });
    send({
      method: 'thread/start',
      id: 2,
      params: { cwd: ws, sandbox: 'workspace-write', approvalPolicy: 'untrusted', ephemeral: true },
    });
    const thread = await wait(2);
    return { init, thread, ws };
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
  }
}
async function codexSandbox(bin) {
  const ws = mkdtempSync(join(SCRATCH, 'codex-sbx-'));
  // CODEX_HOME must not live under /tmp: on Linux Codex refuses to create its helper aliases there
  // ("Refusing to create helper binaries under temporary dir") and bwrap then cannot exec
  // codex-linux-sandbox (fails closed). Per-run directory in the real home, removed afterwards.
  const codexHome = mkdtempSync(join(homedir(), '.remyral-compat-codex-'));
  const env = isolatedEnv({ CODEX_HOME: codexHome });
  try {
    return await codexSandboxIn(bin, ws, env);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
}
async function codexSandboxIn(bin, ws, env) {
  // A path in the real home directory (the isolated HOME lives under $TMPDIR, which the workspace
  // profile deliberately leaves writable). Removed again below if the sandbox let the write through.
  const outside = join(homedir(), `.remyral-compat-sandbox-probe-${randomBytes(4).toString('hex')}`);
  const run = (profile, cmd) =>
    exec(bin, ['sandbox', '-P', profile, '-C', ws, '--', ...cmd], { env, cwd: ws });
  const inCwd = await run(':workspace', ['touch', join(ws, 'inside.txt')]);
  const out = { inCwd, failClosed: false };
  if (inCwd.code !== 0 && /namespace|bwrap|userns/i.test(inCwd.stderr)) {
    out.failClosed = !existsSync(join(ws, 'inside.txt'));
    out.reason =
      inCwd.stderr
        .split('\n')
        .find((l) => /namespace|bwrap|userns/i.test(l))
        ?.trim() ?? '';
    return out;
  }
  out.inCwdOk = inCwd.code === 0 && existsSync(join(ws, 'inside.txt'));
  const home = await run(':workspace', ['touch', outside]);
  out.homeDenied = home.code !== 0 && !existsSync(outside);
  rmSync(outside, { force: true });
  const net = await run(':workspace', [
    process.execPath,
    '-e',
    "fetch('https://example.com').then(()=>process.exit(0)).catch(e=>{console.log(e.cause?.code??e.message);process.exit(3)})",
  ]);
  out.netDenied = net.code !== 0;
  out.netEvidence = (net.stdout + net.stderr).trim().split('\n')[0];
  const ro = await run(':read-only', ['touch', join(ws, 'ro.txt')]);
  out.roDenied = ro.code !== 0 && !existsSync(join(ws, 'ro.txt'));
  const tmpProbe = join(
    platform() === 'darwin' ? '/private/tmp' : '/tmp',
    `remyral-compat-${randomBytes(4).toString('hex')}`,
  );
  const tmp = await run(':workspace', ['touch', tmpProbe]);
  out.tmpWritable = tmp.code === 0 && existsSync(tmpProbe);
  rmSync(tmpProbe, { force: true });
  return out;
}
async function codex() {
  const R = 'codex';
  const bin = which('codex');
  if (!bin) return record(R, 'installed', 'FAIL', '`codex` not on PATH');
  await versionCheck(R, bin);
  await guarded(R, 'app-server stdio handshake without auth (initialize → thread/start)', async () => {
    const { init, thread, ws } = await appServerHandshake(bin);
    const t = thread?.result?.thread;
    const ok = init?.result !== undefined && t !== undefined && JSON.stringify(thread.result).includes(ws);
    record(
      R,
      'app-server stdio handshake without auth (initialize → thread/start)',
      ok ? 'PASS' : 'FAIL',
      `initialize ${init?.result ? 'ok' : JSON.stringify(init?.error ?? null)}; thread/start ${t ? `thread with requested cwd=${String(JSON.stringify(thread.result).includes(ws))}` : JSON.stringify(thread?.error ?? null)}`,
    );
  });
  await guarded(R, 'OS sandbox (codex sandbox -P :workspace / :read-only)', async () => {
    const s = await codexSandbox(bin);
    const name = 'OS sandbox (codex sandbox -P :workspace / :read-only)';
    if ('reason' in s) {
      record(
        R,
        name,
        s.failClosed ? 'UNSUPPORTED' : 'FAIL',
        `${s.failClosed ? 'fails CLOSED (command not run)' : 'command ran without sandbox!'}: ${s.reason}`,
      );
      return;
    }
    const ok = s.inCwdOk && s.homeDenied && s.netDenied && s.roDenied;
    record(
      R,
      name,
      ok ? 'PASS' : 'FAIL',
      `write cwd ${s.inCwdOk ? 'ok' : 'FAILED'}; write $HOME ${s.homeDenied ? 'denied' : 'ALLOWED'}; network ${s.netDenied ? `denied (${s.netEvidence})` : 'ALLOWED'}; :read-only write ${s.roDenied ? 'denied' : 'ALLOWED'}; /tmp outside ws ${s.tmpWritable ? 'writable (known caveat)' : 'denied'}`,
    );
  });
  needsCreds(R, [
    'T2 turn/start notification sequence',
    'T3 approval round trip',
    'T4 interrupt + orphan check',
    'T5 resume',
    'T6 token usage',
    'T7 secret hygiene',
  ]);
}

// ------------------------------------------------------------------ Pi
async function pi() {
  const R = 'pi';
  const bin = which('pi');
  if (!bin) return record(R, 'installed', 'FAIL', '`pi` not on PATH');
  await versionCheck(R, bin);
  await guarded(
    R,
    'RPC framing on an idle session (get_state, get_session_stats, get_commands, malformed, U+2028/2029, EOF)',
    async () => {
      const name =
        'RPC framing on an idle session (get_state, get_session_stats, get_commands, malformed, U+2028/2029, EOF)';
      const env = isolatedEnv();
      const child = spawn(bin, ['--mode', 'rpc', '--offline', '--no-session'], {
        env,
        cwd: SCRATCH,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const lines = [];
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d;
        // Split on LF only: U+2028/2029 inside JSON strings must not end a record (pi.md §9).
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          lines.push(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      const exited = new Promise((r) => child.on('close', (code) => r(code)));
      const send = (s) => child.stdin.write(`${s}\n`);
      send(JSON.stringify({ id: 'a', type: 'get_state' }));
      send(JSON.stringify({ id: 'b', type: 'get_session_stats' }));
      send(JSON.stringify({ id: 'c', type: 'get_commands' }));
      send('{this is not json');
      send(JSON.stringify({ id: SEP_ID, type: 'get_state' }));
      const until = Date.now() + 20_000;
      const parsed = () =>
        lines
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      while (Date.now() < until && parsed().filter((m) => m.type === 'response').length < 5) await sleep(100);
      child.stdin.end();
      const code = await Promise.race([exited, sleep(10_000).then(() => 'timeout')]);
      if (code === 'timeout') child.kill('SIGKILL');
      const msgs = parsed();
      const resp = (id) => msgs.find((m) => m.type === 'response' && m.id === id);
      const parseErr = msgs.find(
        (m) => m.type === 'response' && m.command === 'parse' && m.success === false,
      );
      const ok =
        resp('a')?.success &&
        resp('b')?.success &&
        resp('c')?.success &&
        parseErr &&
        resp(SEP_ID)?.success &&
        code === 0;
      record(
        R,
        name,
        ok ? 'PASS' : 'FAIL',
        `get_state ${String(resp('a')?.success)}, get_session_stats ${String(resp('b')?.success)} (tokens ${JSON.stringify(resp('b')?.data?.tokens ?? null)}), get_commands ${String(resp('c')?.success)}, malformed → parse error ${String(Boolean(parseErr))}, U+2028/2029 id echoed ${String(Boolean(resp(SEP_ID)))}, stdin EOF → exit ${String(code)}`,
      );
    },
  );
  needsCreds(R, [
    'prompt/streaming, steer, follow-up',
    'approval gate extension',
    'abort mid-bash + process tree',
    'resume + cost',
  ]);
}

// ------------------------------------------------------------------ OpenCode
async function opencode() {
  const R = 'opencode';
  const bin = which('opencode');
  if (!bin) return record(R, 'installed', 'FAIL', '`opencode` not on PATH');
  await versionCheck(R, bin);
  const base = { OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1' };
  const basic = (u, p) => ({ authorization: `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}` });

  await guarded(R, 'serve without a password is FAIL-OPEN (documented; adapter must refuse)', async () => {
    const port = await freePort();
    const s = startServer(
      bin,
      ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--pure'],
      isolatedEnv(base),
    );
    try {
      const up = await waitHttp(`http://127.0.0.1:${String(port)}/global/health`, s.child, 45_000);
      const anon = await httpStatus(`http://127.0.0.1:${String(port)}/global/health`);
      const warned = /password|unsecured|not secured|auth/i.test(s.output());
      record(
        R,
        'serve without a password is FAIL-OPEN (documented; adapter must refuse)',
        up && anon.status === 200 ? 'PASS' : 'FAIL',
        `anonymous GET /global/health → ${String(anon.status)}; warning printed ${String(warned)}`,
      );
    } finally {
      await s.stop();
    }
  });

  await guarded(
    R,
    'serve with password: loopback bind, Basic auth 401/401/401/200, custom username, /doc',
    async () => {
      const name = 'serve with password: loopback bind, Basic auth 401/401/401/200, custom username, /doc';
      const port = await freePort();
      const pw = randomBytes(18).toString('base64url');
      const s = startServer(
        bin,
        ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--pure'],
        isolatedEnv({ ...base, OPENCODE_SERVER_PASSWORD: pw }),
      );
      const u = `http://127.0.0.1:${String(port)}`;
      try {
        const up = await waitHttp(`${u}/global/health`, s.child, 45_000);
        const addrs = await listenAddrs(port);
        const anon = (await httpStatus(`${u}/global/health`)).status;
        const wrongPw = (await httpStatus(`${u}/global/health`, basic('opencode', `${pw}x`))).status;
        const wrongUser = (await httpStatus(`${u}/global/health`, basic('someone', pw))).status;
        const good = await httpStatus(`${u}/global/health`, basic('opencode', pw));
        const doc = await httpStatus(`${u}/doc`, basic('opencode', pw));
        const isOpenApi = /"openapi"\s*:/.test(doc.body);
        const ok =
          up &&
          addrs.length > 0 &&
          addrs.every((a) => a === '127.0.0.1') &&
          anon === 401 &&
          wrongPw === 401 &&
          wrongUser === 401 &&
          good.status === 200 &&
          versionOf(good.body) === PINS[R] &&
          isOpenApi;
        record(
          R,
          name,
          ok ? 'PASS' : 'FAIL',
          `listen ${addrs.join(',') || 'none'}; anon ${String(anon)}, wrong pw ${String(wrongPw)}, wrong user ${String(wrongUser)}, correct ${String(good.status)} (version ${String(versionOf(good.body))}); /doc ${String(doc.status)} OpenAPI ${String(isOpenApi)} ${isOpenApi ? '' : doc.body.slice(0, 80)}`,
        );
      } finally {
        await s.stop();
      }
      const port2 = await freePort();
      const s2 = startServer(
        bin,
        ['serve', '--hostname', '127.0.0.1', '--port', String(port2), '--pure'],
        isolatedEnv({ ...base, OPENCODE_SERVER_PASSWORD: pw, OPENCODE_SERVER_USERNAME: 'remyral' }),
      );
      try {
        const u2 = `http://127.0.0.1:${String(port2)}`;
        await waitHttp(`${u2}/global/health`, s2.child, 45_000);
        const custom = (await httpStatus(`${u2}/global/health`, basic('remyral', pw))).status;
        const dflt = (await httpStatus(`${u2}/global/health`, basic('opencode', pw))).status;
        record(
          R,
          'OPENCODE_SERVER_USERNAME honoured',
          custom === 200 && dflt === 401 ? 'PASS' : 'FAIL',
          `custom user ${String(custom)}, default user ${String(dflt)}`,
        );
      } finally {
        await s2.stop();
      }
    },
  );
  needsCreds(R, [
    'prompt_async + SSE + permission.asked',
    'mid-run abort + orphan check',
    'resume after restart',
    'password visible to bash tool',
  ]);
}

const RUNTIMES = { 'claude-code': claudeCode, codex, pi, opencode };
try {
  for (const [name, fn] of Object.entries(RUNTIMES)) {
    if (ONLY && !ONLY.has(name)) continue;
    await fn();
  }
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}
const summary = {
  platform: `${platform()}/${arch()}`,
  node: process.versions.node,
  checkedAt: new Date().toISOString(),
  results,
};
if (opts.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
