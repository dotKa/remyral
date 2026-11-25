import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  backupPolicy,
  backupServiceRunArgs,
  canonicalJson,
  cmdline,
  composeArgs,
  decideRollback,
  envConfig,
  evaluateGate,
  installOverrides,
  isManagedSrcDir,
  makeRecordPayload,
  migrationsHead,
  parseState,
  pinCommand,
  pinName,
  previousRelease,
  protectedTags,
  pruneList,
  recordOutcome,
  recordRollback,
  releaseEnvText,
  requireDomain,
  resolveDeployHost,
  selectRollbackTarget,
  selectTag,
  shq,
  signRecord,
  srcDirFor,
  verifyRecord,
} from '../deploy/plan.mjs';

const SHA = 'a'.repeat(8) + '0123456789abcdef0123456789abcdef';
const T = (n) => n.toString(16).padStart(12, '0');
const id = (c) => `sha256:${c.repeat(64)}`;
const IMAGES = { master: id('1'), web: id('2') };

function state(env, current, entries) {
  return {
    env,
    current,
    history: entries.map(([tag, status, migrations = '0020']) => ({
      tag,
      status,
      migrations,
      srcDir: srcDirFor(tag),
    })),
  };
}

describe('envConfig', () => {
  it('namespaces prod and staging (project, data dir, domain, backup unit)', () => {
    const p = envConfig('prod', { domain: 'console.example.test' });
    const s = envConfig('staging', { domain: 'console-staging.example.test' });
    expect(p).toMatchObject({
      project: 'remyral-prod',
      stackEnv: '/data/remyral/prod/stack.env',
      domain: 'console.example.test',
      backupUnit: 'remyral-backup@prod.service',
      keep: 3,
    });
    expect(s).toMatchObject({
      project: 'remyral-staging',
      releaseEnv: '/data/remyral/staging/deploy/release.env',
      domain: 'console-staging.example.test',
    });
  });
  it('rejects unknown environments', () => {
    expect(() => envConfig('production')).toThrow(/unknown environment/);
    expect(() => envConfig('__proto__')).toThrow(/unknown environment/);
  });
  it('has no built-in domain; requireDomain names the exact key and both places to set it', () => {
    expect(envConfig('prod').domain).toBeUndefined();
    expect(requireDomain(envConfig('prod', { domain: 'console.example.test' }))).toBe('console.example.test');
    expect(() => requireDomain(envConfig('prod'), { host: 'deploy.example.test' })).toThrow(
      'no domain for prod: add the line "REMYRAL_DEPLOY_DOMAIN_PROD=<domain>" to /etc/remyral/deploy.env on deploy.example.test',
    );
    expect(() => requireDomain(envConfig('staging'))).toThrow(
      /REMYRAL_DEPLOY_DOMAIN_STAGING=<domain>.* on the deploy host .*or export REMYRAL_DEPLOY_DOMAIN_STAGING=<domain> in this shell/,
    );
  });
});

describe('deploy host', () => {
  it('--host wins over REMYRAL_DEPLOY_HOST; there is no default; unsafe values are refused', () => {
    expect(resolveDeployHost('a.example.test', { REMYRAL_DEPLOY_HOST: 'b.example.test' })).toBe(
      'a.example.test',
    );
    expect(resolveDeployHost(undefined, { REMYRAL_DEPLOY_HOST: 'admin@b.example.test' })).toBe(
      'admin@b.example.test',
    );
    for (const env of [{}, { REMYRAL_DEPLOY_HOST: '' }]) {
      expect(() => resolveDeployHost(undefined, env)).toThrow(
        /no deploy host: pass --host <ssh alias> or export REMYRAL_DEPLOY_HOST=<ssh alias>/,
      );
    }
    for (const bad of ['-oProxyCommand=x', 'a b', 'a;rm']) {
      expect(() => resolveDeployHost(bad, {}), bad).toThrow(/invalid deploy host/);
    }
  });
});

describe('tag selection', () => {
  it('tag = first 12 hex chars of HEAD', () => {
    expect(selectTag({ fullSha: SHA, porcelain: '' })).toBe(SHA.slice(0, 12));
  });
  it('refuses a dirty tree', () => {
    expect(() => selectTag({ fullSha: SHA, porcelain: ' M apps/master/src/app.ts\n' })).toThrow(/not clean/);
  });
  it('refuses a --tag that is not HEAD and malformed shas', () => {
    expect(() => selectTag({ fullSha: SHA, porcelain: '', requested: 'bbbbbbbbbbbb' })).toThrow(
      /does not match HEAD/,
    );
    expect(() => selectTag({ fullSha: 'HEAD', porcelain: '' })).toThrow(/not a commit sha/);
  });
  it('source dirs are derived only from valid tags', () => {
    expect(srcDirFor(T(1))).toBe(`/opt/remyral-src-${T(1)}`);
    expect(() => srcDirFor('../../etc')).toThrow(/invalid release tag/);
    expect(isManagedSrcDir(`/opt/remyral-src-${T(1)}`)).toBe(true);
    expect(isManagedSrcDir('/opt/remyral-src')).toBe(false);
    expect(isManagedSrcDir('/opt/remyral-src-x/../../')).toBe(false);
  });
  it('migrationsHead picks the highest NNNN_name.sql', () => {
    expect(
      migrationsHead(['0002_auth.sql', '0020_interactive_sessions.sql', '0003_jobs.sql', 'README.md']),
    ).toBe('0020');
    expect(migrationsHead([])).toBe('');
  });
});

describe('rollback decision', () => {
  const previous = { tag: T(1) };
  it('keeps a release that passed the gate', () => {
    expect(
      decideRollback({ gateOk: true, previous, migrationsBefore: '0020', migrationsAfter: '0021' }).action,
    ).toBe('keep');
  });
  it('rolls back automatically when the schema did not change', () => {
    expect(
      decideRollback({ gateOk: false, previous, migrationsBefore: '0020', migrationsAfter: '0020' }),
    ).toMatchObject({ action: 'rollback', to: T(1) });
  });
  it('holds (no automatic downgrade) when migrations were applied', () => {
    const d = decideRollback({ gateOk: false, previous, migrationsBefore: '0020', migrationsAfter: '0021' });
    expect(d.action).toBe('hold');
    expect(d.reason).toMatch(/downgrade refused/);
  });
  it('holds when there is nothing to roll back to', () => {
    expect(
      decideRollback({ gateOk: false, previous: null, migrationsBefore: '0020', migrationsAfter: '0020' })
        .action,
    ).toBe('hold');
  });
  it('previousRelease skips failed releases and the excluded tag', () => {
    const s = state('prod', T(3), [
      [T(3), 'active'],
      [T(2), 'failed'],
      [T(1), 'superseded'],
    ]);
    expect(previousRelease(s, T(3))?.tag).toBe(T(1));
    expect(previousRelease(s, T(9))?.tag).toBe(T(3));
  });
  it('manual rollback target: explicit healthy tag, else newest healthy before current', () => {
    const s = state('prod', T(3), [
      [T(3), 'active'],
      [T(2), 'failed'],
      [T(1), 'superseded'],
    ]);
    expect(selectRollbackTarget(s).tag).toBe(T(1));
    expect(selectRollbackTarget(s, T(1)).tag).toBe(T(1));
    expect(() => selectRollbackTarget(s, T(2))).toThrow(/failed its health gate/);
    expect(() => selectRollbackTarget(s, T(3))).toThrow(/already the current/);
    expect(() => selectRollbackTarget(s, T(7))).toThrow(/never deployed/);
    expect(() => selectRollbackTarget(state('prod', null, []))).toThrow(/nothing deployed/);
  });
});

describe('backup policy before migrating', () => {
  it('runs the unit when installed', () => {
    expect(backupPolicy({ unitInstalled: true, pendingMigrations: true, skip: false }).action).toBe('run');
  });
  it('refuses to migrate without a backup unit, warns otherwise, honours --skip-backup', () => {
    expect(backupPolicy({ unitInstalled: false, pendingMigrations: true, skip: false }).action).toBe('abort');
    expect(backupPolicy({ unitInstalled: false, pendingMigrations: false, skip: false }).action).toBe('warn');
    expect(backupPolicy({ unitInstalled: false, pendingMigrations: true, skip: true }).action).toBe('skip');
  });
  it('p10: prefers the running backup service over the host unit', () => {
    expect(
      backupPolicy({ serviceRunning: true, unitInstalled: true, pendingMigrations: true, skip: false }),
    ).toMatchObject({
      action: 'run',
      via: 'service',
    });
    expect(
      backupPolicy({ serviceRunning: false, unitInstalled: true, pendingMigrations: true, skip: false }).via,
    ).toBe('unit');
    expect(backupServiceRunArgs('abcdef012345')).toEqual([
      'docker',
      'exec',
      'abcdef012345',
      'remyral-backup',
      'run',
      '--reason',
      'pre-deploy',
    ]);
    expect(() => backupServiceRunArgs('x; rm -rf /')).toThrow(/container id/);
  });
});

describe('p10: backup image in the release record', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const withBackup = { ...IMAGES, backup: id('3') };
  const payload = makeRecordPayload({
    env: 'prod',
    tag: T(9),
    commit: SHA,
    images: withBackup,
    migrations: '0075',
    builtAt: '2026-10-18T00:00:00.000Z',
    host: 'deploy.example.test',
  });
  it('signs and verifies the backup image like master/web; older records stay valid without it', () => {
    expect(payload.images).toEqual(withBackup);
    const rec = signRecord(payload, privateKey);
    expect(verifyRecord(rec, [publicKey], withBackup).ok).toBe(true);
    expect(verifyRecord(rec, [publicKey], { ...withBackup, backup: id('4') }).reason).toMatch(/backup image/);
    const old = signRecord({ ...payload, images: IMAGES }, privateKey);
    expect(verifyRecord(old, [publicKey], IMAGES).ok).toBe(true);
    expect(() =>
      makeRecordPayload({ ...payload, images: { ...IMAGES, backup: 'remyral-backup:latest' } }),
    ).toThrow(/backup/);
  });
  it('release.env pins the backup image when the release has one', () => {
    expect(releaseEnvText({ tag: T(9), images: withBackup })).toContain(`REMYRAL_BACKUP_IMAGE=${id('3')}\n`);
    expect(releaseEnvText({ tag: T(9), images: IMAGES })).not.toContain('REMYRAL_BACKUP_IMAGE');
  });
});

describe('prune list', () => {
  it('keeps current + newest healthy releases per environment and the in-flight tag', () => {
    const prod = state('prod', T(5), [
      [T(5), 'active'],
      [T(4), 'failed'],
      [T(3), 'superseded'],
      [T(2), 'superseded'],
      [T(1), 'superseded'],
    ]);
    const staging = state('staging', T(1), [[T(1), 'active']]);
    expect([...protectedTags(prod, 3)]).toEqual([T(5), T(3), T(2)]);
    const hostTags = [T(1), T(2), T(3), T(4), T(5), T(6), 'latest', 'local'];
    expect(pruneList({ hostTags, states: [prod, staging], keep: 3, inFlight: [T(6)] })).toEqual([T(4)]);
    expect(pruneList({ hostTags, states: [prod], keep: 2 })).toEqual([T(1), T(2), T(4), T(6)]);
  });
  it('never lists non-tag names (latest, local, legacy dirs)', () => {
    expect(pruneList({ hostTags: ['latest', 'e2e', '<none>'], states: [], keep: 3 })).toEqual([]);
  });
});

describe('pin containers', () => {
  it('names one stopped container per image ref, valid as a container name', () => {
    expect(pinName('remyral-master:0123456789ab')).toBe('remyral-pin-remyral-master-0123456789ab');
    expect(pinName('remyral-master:0123456789ab')).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
  });
  it('replaces the pin (a rebuilt tag), never starts it, labels it and keeps it off the network', () => {
    const c = pinCommand('remyral-web:0123456789ab');
    expect(c).toContain('docker rm -f remyral-pin-remyral-web-0123456789ab');
    expect(c).toContain('docker create --name remyral-pin-remyral-web-0123456789ab');
    expect(c).toContain('--label tech.remyral.deploy.pin=true --network none remyral-web:0123456789ab');
    expect(c).not.toMatch(/docker (run|start)/);
  });
});

describe('state bookkeeping', () => {
  it('a new active release supersedes the old one', () => {
    const s0 = state('prod', T(1), [[T(1), 'active']]);
    const s1 = recordOutcome(s0, {
      tag: T(2),
      outcome: 'active',
      at: 'now',
      images: IMAGES,
      migrations: '0021',
      srcDir: srcDirFor(T(2)),
    });
    expect(s1.current).toBe(T(2));
    expect(s1.history.map((h) => [h.tag, h.status])).toEqual([
      [T(2), 'active'],
      [T(1), 'superseded'],
    ]);
  });
  it('a failed release does not change current', () => {
    const s0 = state('prod', T(1), [[T(1), 'active']]);
    const s1 = recordOutcome(s0, {
      tag: T(2),
      outcome: 'failed',
      at: 'now',
      images: IMAGES,
      migrations: '0020',
      srcDir: srcDirFor(T(2)),
    });
    expect(s1.current).toBe(T(1));
    expect(s1.history[0]).toMatchObject({ tag: T(2), status: 'failed' });
  });
  it('rollback re-activates the target', () => {
    const s = recordRollback(
      state('prod', T(2), [
        [T(2), 'active'],
        [T(1), 'superseded'],
      ]),
      { from: T(2), to: T(1), at: 'now' },
    );
    expect(s.current).toBe(T(1));
    expect(s.history.map((h) => [h.tag, h.status])).toEqual([
      [T(1), 'active'],
      [T(2), 'rolled_back'],
    ]);
  });
  it('parseState rejects other environments and junk', () => {
    expect(parseState('prod', '')).toEqual({ env: 'prod', current: null, history: [] });
    expect(() => parseState('prod', JSON.stringify({ env: 'staging', current: null, history: [] }))).toThrow(
      /malformed/,
    );
    expect(() =>
      parseState(
        'prod',
        JSON.stringify({ env: 'prod', current: null, history: [{ tag: 'x', status: 'active' }] }),
      ),
    ).toThrow(/invalid release tag/);
  });
});

describe('health gate', () => {
  const good = {
    masterHealth: 'healthy',
    webHealth: 'healthy',
    masterImage: IMAGES.master,
    webImage: IMAGES.web,
    session: '401',
    rootMarkers: 1,
    healthz: '404',
  };
  it('passes when everything matches', () => {
    expect(evaluateGate(good, IMAGES)).toEqual({ ok: true, failures: [] });
  });
  it('fails on unhealthy containers, foreign images, public probes or a broken console', () => {
    const r = evaluateGate(
      {
        ...good,
        masterHealth: 'starting',
        webImage: id('3'),
        healthz: '200',
        rootMarkers: 0,
        session: '502',
      },
      IMAGES,
    );
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(5);
  });
});

describe('release records (signing)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const other = generateKeyPairSync('ed25519');
  const payload = makeRecordPayload({
    env: 'prod',
    tag: T(7),
    commit: SHA,
    images: IMAGES,
    migrations: '0020',
    builtAt: '2026-10-13T00:00:00Z',
    host: 'deploy.example.test',
  });

  it('canonical JSON is independent of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: 'z' } })).toBe(
      '{"a":{"c":"z","d":[1,{"x":1,"y":2}]},"b":1}',
    );
  });
  it('a signed record verifies with the right key and the same image IDs', () => {
    const rec = signRecord(payload, privateKey);
    expect(verifyRecord(rec, [publicKey], { ...IMAGES }).ok).toBe(true);
    // round trip through JSON (as stored on the host)
    expect(verifyRecord(JSON.parse(JSON.stringify(rec)), [publicKey]).ok).toBe(true);
  });
  it('detects a substituted image, an edited record and an untrusted key', () => {
    const rec = signRecord(payload, privateKey);
    expect(verifyRecord(rec, [publicKey], { ...IMAGES, web: id('9') })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/web image on the host/),
    });
    const edited = { ...rec, payload: { ...rec.payload, images: { ...IMAGES, master: id('9') } } };
    expect(verifyRecord(edited, [publicKey]).reason).toMatch(/does not verify/);
    expect(verifyRecord(rec, [other.publicKey]).reason).toMatch(/untrusted key/);
    expect(verifyRecord({ payload }, [publicKey]).ok).toBe(false);
  });
  it('validates payload fields', () => {
    expect(() =>
      makeRecordPayload({ ...payload, images: { master: 'remyral-master:latest', web: IMAGES.web } }),
    ).toThrow(/image id/);
    expect(() => makeRecordPayload({ ...payload, commit: 'abc' })).toThrow(/full sha/);
  });
});

describe('remote command construction', () => {
  it('quotes anything that is not a plain word', () => {
    expect(shq('remyral-prod')).toBe('remyral-prod');
    expect(shq("it's; rm -rf /")).toBe(`'it'\\''s; rm -rf /'`);
    expect(shq('{{.Id}}')).toBe("'{{.Id}}'");
    expect(cmdline(['sudo', 'docker', 'image', 'inspect', '--format', '{{.Id}}', 'remyral-master:abc'])).toBe(
      "sudo docker image inspect --format '{{.Id}}' remyral-master:abc",
    );
  });
  it('release.env pins images by immutable ID; compose args put it after stack.env', () => {
    expect(releaseEnvText({ tag: T(7), images: IMAGES })).toBe(
      `REMYRAL_RELEASE_TAG=${T(7)}\nREMYRAL_MASTER_IMAGE=${IMAGES.master}\nREMYRAL_WEB_IMAGE=${IMAGES.web}\nREMYRAL_PULL_POLICY=never\n`,
    );
    const args = composeArgs(envConfig('staging'), { srcDir: srcDirFor(T(7)), releaseEnv: '/r.env' });
    expect(args.indexOf('/data/remyral/staging/stack.env')).toBeLessThan(args.indexOf('/r.env'));
    expect(args).toContain(`${srcDirFor(T(7))}/infra/coolify/compose.yaml`);
  });
});

describe('installation overrides (/etc/remyral/deploy.env)', () => {
  it('an installation can name its project, data dir and backup unit; {env} is substituted', () => {
    const o = installOverrides(
      '# names of this installation\nREMYRAL_DEPLOY_PROJECT=old-{env}\nREMYRAL_DEPLOY_DATA_DIR=/data/old/{env}\nREMYRAL_DEPLOY_BACKUP_UNIT=old-backup@{env}.service\n',
      'staging',
    );
    expect(o).toEqual({
      project: 'old-staging',
      dataDir: '/data/old/staging',
      backupUnit: 'old-backup@staging.service',
    });
    expect(envConfig('staging', o)).toMatchObject({
      project: 'old-staging',
      stackEnv: '/data/old/staging/stack.env',
      backupUnit: 'old-backup@staging.service',
    });
  });
  it('the deploy environment wins; unknown keys and unsafe values are refused', () => {
    expect(
      installOverrides('REMYRAL_DEPLOY_PROJECT=a-{env}\n', 'prod', { REMYRAL_DEPLOY_PROJECT: 'b-{env}' }),
    ).toEqual({
      project: 'b-prod',
    });
    expect(() => installOverrides('PATH=/tmp\n', 'prod')).toThrow(/unexpected line/);
    expect(() => installOverrides('REMYRAL_DEPLOY_DATA_DIR=/data/../etc\n', 'prod')).toThrow(/invalid value/);
    expect(() => installOverrides('REMYRAL_DEPLOY_PROJECT=x;rm\n', 'prod')).toThrow(/invalid value/);
    expect(installOverrides('', 'prod')).toEqual({});
  });
  it('each environment reads only its own domain key; the shell wins over the host file', () => {
    const text =
      'REMYRAL_DEPLOY_DOMAIN_PROD=console.example.test\nREMYRAL_DEPLOY_DOMAIN_STAGING=console-staging.example.test\n';
    expect(installOverrides(text, 'prod')).toEqual({ domain: 'console.example.test' });
    expect(installOverrides(text, 'staging')).toEqual({ domain: 'console-staging.example.test' });
    expect(installOverrides(text, 'prod', { REMYRAL_DEPLOY_DOMAIN_PROD: 'other.example.test' })).toEqual({
      domain: 'other.example.test',
    });
    expect(installOverrides('', 'staging', { REMYRAL_DEPLOY_DOMAIN_PROD: 'console.example.test' })).toEqual(
      {},
    );
    for (const bad of [
      'https://console.example.test',
      'console',
      'a..example.test',
      'x.example.test;rm',
      '-x.example.test',
    ]) {
      expect(() => installOverrides(`REMYRAL_DEPLOY_DOMAIN_PROD=${bad}\n`, 'prod'), bad).toThrow(
        /invalid value/,
      );
    }
  });
});
