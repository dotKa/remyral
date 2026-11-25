#!/usr/bin/env node
/* global setTimeout, clearTimeout */
// End-to-end check of the Coolify deployment bundle (infra/coolify/compose.yaml, docs/ops/deploy-coolify.md):
// the production images, the production compose file and a local stand-in for the Coolify proxy.
//
//   pnpm e2e:compose [--skip-build] [--keep]
//
// Builds apps/master + apps/web images for the native architecture, starts Traefik
// (infra/coolify/local/proxy.compose.yaml) on 127.0.0.1:18443/18080 with a dev-CA certificate for the
// production hostname (file provider, like the Cloudflare Origin Certificate in Coolify), brings up the
// compose project with throw-away volumes and random credentials, then verifies migrations, the
// non-owner runtime role, routing, security headers, the login flow, a worker over wss:// and the
// CF-Connecting-IP rules. Needs Docker and `openssl`; does not use the dev stack or the repo .env.
// Everything it creates (containers, volumes, networks, temp files) is removed at the end, also on failure
// (unless --keep). Secrets are written to 0600 files in a temp dir and never printed.
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ensureDevCa } from './dev-ca.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const { values: opts } = parseArgs({
  options: {
    'skip-build': { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
  },
});

const DOMAIN = 'console.example.org';
const HTTPS_PORT = Number(process.env.E2E_COMPOSE_HTTPS_PORT ?? 18443);
const HTTP_PORT = Number(process.env.E2E_COMPOSE_HTTP_PORT ?? 18080);
const RUN_ID = randomBytes(3).toString('hex');
const APP_PROJECT = `remyral-e2e-compose-${RUN_ID}`;
const PROXY_PROJECT = `remyral-e2e-proxy-${RUN_ID}`;
const NETWORK = `remyral-e2e-proxy-${RUN_ID}`;
const SUBNET_PREFIX = '172.31.213';
const SUBNET = `${SUBNET_PREFIX}.0/24`;
const MASTER_IMAGE = 'remyral-master:e2e';
const WEB_IMAGE = 'remyral-web:e2e';
const WORKER_IMAGE = 'remyral-worker-dev:e2e';
// node:24-bookworm-slim, same pinned digest as the Dockerfiles.
const NODE_IMAGE =
  'node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205';
const COMPOSE_FILE = join(ROOT, 'infra/coolify/compose.yaml');
const PROXY_FILE = join(ROOT, 'infra/coolify/local/proxy.compose.yaml');
// The master's helmet header set (apps/master/src/app.ts); the web image must send identical values.
const SECURITY_HEADERS = [
  'content-security-policy',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'origin-agent-cluster',
  'referrer-policy',
  'strict-transport-security',
  'x-content-type-options',
  'x-dns-prefetch-control',
  'x-download-options',
  'x-frame-options',
  'x-permitted-cross-domain-policies',
  'x-xss-protection',
];

// ---------------------------------------------------------------- reporting

const results = [];
const t0 = Date.now();
function log(msg) {
  process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}\n`);
}
class StepFailed extends Error {}
async function check(name, fn) {
  const start = Date.now();
  try {
    const detail = (await fn()) ?? '';
    results.push({ name, ok: true, detail: String(detail), ms: Date.now() - start });
    log(`PASS ${name}${detail ? ` — ${String(detail)}` : ''}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, detail, ms: Date.now() - start });
    log(`FAIL ${name} — ${detail}`);
    throw new StepFailed(name);
  }
}
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
function run(cmd, args, { timeoutMs = 900_000, input, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let buf = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      if (!onLine) return;
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
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
      `${cmd} ${args.slice(0, 4).join(' ')} … exited ${String(r.code)}: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`,
    );
  }
  return r;
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
      throw new Error(`timed out waiting for ${desc}${last ? ` (${last.message})` : ''}`);
    }
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------- work dir, secrets, TLS

const WORK = mkdtempSync(join(tmpdir(), 'remyral-e2e-compose-'));
const TLS_DIR = join(WORK, 'tls');
const PROXY_DIR = join(WORK, 'proxy');
const SECRETS_DIR = join(WORK, 'secrets');
const ENV_FILE = join(WORK, 'app.env');
const PROXY_ENV_FILE = join(WORK, 'proxy.env');

const secrets = {
  POSTGRES_SUPERUSER_PASSWORD: randomBytes(24).toString('hex'),
  REMYRAL_DB_OWNER_PASSWORD: randomBytes(24).toString('hex'),
  REMYRAL_DB_APP_PASSWORD: randomBytes(24).toString('hex'),
  REDIS_PASSWORD: randomBytes(24).toString('hex'),
};

function writeAppEnv(trustedSources) {
  const env = {
    REMYRAL_ENV: `e2e${RUN_ID}`,
    REMYRAL_DOMAIN: DOMAIN,
    PROXY_NETWORK: NETWORK,
    REMYRAL_MASTER_IMAGE: MASTER_IMAGE,
    REMYRAL_WEB_IMAGE: WEB_IMAGE,
    REMYRAL_PULL_POLICY: 'never',
    REMYRAL_SECRETS_DIR: SECRETS_DIR,
    // p10-backup-restore: the master mounts <backups>/status read-only (a /data path is not shared on macOS).
    REMYRAL_BACKUP_DIR: join(WORK, 'backups'),
    TRUSTED_CLIENT_IP_SOURCES: trustedSources,
    ...secrets,
  };
  writeFileSync(
    ENV_FILE,
    `${Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')}\n`,
    {
      mode: 0o600,
    },
  );
}

const compose = (args, o) =>
  must('docker', ['compose', '-p', APP_PROJECT, '--env-file', ENV_FILE, '-f', COMPOSE_FILE, ...args], o);
const composeRun = (args, o) =>
  run('docker', ['compose', '-p', APP_PROJECT, '--env-file', ENV_FILE, '-f', COMPOSE_FILE, ...args], o);
const proxyCompose = (args) =>
  must('docker', ['compose', '-p', PROXY_PROJECT, '--env-file', PROXY_ENV_FILE, '-f', PROXY_FILE, ...args]);
/** psql as the superuser through the postgres container's local socket (peer auth); returns trimmed stdout. */
async function sql(query) {
  const r = await compose([
    'exec',
    '-T',
    '-u',
    'postgres',
    'postgres',
    'psql',
    '-U',
    'postgres',
    '-d',
    'remyral',
    '-tAc',
    query,
  ]);
  return r.stdout.trim();
}
/** psql as the runtime role over TCP (scram), password taken from the container's own environment. */
function sqlAsApp(query) {
  return composeRun([
    'exec',
    '-T',
    'postgres',
    'sh',
    '-c',
    'PGPASSWORD="$REMYRAL_DB_APP_PASSWORD" exec psql -h 127.0.0.1 -U remyral_app -d remyral -v ON_ERROR_STOP=1 -tAc "$0"',
    query,
  ]);
}

// ---------------------------------------------------------------- HTTPS client (production hostname → local proxy)

let CA = null;
function lookupLocal(_host, options, cb) {
  if (options?.all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
  else cb(null, '127.0.0.1', 4);
}
function fetchRaw(method, path, { headers = {}, body, plain = false } = {}) {
  return new Promise((resolve, reject) => {
    const reqFn = plain ? httpRequest : httpsRequest;
    const req = reqFn(
      {
        host: DOMAIN,
        port: plain ? HTTP_PORT : HTTPS_PORT,
        method,
        path,
        headers: { host: DOMAIN, 'user-agent': 'remyral-e2e-compose', ...headers },
        lookup: lookupLocal,
        ...(plain ? {} : { ca: CA, servername: DOMAIN }),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('request timeout')));
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

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

/** The console's view: same-origin `/api/*` through the proxy, cookies + CSRF like the browser. */
class Console {
  #cookies = new Map();
  #stepUpAt = 0;
  authenticator = null;
  async req(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const csrf = this.#cookies.get('__Host-ras-csrf');
    if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
    if (this.#cookies.size > 0) headers.cookie = [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetchRaw(method, `/api${path}`, {
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookies = res.headers['set-cookie'] ?? [];
    for (const c of setCookies) {
      const [pair = ''] = c.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (value === '' || /max-age=0/i.test(c)) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
    const json = res.body ? JSON.parse(res.body) : {};
    if (res.status < 200 || res.status >= 300) {
      const err = new Error(`${method} /api${path} → HTTP ${String(res.status)} ${json.error ?? ''}`);
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
  async privileged(path, body) {
    if (Date.now() - this.#stepUpAt > 8 * 60_000) {
      await this.post('/auth/step-up', { code: await this.authenticator.nextCode() });
      this.#stepUpAt = Date.now();
    }
    return this.post(path, body);
  }
}

// ---------------------------------------------------------------- cleanup

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

/** Login attempt with an unknown user from a container on the proxy network; returns the audited IP. */
async function auditedIpFor(cfIp) {
  const marker = `cfip-${randomBytes(4).toString('hex')}`;
  const r = await must('docker', [
    'run',
    '--rm',
    '--network',
    NETWORK,
    '-v',
    `${join(TLS_DIR, 'ca.pem')}:/ca.pem:ro`,
    '-e',
    'NODE_EXTRA_CA_CERTS=/ca.pem',
    '--entrypoint',
    'node',
    NODE_IMAGE,
    '-e',
    `fetch('https://${DOMAIN}/api/auth/login',{method:'POST',headers:{'content-type':'application/json','cf-connecting-ip':'${cfIp}'},body:JSON.stringify({username:'${marker}',password:'not-the-password-0'})}).then(r=>console.log(r.status),e=>{console.log(e.cause?.code??e.message);process.exit(1)})`,
  ]);
  assert(r.stdout.trim() === '401', `login probe answered ${r.stdout.trim()}`);
  return sql(
    "SELECT ip FROM audit_events WHERE action = 'auth.login.password' AND outcome = 'failure' ORDER BY id DESC LIMIT 1",
  );
}

// ---------------------------------------------------------------- main flow

let exitCode = 0;
try {
  log(`run ${RUN_ID}; work dir ${WORK}`);
  defer('remove work dir', () => rmSync(WORK, { recursive: true, force: true }));

  await check('preflight: docker, ports', async () => {
    const v = await must('docker', ['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}']);
    for (const port of [HTTPS_PORT, HTTP_PORT]) {
      assert(await portFree(port), `port ${String(port)} on 127.0.0.1 is in use`);
    }
    return `docker ${v.stdout.trim()}; 127.0.0.1:${String(HTTPS_PORT)}/${String(HTTP_PORT)} free`;
  });

  if (!opts['skip-build']) {
    await check('build images (native arch): master, web, worker', async () => {
      await must('docker', [
        'buildx',
        'build',
        '--load',
        '-f',
        'apps/master/Dockerfile',
        '-t',
        MASTER_IMAGE,
        '.',
      ]);
      await must('docker', ['buildx', 'build', '--load', '-f', 'apps/web/Dockerfile', '-t', WEB_IMAGE, '.']);
      await must('pnpm', ['--filter', '@remyral/worker', 'bundle']);
      await must('docker', [
        'build',
        '-q',
        '-f',
        'infra/dev/docker-worker/Dockerfile',
        '--build-context',
        'bundle=apps/worker/dist',
        '-t',
        WORKER_IMAGE,
        'infra/dev/docker-worker',
      ]);
      return `${MASTER_IMAGE}, ${WEB_IMAGE}, ${WORKER_IMAGE}`;
    });
  }

  await check('image hardening: non-root, no secrets/dev files in layers', async () => {
    const user = (
      await must('docker', ['image', 'inspect', MASTER_IMAGE, '--format', '{{.Config.User}}'])
    ).stdout.trim();
    const webUser = (
      await must('docker', ['image', 'inspect', WEB_IMAGE, '--format', '{{.Config.User}}'])
    ).stdout.trim();
    assert(user === '10001:10001', `master user ${user}`);
    assert(webUser === '101:101', `web user ${webUser}`);
    const files = await must('docker', [
      'run',
      '--rm',
      '--read-only',
      '--entrypoint',
      'find',
      MASTER_IMAGE,
      '/app',
      '-maxdepth',
      '4',
      '(',
      '-name',
      '.env',
      '-o',
      '-name',
      '*.pem',
      '-o',
      '-name',
      '*.key',
      '-o',
      '-name',
      'src',
      '-o',
      '-name',
      'test',
      '-o',
      '-name',
      'typescript',
      '-o',
      '-name',
      'vitest',
      ')',
    ]);
    assert(
      files.stdout.trim() === '',
      `unexpected files in /app: ${files.stdout.trim().split('\n').slice(0, 3).join(', ')}`,
    );
    return 'master 10001, web 101; no .env/keys/src/test/devDeps under /app';
  });

  await check('TLS material, secret files, proxy network', async () => {
    const ca = ensureDevCa(TLS_DIR, { sans: [`DNS:${DOMAIN}`, 'DNS:localhost', 'IP:127.0.0.1'] });
    CA = readFileSync(ca.caCert);
    // Same layout Coolify uses: /data/coolify/proxy/{certs,dynamic} mounted at /traefik.
    mkdirSync(join(PROXY_DIR, 'certs'), { recursive: true, mode: 0o700 });
    mkdirSync(join(PROXY_DIR, 'dynamic'), { recursive: true, mode: 0o700 });
    copyFileSync(ca.serverCert, join(PROXY_DIR, 'certs', 'origin.pem'));
    copyFileSync(ca.serverKey, join(PROXY_DIR, 'certs', 'origin.key'));
    writeFileSync(
      join(PROXY_DIR, 'dynamic', 'remyral-origin-cert.yaml'),
      'tls:\n  certificates:\n    - certFile: /traefik/certs/origin.pem\n      keyFile: /traefik/certs/origin.key\n',
    );
    mkdirSync(SECRETS_DIR, { mode: 0o700 });
    writeFileSync(join(SECRETS_DIR, 'totp.key'), `${randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(
      join(SECRETS_DIR, 'lease-signing.pem'),
      privateKey.export({ format: 'pem', type: 'pkcs8' }),
      {
        mode: 0o600,
      },
    );
    writeAppEnv(SUBNET);
    writeFileSync(
      PROXY_ENV_FILE,
      [
        `E2E_PROXY_PROJECT=${PROXY_PROJECT}`,
        `E2E_APP_PROJECT=${APP_PROJECT}`,
        `PROXY_NETWORK=${NETWORK}`,
        `E2E_HTTPS_PORT=${String(HTTPS_PORT)}`,
        `E2E_HTTP_PORT=${String(HTTP_PORT)}`,
        `E2E_PROXY_DIR=${PROXY_DIR}`,
        `REMYRAL_DOMAIN=${DOMAIN}`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    await must('docker', ['network', 'create', '--subnet', SUBNET, NETWORK]);
    defer('remove network', () => run('docker', ['network', 'rm', NETWORK]));
    return `dev CA for ${DOMAIN}; network ${NETWORK} (${SUBNET})`;
  });

  await check('local Coolify-proxy stand-in (Traefik, file-provider certificate)', async () => {
    await proxyCompose(['up', '-d']);
    defer('stop proxy', () => (opts.keep ? undefined : proxyCompose(['down', '-v', '--remove-orphans'])));
    return `127.0.0.1:${String(HTTPS_PORT)} → :443, :${String(HTTP_PORT)} → :80`;
  });

  await check('compose config valid; images are local only (pull_policy never)', async () => {
    await compose(['config', '-q']);
    await compose(['pull', '--ignore-pull-failures', 'postgres', 'redis']);
    return 'ok';
  });

  await check('compose up: postgres + redis healthy → migrate (owner) → master + web healthy', async () => {
    defer('compose down', () =>
      opts.keep ? undefined : compose(['down', '-v', '--remove-orphans', '--timeout', '20']),
    );
    const up = await composeRun(['up', '-d', '--wait', '--wait-timeout', '180']);
    const ps = await compose(['ps', '-a', '--format', '{{.Service}} {{.State}} {{.Health}} {{.ExitCode}}']);
    const states = Object.fromEntries(
      ps.stdout
        .trim()
        .split('\n')
        .map((l) => l.split(' '))
        .map(([svc, ...rest]) => [svc, rest.join(' ')]),
    );
    assert(
      up.code === 0,
      `compose up --wait failed: ${up.stderr.trim().split('\n').slice(-2).join(' | ')}; ${JSON.stringify(states)}`,
    );
    for (const svc of ['postgres', 'redis', 'master', 'web']) {
      assert(/running healthy/.test(states[svc] ?? ''), `${svc}: ${String(states[svc])}`);
    }
    assert(/exited\s+0$/.test(states.migrate ?? ''), `migrate: ${String(states.migrate)}`);
    const logs = await compose(['logs', '--no-color', 'migrate']);
    const m = /migrations: (\d+) applied/.exec(logs.stdout);
    assert(m && Number(m[1]) > 0, 'migrate did not report applied migrations');
    return `${m[1]} migrations applied; ${Object.entries(states)
      .map(([k, v]) => `${k}=${v.split(' ')[0]}`)
      .join(' ')}`;
  });

  await check('data services: no published ports; Redis requires AUTH', async () => {
    const ports = await compose(['ps', '--format', '{{.Service}} {{.Ports}}']);
    const published = ports.stdout.split('\n').filter((l) => l.includes('->'));
    assert(published.length === 0, `published ports: ${published.join('; ')}`);
    const noAuth = await composeRun(['exec', '-T', 'redis', 'redis-cli', '--no-auth-warning', 'ping']);
    assert(/NOAUTH/.test(noAuth.stdout + noAuth.stderr), 'redis answered without AUTH');
    const aof = await composeRun([
      'exec',
      '-T',
      'redis',
      'sh',
      '-c',
      'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli config get appendonly',
    ]);
    assert(/appendonly\s+yes/.test(aof.stdout), 'AOF not enabled');
    return 'no host ports; redis NOAUTH without password; AOF on';
  });

  await check('roles: schema owned by remyral_owner; master runs as non-owner remyral_app', async () => {
    const owners = await sql(
      "SELECT string_agg(DISTINCT pg_get_userbyid(c.relowner), ',') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','S')",
    );
    assert(owners === 'remyral_owner', `public tables owned by ${owners}`);
    const users = await sql(
      "SELECT string_agg(DISTINCT usename, ',') FROM pg_stat_activity WHERE datname = 'remyral' AND usename IS NOT NULL AND usename <> 'postgres'",
    );
    assert(users === 'remyral_app', `connected roles: ${users}`);
    const attrs = await sql(
      "SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls FROM pg_roles WHERE rolname = 'remyral_app'",
    );
    assert(attrs === 'f', 'remyral_app has elevated attributes');
    return `tables/sequences owned by ${owners}; master connections: ${users}`;
  });

  await check('append-only audit: remyral_app cannot disable triggers, truncate or update', async () => {
    const disable = await sqlAsApp('ALTER TABLE audit_events DISABLE TRIGGER ALL');
    assert(
      disable.code !== 0 && /must be owner/i.test(disable.stderr),
      `DISABLE TRIGGER: ${disable.stderr.trim()}`,
    );
    const trunc = await sqlAsApp('TRUNCATE audit_events');
    assert(trunc.code !== 0 && /permission denied/i.test(trunc.stderr), `TRUNCATE: ${trunc.stderr.trim()}`);
    const ddl = await sqlAsApp('CREATE TABLE remyral_e2e_probe (id int)');
    assert(ddl.code !== 0 && /permission denied/i.test(ddl.stderr), `CREATE TABLE: ${ddl.stderr.trim()}`);
    return 'DISABLE TRIGGER: must be owner; TRUNCATE/CREATE: permission denied';
  });

  let masterHeaders;
  await check('routing: /api/auth/session → master 401 (prefix stripped)', async () => {
    const r = await fetchRaw('GET', '/api/auth/session');
    assert(r.status === 401, `status ${String(r.status)}`);
    assert(/^application\/json/.test(String(r.headers['content-type'])), 'not JSON');
    masterHeaders = r.headers;
    const direct = await fetchRaw('GET', '/auth/session');
    assert(
      direct.status === 200 && /<div id="root">/.test(direct.body),
      'un-prefixed path should be the console',
    );
    return '401 JSON from the master; /auth/session (no /api) is the console';
  });

  await check('web: console served, SPA fallback, caching, identical security headers', async () => {
    const root = await fetchRaw('GET', '/');
    assert(root.status === 200 && /<div id="root">/.test(root.body), `GET / → ${String(root.status)}`);
    assert(
      root.headers['cache-control'] === 'no-cache',
      `index cache-control ${String(root.headers['cache-control'])}`,
    );
    const deep = await fetchRaw('GET', '/fleet/some/deep/link');
    assert(deep.status === 200 && /<div id="root">/.test(deep.body), 'SPA fallback failed');
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(root.body)?.[1];
    assert(asset, 'no bundled script in index.html');
    const a = await fetchRaw('GET', asset);
    assert(a.status === 200 && /immutable/.test(String(a.headers['cache-control'])), 'asset caching');
    const diffs = SECURITY_HEADERS.filter(
      (h) =>
        root.headers[h] !== masterHeaders[h] ||
        a.headers[h] !== masterHeaders[h] ||
        masterHeaders[h] === undefined,
    );
    assert(diffs.length === 0, `headers differ from the master: ${diffs.join(', ')}`);
    assert(
      !/unsafe-inline/.test(String(root.headers['content-security-policy'])),
      'CSP allows unsafe-inline',
    );
    assert(
      root.headers.server === undefined || !/\d/.test(String(root.headers.server)),
      'server version leaked',
    );
    return `${String(SECURITY_HEADERS.length)} security headers identical to the master's`;
  });

  await check('probes and /api/v1/worker are not public; HTTP redirects to HTTPS', async () => {
    for (const p of [
      '/api/healthz',
      '/api/readyz',
      '/api/v1/worker',
      '/api/nonexistent-but-blocked/../healthz',
    ]) {
      const r = await fetchRaw('GET', p);
      assert(!/"status":"(ok|ready|unavailable)"/.test(r.body), `${p} reached a master probe`);
    }
    const hz = await fetchRaw('GET', '/api/healthz');
    assert(hz.status === 404, `/api/healthz → ${String(hz.status)}`);
    for (const p of ['/healthz', '/readyz']) {
      const r = await fetchRaw('GET', p);
      assert(r.status === 200 && /<div id="root">/.test(r.body), `${p} should be the console page`);
    }
    const http = await fetchRaw('GET', '/fleet', { plain: true });
    assert([301, 308].includes(http.status), `http → ${String(http.status)}`);
    assert(
      String(http.headers.location).startsWith(`https://${DOMAIN}`),
      `location ${String(http.headers.location)}`,
    );
    return '/api/healthz|readyz|v1/worker → 404 (web); /healthz → console; http → https';
  });

  await check('public uptime probe /api/status answers ok and nothing else (p1-monitoring)', async () => {
    const r = await fetchRaw('GET', '/api/status');
    assert(r.status === 200, `/api/status → ${String(r.status)}`);
    assert(r.body === '{"status":"ok"}', `/api/status body ${r.body.slice(0, 80)}`);
    assert(r.headers['cache-control'] === 'no-store', 'status probe must not be cached by Cloudflare');
    return '/api/status → 200 {"status":"ok"}, no-store';
  });

  const c = new Console();
  await check(
    'owner account (programmatic createUser in the master container) → login → TOTP enrollment',
    async () => {
      const username = `e2e-compose-${RUN_ID}`;
      const password = `Pw-${randomBytes(18).toString('base64url')}`;
      // The script (with the credentials) goes in on stdin, never on a command line.
      const script = `
      const { createPool } = await import('/app/dist/db/pool.js');
      const { AuditLog } = await import('/app/dist/audit/audit.js');
      const { createUser } = await import('/app/dist/cli/admin.js');
      const pool = createPool({ connectionString: process.env.DATABASE_URL, max: 1 });
      try { await createUser({ pool, audit: new AuditLog(pool) }, ${JSON.stringify({ username, role: 'owner', password })}); }
      finally { await pool.end(); }
      console.log('created');`;
      const r = await compose(['exec', '-T', 'master', 'node', '--input-type=module'], { input: script });
      assert(r.stdout.includes('created'), 'createUser did not report success');
      const login = await c.post('/auth/login', { username, password });
      assert(login.status === 'enrollment_required', `login status ${String(login.status)}`);
      const start = await c.post('/auth/totp/enroll/start');
      c.authenticator = new Authenticator(String(start.secret));
      const confirm = await c.post('/auth/totp/enroll/confirm', { code: await c.authenticator.nextCode() });
      assert(confirm.status === 'authenticated', 'enrollment did not authenticate');
      const session = await c.get('/auth/session');
      assert(session && typeof session === 'object', 'no session');
      return 'owner enrolled; GET /api/auth/session 200 through the proxy';
    },
  );

  await check('append-only audit: existing rows cannot be updated or deleted by remyral_app', async () => {
    const n = Number(await sql('SELECT count(*) FROM audit_events'));
    assert(n > 0, 'no audit rows to test against');
    const upd = await sqlAsApp('UPDATE audit_events SET action = action');
    assert(upd.code !== 0, 'UPDATE audit_events succeeded');
    const del = await sqlAsApp('DELETE FROM audit_events');
    assert(del.code !== 0, 'DELETE audit_events succeeded');
    const after = Number(await sql('SELECT count(*) FROM audit_events'));
    assert(after >= n, 'audit rows disappeared');
    return `${String(n)} rows; UPDATE and DELETE refused by the triggers`;
  });

  await check('worker over wss:// through the proxy: pair → approve → online', async () => {
    const volume = `remyral-e2e-compose-worker-${RUN_ID}`;
    const cfgDir = join(WORK, 'worker');
    mkdirSync(cfgDir, { mode: 0o700 });
    const cfgFile = join(cfgDir, 'config.json');
    writeFileSync(
      cfgFile,
      `${JSON.stringify({ masterUrl: `wss://${DOMAIN}`, workspaceRoot: '/srv/remyral/workspaces', dataDir: '/var/lib/remyral-worker' }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await must('docker', ['volume', 'create', volume]);
    defer('remove worker volume', () => run('docker', ['volume', 'rm', '-f', volume]));
    defer('remove worker containers', async () => {
      const ids = (
        await run('docker', ['ps', '-aq', '--filter', `label=remyral-e2e-compose=${RUN_ID}`])
      ).stdout
        .split(/\s+/)
        .filter(Boolean);
      if (ids.length > 0) await run('docker', ['rm', '-f', ...ids]);
    });
    const args = (name) => [
      '--name',
      name,
      '--label',
      `remyral-e2e-compose=${RUN_ID}`,
      '--network',
      NETWORK,
      '-v',
      `${volume}:/var/lib/remyral-worker`,
      '-v',
      `${cfgFile}:/etc/remyral-worker/config.json:ro`,
      '-v',
      `${join(TLS_DIR, 'ca.pem')}:/etc/remyral-worker/ca.pem:ro`,
      '-e',
      'NODE_EXTRA_CA_CERTS=/etc/remyral-worker/ca.pem',
    ];
    let code = null;
    let fingerprint = null;
    const pair = run(
      'docker',
      ['run', '--rm', ...args(`remyral-e2e-compose-pair-${RUN_ID}`), WORKER_IMAGE, 'pair'],
      {
        timeoutMs: 180_000,
        onLine: (line) => {
          code ??= /Pairing code:\s+([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(line)?.[1] ?? null;
          fingerprint ??= /Fingerprint:\s+(SHA256:[0-9A-F-]+)/.exec(line)?.[1] ?? null;
        },
      },
    );
    await waitFor('pairing code + fingerprint', () => code && fingerprint, {
      timeoutMs: 90_000,
      intervalMs: 250,
    });
    const pending = await waitFor(
      'pending worker in GET /api/workers',
      async () =>
        (await c.get('/workers')).workers.find((w) => w.state === 'pending' && w.fingerprint === fingerprint),
      { timeoutMs: 30_000 },
    );
    await c.privileged(`/workers/${pending.id}/approve`, { pairingCode: code });
    const exit = await Promise.race([pair, sleep(60_000).then(() => null)]);
    assert(exit && exit.code === 0, `pair exited ${String(exit?.code)}`);
    await must('docker', ['run', '-d', ...args(`remyral-e2e-compose-worker-${RUN_ID}`), WORKER_IMAGE, 'run']);
    const w = await waitFor(
      'worker online',
      async () => {
        const x = await c.get(`/workers/${pending.id}`);
        return x.connected && ['online', 'busy'].includes(x.state) ? x : null;
      },
      { timeoutMs: 90_000 },
    );
    return `${pending.id} ${w.state} ${String(w.os)}/${String(w.arch)} via wss://${DOMAIN}`;
  });

  await check('CF-Connecting-IP honoured when the peer is a trusted source', async () => {
    const ip = await auditedIpFor('203.0.113.77');
    assert(ip === '203.0.113.77', `audited ip ${ip}`);
    return `audit ip = header value (peer in ${SUBNET})`;
  });

  await check('CF-Connecting-IP ignored when the peer is not a trusted source', async () => {
    writeAppEnv('192.0.2.0/24'); // documentation range: nothing on the e2e network matches
    await compose(['up', '-d', '--wait', '--wait-timeout', '120', 'master']);
    const ip = await auditedIpFor('203.0.113.78');
    assert(ip !== '203.0.113.78', 'forged header was trusted');
    assert(ip.startsWith(`${SUBNET_PREFIX}.`), `audited ip ${ip} is not the real peer`);
    return `audit ip = real peer ${ip}`;
  });
} catch (err) {
  exitCode = 1;
  if (!(err instanceof StepFailed)) {
    log(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const logs = await composeRun(['logs', '--no-color', '--tail', '40', 'migrate', 'master', 'web']);
    process.stdout.write(`\n--- compose logs (tail) ---\n${logs.stdout.slice(-6000)}\n`);
  } catch {
    // compose may not be up
  }
} finally {
  if (opts.keep) log(`--keep: leaving ${APP_PROJECT}, ${PROXY_PROJECT}, ${NETWORK} and ${WORK}`);
  else await cleanup();
  printTable();
}
process.exit(exitCode);
