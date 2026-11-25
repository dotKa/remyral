#!/usr/bin/env node
/* global fetch, setTimeout, clearTimeout, URLSearchParams */
// Local fleet end-to-end test: a real master, a TLS-terminating proxy, one Linux worker in a Docker
// container and one worker process on this machine (docs/ops/local-fleet-test.md).
//
//   pnpm e2e:fleet [--skip-build] [--no-host-worker] [--keep-logs]
//
// Needs the dev stack (`pnpm dev:up`), Docker, `openssl` and the repo `.env`. Uses its own ports
// (master 8180, proxy 8443), the throw-away database `remyral_e2e_fleet` (dropped + recreated) and Redis
// logical DB 14 (flushed) — never the `remyral` dev database, never a running dev master. Everything it
// starts (master, proxy, containers, volumes, host worker, DB) is removed at the end, also on failure.
// Secrets (DB/Redis URLs, passwords, TOTP secrets, pairing codes) are passed to children, never printed.
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { randomBytes, createHmac } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  cpSync,
} from 'node:fs';
import { connect } from 'node:net';
import { arch as hostArch, platform as hostPlatform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ensureDevCa } from './dev-ca.mjs';
import { startTlsProxy } from './tls-proxy.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const { values: opts } = parseArgs({
  options: {
    'skip-build': { type: 'boolean', default: false },
    'no-host-worker': { type: 'boolean', default: false },
    'keep-logs': { type: 'boolean', default: false },
  },
});

const MASTER_PORT = Number(process.env.E2E_FLEET_MASTER_PORT ?? 8180);
const PROXY_PORT = Number(process.env.E2E_FLEET_PROXY_PORT ?? 8443);
const DB_NAME = 'remyral_e2e_fleet';
const REDIS_DB = '/14';
const IMAGE = 'remyral-worker-dev:e2e';
const RUN_ID = randomBytes(3).toString('hex');
const MASTER = `http://127.0.0.1:${String(MASTER_PORT)}`;
const BUNDLE = join(ROOT, 'apps/worker/dist/remyral-worker.mjs');

// ---------------------------------------------------------------- reporting

const results = [];
const t0 = Date.now();
function log(msg) {
  process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}\n`);
}
async function check(name, fn) {
  const start = Date.now();
  try {
    const detail = (await fn()) ?? '';
    results.push({ name, ok: true, detail: String(detail), ms: Date.now() - start });
    log(`PASS ${name}${detail ? ` — ${String(detail)}` : ''}`);
  } catch (err) {
    results.push({
      name,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      ms: Date.now() - start,
    });
    log(`FAIL ${name} — ${err instanceof Error ? err.message : String(err)}`);
    throw new StepFailed(name);
  }
}
class StepFailed extends Error {}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function printTable() {
  const w = Math.max(...results.map((r) => r.name.length), 4);
  const lines = [`\n${'RESULT'.padEnd(6)}  ${'CHECK'.padEnd(w)}  TIME     DETAIL`];
  for (const r of results) {
    lines.push(
      `${(r.ok ? 'PASS' : 'FAIL').padEnd(6)}  ${r.name.padEnd(w)}  ${`${(r.ms / 1000).toFixed(1)}s`.padStart(7)}  ${r.detail.slice(0, 110)}`,
    );
  }
  const failed = results.filter((r) => !r.ok).length;
  lines.push(
    `\n${failed === 0 ? 'PASS' : 'FAIL'}: ${String(results.length - failed)}/${String(results.length)} checks passed`,
  );
  process.stdout.write(`${lines.join('\n')}\n`);
}

// ---------------------------------------------------------------- processes

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs a command to completion; never uses a shell. */
function run(cmd, args, { env, cwd = ROOT, timeoutMs = 600_000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}
async function must(cmd, args, o) {
  const r = await run(cmd, args, o);
  if (r.code !== 0) {
    throw new Error(
      `${cmd} ${args.slice(0, 3).join(' ')} … exited ${String(r.code)}: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`,
    );
  }
  return r;
}

/** Long-running child with output appended to a log file (and optionally scanned line by line). */
function startLogged(name, cmd, args, { env, onLine } = {}) {
  const out = createWriteStream(join(LOG_DIR, `${name}.log`), { flags: 'a' });
  const child = spawn(cmd, args, { cwd: ROOT, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  const feed = (d) => {
    out.write(d);
    if (!onLine) return;
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  return { child, exited, name };
}
async function stopChild(p, ms = 10_000) {
  if (p.child.exitCode !== null || p.child.signalCode !== null) return;
  p.child.kill('SIGTERM');
  const t = sleep(ms).then(() => 'timeout');
  if ((await Promise.race([p.exited, t])) === 'timeout') p.child.kill('SIGKILL');
  await p.exited;
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = connect(port, '127.0.0.1');
    s.once('connect', () => {
      s.destroy();
      resolve(false);
    });
    s.once('error', () => resolve(true));
  });
}
async function waitFor(desc, fn, { timeoutMs = 60_000, intervalMs = 1_000 } = {}) {
  const until = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() > until) {
      throw new Error(
        `timed out after ${String(timeoutMs / 1000)}s waiting for ${desc}${last ? ` (${last.message})` : ''}`,
      );
    }
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------- TOTP (RFC 6238, as apps/web/e2e/totp.ts)

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(s) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of s.replace(/[\s=-]/g, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
function hotp(key, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(msg).digest();
  const off = mac[mac.length - 1] & 0x0f;
  return ((mac.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}
class Authenticator {
  #last = -1;
  constructor(secret) {
    this.key = base32Decode(secret);
  }
  async nextCode() {
    const now = () => Math.floor(Date.now() / 30_000);
    let step = Math.max(now(), this.#last + 1);
    while (step > now() + 1) {
      await sleep(1_000);
      step = Math.max(now(), this.#last + 1);
    }
    this.#last = step;
    return hotp(this.key, step);
  }
}

// ---------------------------------------------------------------- console-equivalent REST client

class Console {
  #cookies = new Map();
  #stepUpAt = 0;
  authenticator = null;

  async req(method, path, body) {
    const headers = { 'user-agent': 'remyral-e2e-fleet' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const csrf = this.#cookies.get('__Host-ras-csrf');
    if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
    if (this.#cookies.size > 0) headers.cookie = [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${MASTER}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair = ''] = c.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (value === '' || /max-age=0/i.test(c)) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const err = new Error(`${method} ${path} → HTTP ${String(res.status)} ${json.error ?? ''}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }
  get(path) {
    return this.req('GET', path);
  }
  post(path, body) {
    return this.req('POST', path, body);
  }
  /** Privileged call: fresh TOTP step-up when the last one is older than 8 minutes (master allows 10). */
  async privileged(path, body) {
    if (Date.now() - this.#stepUpAt > 8 * 60_000) {
      await this.post('/auth/step-up', { code: await this.authenticator.nextCode() });
      this.#stepUpAt = Date.now();
    }
    return this.post(path, body);
  }
  async worker(id) {
    return this.get(`/workers/${id}`);
  }
  async workers() {
    return (await this.get('/workers')).workers;
  }
  async auditCount(action, target) {
    const q = new URLSearchParams({ action, target, limit: '200' });
    return (await this.get(`/audit?${q.toString()}`)).items.length;
  }
}

// ---------------------------------------------------------------- environment

if (existsSync(join(ROOT, '.env')) && (!process.env.DATABASE_URL || !process.env.REDIS_URL)) {
  process.loadEnvFile(join(ROOT, '.env'));
}
for (const name of ['DATABASE_URL', 'REDIS_URL', 'TOTP_KEY_FILE']) {
  if (!process.env[name]) {
    console.error(`${name} is not set; run \`pnpm dev:keygen && pnpm dev:up\` and keep the repo .env`);
    process.exit(2);
  }
}
const dbUrl = new URL(process.env.DATABASE_URL);
dbUrl.pathname = `/${DB_NAME}`;
const adminDbUrl = new URL(process.env.DATABASE_URL);
adminDbUrl.pathname = '/postgres';
const redisUrl = new URL(process.env.REDIS_URL);
redisUrl.pathname = REDIS_DB;
const totpKeyFile = process.env.TOTP_KEY_FILE.startsWith('/')
  ? process.env.TOTP_KEY_FILE
  : join(ROOT, process.env.TOTP_KEY_FILE);

const WORK = mkdtempSync(join(tmpdir(), 'remyral-e2e-fleet-'));
const LOG_DIR = join(WORK, 'logs');
mkdirSync(LOG_DIR, { mode: 0o700 });
const TLS_DIR = join(WORK, 'tls');

const cleanups = [];
const defer = (name, fn) => cleanups.push({ name, fn });
async function cleanup() {
  while (cleanups.length > 0) {
    const c = cleanups.pop();
    try {
      await c.fn();
    } catch (err) {
      log(`cleanup ${c.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
let interrupted = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (interrupted) return;
    interrupted = true;
    log(`${sig}: cleaning up`);
    void cleanup().finally(() => process.exit(130));
  });
}

async function masterModules() {
  const dist = new URL('apps/master/dist/', `file://${ROOT}`);
  const [pool, migrate, redis, audit, admin] = await Promise.all([
    import(new URL('db/pool.js', dist).href),
    import(new URL('db/migrate.js', dist).href),
    import(new URL('redis.js', dist).href),
    import(new URL('audit/audit.js', dist).href),
    import(new URL('cli/admin.js', dist).href),
  ]);
  return {
    createPool: pool.createPool,
    migrate: migrate.migrate,
    createRedis: redis.createRedis,
    AuditLog: audit.AuditLog,
    createUser: admin.createUser,
  };
}

async function recreateDb(m) {
  const admin = m.createPool({ connectionString: adminDbUrl.toString(), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
  } finally {
    await admin.end();
  }
  const pool = m.createPool({ connectionString: dbUrl.toString(), max: 2 });
  try {
    await m.migrate(pool);
  } finally {
    await pool.end();
  }
}
async function dropDb(m) {
  const admin = m.createPool({ connectionString: adminDbUrl.toString(), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
async function flushRedis(m) {
  if (['', '/', '/0'].includes(redisUrl.pathname)) throw new Error('refusing to flush Redis DB 0');
  const r = m.createRedis(redisUrl.toString(), 'remyral-e2e-fleet');
  await r.connect();
  await r.flushdb();
  r.disconnect();
}

// ---------------------------------------------------------------- worker helpers

const PAIR_CODE = /Pairing code:\s+([A-Z0-9]{4}-[A-Z0-9]{4})/;
const FINGERPRINT = /Fingerprint:\s+(SHA256:[0-9A-F-]+)/;
const APPROVED = /Approved: this machine is worker (wrk_[A-Za-z0-9_-]+)/;

/**
 * Starts `pair`, reads code + fingerprint from its output, then approves the matching pending worker
 * exactly as the console does: find it in GET /workers, compare the fingerprint, step-up, approve.
 */
async function pairAndApprove(c, label, startPair) {
  let code = null;
  let fingerprint = null;
  let approvedId = null;
  const proc = startPair((line) => {
    code ??= PAIR_CODE.exec(line)?.[1] ?? null;
    fingerprint ??= FINGERPRINT.exec(line)?.[1] ?? null;
    approvedId ??= APPROVED.exec(line)?.[1] ?? null;
  });
  defer(`${label} pair process`, () => stopChild(proc, 3_000));
  await waitFor(`${label}: pairing code + fingerprint on the worker's stdout`, () => code && fingerprint, {
    timeoutMs: 60_000,
    intervalMs: 250,
  });
  const pending = await waitFor(
    `${label}: pending enrollment in GET /workers`,
    async () => (await c.workers()).find((w) => w.state === 'pending' && w.fingerprint === fingerprint),
    { timeoutMs: 30_000 },
  );
  assert(
    pending.fingerprint === fingerprint,
    'fingerprint shown in Fleet differs from the one on the worker',
  );
  await c.privileged(`/workers/${pending.id}/approve`, { pairingCode: code });
  const exit = await Promise.race([proc.exited, sleep(30_000).then(() => null)]);
  assert(exit !== null, `${label}: pair process did not exit after approval`);
  assert(exit.code === 0, `${label}: pair exited with ${String(exit.code)}`);
  assert(
    approvedId === pending.id,
    `${label}: worker printed ${String(approvedId)}, Fleet approved ${pending.id}`,
  );
  return { id: pending.id, fingerprint };
}

async function waitState(c, id, desc, pred, timeoutMs = 60_000) {
  return waitFor(
    desc,
    async () => {
      const w = await c.worker(id);
      return pred(w) ? w : null;
    },
    { timeoutMs },
  );
}
const isOnline = (w) => w.connected && ['online', 'busy'].includes(w.state);

// ---------------------------------------------------------------- main flow

const dockerArch = { arm64: 'arm64', aarch64: 'arm64', amd64: 'x64', x86_64: 'x64' };
let m;
let exitCode = 0;
try {
  log(`run ${RUN_ID}; work dir ${WORK}`);

  await check('preflight: docker, ports, dev stack', async () => {
    const v = await must('docker', ['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}']);
    for (const port of [MASTER_PORT, PROXY_PORT]) {
      assert(await portFree(port), `port ${String(port)} on 127.0.0.1 is in use`);
    }
    return `docker server ${v.stdout.trim()}; ports ${String(MASTER_PORT)}/${String(PROXY_PORT)} free`;
  });
  const serverPlatform = (
    await must('docker', ['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'])
  ).stdout.trim();
  const expectedContainerArch = dockerArch[serverPlatform.split('/')[1]] ?? serverPlatform.split('/')[1];

  if (!opts['skip-build']) {
    await check('build master + worker bundle', async () => {
      await must('pnpm', ['--filter', '@remyral/master...', 'build']);
      await must('pnpm', ['--filter', '@remyral/worker', 'bundle']);
      return 'apps/master/dist, apps/worker/dist/remyral-worker.mjs';
    });
  }
  m = await masterModules();

  await check(`throw-away database ${DB_NAME} + Redis DB ${REDIS_DB.slice(1)}`, async () => {
    await recreateDb(m);
    await flushRedis(m);
    defer('drop database', () => dropDb(m));
    defer('flush redis', () => flushRedis(m));
    return 'recreated and migrated';
  });

  let master;
  await check(`master on 127.0.0.1:${String(MASTER_PORT)}`, async () => {
    master = startLogged('master', process.execPath, ['apps/master/dist/main.js'], {
      env: {
        ...process.env,
        NODE_ENV: 'development',
        MASTER_HOST: '127.0.0.1',
        MASTER_PORT: String(MASTER_PORT),
        DATABASE_URL: dbUrl.toString(),
        REDIS_URL: redisUrl.toString(),
        TOTP_KEY_FILE: totpKeyFile,
        LOG_LEVEL: 'info',
        TRUST_PROXY_HOPS: '0',
      },
    });
    defer('stop master', () => stopChild(master, 15_000));
    await waitFor('master /readyz', async () => (await fetch(`${MASTER}/readyz`)).ok, {
      timeoutMs: 30_000,
      intervalMs: 300,
    });
    return 'ready';
  });

  let proxy;
  await check(`TLS proxy 127.0.0.1:${String(PROXY_PORT)} (dev CA, SAN host.docker.internal)`, async () => {
    const ca = ensureDevCa(TLS_DIR);
    proxy = await startTlsProxy({
      cert: ca.serverCert,
      key: ca.serverKey,
      listen: `127.0.0.1:${String(PROXY_PORT)}`,
      target: `127.0.0.1:${String(MASTER_PORT)}`,
    });
    defer('stop TLS proxy', () => proxy.close());
    // Verification on, trusting only the dev CA: a container talks to the master like a remote node would.
    const r = await must('docker', [
      'run',
      '--rm',
      '-v',
      `${ca.caCert}:/ca.pem:ro`,
      '-e',
      'NODE_EXTRA_CA_CERTS=/ca.pem',
      '--entrypoint',
      'node',
      'node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205',
      '-e',
      `fetch('https://host.docker.internal:${String(PROXY_PORT)}/healthz').then(r=>console.log(r.status)).catch(e=>{console.log(e.cause?.code??e.message);process.exit(1)})`,
    ]);
    assert(r.stdout.trim() === '200', `container → proxy → master /healthz gave ${r.stdout.trim()}`);
    const bad = await run('docker', [
      'run',
      '--rm',
      '--entrypoint',
      'node',
      'node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205',
      '-e',
      `fetch('https://host.docker.internal:${String(PROXY_PORT)}/healthz').then(r=>console.log(r.status)).catch(e=>console.log(e.cause?.code??e.message))`,
    ]);
    assert(
      /UNABLE_TO_VERIFY|SELF_SIGNED|CERT/.test(bad.stdout),
      `without the CA the TLS handshake must fail (got ${bad.stdout.trim()})`,
    );
    return 'container reaches wss://host.docker.internal; untrusted without the CA';
  });

  const c = new Console();
  await check('owner account: create, login, TOTP enrollment', async () => {
    const pool = m.createPool({ connectionString: dbUrl.toString(), max: 1 });
    const username = `e2e-fleet-${RUN_ID}`;
    const password = `Pw-${randomBytes(18).toString('base64url')}`;
    try {
      await m.createUser({ pool, audit: new m.AuditLog(pool) }, { username, role: 'owner', password });
    } finally {
      await pool.end();
    }
    const login = await c.post('/auth/login', { username, password });
    assert(login.status === 'enrollment_required', `login status ${String(login.status)}`);
    const start = await c.post('/auth/totp/enroll/start');
    c.authenticator = new Authenticator(String(start.secret));
    const confirm = await c.post('/auth/totp/enroll/confirm', { code: await c.authenticator.nextCode() });
    assert(confirm.status === 'authenticated', 'enrollment did not authenticate the session');
    return 'owner enrolled; session authenticated';
  });

  // ---------------- container worker
  await check('build container image', async () => {
    await must('docker', [
      'build',
      '-q',
      '-f',
      'infra/dev/docker-worker/Dockerfile',
      '--build-context',
      'bundle=apps/worker/dist',
      '-t',
      IMAGE,
      'infra/dev/docker-worker',
    ]);
    return IMAGE;
  });

  const volume = `remyral-e2e-fleet-data-${RUN_ID}`;
  const cfgDir = join(WORK, 'container');
  mkdirSync(cfgDir, { mode: 0o700 });
  const cfgFile = join(cfgDir, 'config.json');
  writeFileSync(
    cfgFile,
    `${JSON.stringify({ masterUrl: `wss://host.docker.internal:${String(PROXY_PORT)}`, workspaceRoot: '/srv/remyral/workspaces', dataDir: '/var/lib/remyral-worker' }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const caCertPath = join(TLS_DIR, 'ca.pem');
  await must('docker', ['volume', 'create', volume]);
  defer('remove volume', () => run('docker', ['volume', 'rm', '-f', volume]));
  const containerArgs = (name) => [
    '--name',
    name,
    '--label',
    `remyral-e2e-fleet=${RUN_ID}`,
    '-v',
    `${volume}:/var/lib/remyral-worker`,
    '-v',
    `${cfgFile}:/etc/remyral-worker/config.json:ro`,
    '-v',
    `${caCertPath}:/etc/remyral-worker/ca.pem:ro`,
    '-e',
    'NODE_EXTRA_CA_CERTS=/etc/remyral-worker/ca.pem',
  ];
  defer('remove containers', async () => {
    const ids = (await run('docker', ['ps', '-aq', '--filter', `label=remyral-e2e-fleet=${RUN_ID}`])).stdout
      .split(/\s+/)
      .filter(Boolean);
    if (ids.length > 0) await run('docker', ['rm', '-f', ...ids]);
  });

  let cw;
  await check('container worker: pair + approve (code + fingerprint + step-up)', async () => {
    cw = await pairAndApprove(c, 'container', (onLine) =>
      startLogged(
        'container-pair',
        'docker',
        ['run', '--rm', ...containerArgs(`remyral-e2e-pair-${RUN_ID}`), IMAGE, 'pair'],
        { onLine },
      ),
    );
    return `${cw.id} ${cw.fingerprint.slice(0, 22)}…`;
  });

  const cName = `remyral-e2e-worker-${RUN_ID}`;
  const startContainer = () => must('docker', ['run', '-d', ...containerArgs(cName), IMAGE, 'run']);
  await check('container worker: run → online, linux facts, capabilities', async () => {
    await startContainer();
    const w = await waitState(c, cw.id, 'container worker online', isOnline, 60_000);
    assert(w.os === 'linux', `os ${String(w.os)}`);
    assert(w.arch === expectedContainerArch, `arch ${String(w.arch)} != ${expectedContainerArch}`);
    const d = await waitState(
      c,
      cw.id,
      'capabilities + heartbeat',
      (x) => x.capabilitiesAt !== null && x.load !== null,
      60_000,
    );
    assert(d.runtimes.length === 5, `expected 5 runtime reports, got ${String(d.runtimes.length)}`);
    assert(
      d.tools.some((t) => t.name === 'git'),
      'git not in reported tools',
    );
    return `${w.state} ${w.os}/${w.arch} ${String(w.osVersion)}; ${String(d.runtimes.length)} runtimes, tools ${d.tools.map((t) => t.name).join(',')}`;
  });

  // ---------------- host worker (this machine)
  let hw = null;
  let hostWorker = null;
  if (!opts['no-host-worker']) {
    const hDir = join(WORK, 'host-worker');
    mkdirSync(join(hDir, 'workspaces'), { recursive: true, mode: 0o700 });
    const hCfg = join(hDir, 'config.json');
    writeFileSync(
      hCfg,
      `${JSON.stringify({ masterUrl: `wss://127.0.0.1:${String(PROXY_PORT)}`, workspaceRoot: join(hDir, 'workspaces'), dataDir: join(hDir, 'data') }, null, 2)}\n`,
      { mode: 0o600 },
    );
    // The worker never needs the master's secrets: pass the environment without them.
    const masterOnly = new Set([
      'DATABASE_URL',
      'REDIS_URL',
      'TOTP_KEY_FILE',
      'REMYRAL_PG_PASSWORD',
      'REMYRAL_REDIS_PASSWORD',
    ]);
    const hEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !masterOnly.has(k))),
      NODE_EXTRA_CA_CERTS: caCertPath,
    };
    await check(`host worker (${hostPlatform()}/${hostArch()}): pair + approve`, async () => {
      hw = await pairAndApprove(c, 'host', (onLine) =>
        startLogged('host-pair', process.execPath, [BUNDLE, 'pair', '--config', hCfg], { env: hEnv, onLine }),
      );
      return `${hw.id} ${hw.fingerprint.slice(0, 22)}…`;
    });
    await check('host worker: run → online; two workers on different OS online at once', async () => {
      hostWorker = startLogged('host-worker', process.execPath, [BUNDLE, 'run', '--config', hCfg], {
        env: hEnv,
      });
      defer('stop host worker', () => stopChild(hostWorker));
      const w = await waitState(c, hw.id, 'host worker online', isOnline, 60_000);
      const expectOs =
        { darwin: 'darwin', linux: 'linux', win32: 'windows' }[hostPlatform()] ?? hostPlatform();
      assert(w.os === expectOs && w.arch === hostArch(), `facts ${String(w.os)}/${String(w.arch)}`);
      await waitState(c, hw.id, 'host capabilities', (x) => x.capabilitiesAt !== null, 90_000);
      const online = (await c.workers()).filter(isOnline);
      assert(online.length === 2, `${String(online.length)} workers online`);
      assert(
        new Set(online.map((x) => `${x.os}/${x.arch}`)).size === 2,
        'both workers report the same os/arch',
      );
      return online.map((x) => `${x.os}/${x.arch}`).join(' + ');
    });
  }

  // ---------------- chaos on the container worker
  await check('chaos: docker pause → offline (heartbeat loss) → unpause → online', async () => {
    const sessionsBefore = await c.auditCount('worker.session.start', cw.id);
    await must('docker', ['pause', cName]);
    const t = Date.now();
    await waitState(c, cw.id, 'offline after pause', (w) => !w.connected && !isOnline(w), 120_000);
    const offlineAfter = Math.round((Date.now() - t) / 1000);
    await must('docker', ['unpause', cName]);
    const t2 = Date.now();
    await waitState(c, cw.id, 'online after unpause', isOnline, 120_000);
    const sessionsAfter = await c.auditCount('worker.session.start', cw.id);
    assert(sessionsAfter > sessionsBefore, 'no new authenticated session after unpause');
    return `offline after ${String(offlineAfter)}s, online again ${String(Math.round((Date.now() - t2) / 1000))}s after unpause (new session)`;
  });

  await check('chaos: kill + remove container, new container on same volume → same identity', async () => {
    const before = await c.workers();
    const sessionsBefore = await c.auditCount('worker.session.start', cw.id);
    await must('docker', ['kill', cName]);
    await must('docker', ['rm', '-f', cName]);
    await waitState(c, cw.id, 'offline after kill', (w) => !w.connected, 120_000);
    await startContainer();
    const w = await waitState(c, cw.id, 'online after restart', isOnline, 90_000);
    assert(w.fingerprint === cw.fingerprint, 'fingerprint changed');
    const after = await c.workers();
    assert(
      after.length === before.length,
      `worker count changed ${String(before.length)} → ${String(after.length)}`,
    );
    assert(
      (await c.auditCount('worker.session.start', cw.id)) > sessionsBefore,
      'no new challenge-authenticated session',
    );
    return `${cw.id} back online with the same key, no new enrollment`;
  });

  await check('drain: state draining, intent kept, still connected', async () => {
    const w = await c.privileged(`/workers/${cw.id}/drain`, { reason: 'e2e fleet drain' });
    assert(w.drainRequestedAt !== null, 'drainRequestedAt not set');
    const d = await waitState(c, cw.id, 'draining', (x) => x.state === 'draining' && x.connected, 30_000);
    return `state ${d.state}`;
  });

  await check('revoke: socket closed at once, quarantined', async () => {
    const t = Date.now();
    await c.privileged(`/workers/${cw.id}/revoke`, { reason: 'e2e fleet revoke' });
    const w = await waitState(c, cw.id, 'disconnected after revoke', (x) => !x.connected, 10_000);
    assert(
      w.state === 'quarantined' && w.quarantineReason === 'revoked',
      `state ${w.state}/${String(w.quarantineReason)}`,
    );
    const d = await c.worker(cw.id);
    assert(
      d.credentials.every((k) => k.status === 'revoked'),
      'a credential is not revoked',
    );
    return `disconnected within ${String(Date.now() - t)} ms; credentials revoked`;
  });

  await check('revoke: restarted container is refused, never reconnects', async () => {
    const sessionsBefore = await c.auditCount('worker.session.start', cw.id);
    await must('docker', ['restart', '-t', '2', cName]);
    await waitFor(
      'worker log shows the revocation refusal',
      async () => {
        const logs = await run('docker', ['logs', cName]);
        return /revoked/i.test(logs.stdout + logs.stderr);
      },
      { timeoutMs: 30_000 },
    );
    await sleep(5_000);
    const w = await c.worker(cw.id);
    assert(!w.connected, 'revoked worker is connected');
    assert(
      (await c.auditCount('worker.session.start', cw.id)) === sessionsBefore,
      'a session was opened for a revoked key',
    );
    return 'refused (ERROR revoked), no session';
  });

  if (hw !== null) {
    await check('host worker still online after container chaos', async () => {
      const w = await c.worker(hw.id);
      assert(isOnline(w), `host worker ${w.state} connected=${String(w.connected)}`);
      return `${w.state}`;
    });
  }
} catch (err) {
  exitCode = 1;
  if (!(err instanceof StepFailed)) {
    results.push({
      name: 'harness',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      ms: 0,
    });
    log(`harness error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
} finally {
  await cleanup();
  printTable();
  if (results.some((r) => !r.ok)) exitCode = 1;
  if (exitCode !== 0 || opts['keep-logs']) {
    const keep = join(tmpdir(), `remyral-e2e-fleet-logs-${RUN_ID}`);
    cpSync(LOG_DIR, keep, { recursive: true });
    process.stdout.write(`logs kept in ${keep} (master + worker JSON logs; no secrets)\n`);
  }
  rmSync(WORK, { recursive: true, force: true });
  process.exit(exitCode);
}
