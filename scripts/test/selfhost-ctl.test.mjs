// p16-selfhost-onboarding: the release tool (scripts/release/control-plane.mjs) builds and signs real bundles into a
// temp dir, and the published `install.sh` / `remyral-ctl` (bash + OpenSSL) installs, upgrades and rolls back from them
// against a fake `docker` and `curl` (scripts/test/fixtures/selfhost/). Nothing is pulled, started or contacted.
import { Buffer } from 'node:buffer';
import { execFile, execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TOOL = join(ROOT, 'scripts/release/control-plane.mjs');
const FIXTURES = join(ROOT, 'scripts/test/fixtures/selfhost');
const work = mkdtempSync(join(tmpdir(), 'remyral-selfhost-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const COMMIT = 'c0ffee'.padEnd(40, '0');
const d = (c) => `sha256:${c.repeat(64)}`;
const DIGESTS = {
  '1.0.0': { master: d('a'), web: d('b'), backup: d('c') },
  '1.1.0': { master: d('d'), web: d('e'), backup: d('f') },
};
const ref = (v, k) => `ghcr.io/acme/remyral-${k}@${DIGESTS[v][k]}`;

function keypair(dir) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  mkdirSync(dir, { recursive: true });
  const pem = join(dir, 'key.pem');
  writeFileSync(pem, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  return { pem, pub: publicKey.export({ format: 'jwk' }).x };
}
const vendor = keypair(join(work, 'vendor'));
const intruder = keypair(join(work, 'intruder'));
const releases = join(work, 'releases');

function tool(args) {
  return execFileSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: 'utf8' });
}
function bundle(version, extra = []) {
  writeFileSync(join(work, `digests-${version}.json`), JSON.stringify(DIGESTS[version]));
  return tool([
    'bundle',
    '--version',
    version,
    '--registry',
    'ghcr.io/acme',
    '--key',
    vendor.pem,
    '--digests',
    join(work, `digests-${version}.json`),
    '--min-worker',
    '1.0.75',
    '--release-url',
    'https://releases.test',
    '--out',
    releases,
    '--commit',
    COMMIT,
    '--created-at',
    `2026-10-2${version === '1.0.0' ? '0' : '3'}T10:00:00.000Z`,
    ...extra,
  ]);
}

// ---------------------------------------------------------------- sandbox per run

const bin = join(work, 'bin');
mkdirSync(bin, { recursive: true });
for (const [name, file] of [
  ['docker', 'fake-docker.mjs'],
  ['curl', 'fake-curl.mjs'],
  ['systemctl', 'fake-systemctl.mjs'],
]) {
  writeFileSync(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${join(FIXTURES, file)}" "$@"\n`);
  chmodSync(join(bin, name), 0o755);
}
const meminfo = join(work, 'meminfo');
writeFileSync(meminfo, 'MemTotal:        8000000 kB\nMemFree:  100 kB\n');

let box;
function newBox() {
  const root = mkdtempSync(join(work, 'box-'));
  box = {
    root,
    data: join(root, 'data'),
    bin: join(root, 'usr-local-bin'),
    state: join(root, 'docker-state.json'),
    log: join(root, 'docker.log'),
  };
  writeFileSync(box.log, '');
  return box;
}
const dockerState = () => JSON.parse(readFileSync(box.state, 'utf8'));
const setState = (patch) => {
  const s = existsSync(box.state)
    ? dockerState()
    : { images: {}, containers: {}, networks: [], users: 0, dbHead: '', backups: [] };
  writeFileSync(box.state, JSON.stringify({ ...s, ...patch }));
};
const calls = () => readFileSync(box.log, 'utf8').split('\n').filter(Boolean);

function ctl(script, args, { env = {}, meminfoFile = meminfo } = {}) {
  return new Promise((resolve) => {
    execFile(
      'bash',
      [script, ...args],
      {
        env: {
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          HOME: box.root,
          TMPDIR: box.root,
          FAKE_DOCKER_STATE: box.state,
          FAKE_DOCKER_LOG: box.log,
          FAKE_RELEASES_DIR: releases,
          REMYRAL_CTL_ALLOW_NONROOT: '1',
          REMYRAL_CTL_OS: 'Linux',
          REMYRAL_CTL_ARCH: 'x86_64',
          REMYRAL_CTL_MEMINFO: meminfoFile,
          REMYRAL_CTL_BIN_DIR: box.bin,
          REMYRAL_CTL_SYSTEMD_DIR: join(box.root, 'no-systemd'),
          REMYRAL_CTL_GATE_TRIES: '2',
          REMYRAL_CTL_SLEEP: '0',
          ...env,
        },
        maxBuffer: 8 * 1024 * 1024,
      },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }),
    );
  });
}
const installer = () => join(releases, '1.0.0', 'install.sh');
const INSTALL = ['--domain', 'remyral.example.com', '--tls', 'letsencrypt', '--email', 'ops@example.com'];

beforeAll(() => {
  bundle('1.0.0');
  bundle('1.1.0', ['--breaking', 'Example breaking note for the test']);
  tool(['feed', '--out', releases, '--key', vendor.pem, '--created-at', '2026-10-23T11:00:00.000Z']);
}, 60_000);

// ---------------------------------------------------------------- the release tool

describe('control-plane release tool', { timeout: 60_000 }, () => {
  it('writes a signed bundle: manifest with digests, schema, worker floor, file hashes and the keys compiled in', () => {
    const dir = join(releases, '1.1.0');
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(m).toMatchObject({
      schema: 1,
      name: 'remyral-control-plane',
      version: '1.1.0',
      channel: 'stable',
      commit: COMMIT,
      images: { master: ref('1.1.0', 'master'), web: ref('1.1.0', 'web'), backup: ref('1.1.0', 'backup') },
      minWorkerVersion: '1.0.75',
      breaking: ['Example breaking note for the test'],
      trustedKeys: [vendor.pub],
    });
    expect(m.migrationsHead).toMatch(/^\d{4}$/);
    expect(Object.keys(m.files).sort()).toEqual(
      [
        'INSTALL.md',
        'KURULUM.md',
        'NOTES.md',
        'compose.selfhost.yaml',
        'compose.yaml',
        'install.sh',
        'remyral-ctl',
      ].sort(),
    );
    const ctlText = readFileSync(join(dir, 'remyral-ctl'), 'utf8');
    expect(ctlText).toContain(`REMYRAL_TRUSTED_KEYS='${vendor.pub}'`);
    expect(ctlText).toContain("REMYRAL_DEFAULT_RELEASE_URL='https://releases.test'");
    expect(ctlText).toContain("REMYRAL_CTL_BUNDLE_VERSION='1.1.0'");
    expect(readFileSync(join(dir, 'install.sh'))).toEqual(readFileSync(join(dir, 'remyral-ctl')));
    expect(statSync(join(dir, 'install.sh')).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(dir, 'NOTES.md'), 'utf8')).toMatch(/^# Remyral 1\.1\.0\n/);
    expect(tool(['verify', '--dir', dir, '--public-key', vendor.pub])).toMatch(
      /^OK remyral-control-plane 1\.1\.0/,
    );
  });

  it('refuses to verify with a foreign key, a tampered file, or to overwrite a published version', () => {
    const dir = join(releases, '1.1.0');
    expect(() => tool(['verify', '--dir', dir, '--public-key', intruder.pub])).toThrow(/unknown key/);
    const copy = join(work, 'tampered');
    cpSync(dir, copy, { recursive: true });
    appendFileSync(join(copy, 'compose.yaml'), '\n# changed\n');
    expect(() => tool(['verify', '--dir', copy, '--public-key', vendor.pub])).toThrow(/does not match/);
    expect(() => bundle('1.1.0')).toThrow(/already holds a release/);
  });

  it('signs a feed of every release, newest first, with notes and summaries from the CHANGELOG', () => {
    const feed = JSON.parse(readFileSync(join(releases, 'feed.json'), 'utf8'));
    expect(feed.releases.map((r) => r.version)).toEqual(['1.1.0', '1.0.0']);
    expect(feed.releases[0]).toMatchObject({
      minWorkerVersion: '1.0.75',
      breaking: ['Example breaking note for the test'],
    });
    expect(feed.releases[0].summary.length).toBeGreaterThan(0);
    expect(feed.releases[0].summary.length).toBeLessThanOrEqual(300);
    expect(JSON.parse(readFileSync(join(releases, 'feed.sig.json'), 'utf8')).signature).toMatch(
      /^[A-Za-z0-9_-]+$/,
    );
  });
});

// ---------------------------------------------------------------- install

describe('install.sh', { timeout: 120_000 }, () => {
  beforeEach(() => {
    newBox();
  });

  it('--dry-run: checks, verifies the signed release, prints the plan and changes nothing', async () => {
    const r = await ctl(installer(), [...INSTALL, '--data-dir', box.data, '--dry-run']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('DRY RUN');
    expect(r.stdout).toContain('ok   Docker 27.3.1');
    expect(r.stdout).toContain('signed by a trusted key');
    // No --version: the newest release of the signed feed.
    expect(r.stdout).toContain(`docker pull --quiet ${ref('1.1.0', 'master')}`);
    expect(r.stdout).toContain('run --rm --no-TTY migrate');
    expect(existsSync(box.data)).toBe(false);
    const mutating = calls().filter((c) =>
      /^(pull|network create|compose .* (up|run|exec)|stop|start)\b/.test(c),
    );
    expect(mutating).toEqual([]);
  });

  it('installs: secrets with tight modes (never printed), pinned images, migrate, gate, one-time setup token', async () => {
    const r = await ctl(installer(), [...INSTALL, '--data-dir', box.data, '--yes']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    const stack = readFileSync(join(box.data, 'stack.env'), 'utf8');
    expect(statSync(join(box.data, 'stack.env')).mode & 0o777).toBe(0o600);
    expect(statSync(join(box.data, 'secrets/totp.key')).mode & 0o777).toBe(0o400);
    expect(statSync(join(box.data, 'secrets/lease-signing.pem')).mode & 0o777).toBe(0o400);
    expect(statSync(box.data).mode & 0o777).toBe(0o700);
    const secrets = [
      'POSTGRES_SUPERUSER_PASSWORD',
      'REMYRAL_DB_OWNER_PASSWORD',
      'REMYRAL_DB_APP_PASSWORD',
      'REDIS_PASSWORD',
    ].map((k) => new RegExp(`^${k}=([0-9a-f]{64})$`, 'm').exec(stack)?.[1]);
    for (const s of secrets) {
      expect(s).toMatch(/^[0-9a-f]{64}$/);
      expect(r.stdout).not.toContain(s);
    }
    expect(r.stdout).not.toContain(readFileSync(join(box.data, 'secrets/totp.key'), 'utf8').trim());
    expect(stack).toContain('REMYRAL_DOMAIN=remyral.example.com');
    expect(stack).toContain('PROXY_NETWORK=remyral-proxy');
    expect(stack).toContain('UPDATE_FEED_URL=https://releases.test/feed.json');
    expect(stack).toContain(`CONTROL_PLANE_RELEASE_KEYS=${vendor.pub}`);
    const rel = readFileSync(join(box.data, 'release.env'), 'utf8');
    expect(rel).toContain(`REMYRAL_MASTER_IMAGE=${ref('1.1.0', 'master')}`);
    expect(rel).toContain('REMYRAL_VERSION=1.1.0');
    expect(rel).toContain(`REMYRAL_RELEASE_TAG=${COMMIT.slice(0, 12)}`);
    const traefik = readFileSync(join(box.data, 'proxy/traefik.yml'), 'utf8');
    expect(traefik).toContain('certResolver: le');
    expect(traefik).toContain('email: "ops@example.com"');
    expect(traefik).toContain('Label(`com.docker.compose.project`,`remyral-prod`)');
    expect(readFileSync(join(box.data, 'trust/keys'), 'utf8').trim()).toBe(vendor.pub);
    expect(readFileSync(join(box.bin, 'remyral-ctl'))).toEqual(
      readFileSync(join(releases, '1.1.0', 'remyral-ctl')),
    );
    expect(readFileSync(join(box.data, 'state/current'), 'utf8').trim()).toBe('1.1.0');
    expect(r.stdout).toMatch(/One-time setup token/);
    expect(r.stdout).toMatch(/\brst_[a-z2-7]{32}\b/);
    expect(r.stdout).toContain('https://remyral.example.com/setup');
    const c = calls();
    const order = [
      'pull --quiet',
      'up -d --wait --wait-timeout 180 postgres redis',
      'run --rm --no-TTY migrate',
      'master web proxy backup',
      'setup:token',
    ].map((needle) => c.findIndex((l) => l.includes(needle)));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('is idempotent: a re-run keeps every secret and prints no second token', async () => {
    await ctl(installer(), [...INSTALL, '--data-dir', box.data, '--yes']);
    const before = readFileSync(join(box.data, 'stack.env'), 'utf8');
    const totp = readFileSync(join(box.data, 'secrets/totp.key'));
    const r = await ctl(join(box.bin, 'remyral-ctl'), ['install', '--data-dir', box.data, '--yes']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(readFileSync(join(box.data, 'stack.env'), 'utf8')).toBe(before);
    expect(readFileSync(join(box.data, 'secrets/totp.key'))).toEqual(totp);
    expect(r.stdout).not.toMatch(/\brst_/);
    expect(r.stdout).toContain("'remyral-ctl setup-token'");
    expect(calls().filter((l) => l.startsWith('pull ')).length).toBe(3);
  });

  it('a re-run keeps the lines an operator added and changes only what its flags set (p17-host-actions)', async () => {
    await ctl(installer(), [...INSTALL, '--data-dir', box.data, '--yes']);
    const file = join(box.data, 'stack.env');
    const first = readFileSync(file, 'utf8');
    const added = [
      '# SMTP for notifications (added by the operator)',
      'NOTIFY_SMTP_HOST=smtp.example.com',
      'NOTIFY_SMTP_FROM=remyral@example.com',
      'PUSH_VAPID_SUBJECT=mailto:ops@example.com',
      'BACKUP_TIME=03:15',
      'WEIRD_VALUE=a\\b&c|d',
    ];
    // The operator also points the update feed at a mirror; a re-run without --release-url keeps it.
    writeFileSync(
      file,
      `${first.replace(/^UPDATE_FEED_URL=.*$/m, 'UPDATE_FEED_URL=https://mirror.example.com/feed.json')}${added.join('\n')}\n`,
      { mode: 0o600 },
    );
    const r = await ctl(join(box.bin, 'remyral-ctl'), [
      'install',
      '--data-dir',
      box.data,
      '--email',
      'new@example.com',
      '--yes',
    ]);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    const after = readFileSync(file, 'utf8');
    for (const l of added) expect(after.split('\n')).toContain(l);
    expect(after).toContain('REMYRAL_ACME_EMAIL=new@example.com');
    expect(after).not.toContain('REMYRAL_ACME_EMAIL=ops@example.com');
    expect(after).toContain('UPDATE_FEED_URL=https://mirror.example.com/feed.json');
    expect(after.match(/^REMYRAL_ACME_EMAIL=/gm)).toHaveLength(1);
    for (const k of ['POSTGRES_SUPERUSER_PASSWORD', 'REDIS_PASSWORD', 'REMYRAL_DB_APP_PASSWORD']) {
      const v = (t) => new RegExp(`^${k}=(.*)$`, 'm').exec(t)?.[1];
      expect(v(after)).toBe(v(first));
    }
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Every line of the first install is still there except the one the flag changed (order kept).
    const changed = first
      .split('\n')
      .filter((l) => !l.startsWith('REMYRAL_ACME_EMAIL=') && !l.startsWith('UPDATE_FEED_URL='));
    const kept = after.split('\n').filter((l) => changed.includes(l));
    expect(kept).toEqual(changed);
    // An explicit --release-url does move the feed address.
    await ctl(join(box.bin, 'remyral-ctl'), [
      'install',
      '--data-dir',
      box.data,
      '--release-url',
      'https://releases.test',
      '--yes',
    ]);
    expect(readFileSync(file, 'utf8')).toContain('UPDATE_FEED_URL=https://releases.test/feed.json');
    expect(readFileSync(file, 'utf8')).toContain('NOTIFY_SMTP_HOST=smtp.example.com');
  });

  it('a manifest signed by an unknown key aborts before anything is pulled or written', async () => {
    const forged = join(work, 'forged');
    rmSync(forged, { recursive: true, force: true });
    cpSync(join(releases, '1.0.0'), forged, { recursive: true });
    // Re-sign the same manifest with the intruder key: well-formed, but not trusted.
    const { signBytes, CP_RELEASE_CONTEXT } = await import('../release/control-plane-lib.mjs');
    const { createPrivateKey } = await import('node:crypto');
    const sig = signBytes(
      CP_RELEASE_CONTEXT,
      readFileSync(join(forged, 'manifest.json')),
      createPrivateKey(readFileSync(intruder.pem)),
    );
    writeFileSync(join(forged, 'manifest.sig.json'), `${JSON.stringify(sig)}\n`);
    const r = await ctl(installer(), [...INSTALL, '--data-dir', box.data, '--bundle', forged, '--yes']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/SIGNATURE CHECK FAILED/);
    expect(existsSync(join(box.data, 'stack.env'))).toBe(false);
    expect(calls().filter((l) => l.startsWith('pull'))).toEqual([]);
  });

  it('a manifest changed after signing, or a file that does not match it, aborts', async () => {
    const t = join(work, 'tampered-manifest');
    rmSync(t, { recursive: true, force: true });
    cpSync(join(releases, '1.0.0'), t, { recursive: true });
    const m = readFileSync(join(t, 'manifest.json'), 'utf8').replace(DIGESTS['1.0.0'].master, d('9'));
    writeFileSync(join(t, 'manifest.json'), m);
    let r = await ctl(installer(), [...INSTALL, '--data-dir', box.data, '--bundle', t, '--yes']);
    expect(r.stderr).toMatch(/SIGNATURE CHECK FAILED/);
    cpSync(join(releases, '1.0.0', 'manifest.json'), join(t, 'manifest.json'));
    appendFileSync(join(t, 'compose.yaml'), '\n  evil: {}\n');
    r = await ctl(installer(), [...INSTALL, '--data-dir', box.data, '--bundle', t, '--yes']);
    expect(r.stderr).toMatch(/INTEGRITY CHECK FAILED: compose\.yaml/);
    expect(calls().filter((l) => l.startsWith('pull'))).toEqual([]);
  });

  it('a pulled image without the signed digest aborts', async () => {
    setState({ wrongDigest: true });
    const r = await ctl(installer(), [...INSTALL, '--data-dir', box.data, '--yes']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/does not carry the signed digest/);
  });

  it('prerequisites: too little memory, another OS, missing flags', async () => {
    const small = join(work, 'meminfo-small');
    writeFileSync(small, 'MemTotal:        2000000 kB\n');
    let r = await ctl(installer(), [...INSTALL, '--data-dir', box.data, '--yes'], { meminfoFile: small });
    expect(r.stdout).toMatch(/FAIL memory 1953 MiB/);
    expect(r.stderr).toMatch(/prerequisite check\(s\) failed/);
    r = await ctl(installer(), [...INSTALL, '--data-dir', box.data, '--yes'], {
      env: { REMYRAL_CTL_OS: 'Darwin' },
    });
    expect(r.stderr).toMatch(/Linux only — Darwin is not supported/);
    r = await ctl(installer(), ['--domain', 'remyral.example.com', '--data-dir', box.data, '--yes']);
    expect(r.stderr).toMatch(/--tls is required/);
    r = await ctl(installer(), [
      '--domain',
      'remyral.example.com',
      '--tls',
      'letsencrypt',
      '--data-dir',
      box.data,
      '--yes',
    ]);
    expect(r.stderr).toMatch(/--email is required/);
    expect(existsSync(join(box.data, 'stack.env'))).toBe(false);
  });

  it('cloudflare / proxy mode: own certificate, trusted proxy, custom ports', async () => {
    const cert = join(box.root, 'origin.crt');
    const key = join(box.root, 'origin.key');
    writeFileSync(cert, 'CERT');
    writeFileSync(key, 'KEY');
    const r = await ctl(installer(), [
      '--domain',
      'remyral.example.com',
      '--tls',
      'proxy',
      '--tls-cert',
      cert,
      '--tls-key',
      key,
      '--https-port',
      '8443',
      '--http-port',
      '8080',
      '--trusted-proxy',
      '10.0.0.0/8',
      '--data-dir',
      box.data,
      '--yes',
    ]);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    const traefik = readFileSync(join(box.data, 'proxy/traefik.yml'), 'utf8');
    expect(traefik).not.toContain('certResolver');
    expect(traefik).toContain('- "10.0.0.0/8"');
    expect(readFileSync(join(box.data, 'proxy/dynamic/tls.yml'), 'utf8')).toContain(
      '/etc/traefik/certs/server.crt',
    );
    expect(statSync(join(box.data, 'proxy/certs/server.key')).mode & 0o777).toBe(0o600);
    const stack = readFileSync(join(box.data, 'stack.env'), 'utf8');
    expect(stack).toContain('REMYRAL_HTTPS_PORT=8443');
    expect(stack).toContain('TRUST_PROXY_HOPS=2');
    expect(calls().some((l) => l.includes('--resolve remyral.example.com:8443:127.0.0.1'))).toBe(true);
    expect(r.stdout).toContain('https://remyral.example.com:8443/setup');
  });
});

// ---------------------------------------------------------------- upgrade / rollback

describe('remyral-ctl upgrade and rollback', { timeout: 120_000 }, () => {
  let installed;
  beforeEach(async () => {
    newBox();
    const r = await ctl(installer(), [...INSTALL, '--version', '1.0.0', '--data-dir', box.data, '--yes']);
    expect(r.code).toBe(0);
    setState({ users: 1 });
    installed = join(box.bin, 'remyral-ctl');
    writeFileSync(box.log, '');
  }, 120_000);

  it('--check: reports the newer release and caches the signed feed for the console', async () => {
    const r = await ctl(installed, ['upgrade', '--check', '--data-dir', box.data]);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('update available: 1.0.0 → 1.1.0');
    expect(readFileSync(join(box.data, 'update/feed.json'))).toEqual(
      readFileSync(join(releases, 'feed.json')),
    );
    expect(calls().filter((l) => !l.startsWith('curl'))).toEqual([]);
  });

  it('--check also caches the worker feed, the newest worker bundle and the version catalog (p17-update-channel)', async () => {
    const w = join(releases, 'workers');
    mkdirSync(join(w, '1.1.5'), { recursive: true });
    mkdirSync(join(releases, 'catalog'), { recursive: true });
    const feed = `{\n  "schema": 1,\n  "releases": [\n    {\n      "bundle": {\n        "path": "1.1.5/release.json",\n        "size": 2\n      }\n    }\n  ]\n}\n`;
    writeFileSync(join(w, 'feed.json'), feed);
    writeFileSync(join(w, 'feed.sig.json'), '{"keyId":"x","signature":"y"}');
    writeFileSync(join(w, '1.1.5', 'release.json'), '{}');
    writeFileSync(join(releases, 'catalog', 'catalog.json'), '{"sequence":1}');
    writeFileSync(join(releases, 'catalog', 'catalog.sig.json'), '{}');
    // An older cached bundle goes away.
    mkdirSync(join(box.data, 'update/workers/1.1.4'), { recursive: true });
    try {
      const r = await ctl(installed, ['upgrade', '--check', '--data-dir', box.data]);
      expect(r.code).toBe(0);
      expect(readFileSync(join(box.data, 'update/workers/feed.json'), 'utf8')).toBe(feed);
      expect(readFileSync(join(box.data, 'update/workers/1.1.5/release.json'), 'utf8')).toBe('{}');
      expect(existsSync(join(box.data, 'update/workers/1.1.4'))).toBe(false);
      expect(readFileSync(join(box.data, 'update/catalog/catalog.json'), 'utf8')).toBe('{"sequence":1}');
    } finally {
      rmSync(w, { recursive: true, force: true });
      rmSync(join(releases, 'catalog'), { recursive: true, force: true });
    }
  });

  it('--dry-run prints the whole upgrade and changes nothing', async () => {
    const r = await ctl(installed, ['upgrade', '--data-dir', box.data, '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Breaking changes in 1.1.0');
    expect(r.stdout).toContain('remyral-backup run --reason pre-upgrade');
    expect(r.stdout).toMatch(/the images roll back to 1\.0\.0/);
    expect(readFileSync(join(box.data, 'state/current'), 'utf8').trim()).toBe('1.0.0');
    expect(
      calls().filter((l) => /^(pull|stop|start|exec .*remyral-backup|compose .* (up|run))/.test(l)),
    ).toEqual([]);
  });

  it('refuses breaking changes without --yes on a non-interactive run', async () => {
    const r = await ctl(installed, ['upgrade', '--data-dir', box.data]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/re-run with --yes/);
  });

  it('upgrades: stop master, backup, migrate, start, gate; records the backup', async () => {
    setState({ migrateTo: { '1.1.0': '9999' } });
    const r = await ctl(installed, ['upgrade', '--data-dir', box.data, '--yes']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('OK: Remyral 1.1.0 runs');
    expect(readFileSync(join(box.data, 'state/current'), 'utf8').trim()).toBe('1.1.0');
    expect(readFileSync(join(box.data, 'release.env'), 'utf8')).toContain(
      `REMYRAL_MASTER_IMAGE=${ref('1.1.0', 'master')}`,
    );
    expect(readFileSync(join(box.data, 'state/history'), 'utf8')).toMatch(
      /1\.1\.0 active 9999 remana-prod-20261023T120000Z/,
    );
    const c = calls();
    const at = (needle) => c.findIndex((l) => l.includes(needle));
    expect(at('stop --time 20')).toBeLessThan(at('remyral-backup run --reason pre-upgrade'));
    expect(at('remyral-backup run')).toBeLessThan(at('run --rm --no-TTY migrate'));
    expect(at('run --rm --no-TTY migrate')).toBeLessThan(at('--remove-orphans master web proxy backup'));
    expect(readFileSync(join(box.bin, 'remyral-ctl'))).toEqual(
      readFileSync(join(releases, '1.1.0', 'remyral-ctl')),
    );
  });

  it('a failed backup stops the upgrade and starts the master again', async () => {
    setState({ failBackup: true });
    const r = await ctl(installed, ['upgrade', '--data-dir', box.data, '--yes']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/pre-upgrade backup failed; nothing was changed/);
    expect(dockerState().containers.master.running).toBe(true);
    expect(calls().some((l) => l.includes('run --rm --no-TTY migrate'))).toBe(false);
    expect(readFileSync(join(box.data, 'state/current'), 'utf8').trim()).toBe('1.0.0');
  });

  it('a failed health gate without a schema change rolls the images back automatically', async () => {
    setState({ unhealthy: [ref('1.1.0', 'master')] });
    const r = await ctl(installed, ['upgrade', '--data-dir', box.data, '--yes']);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toMatch(/UPGRADE FAILED: .*master is unhealthy/);
    expect(r.stderr).toMatch(/rolled back to 1\.0\.0 \(healthy\); 1\.1\.0 is recorded as failed/);
    expect(dockerState().containers.master.image).toBe(ref('1.0.0', 'master'));
    expect(readFileSync(join(box.data, 'release.env'), 'utf8')).toContain(
      `REMYRAL_MASTER_IMAGE=${ref('1.0.0', 'master')}`,
    );
    expect(readFileSync(join(box.data, 'state/current'), 'utf8').trim()).toBe('1.0.0');
  });

  it('a failed gate after the schema advanced holds and names the restore; rollback --restore-backup restores', async () => {
    const head = dockerState().dbHead;
    setState({ unhealthy: [ref('1.1.0', 'master')], migrateTo: { '1.1.0': '9999' } });
    const r = await ctl(installed, ['upgrade', '--data-dir', box.data, '--yes']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/NOT rolled back: the schema advanced .* → 9999/);
    expect(r.stderr).toContain(
      'remyral-ctl rollback --to 1.0.0 --restore-backup remana-prod-20261023T120000Z',
    );

    let rb = await ctl(installed, ['rollback', '--to', '1.0.0', '--data-dir', box.data, '--yes']);
    expect(rb.stderr).toMatch(/schema 9999 is newer than 1\.0\.0 expects/);

    mkdirSync(join(box.data, 'backups/db'), { recursive: true });
    writeFileSync(join(box.data, 'backups/db/remana-prod-20261023T120000Z.dump'), 'dump');
    rb = await ctl(installed, [
      'rollback',
      '--to',
      '1.0.0',
      '--restore-backup',
      'remana-prod-20261023T120000Z',
      '--data-dir',
      box.data,
      '--yes',
    ]);
    expect(rb.stderr).toBe('');
    expect(rb.code).toBe(0);
    expect(dockerState().dbHead).toBe(head);
    expect(rb.stdout).toContain('remyral_replaced_');
    expect(readFileSync(join(box.data, 'state/current'), 'utf8').trim()).toBe('1.0.0');
    expect(
      calls().some((l) =>
        l.includes('pg_restore -U postgres -d remyral_restore --exit-on-error /tmp/restore.dump'),
      ),
    ).toBe(true);
  });

  it('status, version, doctor (master checks; older releases without it) and setup-token after an owner exists', async () => {
    let r = await ctl(installed, ['status', '--data-dir', box.data]);
    expect(r.stdout).toContain('release   1.0.0');
    expect(r.stdout).toMatch(/master +healthy/);
    r = await ctl(installed, ['version', '--data-dir', box.data]);
    expect(r.stdout).toContain('remyral-ctl 1.0.0');
    r = await ctl(installed, ['doctor', '--data-dir', box.data]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('ok   redis.ping');
    expect(calls().some((l) => l.endsWith('exec -T master remyral-master doctor'))).toBe(true);
    setState({ doctorErrors: true });
    r = await ctl(installed, ['doctor', '--data-dir', box.data]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('the doctor found errors');
    setState({ doctorErrors: false, doctorMissing: true });
    r = await ctl(installed, ['doctor', '--data-dir', box.data]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("this release has no 'doctor' yet");
    r = await ctl(installed, ['setup-token', '--data-dir', box.data]);
    expect(r.stderr).toMatch(/an account exists already/);
  });

  it('uninstall keeps the data unless --purge-data', async () => {
    let r = await ctl(installed, ['uninstall', '--data-dir', box.data, '--yes']);
    expect(r.code).toBe(0);
    expect(existsSync(join(box.data, 'stack.env'))).toBe(true);
    expect(calls().some((l) => /compose .* down --remove-orphans$/.test(l))).toBe(true);
    r = await ctl(installed, ['uninstall', '--purge-data', '--data-dir', box.data, '--yes']);
    expect(r.code).toBe(0);
    expect(existsSync(box.data)).toBe(false);
    expect(existsSync(join(box.bin, 'remyral-ctl'))).toBe(false);
  });
});

// ---------------------------------------------------------------- domain changes from the console (p17-domain-wizard)

describe(
  'remyral-ctl apply-pending (domain change requests signed by the master)',
  { timeout: 120_000 },
  () => {
    let installed;
    let systemd;
    const reqDir = () => join(box.data, 'host/requests');
    const statusFile = (f) => join(box.data, 'host/status', f);
    const result = () => JSON.parse(readFileSync(statusFile('domain-result.json'), 'utf8'));
    const stackEnv = () => readFileSync(join(box.data, 'stack.env'), 'utf8');
    const apply = (env = {}) =>
      ctl(installed, ['apply-pending', '--data-dir', box.data], {
        env: { REMYRAL_CTL_SYSTEMD_DIR: systemd, REMYRAL_CTL_DOMAIN_GATE_TRIES: '2', ...env },
      });
    const iso = (ms) => `${new Date(Date.now() + ms).toISOString().slice(0, 19)}Z`;

    /** Writes a request exactly as the master does (apps/master/src/console-domain/host-files.ts), signed by `pem`. */
    async function request(over = {}, pem = join(box.data, 'secrets/lease-signing.pem')) {
      const files = await import('../../apps/master/src/console-domain/host-files.ts');
      const { createPrivateKey, randomUUID, sign } = await import('node:crypto');
      const key = createPrivateKey(readFileSync(pem));
      const signer = {
        signHostDocument: (context, bytes) => ({
          kid: 'k1',
          signature: sign(null, Buffer.concat([Buffer.from(`${context}\n`), bytes]), key).toString(
            'base64url',
          ),
        }),
      };
      const doc = {
        kind: files.DOMAIN_CHANGE_KIND,
        id: randomUUID(),
        nonce: files.newNonce(),
        domain: 'yeni.example.com',
        tls: 'letsencrypt',
        email: '',
        previousDomain: 'remyral.example.com',
        createdAt: iso(0),
        expiresAt: iso(15 * 60_000),
        ...over,
      };
      await files.writeRequest(reqDir(), doc, signer);
      return doc;
    }

    beforeEach(async () => {
      newBox();
      systemd = join(box.root, 'systemd');
      mkdirSync(systemd);
      const r = await ctl(installer(), [...INSTALL, '--data-dir', box.data, '--yes'], {
        env: { REMYRAL_CTL_SYSTEMD_DIR: systemd, REMYRAL_CTL_ADDRESSES: '203.0.113.7 127.0.0.1 fe80::1' },
      });
      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      setState({ users: 1 });
      installed = join(box.bin, 'remyral-ctl');
      writeFileSync(box.log, '');
    }, 120_000);

    it('install sets up the host directory, the root units and the heartbeat the console reads', () => {
      expect(stackEnv()).toContain(`REMYRAL_HOST_DIR=${join(box.data, 'host')}`);
      expect(statSync(reqDir()).mode & 0o777).toBe(0o700);
      expect(statSync(join(box.data, 'host/status')).mode & 0o777).toBe(0o755);
      const path = readFileSync(join(systemd, 'remyral-apply-pending.path'), 'utf8');
      expect(path).toContain(`PathChanged=${join(box.data, 'host/requests/domain-change.json')}`);
      expect(readFileSync(join(systemd, 'remyral-apply-pending.timer'), 'utf8')).toContain(
        'OnUnitActiveSec=1min',
      );
      expect(readFileSync(join(systemd, 'remyral-apply-pending.service'), 'utf8')).toContain(
        `ExecStart=${box.bin}/remyral-ctl apply-pending --data-dir ${box.data}`,
      );
      const beat = JSON.parse(readFileSync(statusFile('applier.json'), 'utf8'));
      expect(beat).toMatchObject({
        kind: 'remyral-host-applier/v1',
        // install.sh of 1.0.0 installs the newest release; the heartbeat names the remyral-ctl that wrote it.
        version: '1.0.0',
        domain: 'remyral.example.com',
        tls: 'letsencrypt',
        acmeEmail: 'ops@example.com',
        addresses: ['203.0.113.7'],
      });
    });

    it('applies a signed request: new name healthy, the old one keeps answering, request consumed, no replay', async () => {
      const doc = await request({ email: 'web@example.com' });
      const r = await apply();
      expect(r.code).toBe(0);
      expect(result()).toMatchObject({ id: doc.id, state: 'applied', domain: 'yeni.example.com' });
      expect(existsSync(join(reqDir(), 'domain-change.json'))).toBe(false);
      expect(existsSync(join(reqDir(), 'domain-change.sig.json'))).toBe(false);
      const stack = stackEnv();
      expect(stack).toContain('REMYRAL_DOMAIN=yeni.example.com');
      expect(stack).toContain('REMYRAL_ACME_EMAIL=web@example.com');
      expect(statSync(join(box.data, 'stack.env')).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(box.data, 'proxy/traefik.yml'), 'utf8')).toContain('email: "web@example.com"');
      const alias = readFileSync(join(box.data, 'proxy/dynamic/domain-previous.yml'), 'utf8');
      expect(alias).toContain('Host(`remyral.example.com`)');
      expect(alias).toContain('service: remyral-prod-master@docker');
      const c = calls();
      expect(c.some((l) => /compose .* up -d --wait --wait-timeout 300 master web$/.test(l))).toBe(true);
      expect(c.some((l) => /compose .* up -d --force-recreate proxy$/.test(l))).toBe(true);
      // The gate probed the NEW name, with and without -k (Let's Encrypt: a trusted certificate).
      expect(
        c.some((l) => l.startsWith('curl -s -o /dev/null') && l.includes('https://yeni.example.com:443/')),
      ).toBe(true);
      expect(JSON.parse(readFileSync(statusFile('applier.json'), 'utf8')).domain).toBe('yeni.example.com');
      // The same signed bytes again: refused (nonce already used), nothing changes.
      await request({ ...doc, previousDomain: 'yeni.example.com' });
      writeFileSync(box.log, '');
      const replay = JSON.parse(readFileSync(join(reqDir(), 'domain-change.json'), 'utf8'));
      expect(replay.nonce).toBe(doc.nonce);
      expect((await apply()).code).toBe(0);
      expect(result()).toMatchObject({ id: doc.id, state: 'refused' });
      expect(result().detail).toMatch(/already used/);
      expect(calls().filter((l) => l.includes(' up '))).toEqual([]);
    });

    it('rolls back when the new name does not become healthy (and keeps the old one answering meanwhile)', async () => {
      setState({ unreachableDomains: ['bad.example.com'] });
      const before = readFileSync(join(box.data, 'proxy/traefik.yml'), 'utf8');
      const doc = await request({ domain: 'bad.example.com', tls: 'cloudflare' });
      const r = await apply();
      expect(r.code).toBe(0);
      expect(result()).toMatchObject({ id: doc.id, state: 'rolled_back', domain: 'bad.example.com' });
      expect(result().detail).toMatch(/back on remyral\.example\.com/);
      expect(stackEnv()).toContain('REMYRAL_DOMAIN=remyral.example.com');
      expect(stackEnv()).toContain('REMYRAL_TLS_MODE=letsencrypt');
      expect(readFileSync(join(box.data, 'proxy/traefik.yml'), 'utf8')).toBe(before);
      expect(existsSync(join(box.data, 'proxy/dynamic/domain-previous.yml'))).toBe(false);
      // Recreated for the new name, then again for the old one.
      expect(calls().filter((l) => /up -d --wait --wait-timeout 300 master web$/.test(l)).length).toBe(2);
    });

    it("Let's Encrypt: a name without a trusted certificate in time is rolled back", async () => {
      setState({ untrustedDomains: ['yeni.example.com'] });
      const doc = await request();
      await apply();
      expect(result()).toMatchObject({ id: doc.id, state: 'rolled_back' });
      expect(result().detail).toMatch(/no trusted certificate/);
      expect(stackEnv()).toContain('REMYRAL_DOMAIN=remyral.example.com');
    });

    it('refuses a foreign signature, an expired or stale request and any value outside the install rules', async () => {
      const foreign = keypair(join(box.root, 'other'));
      await request({}, foreign.pem);
      await apply();
      expect(result()).toMatchObject({ id: '', state: 'refused' });
      expect(result().detail).toMatch(/signature check failed/);
      const doc = await request({ expiresAt: iso(-60_000) });
      await apply();
      expect(result()).toMatchObject({ id: doc.id, state: 'refused' });
      expect(result().detail).toMatch(/expired/);
      await request({ previousDomain: 'other.example.com' });
      await apply();
      expect(result().detail).toMatch(
        /made for other\.example\.com but this host serves remyral\.example\.com/,
      );
      // Signed by the master but outside the rules (a compromised master): refused, nothing runs.
      const { createPrivateKey, sign, randomUUID } = await import('node:crypto');
      const key = createPrivateKey(readFileSync(join(box.data, 'secrets/lease-signing.pem')));
      for (const domain of ['x.example.com`touch pwned`', 'EVIL.example.com', '10.0.0.1', 'localhost']) {
        const id = randomUUID();
        const bytes = Buffer.from(
          `${JSON.stringify(
            {
              kind: 'remyral-host-domain-change/v1',
              id,
              nonce: randomUUID().replaceAll('-', ''),
              domain,
              tls: 'letsencrypt',
              email: '',
              previousDomain: 'remyral.example.com',
              createdAt: iso(0),
              expiresAt: iso(60_000),
            },
            null,
            2,
          )}\n`,
        );
        const signature = sign(
          null,
          Buffer.concat([Buffer.from('remyral-host-domain-change/v1\n'), bytes]),
          key,
        ).toString('base64url');
        writeFileSync(join(reqDir(), 'domain-change.sig.json'), JSON.stringify({ keyId: 'k', signature }));
        writeFileSync(join(reqDir(), 'domain-change.json'), bytes);
        await apply();
        expect(result(), domain).toMatchObject({ id, state: 'refused', domain: '' });
      }
      expect(existsSync(join(box.root, 'pwned'))).toBe(false);
      expect(stackEnv()).toContain('REMYRAL_DOMAIN=remyral.example.com');
      expect(calls().filter((l) => l.includes(' up '))).toEqual([]);
    });

    it('the previous name stops answering after the grace period', async () => {
      await request();
      await apply();
      expect(result().state).toBe('applied');
      expect(existsSync(join(box.data, 'proxy/dynamic/domain-previous.yml'))).toBe(true);
      const [old, until] = readFileSync(join(box.data, 'state/domain-alias'), 'utf8').trim().split(' ');
      expect(old).toBe('remyral.example.com');
      expect(Number(until) - Date.now() / 1000).toBeGreaterThan(3500);
      // An hour later (the minute timer's next run after the grace period):
      writeFileSync(
        join(box.data, 'state/domain-alias'),
        `${old} ${String(Math.floor(Date.now() / 1000) - 1)}\n`,
      );
      const r = await apply();
      expect(r.stdout).toContain('the previous console name remyral.example.com no longer answers');
      expect(existsSync(join(box.data, 'proxy/dynamic/domain-previous.yml'))).toBe(false);
    });

    it('the daily check sets the applier up on an install that lacks it (upgraded by an older remyral-ctl)', async () => {
      for (const u of ['service', 'path', 'timer']) rmSync(join(systemd, `remyral-apply-pending.${u}`));
      rmSync(join(box.data, 'host'), { recursive: true, force: true });
      writeFileSync(
        join(box.data, 'stack.env'),
        stackEnv()
          .split('\n')
          .filter((l) => !l.startsWith('REMYRAL_HOST_DIR='))
          .join('\n'),
        { mode: 0o600 },
      );
      const r = await ctl(installed, ['upgrade', '--check', '--data-dir', box.data], {
        env: { REMYRAL_CTL_SYSTEMD_DIR: systemd },
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('up to date: 1.1.0');
      expect(existsSync(join(systemd, 'remyral-apply-pending.timer'))).toBe(true);
      expect(existsSync(reqDir())).toBe(true);
      expect(stackEnv()).toContain(`REMYRAL_HOST_DIR=${join(box.data, 'host')}`);
      expect(calls()).toContain(
        'systemctl enable --now remyral-apply-pending.path remyral-apply-pending.timer',
      );
    });

    it('uninstall removes the applier units', async () => {
      const r = await ctl(installed, ['uninstall', '--data-dir', box.data, '--yes'], {
        env: { REMYRAL_CTL_SYSTEMD_DIR: systemd },
      });
      expect(r.code).toBe(0);
      expect(existsSync(join(systemd, 'remyral-apply-pending.timer'))).toBe(false);
      expect(calls()).toContain(
        'systemctl disable --now remyral-apply-pending.timer remyral-apply-pending.path',
      );
    });
  },
);

// ---------------------------------------------------------------- update / rollback from the console (p17-host-actions)

describe(
  'remyral-ctl apply-pending: update and rollback requests (p17-host-actions)',
  { timeout: 180_000 },
  () => {
    let installed;
    let systemd;
    const reqDir = () => join(box.data, 'host/requests');
    const result = (kind) =>
      JSON.parse(readFileSync(join(box.data, 'host/status', `${kind}-result.json`), 'utf8'));
    const current = () => readFileSync(join(box.data, 'state/current'), 'utf8').trim();
    const apply = (env = {}) =>
      ctl(installed, ['apply-pending', '--data-dir', box.data], {
        env: { REMYRAL_CTL_SYSTEMD_DIR: systemd, ...env },
      });
    const iso = (ms) => `${new Date(Date.now() + ms).toISOString().slice(0, 19)}Z`;

    /** Writes a request exactly as the master does (apps/master/src/host-actions/files.ts), signed by `pem`. */
    async function hostRequest(kind, fields, over = {}, pem = join(box.data, 'secrets/lease-signing.pem')) {
      const files = await import('../../apps/master/src/host-actions/files.ts');
      const { createPrivateKey, randomUUID, sign } = await import('node:crypto');
      const key = createPrivateKey(readFileSync(pem));
      const signer = {
        signHostDocument: (context, bytes) => ({
          kid: 'k1',
          signature: sign(null, Buffer.concat([Buffer.from(`${context}\n`), bytes]), key).toString(
            'base64url',
          ),
        }),
      };
      const common = {
        id: randomUUID(),
        nonce: randomUUID().replaceAll('-', ''),
        createdAt: iso(0),
        expiresAt: iso(15 * 60_000),
        ...over,
      };
      await files.writeHostRequest(reqDir(), kind, common, fields, signer);
      return common;
    }
    /** Signs arbitrary bytes as a request of `kind` (what a compromised master could write). */
    async function rawRequest(kind, doc) {
      const { createPrivateKey, sign } = await import('node:crypto');
      const key = createPrivateKey(readFileSync(join(box.data, 'secrets/lease-signing.pem')));
      const bytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
      const signature = sign(
        null,
        Buffer.concat([Buffer.from(`remyral-host-${kind}/v1\n`), bytes]),
        key,
      ).toString('base64url');
      writeFileSync(join(reqDir(), `${kind}.sig.json`), JSON.stringify({ keyId: 'k', signature }));
      writeFileSync(join(reqDir(), `${kind}.json`), bytes);
    }

    beforeEach(async () => {
      newBox();
      systemd = join(box.root, 'systemd');
      mkdirSync(systemd);
      const r = await ctl(installer(), [...INSTALL, '--version', '1.0.0', '--data-dir', box.data, '--yes'], {
        env: { REMYRAL_CTL_SYSTEMD_DIR: systemd },
      });
      expect(r.code).toBe(0);
      setState({ users: 1 });
      installed = join(box.bin, 'remyral-ctl');
      writeFileSync(box.log, '');
    }, 120_000);

    it('the heartbeat names the request kinds and the releases on the host; the path unit watches every kind', () => {
      const beat = JSON.parse(readFileSync(join(box.data, 'host/status/applier.json'), 'utf8'));
      expect(beat.kinds).toEqual(expect.arrayContaining(['domain-change', 'upgrade', 'rollback']));
      expect(beat).toMatchObject({ current: '1.0.0', releases: ['1.0.0'] });
      const path = readFileSync(join(systemd, 'remyral-apply-pending.path'), 'utf8');
      for (const k of ['domain-change', 'upgrade', 'rollback'])
        expect(path).toContain(`PathChanged=${join(box.data, `host/requests/${k}.json`)}`);
      expect(readFileSync(join(systemd, 'remyral-apply-pending.service'), 'utf8')).toContain(
        'TimeoutStartSec=90min',
      );
    });

    it('upgrade: runs the upgrade code path (stop, backup, migrate, start, gate) and reports steps and the outcome', async () => {
      const req = await hostRequest('upgrade', {
        version: '1.1.0',
        fromVersion: '1.0.0',
        acceptBreaking: 'yes',
      });
      const r = await apply();
      expect(r.code).toBe(0);
      expect(existsSync(join(reqDir(), 'upgrade.json'))).toBe(false);
      expect(existsSync(join(reqDir(), 'upgrade.sig.json'))).toBe(false);
      const res = result('upgrade');
      expect(res).toMatchObject({
        kind: 'remyral-host-result/v1',
        request: 'upgrade',
        id: req.id,
        state: 'applied',
      });
      expect(res.detail).toMatch(/OK: Remyral 1\.1\.0 runs/);
      expect(res.step).toBe('health gate');
      expect(res.log.some((l) => l.includes('pre-upgrade backup'))).toBe(true);
      expect(res.log.join('\n')).not.toMatch(/PASSWORD|SECRET/i);
      expect(current()).toBe('1.1.0');
      const c = calls();
      const at = (needle) => c.findIndex((l) => l.includes(needle));
      expect(at('stop --time 20')).toBeGreaterThanOrEqual(0);
      expect(at('stop --time 20')).toBeLessThan(at('remyral-backup run --reason pre-upgrade'));
      expect(at('remyral-backup run')).toBeLessThan(at('run --rm --no-TTY migrate'));
      // The lock was held by the applier for the child and is released afterwards.
      expect(existsSync(join(box.data, '.lock'))).toBe(false);
      const beat = JSON.parse(readFileSync(join(box.data, 'host/status/applier.json'), 'utf8'));
      expect(beat).toMatchObject({ current: '1.1.0', previous: '1.0.0' });
      expect(beat.releases).toEqual(expect.arrayContaining(['1.0.0', '1.1.0']));
      expect(readFileSync(join(box.data, 'state/host-history'), 'utf8')).toMatch(/ upgrade applied /);
    });

    it('upgrade: breaking changes the owner did not confirm stop it before anything changes', async () => {
      await hostRequest('upgrade', { version: '1.1.0', fromVersion: '1.0.0', acceptBreaking: 'no' });
      await apply();
      expect(result('upgrade')).toMatchObject({ state: 'failed' });
      expect(result('upgrade').detail).toMatch(/re-run with --yes/);
      expect(current()).toBe('1.0.0');
      expect(calls().filter((l) => /^(stop|compose .* (up|run))/.test(l))).toEqual([]);
    });

    it('upgrade: an automatic rollback and a hold are reported as such', async () => {
      setState({ unhealthy: [ref('1.1.0', 'master')] });
      await hostRequest('upgrade', { version: '1.1.0', fromVersion: '1.0.0', acceptBreaking: 'yes' });
      await apply();
      expect(result('upgrade')).toMatchObject({ state: 'rolled_back' });
      expect(current()).toBe('1.0.0');
      setState({ unhealthy: [ref('1.1.0', 'master')], migrateTo: { '1.1.0': '9999' } });
      await hostRequest('upgrade', { version: '1.1.0', fromVersion: '1.0.0', acceptBreaking: 'yes' });
      await apply();
      expect(result('upgrade')).toMatchObject({ state: 'held' });
      expect(result('upgrade').detail).toMatch(/--restore-backup remana-prod-20261023T120000Z/);
    });

    it('rollback: to a release on the host; with a restore only when the backup and the separate flag are both given', async () => {
      await hostRequest('upgrade', { version: '1.1.0', fromVersion: '1.0.0', acceptBreaking: 'yes' });
      await apply();
      expect(current()).toBe('1.1.0');
      // A backup id without restoreDatabase=yes (or the reverse) is refused; so is a backup that is not on the host.
      await hostRequest('rollback', {
        version: '1.0.0',
        fromVersion: '1.1.0',
        backupId: 'remana-prod-20261023T120000Z',
        restoreDatabase: 'no',
      });
      await apply();
      expect(result('rollback')).toMatchObject({ state: 'refused' });
      expect(result('rollback').detail).toMatch(/both the backup id and restoreDatabase=yes/);
      await hostRequest('rollback', {
        version: '1.0.0',
        fromVersion: '1.1.0',
        backupId: 'remana-prod-20261023T120000Z',
        restoreDatabase: 'yes',
      });
      await apply();
      expect(result('rollback').detail).toMatch(/is not on this host/);
      writeFileSync(box.log, '');
      mkdirSync(join(box.data, 'backups/db'), { recursive: true });
      writeFileSync(join(box.data, 'backups/db/remana-prod-20261023T120000Z.dump'), 'dump');
      const req = await hostRequest('rollback', {
        version: '1.0.0',
        fromVersion: '1.1.0',
        backupId: 'remana-prod-20261023T120000Z',
        restoreDatabase: 'yes',
      });
      await apply();
      expect(result('rollback')).toMatchObject({ id: req.id, state: 'applied' });
      expect(current()).toBe('1.0.0');
      expect(calls().some((l) => l.includes('pg_restore'))).toBe(true);
      expect(calls().some((l) => l.includes('RENAME TO remyral_replaced_'))).toBe(true);
    });

    it('refuses a foreign signature, extra or nested fields, a stale or replayed request and values outside the rules', async () => {
      const foreign = keypair(join(box.root, 'other'));
      await hostRequest(
        'upgrade',
        { version: '1.1.0', fromVersion: '1.0.0', acceptBreaking: 'yes' },
        {},
        foreign.pem,
      );
      await apply();
      expect(result('upgrade')).toMatchObject({ id: '', state: 'refused' });
      expect(result('upgrade').detail).toMatch(/signature check failed/);
      // A domain-change signature does not open an upgrade (each kind has its own signature domain).
      const { createPrivateKey, sign, randomUUID } = await import('node:crypto');
      const key = createPrivateKey(readFileSync(join(box.data, 'secrets/lease-signing.pem')));
      const doc = {
        kind: 'remyral-host-upgrade/v1',
        id: randomUUID(),
        nonce: randomUUID().replaceAll('-', ''),
        version: '1.1.0',
        fromVersion: '1.0.0',
        acceptBreaking: 'yes',
        createdAt: iso(0),
        expiresAt: iso(60_000),
      };
      const bytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
      writeFileSync(
        join(reqDir(), 'upgrade.sig.json'),
        JSON.stringify({
          keyId: 'k',
          signature: sign(
            null,
            Buffer.concat([Buffer.from('remyral-host-domain-change/v1\n'), bytes]),
            key,
          ).toString('base64url'),
        }),
      );
      writeFileSync(join(reqDir(), 'upgrade.json'), bytes);
      await apply();
      expect(result('upgrade').detail).toMatch(/signature check failed/);
      // Signed by the master but shaped outside the rules (a compromised master): refused before any value is used.
      const base = () => ({ ...doc, id: randomUUID(), nonce: randomUUID().replaceAll('-', '') });
      for (const bad of [
        { ...base(), registry: 'evil.example.com' },
        { ...base(), version: ['1.1.0'] },
        { ...base(), version: '1.1.0" --skip-backup "' },
        { ...base(), acceptBreaking: undefined },
      ]) {
        await rawRequest('upgrade', bad);
        await apply();
        expect(result('upgrade'), JSON.stringify(bad)).toMatchObject({ state: 'refused' });
        expect(result('upgrade').detail).toMatch(/not a upgrade request/);
      }
      for (const [fields, why] of [
        [{ version: '1.1.0;touch pwned', fromVersion: '1.0.0', acceptBreaking: 'yes' }, /malformed version/],
        [
          { version: '1.1.0', fromVersion: '0.9.0', acceptBreaking: 'yes' },
          /made for 0\.9\.0 but this host runs 1\.0\.0/,
        ],
        [
          { version: '0.9.0', fromVersion: '1.0.0', acceptBreaking: 'yes' },
          /not newer than the running 1\.0\.0/,
        ],
        [
          { version: '1.1.0', fromVersion: '1.0.0', acceptBreaking: 'maybe' },
          /acceptBreaking must be yes or no/,
        ],
      ]) {
        await hostRequest('upgrade', fields);
        await apply();
        expect(result('upgrade'), JSON.stringify(fields)).toMatchObject({ state: 'refused' });
        expect(result('upgrade').detail).toMatch(why);
      }
      await hostRequest(
        'upgrade',
        { version: '1.1.0', fromVersion: '1.0.0', acceptBreaking: 'yes' },
        { expiresAt: iso(3 * 3600_000) },
      );
      await apply();
      expect(result('upgrade').detail).toMatch(/validity window/);
      await hostRequest(
        'upgrade',
        { version: '1.1.0', fromVersion: '1.0.0', acceptBreaking: 'yes' },
        { expiresAt: iso(-60_000) },
      );
      await apply();
      expect(result('upgrade').detail).toMatch(/expired/);
      await hostRequest('rollback', {
        version: '1.1.0',
        fromVersion: '1.0.0',
        backupId: '',
        restoreDatabase: 'no',
      });
      await apply();
      expect(result('rollback').detail).toMatch(/not a previous release kept on this host/);
      expect(existsSync(join(box.root, 'pwned'))).toBe(false);
      expect(calls().filter((l) => /^(stop|compose .* (up|run))/.test(l))).toEqual([]);
      expect(current()).toBe('1.0.0');
      // The same signed request twice: the second is a replay.
      const once = await hostRequest('upgrade', {
        version: '1.1.0',
        fromVersion: '1.0.0',
        acceptBreaking: 'no',
      });
      const bytesOnce = readFileSync(join(reqDir(), 'upgrade.json'));
      const sigOnce = readFileSync(join(reqDir(), 'upgrade.sig.json'));
      await apply();
      writeFileSync(join(reqDir(), 'upgrade.sig.json'), sigOnce);
      writeFileSync(join(reqDir(), 'upgrade.json'), bytesOnce);
      await apply();
      expect(result('upgrade')).toMatchObject({ id: once.id, state: 'refused' });
      expect(result('upgrade').detail).toMatch(/already used/);
    });
  },
);

// ---------------------------------------------------------------- backups from the console (p17-host-actions part 3)

describe('remyral-ctl apply-pending: backup requests (p17-host-actions part 3)', { timeout: 180_000 }, () => {
  let installed;
  let systemd;
  const reqDir = () => join(box.data, 'host/requests');
  const result = (kind) =>
    JSON.parse(readFileSync(join(box.data, 'host/status', `${kind}-result.json`), 'utf8'));
  const stackEnv = () => readFileSync(join(box.data, 'stack.env'), 'utf8');
  const beat = () => JSON.parse(readFileSync(join(box.data, 'host/status/applier.json'), 'utf8'));
  const apply = () =>
    ctl(installed, ['apply-pending', '--data-dir', box.data], {
      env: {
        REMYRAL_CTL_SYSTEMD_DIR: systemd,
        FAKE_RECIPIENTS_FILE: join(box.data, 'backup-config/recipients.txt'),
      },
    });
  const iso = (ms) => `${new Date(Date.now() + ms).toISOString().slice(0, 19)}Z`;
  const R1 = `age1${'q'.repeat(58)}`;
  const R2 = `age1${'p'.repeat(58)}`;
  const R3 = `age1${'z'.repeat(58)}`;
  const recipientsFile = () => join(box.data, 'backup-config/recipients.txt');
  const pendingFile = (c) => join(box.data, 'state/backup-pending', c);
  /** Moves the host's own first-seen time of a waiting change back by `s` seconds (time passing on the host). */
  const age = (change, s) => {
    const f = pendingFile(change);
    const text = readFileSync(f, 'utf8');
    const since = Number(/^since=(\d+)$/m.exec(text)[1]);
    writeFileSync(f, text.replace(/^since=\d+$/m, `since=${since - s}`));
  };
  const WAIT = 72 * 3600;
  const BACKUP = 'remana-prod-20261023T120000Z';
  const SECRET = 'Sup3rSecretValue/with+chars=';
  async function hostRequest(kind, fields) {
    const files = await import('../../apps/master/src/host-actions/files.ts');
    const { createPrivateKey, randomUUID, sign } = await import('node:crypto');
    const key = createPrivateKey(readFileSync(join(box.data, 'secrets/lease-signing.pem')));
    const signer = {
      signHostDocument: (context, bytes) => ({
        kid: 'k1',
        signature: sign(null, Buffer.concat([Buffer.from(`${context}\n`), bytes]), key).toString('base64url'),
      }),
    };
    const common = {
      id: randomUUID(),
      nonce: randomUUID().replaceAll('-', ''),
      createdAt: iso(0),
      expiresAt: iso(15 * 60_000),
    };
    await files.writeHostRequest(reqDir(), kind, common, fields, signer);
    return common;
  }
  const config = (over = {}) => ({
    time: '03:15',
    intervalMinutes: '',
    keepDaily: '10',
    keepWeekly: '6',
    keepMonthly: '12',
    keepRecentHours: '',
    drillEnabled: 'true',
    drillWeekday: 'sat',
    drillTime: '05:00',
    walArchive: 'off',
    recipients: `${R1},${R2}`,
    ...over,
  });
  const offsite = (over = {}) => ({
    mode: 'set',
    endpoint: 'https://acct.r2.cloudflarestorage.com',
    region: 'auto',
    bucket: 'remyral-backups',
    prefix: 'acme/prod',
    pathStyle: 'true',
    accessKeyId: 'AKIAEXAMPLE1234',
    secretAccessKey: SECRET,
    ...over,
  });

  beforeEach(async () => {
    newBox();
    systemd = join(box.root, 'systemd');
    mkdirSync(systemd);
    const r = await ctl(installer(), [...INSTALL, '--data-dir', box.data, '--yes'], {
      env: { REMYRAL_CTL_SYSTEMD_DIR: systemd },
    });
    expect(r.code).toBe(0);
    setState({ users: 1 });
    installed = join(box.bin, 'remyral-ctl');
    writeFileSync(box.log, '');
  }, 120_000);

  it('backup-run and backup-drill: the backup service runs them; the outcome and id come back', async () => {
    const run = await hostRequest('backup-run', { reason: 'panel-before-migration' });
    await apply();
    expect(result('backup-run')).toMatchObject({ id: run.id, state: 'applied' });
    expect(result('backup-run').detail).toBe(`backup ${BACKUP}: ok`);
    expect(calls().some((l) => l.includes('remyral-backup run --reason panel-before-migration'))).toBe(true);
    await hostRequest('backup-run', { reason: 'Before Migration; rm -rf /' });
    await apply();
    expect(result('backup-run')).toMatchObject({ state: 'refused' });
    const drill = await hostRequest('backup-drill', { backupId: BACKUP });
    await apply();
    expect(result('backup-drill')).toMatchObject({
      id: drill.id,
      state: 'applied',
      detail: `drill passed (${BACKUP})`,
    });
    expect(dockerState().drills).toEqual([BACKUP]);
    setState({ failDrill: true });
    await hostRequest('backup-drill', { backupId: '' });
    await apply();
    expect(result('backup-drill')).toMatchObject({ state: 'failed' });
    await hostRequest('backup-drill', { backupId: '../../etc/passwd' });
    await apply();
    expect(result('backup-drill')).toMatchObject({ state: 'refused', detail: 'malformed backup id' });
  });

  it('backup-restore: only a backup on this host with the separate flag; stop, restore, migrate, start, gate', async () => {
    await hostRequest('backup-restore', { backupId: BACKUP, restoreDatabase: 'yes' });
    await apply();
    expect(result('backup-restore')).toMatchObject({
      state: 'refused',
      detail: `backup ${BACKUP} is not on this host`,
    });
    mkdirSync(join(box.data, 'backups/db'), { recursive: true });
    writeFileSync(join(box.data, `backups/db/${BACKUP}.dump`), 'dump');
    await hostRequest('backup-restore', { backupId: BACKUP, restoreDatabase: 'no' });
    await apply();
    expect(result('backup-restore')).toMatchObject({ state: 'refused' });
    writeFileSync(box.log, '');
    const req = await hostRequest('backup-restore', { backupId: BACKUP, restoreDatabase: 'yes' });
    await apply();
    expect(result('backup-restore')).toMatchObject({ id: req.id, state: 'applied' });
    expect(result('backup-restore').detail).toMatch(
      new RegExp(`OK: Remyral 1\\.1\\.0 runs on backup ${BACKUP}`),
    );
    const c = calls();
    const at = (needle) => c.findIndex((l) => l.includes(needle));
    expect(at('stop master backup')).toBeGreaterThanOrEqual(0);
    expect(at('stop master backup')).toBeLessThan(at('pg_restore'));
    expect(at('pg_restore')).toBeLessThan(at('RENAME TO remyral_replaced_'));
    expect(at('RENAME TO remyral_replaced_')).toBeLessThan(at('run --rm --no-TTY migrate'));
    expect(at('run --rm --no-TTY migrate')).toBeLessThan(
      at('up -d --wait --wait-timeout 300 master web backup'),
    );
    expect(readFileSync(join(box.data, 'state/history'), 'utf8')).toMatch(
      new RegExp(`1\\.1\\.0 active \\S+ ${BACKUP}`),
    );
    expect(existsSync(join(box.data, '.lock'))).toBe(false);
  });

  it('backup-config: written into stack.env and recipients.txt, the backup service recreated; WAL also restarts Postgres', async () => {
    // Recipients the host does not use yet wait (Part 0): seed the two as the current set to test the immediate path.
    writeFileSync(recipientsFile(), `${R1}\n${R2}\n`);
    const req = await hostRequest('backup-config', config());
    await apply();
    expect(result('backup-config')).toMatchObject({ id: req.id, state: 'applied' });
    const env = stackEnv();
    for (const l of [
      'BACKUP_TIME=03:15',
      'BACKUP_INTERVAL_MINUTES=',
      'BACKUP_KEEP_DAILY=10',
      'BACKUP_KEEP_WEEKLY=6',
      'BACKUP_KEEP_MONTHLY=12',
      'BACKUP_DRILL_WEEKDAY=sat',
      'BACKUP_DRILL_TIME=05:00',
      'PG_WAL_ARCHIVE=off',
    ])
      expect(env.split('\n')).toContain(l);
    expect(readFileSync(join(box.data, 'backup-config/recipients.txt'), 'utf8')).toContain(`${R1}\n${R2}\n`);
    expect(calls().some((l) => /up -d --wait --wait-timeout 300 backup$/.test(l))).toBe(true);
    expect(beat().backup).toMatchObject({
      BACKUP_TIME: '03:15',
      BACKUP_KEEP_DAILY: '10',
      recipients: [R1, R2],
      offsite: '',
    });
    writeFileSync(box.log, '');
    await hostRequest('backup-config', config({ walArchive: 'on' }));
    await apply();
    expect(calls().some((l) => /up -d --wait --wait-timeout 300 postgres backup$/.test(l))).toBe(true);
    expect(stackEnv()).toContain('PG_WAL_ARCHIVE=on');
    // Values outside the rules: refused before anything is written.
    const before = stackEnv();
    for (const [over, why] of [
      [{ recipients: R1 }, /2 to 10 different encryption recipients/],
      [{ recipients: `${R1},${R1}` }, /2 to 10 different/],
      [{ recipients: `${R1},AGE-SECRET-KEY-1ABC` }, /not an age public key/],
      [{ time: '25:00' }, /time must be HH:MM/],
      [{ intervalMinutes: '5' }, /intervalMinutes/],
      [{ keepDaily: '0', keepWeekly: '0', keepMonthly: '0' }, /keeps nothing/],
      [{ drillWeekday: 'someday' }, /drillWeekday/],
      [{ walArchive: 'maybe' }, /walArchive/],
    ]) {
      await hostRequest('backup-config', config(over));
      await apply();
      expect(result('backup-config'), JSON.stringify(over)).toMatchObject({ state: 'refused' });
      expect(result('backup-config').detail).toMatch(why);
    }
    expect(stackEnv()).toBe(before);
    // The services do not come up with the new settings: both files are restored.
    setState({ failUp: ['backup'] });
    await hostRequest('backup-config', config({ time: '04:45' }));
    await apply();
    expect(result('backup-config')).toMatchObject({ state: 'failed' });
    expect(stackEnv()).toBe(before);
  });

  it('backup-offsite: the keys go only into offsite.env (root 0600) — never into the status, the heartbeat or a log', async () => {
    const req = await hostRequest('backup-offsite', offsite());
    await apply();
    // A first target waits on the host (Part 0); after the wait it is written.
    expect(result('backup-offsite')).toMatchObject({ id: req.id, state: 'scheduled' });
    age('offsite', WAIT);
    await apply();
    expect(beat().backup.changes.at(-1)).toMatchObject({ change: 'offsite', state: 'applied', id: req.id });
    expect(result('backup-offsite').detail).toContain(
      's3://remyral-backups/acme/prod/ @ acct.r2.cloudflarestorage.com',
    );
    const file = join(box.data, 'backup-config/offsite.env');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain(`BACKUP_S3_SECRET_ACCESS_KEY=${SECRET}`);
    expect(text).toContain('BACKUP_S3_ENDPOINT=https://acct.r2.cloudflarestorage.com');
    expect(text).toContain('BACKUP_S3_FORCE_PATH_STYLE=true');
    expect(beat().backup.offsite).toBe('s3://remyral-backups/acme/prod/ @ acct.r2.cloudflarestorage.com');
    const { readdirSync } = await import('node:fs');
    for (const dir of [join(box.data, 'host/status'), join(box.data, 'state'), reqDir()]) {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isFile()) expect(readFileSync(p, 'utf8'), p).not.toContain(SECRET);
      }
    }
    expect(readFileSync(box.log, 'utf8')).not.toContain(SECRET);
    for (const over of [
      { endpoint: 'http://acct.r2.cloudflarestorage.com' },
      { bucket: 'Bad_Bucket' },
      { prefix: '../escape' },
      { secretAccessKey: 'short' },
      { mode: 'append' },
    ]) {
      await hostRequest('backup-offsite', offsite(over));
      await apply();
      expect(result('backup-offsite'), JSON.stringify(over)).toMatchObject({ state: 'refused' });
    }
    expect(readFileSync(file, 'utf8')).toBe(text);
    await hostRequest(
      'backup-offsite',
      offsite({
        mode: 'clear',
        endpoint: '',
        region: '',
        bucket: '',
        prefix: '',
        pathStyle: '',
        accessKeyId: '',
        secretAccessKey: '',
      }),
    );
    await apply();
    expect(result('backup-offsite')).toMatchObject({ state: 'applied' });
    expect(existsSync(file)).toBe(false);
    expect(beat().backup.offsite).toBe('');
  });

  describe('the host time lock (p17-panel-settings Part 0)', () => {
    it('adding a recipient waits 72 h from the time the host first saw it — a backdated createdAt changes nothing', async () => {
      writeFileSync(recipientsFile(), `${R1}\n${R2}\n`);
      const before = Math.floor(Date.now() / 1000);
      // The master dates its request (signed) 3 days back: the host ignores it (and the 1-hour window refuses it).
      const files = await import('../../apps/master/src/host-actions/files.ts');
      const { createPrivateKey, randomUUID, sign } = await import('node:crypto');
      const key = createPrivateKey(readFileSync(join(box.data, 'secrets/lease-signing.pem')));
      const signer = {
        signHostDocument: (context, bytes) => ({
          kid: 'k1',
          signature: sign(null, Buffer.concat([Buffer.from(`${context}\n`), bytes]), key).toString(
            'base64url',
          ),
        }),
      };
      const old = {
        id: randomUUID(),
        nonce: randomUUID().replaceAll('-', ''),
        createdAt: iso(-WAIT * 1000),
        expiresAt: iso(15 * 60_000),
      };
      await files.writeHostRequest(
        reqDir(),
        'backup-config',
        old,
        config({ recipients: `${R1},${R2},${R3}` }),
        signer,
      );
      await apply();
      expect(result('backup-config')).toMatchObject({ id: old.id, state: 'refused' });
      expect(existsSync(pendingFile('recipients'))).toBe(false);
      // A request within the window: the wait starts when the host saw it.
      const req = await hostRequest(
        'backup-config',
        config({ keepDaily: '9', recipients: `${R1},${R2},${R3}` }),
      );
      await apply();
      expect(result('backup-config')).toMatchObject({ id: req.id, state: 'scheduled' });
      expect(result('backup-config').detail).toMatch(
        /adding 1 encryption recipient\(s\) waits until \S+ \(host time lock\)/,
      );
      const since = Number(/^since=(\d+)$/m.exec(readFileSync(pendingFile('recipients'), 'utf8'))[1]);
      expect(since).toBeGreaterThanOrEqual(before);
      expect(statSync(join(box.data, 'state/backup-pending')).mode & 0o777).toBe(0o700);
      // Everything else applied at once; the recipients did not change.
      expect(stackEnv().split('\n')).toContain('BACKUP_KEEP_DAILY=9');
      expect(readFileSync(recipientsFile(), 'utf8')).not.toContain(R3);
      const p = beat().backup.pending;
      expect(p).toHaveLength(1);
      expect(p[0]).toMatchObject({ change: 'recipients', id: req.id, added: [R3], target: '' });
      expect(Date.parse(p[0].until) - Date.parse(p[0].since)).toBe(WAIT * 1000);
      // A backup taken during the wait is encrypted to the old recipients only.
      await hostRequest('backup-run', { reason: 'during-the-wait' });
      await apply();
      expect(dockerState().backups.at(-1).recipients).toEqual([R1, R2]);
      // 71 h later: still waiting. The same request again keeps the host's first-seen time.
      age('recipients', WAIT - 3600);
      const again = await hostRequest(
        'backup-config',
        config({ keepDaily: '9', recipients: `${R1},${R2},${R3}` }),
      );
      await apply();
      expect(readFileSync(recipientsFile(), 'utf8')).not.toContain(R3);
      expect(
        Number(/^since=(\d+)$/m.exec(readFileSync(pendingFile('recipients'), 'utf8'))[1]),
      ).toBeLessThanOrEqual(since - (WAIT - 3600));
      // 72 h after the host first saw it: applied by the next run.
      age('recipients', 3600);
      await apply();
      expect(readFileSync(recipientsFile(), 'utf8')).toContain(`${R1}\n${R2}\n${R3}\n`);
      expect(existsSync(pendingFile('recipients'))).toBe(false);
      expect(beat().backup.pending).toEqual([]);
      expect(beat().backup.changes.at(-1)).toMatchObject({
        change: 'recipients',
        state: 'applied',
        id: again.id,
      });
      await hostRequest('backup-run', { reason: 'after-the-wait' });
      await apply();
      expect(dockerState().backups.at(-1).recipients).toEqual([R1, R2, R3]);
    });

    it('a new recipient in a later request starts the wait again; removing one and a request without additions are immediate', async () => {
      writeFileSync(recipientsFile(), `${R1}\n${R2}\n${R3}\n`);
      // Removal: immediate.
      await hostRequest('backup-config', config({ recipients: `${R1},${R2}` }));
      await apply();
      expect(result('backup-config')).toMatchObject({ state: 'applied' });
      expect(readFileSync(recipientsFile(), 'utf8')).not.toContain(R3);
      // Add R3 back + remove R2 (two current keys would not stay): nothing changes now, the whole set waits.
      const R4 = `age1${'x'.repeat(58)}`;
      await hostRequest('backup-config', config({ recipients: `${R1},${R3}` }));
      await apply();
      expect(result('backup-config')).toMatchObject({ state: 'scheduled' });
      expect(readFileSync(recipientsFile(), 'utf8')).toContain(`${R1}\n${R2}\n`);
      age('recipients', WAIT - 60);
      // Another new key: the wait restarts from now.
      await hostRequest('backup-config', config({ recipients: `${R1},${R2},${R4}` }));
      await apply();
      age('recipients', 120);
      await apply();
      expect(readFileSync(recipientsFile(), 'utf8')).not.toContain(R4);
      expect(beat().backup.pending[0].added).toEqual([R4]);
      // The owner saves without the addition: the waiting change is withdrawn.
      await hostRequest('backup-config', config({ recipients: `${R1},${R2}` }));
      await apply();
      expect(result('backup-config').detail).toMatch(/withdrawn/);
      expect(beat().backup.pending).toEqual([]);
      expect(beat().backup.changes.at(-1)).toMatchObject({ change: 'recipients', state: 'superseded' });
    });

    it('an off-site target change waits (the copies keep their target); prefix-only changes and clear are immediate', async () => {
      const req = await hostRequest('backup-offsite', offsite());
      await apply();
      age('offsite', WAIT);
      await apply();
      const file = join(box.data, 'backup-config/offsite.env');
      expect(readFileSync(file, 'utf8')).toContain('BACKUP_S3_BUCKET=remyral-backups');
      expect(beat().backup.changes.at(-1)).toMatchObject({ id: req.id, state: 'applied' });
      // Same bucket and keys, another prefix: immediate.
      await hostRequest('backup-offsite', offsite({ prefix: 'acme/other' }));
      await apply();
      expect(result('backup-offsite')).toMatchObject({ state: 'applied' });
      expect(readFileSync(file, 'utf8')).toContain('BACKUP_S3_PREFIX=acme/other');
      // Another bucket, another key or endpoint: waits; the file keeps the old target.
      for (const over of [
        { bucket: 'evil-bucket' },
        { accessKeyId: 'AKIAOTHER5678' },
        { secretAccessKey: 'An0therSecretValue' },
        { endpoint: 'https://evil.example.com' },
      ]) {
        await hostRequest('backup-offsite', offsite({ prefix: 'acme/other', ...over }));
        await apply();
        expect(result('backup-offsite'), JSON.stringify(over)).toMatchObject({ state: 'scheduled' });
        expect(readFileSync(file, 'utf8')).toContain('BACKUP_S3_BUCKET=remyral-backups');
        expect(readFileSync(file, 'utf8')).toContain('BACKUP_S3_ACCESS_KEY_ID=AKIAEXAMPLE1234');
      }
      expect(statSync(pendingFile('offsite.env')).mode & 0o777).toBe(0o600);
      expect(beat().backup.pending[0]).toMatchObject({
        change: 'offsite',
        target: 's3://remyral-backups/acme/other/ @ evil.example.com',
      });
      expect(JSON.stringify(beat())).not.toContain('AKIA');
      // Clear: immediate, and the waiting change goes with it.
      await hostRequest(
        'backup-offsite',
        offsite({
          mode: 'clear',
          endpoint: '',
          region: '',
          bucket: '',
          prefix: '',
          pathStyle: '',
          accessKeyId: '',
          secretAccessKey: '',
        }),
      );
      await apply();
      expect(existsSync(file)).toBe(false);
      expect(existsSync(pendingFile('offsite.env'))).toBe(false);
      expect(beat().backup.pending).toEqual([]);
    });

    it('backup-change-cancel withdraws a waiting change (signed like the others); status names it; the operator can confirm', async () => {
      writeFileSync(recipientsFile(), `${R1}\n${R2}\n`);
      await hostRequest('backup-config', config({ recipients: `${R1},${R2},${R3}` }));
      await hostRequest('backup-offsite', offsite());
      await apply();
      await apply();
      expect(
        beat()
          .backup.pending.map((p) => p.change)
          .sort(),
      ).toEqual(['offsite', 'recipients']);
      expect(beat().kinds).toContain('backup-change-cancel');
      const st = await ctl(installed, ['status', '--data-dir', box.data]);
      expect(st.stdout).toMatch(/WAITING {3}backup recipients change from the console: takes effect /);
      expect(st.stdout).toMatch(/WAITING {3}backup offsite change/);
      expect(st.stdout).not.toContain(SECRET);
      // A cancel with a foreign field or value is refused; a valid one withdraws only what it names.
      await hostRequest('backup-change-cancel', { change: 'everything' });
      await apply();
      expect(result('backup-change-cancel')).toMatchObject({ state: 'refused' });
      const c = await hostRequest('backup-change-cancel', { change: 'recipients' });
      await apply();
      expect(result('backup-change-cancel')).toMatchObject({
        id: c.id,
        state: 'applied',
        detail: 'cancelled: recipients',
      });
      expect(existsSync(pendingFile('recipients'))).toBe(false);
      age('offsite', WAIT); // a cancelled change never applies; the other one still does
      // The operator on the host confirms the off-site one at once instead of waiting.
      const r = await ctl(installed, ['backup-change', 'confirm', '--yes', '--data-dir', box.data]);
      expect(r.code).toBe(0);
      expect(readFileSync(recipientsFile(), 'utf8')).not.toContain(R3);
      expect(readFileSync(join(box.data, 'backup-config/offsite.env'), 'utf8')).toContain(
        'BACKUP_S3_BUCKET=remyral-backups',
      );
      expect(beat().backup.changes.map((x) => `${x.change}:${x.state}`)).toEqual([
        'recipients:cancelled',
        'offsite:applied',
      ]);
      await hostRequest('backup-change-cancel', { change: 'all' });
      await apply();
      expect(result('backup-change-cancel')).toMatchObject({
        state: 'applied',
        detail: 'nothing was waiting',
      });
    });
  });
});

describe('remyral-ctl (source tree)', { timeout: 60_000 }, () => {
  it('a source copy carries no release keys and refuses to install', async () => {
    newBox();
    const r = await ctl(join(ROOT, 'infra/selfhost/remyral-ctl'), [
      ...INSTALL,
      '--release-url',
      'https://releases.test',
      '--data-dir',
      box.data,
      '--yes',
    ]);
    expect(r.stderr).toMatch(/carries no release keys/);
  });

  it('shellcheck-clean when shellcheck is installed', () => {
    let have = true;
    try {
      execFileSync('shellcheck', ['--version'], { stdio: 'ignore' });
    } catch {
      have = false;
    }
    if (!have) return; // UNVERIFIED here: shellcheck is not installed on this machine (docs/design §9)
    execFileSync('shellcheck', ['-s', 'bash', join(ROOT, 'infra/selfhost/remyral-ctl')], {
      stdio: 'inherit',
    });
  });
});
