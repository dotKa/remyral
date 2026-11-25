#!/usr/bin/env node
/* global setTimeout */
// Control-plane deploy from the owner's Mac to the EC2 host (p1-cicd, docs/ops/cicd.md).
//
//   node scripts/deploy/deploy.mjs [deploy] [--env prod|staging] [--verify] [--dry-run] [--skip-backup]
//                                  [--infra] [--rebuild] [--no-host-build] [--keep N]
//   node scripts/deploy/deploy.mjs rollback [--env …] [--to <tag>] [--dry-run]
//   node scripts/deploy/deploy.mjs status   [--env …]
//   node scripts/deploy/deploy.mjs keygen   --out <dir>
//
// Configuration (no installation's values live in this source):
//   - the ssh host: --host or REMYRAL_DEPLOY_HOST (required);
//   - the public domain of each environment: REMYRAL_DEPLOY_DOMAIN_PROD / REMYRAL_DEPLOY_DOMAIN_STAGING (required for
//     deploy and rollback);
//   - optionally the compose project, data dir and backup unit: REMYRAL_DEPLOY_PROJECT / _DATA_DIR / _BACKUP_UNIT
//     (`{env}` = prod | staging), else the defaults of a fresh install (remyral-<env>, /data/remyral/<env>).
// Every REMYRAL_DEPLOY_* key except the host may live in /etc/remyral/deploy.env on the host (read over ssh); the same
// variables in this script's environment win (and are the only source with --offline).
//
// deploy: clean tree → tag = HEAD short sha (12) → [pnpm verify] → git archive HEAD → rsync to
// /opt/remyral-src-<tag> → docker build on the host → record image IDs + Ed25519-sign the record → re-inspect
// and verify before rollout → pre-deploy backup → migrate → roll master + web (images pinned by ID via
// <deployDir>/release.env) → health gate (container health, image IDs, smoke curls through Traefik) →
// keep, or automatic rollback to the previous release (only when the schema did not advance) → prune
// releases beyond --keep (default 3). --dry-run prints every step and command and changes nothing;
// with --offline it does not contact the host at all (state from --state-file).
import { execFileSync, spawn } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  assertTag,
  backupPolicy,
  backupServiceRunArgs,
  cmdline,
  composeArgs,
  decideRollback,
  emptyState,
  envConfig,
  INSTALL_CONFIG,
  installOverrides,
  evaluateGate,
  isManagedSrcDir,
  makeRecordPayload,
  migrationsHead,
  parseState,
  previousRelease,
  TAG_RE,
  pinCommand,
  pinName,
  pruneList,
  requireDomain,
  resolveDeployHost,
  recordImageKeys,
  recordOutcome,
  recordRollback,
  releaseEnvText,
  selectRollbackTarget,
  selectTag,
  signRecord,
  srcDirFor,
  SSH_OPTS,
  tagOfSrcDir,
  verifyRecord,
} from './plan.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** Image repositories this deploy builds and prunes. */
const IMAGE_REPOS = ['remyral'];
const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    env: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    offline: { type: 'boolean', default: false },
    'state-file': { type: 'string' },
    tag: { type: 'string' },
    commit: { type: 'string' },
    to: { type: 'string' },
    verify: { type: 'boolean', default: false },
    'skip-backup': { type: 'boolean', default: false },
    infra: { type: 'boolean', default: false },
    rebuild: { type: 'boolean', default: false },
    // 2026-10-29: the 2-vCPU / 4 GB host cannot run the image builds any more (tsc swaps for half an hour and the live
    // master times out on Postgres): build off-host with scripts/deploy/build-local.mjs, then deploy with this flag.
    'no-host-build': { type: 'boolean', default: false },
    keep: { type: 'string' },
    host: { type: 'string' },
    key: { type: 'string' },
    out: { type: 'string' },
  },
});
const COMMAND = positionals[0] ?? 'deploy';
const DRY = opts['dry-run'];
const OFFLINE = opts.offline;
if (OFFLINE && !DRY) die('--offline is only valid with --dry-run');
let HOST = '';
if (COMMAND !== 'keygen') {
  try {
    HOST = resolveDeployHost(opts.host, process.env);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
}
const KEY_PATH =
  opts.key ?? process.env.REMYRAL_DEPLOY_KEY ?? join(homedir(), '.config/remyral/deploy-signing.pem');
const LOCAL_RECORDS = join(homedir(), '.local/state/remyral/deploy');

// ---------------------------------------------------------------- output / steps

let stepNo = 0;
function out(line) {
  process.stdout.write(`${line}\n`);
}
function die(message) {
  process.stderr.write(`deploy: ${message}\n`);
  process.exit(1);
}
/** Prints a numbered step (and its command); runs `fn` unless --dry-run, then returns `placeholder`. */
async function step(title, display, fn, placeholder) {
  stepNo += 1;
  out(`[${String(stepNo).padStart(2)}] ${title}`);
  for (const d of [display].flat().filter(Boolean)) out(`       $ ${d}`);
  if (DRY) return placeholder;
  return fn();
}
const note = (msg) => out(`       ${msg}`);

// ---------------------------------------------------------------- processes

function run(cmd, args, { input, inherit = false, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: inherit ? ['pipe', 'inherit', 'inherit'] : 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && !allowFail) {
        reject(
          new Error(`${cmd} exited ${String(code)}: ${stderr.trim().split('\n').slice(-4).join(' | ')}`),
        );
      } else resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
/** Runs one command line on the host (built only from validated values via cmdline/shq). */
const remote = (line, o) => run('ssh', [...SSH_OPTS, HOST, '--', line], o);
const sudo = (args) => cmdline(['sudo', ...args]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- keys

function loadSigningKey() {
  let st;
  try {
    st = statSync(KEY_PATH);
  } catch {
    die(
      `signing key ${KEY_PATH} not found — create one with: node scripts/deploy/deploy.mjs keygen --out ~/.config/remyral`,
    );
  }
  if ((st.mode & 0o077) !== 0) die(`${KEY_PATH} is readable by group/others; chmod 600 it`);
  const key = createPrivateKey(readFileSync(KEY_PATH));
  if (key.asymmetricKeyType !== 'ed25519') die(`${KEY_PATH} is not an Ed25519 key`);
  return key;
}
function trustedKeys(privateKey) {
  const keys = privateKey ? [createPublicKey(privateKey)] : [];
  const extra = process.env.REMYRAL_DEPLOY_TRUSTED;
  if (extra) {
    const pems =
      readFileSync(extra, 'utf8').match(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/g) ?? [];
    for (const p of pems) keys.push(createPublicKey(p));
  }
  return keys;
}

// ---------------------------------------------------------------- host queries

/**
 * Environment config with the installation's own names (host file /etc/remyral/deploy.env, this env wins). With
 * `needDomain` a missing domain stops here, before anything changes, with one error naming the key.
 */
async function resolveConfig(env, overrides = {}, { needDomain = false } = {}) {
  envConfig(env); // an unknown environment is refused before the host is contacted
  const text = OFFLINE
    ? ''
    : (await remote(sudo(['sh', '-c', `cat ${INSTALL_CONFIG} 2>/dev/null || true`]))).stdout;
  const cfg = envConfig(env, { ...overrides, ...installOverrides(text, env, process.env) });
  if (needDomain) requireDomain(cfg, { host: HOST });
  return cfg;
}

async function readStackEnv(cfg) {
  const r = await remote(sudo(['sh', '-c', `cat ${cfg.stackEnv} 2>/dev/null || true`]));
  return r.stdout;
}

/** The database of the environment (stack.env REMYRAL_DB_NAME, default remyral). */
async function dbName(cfg) {
  const text = OFFLINE ? '' : await readStackEnv(cfg);
  const m = /^REMYRAL_DB_NAME=([A-Za-z0-9_]{1,63})\s*$/m.exec(text);
  return m?.[1] ?? 'remyral';
}

async function readState(cfg) {
  if (OFFLINE) {
    const file = opts['state-file'];
    if (!file) return emptyState(cfg.env);
    const all = JSON.parse(readFileSync(file, 'utf8'));
    return parseState(cfg.env, all[cfg.env] ? JSON.stringify(all[cfg.env]) : '');
  }
  const r = await remote(sudo(['sh', '-c', `cat ${cfg.stateFile} 2>/dev/null || true`]));
  return parseState(cfg.env, r.stdout);
}
async function writeState(cfg, state) {
  const text = `${JSON.stringify(state, null, 2)}\n`;
  await step(
    `write deploy state (${state.current ?? 'none'} current)`,
    `sudo tee ${cfg.stateFile}`,
    async () => {
      await remote(sudo(['install', '-d', '-m', '0700', cfg.deployDir]));
      await writeRemoteFile(cfg.stateFile, text, '0600');
    },
  );
}
async function imageIds(refs) {
  const r = await remote(sudo(['docker', 'image', 'inspect', '--format', '{{.Id}}', ...refs]));
  const ids = r.stdout.trim().split('\n');
  if (ids.length !== refs.length) throw new Error(`could not inspect ${refs.join(', ')}`);
  return ids;
}
async function containerOf(cfg, service) {
  const r = await remote(
    sudo([
      'docker',
      'ps',
      '-q',
      '--filter',
      `label=com.docker.compose.project=${cfg.project}`,
      '--filter',
      `label=com.docker.compose.service=${service}`,
    ]),
  );
  return r.stdout.trim().split('\n').filter(Boolean)[0] ?? null;
}
async function dbMigrationsHead(cfg) {
  const pg = await containerOf(cfg, 'postgres');
  if (!pg) throw new Error(`no running postgres in ${cfg.project}`);
  const r = await remote(
    sudo([
      'docker',
      'exec',
      '-u',
      'postgres',
      pg,
      'psql',
      '-U',
      'postgres',
      '-d',
      await dbName(cfg),
      '-X',
      '-tAc',
      "SELECT coalesce(max(version), '') FROM schema_migrations",
    ]),
  );
  return r.stdout.trim();
}
/** Writes stdin to `path` atomically (tmp + rename) with the given mode, as root. */
async function writeRemoteFile(path, text, mode = '0644') {
  await remote(
    sudo([
      'sh',
      '-c',
      'umask 077; cat > "$1.tmp" && chmod "$2" "$1.tmp" && mv "$1.tmp" "$1"',
      'sh',
      path,
      mode,
    ]),
    {
      input: text,
    },
  );
}

/** Observes the health gate inputs on the host, retrying while Traefik picks up the new containers. */
async function healthGate(cfg, images) {
  const curl = (path, extra = []) =>
    sudo([
      'curl',
      '-sk',
      '--max-time',
      '10',
      '--resolve',
      `${cfg.domain}:443:127.0.0.1`,
      ...extra,
      `https://${cfg.domain}${path}`,
    ]);
  let last;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const obs = { masterHealth: 'missing', webHealth: 'missing', masterImage: '', webImage: '' };
    for (const svc of ['master', 'web']) {
      const id = await containerOf(cfg, svc);
      if (!id) continue;
      const r = await remote(
        sudo(['docker', 'inspect', '--format', '{{.State.Health.Status}} {{.Image}}', id]),
      );
      const [health, image] = r.stdout.trim().split(' ');
      obs[`${svc}Health`] = health;
      obs[`${svc}Image`] = image;
    }
    obs.session = (
      await remote(curl('/api/auth/session', ['-o', '/dev/null', '-w', '%{http_code}']), { allowFail: true })
    ).stdout.trim();
    obs.healthz = (
      await remote(curl('/api/healthz', ['-o', '/dev/null', '-w', '%{http_code}']), { allowFail: true })
    ).stdout.trim();
    const root = await remote(curl('/'), { allowFail: true });
    obs.rootMarkers = (root.stdout.match(/id="root"/g) ?? []).length;
    last = evaluateGate(obs, images);
    if (last.ok) return last;
    await sleep(5000);
  }
  return last;
}

// ---------------------------------------------------------------- rollout primitives

async function rollout(cfg, { srcDir, releaseEnv, infra, backup = false }) {
  const base = composeArgs(cfg, { srcDir, releaseEnv });
  const cmds = [];
  if (infra) cmds.push([...base, 'up', '-d', '--wait', '--wait-timeout', '180', 'postgres', 'redis']);
  // --no-deps: an app rollout never recreates Postgres/Redis (their config changes go through --infra).
  cmds.push([...base, 'up', '-d', '--wait', '--wait-timeout', '180', '--no-deps', 'master', 'web']);
  // p10-backup-restore: the backup service of releases that built its image (compose profile `backup`; named here,
  // so it starts). Not waited for: its health needs a minute of heartbeats and never gates the app rollout.
  if (backup) cmds.push([...base, 'up', '-d', '--no-deps', 'backup']);
  await step(
    `roll master + web (${cfg.project})`,
    cmds.map((c) => sudo(c)),
    async () => {
      for (const c of cmds) await remote(sudo(c), { allowFail: true });
    },
  );
}

async function fetchRecord(cfg, tag) {
  const r = await remote(sudo(['cat', `${cfg.recordsDir}/${assertTag(tag)}.json`]), { allowFail: true });
  if (r.code !== 0) throw new Error(`no deploy record for ${tag} on the host`);
  return JSON.parse(r.stdout);
}

async function verifyOnHost(cfg, record, keys, label) {
  return step(
    `verify signed record of ${record.payload.tag} against the host's images (${label})`,
    null,
    async () => {
      // p10-backup-restore: records of releases with a backup image verify it too.
      const names = recordImageKeys(record.payload.images);
      const ids = await imageIds(names.map((k) => record.payload.images[k]));
      const v = verifyRecord(record, keys, Object.fromEntries(names.map((k, i) => [k, ids[i]])));
      if (!v.ok) throw new Error(`release record ${record.payload.tag}: ${v.reason}`);
      note(
        `ok: keyId ${record.signature.keyId}, ${names.map((k, i) => `${k} ${String(ids[i]).slice(7, 19)}`).join(', ')}`,
      );
      return v;
    },
  );
}

// ---------------------------------------------------------------- commands

async function cmdDeploy() {
  const cfg = await resolveConfig(
    opts.env ?? process.env.REMYRAL_ENV ?? 'prod',
    {
      keep: opts.keep ? Number(opts.keep) : undefined,
    },
    { needDomain: true },
  );
  if (!Number.isInteger(cfg.keep) || cfg.keep < 2) die('--keep must be an integer ≥ 2');
  out(
    `deploy → ${cfg.env} (${cfg.project}, ${cfg.domain}) via ${HOST}${DRY ? ' — DRY RUN, nothing is changed' : ''}`,
  );

  // 1. preflight
  let fullSha;
  let tag;
  let migrations;
  if (DRY && opts.commit) {
    fullSha = opts.commit;
    tag = selectTag({ fullSha, porcelain: '', requested: opts.tag });
    migrations = migrationsHead(readdirSync(join(ROOT, 'apps/master/migrations')));
  } else {
    fullSha = git('rev-parse', 'HEAD');
    tag = selectTag({ fullSha, porcelain: git('status', '--porcelain'), requested: opts.tag });
    migrations = migrationsHead(
      git('ls-tree', '--name-only', 'HEAD', 'apps/master/migrations/')
        .split('\n')
        .map((p) => p.split('/').at(-1)),
    );
  }
  await step(
    'preflight: clean tree, tag = HEAD short sha',
    `git status --porcelain && git rev-parse HEAD`,
    () => undefined,
  );
  note(`tag ${tag} (commit ${fullSha}), build expects schema ${migrations}`);
  if (opts.verify) await step('pnpm verify', 'pnpm verify', () => run('pnpm', ['verify'], { inherit: true }));
  const key = DRY ? null : loadSigningKey();
  const keys = trustedKeys(key);
  await step('ssh reachability', `ssh ${SSH_OPTS.join(' ')} ${HOST} true`, () => remote('true'));

  // 2. state
  // Reading state is read-only, so a dry run reads it too (unless --offline: then --state-file or empty).
  await step(
    'read deploy state (both environments, for pruning)',
    `sudo cat ${cfg.stateFile}`,
    () => undefined,
  );
  let state = await readState(cfg);
  const otherState = await readState(await resolveConfig(cfg.env === 'prod' ? 'staging' : 'prod'));
  if (!state.current && !OFFLINE) state = await adoptRunning(cfg, state, keys, key);
  const previous = previousRelease(state, tag);
  note(`current ${state.current ?? 'none'}; rollback target ${previous?.tag ?? 'none'}`);
  if (state.current === tag) note(`${tag} is already current: re-deploying the same release`);

  // 3. ship the committed tree
  const srcDir = srcDirFor(tag);
  const exportDir = DRY ? '<tmp>' : mkdtempSync(join(tmpdir(), `remyral-deploy-${tag}-`));
  try {
    await step(
      `export commit ${tag} (tracked files only: no .env, no secrets, no node_modules)`,
      `git archive ${fullSha} | tar -x -C ${exportDir}`,
      async () => {
        await run('sh', ['-c', `git archive --format=tar "$0" | tar -x -C "$1"`, fullSha, exportDir]);
        writeFileSync(join(exportDir, '.remyral-commit'), `${fullSha}\n`);
      },
    );
    const rsyncArgs = [
      '-a',
      '--delete',
      '-e',
      `ssh ${SSH_OPTS.join(' ')}`,
      '--rsync-path',
      'sudo rsync',
      `${exportDir}/`,
      `${HOST}:${srcDir}/`,
    ];
    await step(`rsync tree → ${HOST}:${srcDir}`, cmdline(['rsync', ...rsyncArgs]), async () => {
      await remote(sudo(['install', '-d', '-m', '0755', srcDir]));
      await run('rsync', rsyncArgs);
    });
  } finally {
    if (!DRY) rmSync(exportDir, { recursive: true, force: true });
  }

  // 4. build on the host
  const refs = {
    master: `remyral-master:${tag}`,
    web: `remyral-web:${tag}`,
    backup: `remyral-backup:${tag}`,
  };
  // p10-backup-restore: the backup service image (infra/backup/Dockerfile) is built and signed like master/web.
  const dockerfiles = {
    master: `${srcDir}/apps/master/Dockerfile`,
    web: `${srcDir}/apps/web/Dockerfile`,
    backup: `${srcDir}/infra/backup/Dockerfile`,
  };
  for (const app of ['master', 'web', 'backup']) {
    const build = [
      'docker',
      'build',
      '--label',
      `org.opencontainers.image.revision=${fullSha}`,
      '--label',
      `org.opencontainers.image.version=${tag}`,
      '-f',
      dockerfiles[app],
      '-t',
      refs[app],
      srcDir,
    ];
    await step(`build ${refs[app]} on the host`, sudo(build), async () => {
      if (!opts.rebuild) {
        const have = await remote(
          sudo([
            'docker',
            'image',
            'inspect',
            '--format',
            '{{index .Config.Labels "org.opencontainers.image.revision"}}',
            refs[app],
          ]),
          { allowFail: true },
        );
        if (have.code === 0 && have.stdout.trim() === fullSha) {
          note('image for this commit already present — reused (--rebuild to force)');
          return;
        }
      }
      if (opts['no-host-build'])
        die(
          `${refs[app]} is not on the host for ${fullSha.slice(0, 12)}: run node scripts/deploy/build-local.mjs ${fullSha.slice(0, 12)} first (--no-host-build never builds on the host)`,
        );
      await remote(sudo(build), { inherit: true });
    });
  }

  // 4b. pin the new images against host-wide image prunes until a container runs them (and after, for rollback)
  await step(
    'pin the new images (stopped pin containers; a host image prune cannot delete them)',
    sudo(['sh', '-c', pinCommand(refs.master)]),
    async () => {
      for (const app of ['master', 'web', 'backup']) await remote(sudo(['sh', '-c', pinCommand(refs[app])]));
    },
  );

  // 5. record image IDs + sign
  const record = await step(
    'record image IDs and sign the release record (Ed25519)',
    [
      sudo(['docker', 'image', 'inspect', '--format', '{{.Id}}', refs.master, refs.web, refs.backup]),
      `sign with ${KEY_PATH} → ${cfg.recordsDir}/${tag}.json`,
    ],
    async () => {
      const [master, web, backup] = await imageIds([refs.master, refs.web, refs.backup]);
      const payload = makeRecordPayload({
        env: cfg.env,
        tag,
        commit: fullSha,
        images: { master, web, backup },
        migrations,
        builtAt: new Date().toISOString(),
        host: HOST,
      });
      const rec = signRecord(payload, key);
      mkdirSync(join(LOCAL_RECORDS, cfg.env), { recursive: true });
      writeFileSync(join(LOCAL_RECORDS, cfg.env, `${tag}.json`), `${JSON.stringify(rec, null, 2)}\n`);
      await remote(sudo(['install', '-d', '-m', '0700', cfg.recordsDir]));
      await writeRemoteFile(`${cfg.recordsDir}/${tag}.json`, `${JSON.stringify(rec, null, 2)}\n`, '0600');
      note(`master ${master}\n       web    ${web}\n       backup ${backup}`);
      return rec;
    },
    {
      payload: {
        tag,
        images: { master: '<master image id>', web: '<web image id>', backup: '<backup image id>' },
      },
    },
  );

  // 6. verify right before rollout (detects a retag/substitution on the host since the build)
  await verifyOnHost(cfg, record, keys, 'pre-rollout');

  // 7. pre-deploy backup + 8. migrations
  const before = await step(
    'read schema version',
    'docker exec <postgres> psql -tAc "SELECT max(version) FROM schema_migrations"',
    () => dbMigrationsHead(cfg),
    '<db head>',
  );
  const pending = DRY ? true : migrations > before;
  const backupContainer = DRY ? null : await containerOf(cfg, 'backup');
  const unitInstalled = DRY
    ? true
    : (await remote(sudo(['systemctl', 'cat', cfg.backupUnit]), { allowFail: true })).code === 0;
  const policy = backupPolicy({
    serviceRunning: backupContainer !== null,
    unitInstalled,
    pendingMigrations: pending,
    skip: opts['skip-backup'],
  });
  if (policy.action === 'abort') die(policy.reason);
  if (policy.action === 'warn') note(`WARNING: ${policy.reason}`);
  if (policy.action === 'run' && policy.via === 'service') {
    const backupArgs = backupServiceRunArgs(backupContainer);
    await step(
      'pre-deploy backup in the backup service (blocks; a failed backup stops the deploy)',
      sudo(backupArgs),
      () => remote(sudo(backupArgs)),
    );
  } else if (policy.action === 'run') {
    await step(
      'pre-deploy backup (blocks until uploaded)',
      sudo(['systemctl', 'start', cfg.backupUnit]),
      () => remote(sudo(['systemctl', 'start', cfg.backupUnit])),
    );
  }
  const nextEnv = `${cfg.deployDir}/release.env.next`;
  await step(
    `write ${nextEnv} (images pinned by ID)`,
    releaseEnvText(record.payload).trim().split('\n'),
    async () => {
      await remote(sudo(['install', '-d', '-m', '0700', cfg.deployDir]));
      await writeRemoteFile(nextEnv, releaseEnvText(record.payload));
    },
  );
  await step(
    'migrate (forward-only, as the migration owner role)',
    sudo([...composeArgs(cfg, { srcDir, releaseEnv: nextEnv }), 'run', '--rm', '--no-TTY', 'migrate']),
    () =>
      remote(
        sudo([...composeArgs(cfg, { srcDir, releaseEnv: nextEnv }), 'run', '--rm', '--no-TTY', 'migrate']),
        { inherit: true },
      ),
  );
  const after = await step(
    'read schema version after migrate',
    null,
    () => dbMigrationsHead(cfg),
    '<db head>',
  );

  // 9. rollout + 10. gate
  await rollout(cfg, { srcDir, releaseEnv: nextEnv, infra: opts.infra, backup: true });
  const gate = await step(
    'health gate: master/web healthy, running the signed image IDs, smoke curls through Traefik on the host',
    [
      `curl -sk --resolve ${cfg.domain}:443:127.0.0.1 https://${cfg.domain}/api/auth/session → 401`,
      `curl -sk --resolve ${cfg.domain}:443:127.0.0.1 https://${cfg.domain}/ → contains id="root"`,
      `curl -sk --resolve ${cfg.domain}:443:127.0.0.1 https://${cfg.domain}/api/healthz → 404`,
    ],
    () => healthGate(cfg, record.payload.images),
    { ok: true, failures: [] },
  );

  // 11. keep / rollback / hold
  const decision = DRY
    ? { action: 'keep', reason: 'dry run' }
    : decideRollback({ gateOk: gate.ok, previous, migrationsBefore: before, migrationsAfter: after });
  const at = new Date().toISOString();
  const entry = { tag, at, images: record.payload.images, migrations, srcDir };
  if (decision.action === 'keep') {
    await step(`activate ${tag}: release.env.next → release.env`, sudo(['mv', nextEnv, cfg.releaseEnv]), () =>
      remote(sudo(['mv', nextEnv, cfg.releaseEnv])),
    );
    state = recordOutcome(state, { ...entry, outcome: 'active' });
    await writeState(cfg, state);
    await prune(cfg, [state, otherState], tag);
    out(`\nOK: ${cfg.env} runs ${tag}${DRY ? ' (dry run)' : ''}`);
    if (DRY) {
      out(
        '       on gate failure: automatic rollback to the previous release if the schema did not advance;',
      );
      out('       otherwise hold (no automatic downgrade) — see docs/ops/cicd.md §5');
    }
    return;
  }
  out(`\nHEALTH GATE FAILED: ${gate.failures.join('; ')}`);
  if (decision.action === 'rollback') {
    const prevRecord = await fetchRecord(cfg, decision.to);
    await verifyOnHost(cfg, prevRecord, keys, 'rollback');
    await rollout(cfg, {
      srcDir: previous.srcDir,
      releaseEnv: cfg.releaseEnv,
      infra: false,
      backup: Boolean(prevRecord.payload.images.backup),
    });
    const regate = await healthGate(cfg, prevRecord.payload.images);
    state = recordOutcome(state, { ...entry, outcome: 'failed' });
    await writeState(cfg, state);
    await remote(sudo(['rm', '-f', nextEnv]));
    die(
      `rolled back to ${decision.to} (${regate.ok ? 'healthy' : `STILL UNHEALTHY: ${regate.failures.join('; ')}`}); ${tag} marked failed`,
    );
  }
  // hold: the new release keeps running; record that honestly.
  await remote(sudo(['mv', nextEnv, cfg.releaseEnv]));
  state = { ...recordOutcome(state, { ...entry, outcome: 'failed' }), current: tag };
  await writeState(cfg, state);
  die(`NOT rolled back: ${decision.reason}`);
}

/** First deploy into an environment started by hand (deploy-coolify.md §6): adopt the running release. */
async function adoptRunning(cfg, state, keys, key) {
  const id = await containerOf(cfg, 'master');
  if (!id) return state;
  const r = await remote(sudo(['docker', 'inspect', '--format', '{{.Config.Image}}', id]));
  const m = /^(remyral)-master:([0-9a-f]{12})$/.exec(r.stdout.trim());
  if (!m) {
    note(`running master image ${r.stdout.trim()} is not remyral-master:<tag>; nothing to adopt`);
    return state;
  }
  const repo = m[1];
  const tag = m[2];
  if (DRY) {
    note(
      `would adopt the running release ${tag} (sign its image IDs, record /opt/remyral-src as its source)`,
    );
    return recordOutcome(state, {
      tag,
      outcome: 'active',
      at: '<now>',
      images: {},
      migrations: '',
      srcDir: '/opt/remyral-src',
    });
  }
  const [master, web] = await imageIds([`${repo}-master:${tag}`, `${repo}-web:${tag}`]);
  const commit = git('rev-parse', '--verify', `${tag}^{commit}`);
  const migrations = await dbMigrationsHead(cfg);
  const rec = signRecord(
    makeRecordPayload({
      env: cfg.env,
      tag,
      commit,
      images: { master, web },
      migrations,
      builtAt: 'adopted',
      host: HOST,
    }),
    key,
  );
  await remote(sudo(['install', '-d', '-m', '0700', cfg.recordsDir]));
  await writeRemoteFile(`${cfg.recordsDir}/${tag}.json`, `${JSON.stringify(rec, null, 2)}\n`, '0600');
  if (!verifyRecord(rec, keys).ok) throw new Error('adoption record does not verify');
  note(`adopted running release ${tag} (source /opt/remyral-src)`);
  const next = recordOutcome(state, {
    tag,
    outcome: 'active',
    at: new Date().toISOString(),
    images: { master, web },
    migrations,
    srcDir: '/opt/remyral-src',
  });
  await writeRemoteFile(`${cfg.releaseEnv}`, releaseEnvText({ tag, images: { master, web } }));
  return next;
}

async function prune(cfg, states, inFlight) {
  let hostTags = [];
  let hostImages = [];
  if (!DRY) {
    const imgs = await remote(sudo(['docker', 'image', 'ls', '--format', '{{.Repository}} {{.Tag}}']));
    hostImages = imgs.stdout
      .split('\n')
      .map((l) => l.split(' '))
      .filter(([repo]) => IMAGE_REPOS.some((r) => [`${r}-master`, `${r}-web`, `${r}-backup`].includes(repo)));
    hostTags = hostImages.map(([, t]) => t);
    const dirs = await remote('ls -1d /opt/remyral-src-* 2>/dev/null || true');
    hostTags.push(...dirs.stdout.split('\n').filter(isManagedSrcDir).map(tagOfSrcDir));
  }
  const list = pruneList({ hostTags, states, keep: cfg.keep, inFlight: [inFlight] });
  await step(
    `prune releases beyond the newest ${String(cfg.keep)} per environment${DRY ? '' : `: ${list.join(', ') || 'nothing'}`}`,
    DRY
      ? [
          'sudo docker image rm remyral-master:<old> remyral-web:<old> remyral-backup:<old>',
          'sudo rm -rf /opt/remyral-src-<old>',
        ]
      : null,
    async () => {
      for (const t of list) {
        for (const repo of IMAGE_REPOS) {
          const pins = ['master', 'web', 'backup'].map((app) => pinName(`${repo}-${app}:${t}`));
          await remote(sudo(['docker', 'rm', '-f', ...pins]), { allowFail: true });
          await remote(sudo(['docker', 'image', 'rm', `${repo}-master:${t}`, `${repo}-web:${t}`]), {
            allowFail: true,
          });
          await remote(sudo(['docker', 'image', 'rm', `${repo}-backup:${t}`]), { allowFail: true });
        }
        const dir = srcDirFor(t);
        if (isManagedSrcDir(dir)) await remote(sudo(['rm', '-rf', '--', dir]));
      }
      // The kept releases (rollback targets) get a pin too — also those built before pins existed.
      for (const [repo, t] of hostImages) {
        if (list.includes(t) || !TAG_RE.test(t)) continue;
        const ref = `${repo}:${t}`;
        const has = await remote(
          sudo(['docker', 'container', 'inspect', '--format', '{{.Image}}', pinName(ref)]),
          {
            allowFail: true,
          },
        );
        if (has.code !== 0) await remote(sudo(['sh', '-c', pinCommand(ref)]), { allowFail: true });
      }
    },
  );
}

async function cmdRollback() {
  const cfg = await resolveConfig(opts.env ?? process.env.REMYRAL_ENV ?? 'prod', {}, { needDomain: true });
  out(`rollback ${cfg.env} via ${HOST}${DRY ? ' — DRY RUN' : ''}`);
  const key = DRY ? null : loadSigningKey();
  const keys = trustedKeys(key);
  let state = await readState(cfg);
  const target = selectRollbackTarget(state, opts.to);
  note(`${state.current} → ${target.tag} (schema ${target.migrations || '?'})`);
  const head = DRY ? '<db head>' : await dbMigrationsHead(cfg);
  if (!DRY && target.migrations && head > target.migrations) {
    die(
      `database schema ${head} is newer than ${target.tag} expects (${target.migrations}); an image rollback would crash-loop. Restore the pre-deploy backup first (docs/ops/backups.md §7)`,
    );
  }
  const record = DRY ? null : await fetchRecord(cfg, target.tag);
  if (record) await verifyOnHost(cfg, record, keys, 'rollback');
  const shown = target.images?.master
    ? target.images
    : { master: '<master image id>', web: '<web image id>' };
  await step(
    `write ${cfg.releaseEnv} for ${target.tag}`,
    releaseEnvText({ tag: target.tag, images: shown }).trim().split('\n'),
    () => writeRemoteFile(cfg.releaseEnv, releaseEnvText({ tag: target.tag, images: record.payload.images })),
  );
  await rollout(cfg, {
    srcDir: target.srcDir,
    releaseEnv: cfg.releaseEnv,
    infra: false,
    backup: Boolean(record?.payload.images.backup),
  });
  const gate = await step('health gate', null, () => healthGate(cfg, record.payload.images), {
    ok: true,
    failures: [],
  });
  if (!gate.ok) die(`rollback target unhealthy: ${gate.failures.join('; ')}`);
  state = recordRollback(state, { from: state.current, to: target.tag, at: new Date().toISOString() });
  await writeState(cfg, state);
  out(`OK: ${cfg.env} runs ${target.tag}`);
}

async function cmdStatus() {
  const cfg = await resolveConfig(opts.env ?? process.env.REMYRAL_ENV ?? 'prod');
  const state = await readState(cfg);
  out(`${cfg.env}: current ${state.current ?? 'none'} (project ${cfg.project}, data ${cfg.dataDir})`);
  for (const h of state.history.slice(0, 10))
    out(`  ${h.tag}  ${h.status.padEnd(11)} ${h.at ?? ''}  schema ${h.migrations || '?'}  ${h.srcDir ?? ''}`);
  if (!OFFLINE && state.current) {
    const keys = trustedKeys(statSafe(KEY_PATH) ? loadSigningKey() : null);
    const rec = await fetchRecord(cfg, state.current);
    const names = recordImageKeys(rec.payload.images);
    const ids = await imageIds(names.map((k) => rec.payload.images[k]));
    out(
      `  record ${state.current}: ${verifyRecord(rec, keys, Object.fromEntries(names.map((k, i) => [k, ids[i]]))).reason}`,
    );
  }
}
const statSafe = (p) => {
  try {
    return statSync(p);
  } catch {
    return null;
  }
};

function cmdKeygen() {
  const dir = opts.out ?? die('--out <dir> is required');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = join(dir, 'deploy-signing.pem');
  writeFileSync(pem, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  chmodSync(pem, 0o600);
  writeFileSync(join(dir, 'deploy-signing.pub'), publicKey.export({ type: 'spki', format: 'pem' }), {
    flag: 'wx',
  });
  out(`wrote ${pem} (0600, keep on this Mac + password manager) and deploy-signing.pub`);
}

try {
  if (COMMAND === 'deploy') await cmdDeploy();
  else if (COMMAND === 'rollback') await cmdRollback();
  else if (COMMAND === 'status') await cmdStatus();
  else if (COMMAND === 'keygen') cmdKeygen();
  else die(`unknown command ${COMMAND} (deploy | rollback | status | keygen)`);
} catch (err) {
  die(err instanceof Error ? err.message : String(err));
}
