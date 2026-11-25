import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../deploy/deploy.mjs', import.meta.url));
const COMMIT = '0123456789ab' + 'c'.repeat(28);
const TAG = COMMIT.slice(0, 12);
const OLD = 'aaaaaaaaaaaa';
const work = mkdtempSync(join(tmpdir(), 'remyral-deploy-dry-'));

// A fake `ssh`/`rsync` first on PATH: if the dry run tried to reach the host, the marker file appears.
const bin = join(work, 'bin');
const marker = join(work, 'contacted');
mkdirSync(bin, { recursive: true });
for (const name of ['ssh', 'rsync']) {
  writeFileSync(join(bin, name), `#!/bin/sh\necho "$0 $*" >> '${marker}'\nexit 99\n`);
  chmodSync(join(bin, name), 0o755);
}

const stateFile = join(work, 'state.json');
writeFileSync(
  stateFile,
  JSON.stringify({
    prod: {
      env: 'prod',
      current: OLD,
      history: [{ tag: OLD, status: 'active', migrations: '0020', srcDir: `/opt/remyral-src-${OLD}` }],
    },
  }),
);

// The installation's values come only from configuration (example.test here); the caller's own REMYRAL_* are dropped.
const CONFIG = {
  REMYRAL_DEPLOY_HOST: 'deploy.example.test',
  REMYRAL_DEPLOY_DOMAIN_PROD: 'console.example.test',
  REMYRAL_DEPLOY_DOMAIN_STAGING: 'console-staging.example.test',
};

function dryRun(args, config = CONFIG) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('REMYRAL_')));
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      {
        env: {
          ...env,
          ...config,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          REMYRAL_DEPLOY_KEY: join(work, 'no-key.pem'),
        },
      },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('deploy.mjs --dry-run --offline', () => {
  it('prints every step in order, pins images by ID, and contacts nothing', async () => {
    const r = await dryRun([
      'deploy',
      '--dry-run',
      '--offline',
      '--env',
      'prod',
      '--commit',
      COMMIT,
      '--tag',
      TAG,
      '--state-file',
      stateFile,
    ]);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    const titles = r.stdout
      .split('\n')
      .filter((l) => /^\[\s*\d+\]/.test(l))
      .map((l) => l.replace(/^\[\s*\d+\] /, ''));
    const expectOrder = [
      /^preflight/,
      /^ssh reachability/,
      /^read deploy state/,
      /^export commit/,
      /^rsync tree → deploy\.example\.test:\/opt\/remyral-src-0123456789ab/,
      /^build remyral-master:0123456789ab/,
      /^build remyral-web:0123456789ab/,
      /^build remyral-backup:0123456789ab/,
      /^pin the new images/,
      /^record image IDs and sign/,
      /^verify signed record/,
      /^read schema version$/,
      /^pre-deploy backup/,
      /^write \/data\/remyral\/prod\/deploy\/release.env.next/,
      /^migrate/,
      /^read schema version after migrate/,
      /^roll master \+ web \(remyral-prod\)/,
      /^health gate/,
      /^activate 0123456789ab/,
      /^write deploy state/,
      /^prune releases/,
    ];
    expect(titles).toHaveLength(expectOrder.length);
    titles.forEach((t, i) => expect(t).toMatch(expectOrder[i]));
    expect(r.stdout).toContain(`rollback target ${OLD}`);
    expect(r.stdout).toContain('--no-deps master web');
    expect(r.stdout).toContain(
      '--env-file /data/remyral/prod/stack.env --env-file /data/remyral/prod/deploy/release.env.next',
    );
    expect(r.stdout).toContain(
      'curl -sk --resolve console.example.test:443:127.0.0.1 https://console.example.test/api/auth/session → 401',
    );
    expect(r.stdout).toContain('REMYRAL_MASTER_IMAGE=<master image id>');
    // p10-backup-restore: the backup image is built from infra/backup/Dockerfile, pinned and started with the release.
    expect(r.stdout).toContain(
      '-f /opt/remyral-src-0123456789ab/infra/backup/Dockerfile -t remyral-backup:0123456789ab',
    );
    expect(r.stdout).toContain('REMYRAL_BACKUP_IMAGE=<backup image id>');
    expect(r.stdout).toContain('up -d --no-deps backup');
    expect(existsSync(marker)).toBe(false);
  });

  it('staging uses its own project, domain and directories', async () => {
    const r = await dryRun([
      'deploy',
      '--dry-run',
      '--offline',
      '--env',
      'staging',
      '--commit',
      COMMIT,
      '--state-file',
      stateFile,
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('remyral-staging');
    expect(r.stdout).toContain('https://console-staging.example.test/api/auth/session');
    expect(r.stdout).not.toContain('https://console.example.test/');
    expect(r.stdout).toContain('/data/remyral/staging/deploy/release.env.next');
    expect(r.stdout).not.toContain('/data/remyral/prod/');
    expect(r.stdout).toContain('rollback target none');
    expect(existsSync(marker)).toBe(false);
  });

  it('rollback dry run picks the previous healthy release', async () => {
    const s = JSON.parse(readFileSync(stateFile, 'utf8'));
    s.prod.history.unshift({
      tag: TAG,
      status: 'active',
      migrations: '0020',
      srcDir: `/opt/remyral-src-${TAG}`,
    });
    s.prod.history[1].status = 'superseded';
    s.prod.current = TAG;
    const f = join(work, 'state2.json');
    writeFileSync(f, JSON.stringify(s));
    const r = await dryRun(['rollback', '--dry-run', '--offline', '--env', 'prod', '--state-file', f]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`${TAG} → ${OLD}`);
    expect(r.stdout).toContain(`/opt/remyral-src-${OLD}/infra/coolify/compose.yaml`);
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses --offline without --dry-run and unknown environments', async () => {
    expect((await dryRun(['deploy', '--offline'])).stderr).toMatch(/only valid with --dry-run/);
    expect(
      (await dryRun(['deploy', '--dry-run', '--offline', '--env', 'qa', '--commit', COMMIT])).stderr,
    ).toMatch(/unknown environment/);
    expect(existsSync(marker)).toBe(false);
  });

  it('names the missing host or domain key and where to set it, before contacting anything', async () => {
    const args = ['deploy', '--dry-run', '--offline', '--env', 'prod', '--commit', COMMIT];
    const noHost = await dryRun(args, { REMYRAL_DEPLOY_DOMAIN_PROD: 'console.example.test' });
    expect(noHost.code).not.toBe(0);
    expect(noHost.stdout).toBe('');
    expect(noHost.stderr).toMatch(/no deploy host: pass --host <ssh alias> or export REMYRAL_DEPLOY_HOST=/);

    const noDomain = await dryRun(args, { REMYRAL_DEPLOY_HOST: 'deploy.example.test' });
    expect(noDomain.code).not.toBe(0);
    expect(noDomain.stdout).toBe('');
    expect(noDomain.stderr).toContain(
      'no domain for prod: add the line "REMYRAL_DEPLOY_DOMAIN_PROD=<domain>" to /etc/remyral/deploy.env on deploy.example.test',
    );
    expect(noDomain.stderr).toContain('or export REMYRAL_DEPLOY_DOMAIN_PROD=<domain> in this shell');

    // staging needs only its own domain; a rollback needs it too (health gate).
    const staging = await dryRun(
      ['deploy', '--dry-run', '--offline', '--env', 'staging', '--commit', COMMIT],
      {
        REMYRAL_DEPLOY_HOST: 'deploy.example.test',
        REMYRAL_DEPLOY_DOMAIN_STAGING: 'console-staging.example.test',
      },
    );
    expect(staging.code).toBe(0);
    const rollback = await dryRun(['rollback', '--dry-run', '--offline', '--env', 'staging'], {
      REMYRAL_DEPLOY_HOST: 'deploy.example.test',
    });
    expect(rollback.stderr).toMatch(/no domain for staging: .*REMYRAL_DEPLOY_DOMAIN_STAGING=<domain>/);

    // --host wins over the environment and keygen needs no host at all.
    const flag = await dryRun([...args, '--host', 'other.example.test'], CONFIG);
    expect(flag.stdout).toContain('via other.example.test');
    expect((await dryRun(['keygen'], {})).stderr).toMatch(/--out <dir> is required/);
    expect(existsSync(marker)).toBe(false);
  });
});
