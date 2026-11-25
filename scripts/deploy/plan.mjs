// Pure planning logic of the control-plane deploy (p1-cicd, docs/ops/cicd.md). No I/O here: everything
// that decides WHAT to do — environment layout, tag rules, rollback decision, prune list, health-gate
// evaluation, release-record signing — lives in this module and is unit-tested
// (scripts/test/deploy-plan.test.mjs). scripts/deploy/deploy.mjs performs the I/O.
import { Buffer } from 'node:buffer';
import { createHash, createPublicKey, sign, verify } from 'node:crypto';

export const TAG_RE = /^[0-9a-f]{12}$/;
export const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;
export const MIGRATION_RE = /^\d{4}$/;
export const RECORD_CONTEXT = 'remyral-deploy-record/v1\n';
export const DEFAULT_KEEP = 3;
/**
 * The ssh host (alias or user@host) of the control-plane host: `--host`, else REMYRAL_DEPLOY_HOST. There is no built-in
 * default — every installation names its own host.
 */
export function resolveDeployHost(flag, processEnv = {}) {
  const host = flag ?? processEnv.REMYRAL_DEPLOY_HOST;
  if (host === undefined || host === '') {
    throw new Error(
      'no deploy host: pass --host <ssh alias> or export REMYRAL_DEPLOY_HOST=<ssh alias> (e.g. in your shell profile)',
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9@._-]{0,200}$/.test(host)) throw new Error(`invalid deploy host "${host}"`);
  return host;
}
// The admin alias may enable connection multiplexing; a stale master socket has hung deploys before
// (docs/ops/deploy-coolify.md), so every connection is a fresh one.
export const SSH_OPTS = Object.freeze([
  '-o',
  'ControlMaster=no',
  '-o',
  'ControlPath=none',
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=15',
]);
const SRC_PREFIX = '/opt/remyral-src-';
export const ENVIRONMENTS = Object.freeze(['prod', 'staging']);
/** The key naming an environment's public domain (host file or the deploy's environment). */
export const domainKey = (env) => `REMYRAL_DEPLOY_DOMAIN_${String(env).toUpperCase()}`;

/**
 * Per-environment layout on the host. prod and staging differ only in names (deploy-coolify.md §1). An installation can
 * name its own compose project, data dir and backup unit (`overrides`, from the host's {@link INSTALL_CONFIG} file or
 * the deploy's environment, see {@link installOverrides}); the defaults are those of a fresh install. The public domain
 * has no default: `domain` stays undefined until an installation names it ({@link requireDomain}).
 */
export function envConfig(env, overrides = {}) {
  if (!ENVIRONMENTS.includes(env)) throw new Error(`unknown environment "${String(env)}" (prod | staging)`);
  const dataDir = overrides.dataDir ?? `/data/remyral/${env}`;
  return {
    env,
    project: overrides.project ?? `remyral-${env}`,
    domain: overrides.domain,
    dataDir,
    stackEnv: `${dataDir}/stack.env`,
    deployDir: `${dataDir}/deploy`,
    releaseEnv: `${dataDir}/deploy/release.env`,
    stateFile: `${dataDir}/deploy/releases.json`,
    recordsDir: `${dataDir}/deploy/records`,
    backupUnit: overrides.backupUnit ?? `remyral-backup@${env}.service`,
    keep: overrides.keep ?? DEFAULT_KEEP,
  };
}

/** Host file naming an installation's domains / compose project / data dir / backup unit (root-owned). */
export const INSTALL_CONFIG = '/etc/remyral/deploy.env';
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
// key → [field, valid value, only for this environment]
const OVERRIDE_KEYS = {
  REMYRAL_DEPLOY_PROJECT: ['project', /^[a-z0-9][a-z0-9_-]{0,62}$/],
  REMYRAL_DEPLOY_DATA_DIR: ['dataDir', /^\/[A-Za-z0-9._/-]{1,200}$/],
  REMYRAL_DEPLOY_BACKUP_UNIT: ['backupUnit', /^[A-Za-z0-9@._-]{1,100}\.service$/],
  [domainKey('prod')]: ['domain', DOMAIN_RE, 'prod'],
  [domainKey('staging')]: ['domain', DOMAIN_RE, 'staging'],
};

/**
 * The environment's public domain, or one error naming the exact key and both places it can be set. Only what talks
 * to the public routes (deploy, rollback health gate) needs it; reading state or publishing a release does not.
 */
export function requireDomain(cfg, { host } = {}) {
  if (cfg.domain) return cfg.domain;
  const key = domainKey(cfg.env);
  throw new Error(
    `no domain for ${cfg.env}: add the line "${key}=<domain>" to ${INSTALL_CONFIG} on ${host ?? 'the deploy host'} ` +
      `(root-owned, one KEY=value per line), or export ${key}=<domain> in this shell (it wins over the host file; ` +
      '--offline reads only the shell)',
  );
}

/**
 * Installation overrides for one environment from the host file text and the deploy's own environment (which wins).
 * Values may contain `{env}` (prod | staging). Unknown keys and invalid values are refused.
 */
export function installOverrides(text, env, processEnv = {}) {
  const raw = {};
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const m = /^([A-Z_]+)=(.*)$/.exec(t);
    if (!m || !Object.hasOwn(OVERRIDE_KEYS, m[1]))
      throw new Error(`${INSTALL_CONFIG}: unexpected line "${t.slice(0, 60)}"`);
    raw[m[1]] = m[2];
  }
  for (const k of Object.keys(OVERRIDE_KEYS)) if (processEnv[k]) raw[k] = processEnv[k];
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const [field, re, onlyEnv] = OVERRIDE_KEYS[k];
    if (onlyEnv !== undefined && onlyEnv !== env) continue;
    const value = v.replaceAll('{env}', env);
    if (!re.test(value) || value.includes('..')) throw new Error(`${k}: invalid value "${value}"`);
    out[field] = value;
  }
  return out;
}

export function assertTag(tag) {
  if (typeof tag !== 'string' || !TAG_RE.test(tag)) {
    throw new Error(
      `invalid release tag "${String(tag)}" (12 lowercase hex chars = git rev-parse --short=12)`,
    );
  }
  return tag;
}

/** The release tag is the commit's 12-char short sha; a dirty tree never gets a tag. */
export function selectTag({ fullSha, porcelain, requested }) {
  if (porcelain.trim() !== '') {
    throw new Error('working tree is not clean: commit or stash first (a tag must name exactly one tree)');
  }
  if (!/^[0-9a-f]{40}$/.test(fullSha)) throw new Error(`not a commit sha: ${fullSha}`);
  const tag = fullSha.slice(0, 12);
  if (requested !== undefined && requested !== tag) {
    throw new Error(`--tag ${requested} does not match HEAD (${tag}); check out that commit instead`);
  }
  return tag;
}

export const srcDirFor = (tag) => `${SRC_PREFIX}${assertTag(tag)}`;
/** A release source dir this tool manages. */
export const isManagedSrcDir = (dir) =>
  dir.startsWith(SRC_PREFIX) && TAG_RE.test(dir.slice(SRC_PREFIX.length));
/** The tag of a managed source dir. */
export const tagOfSrcDir = (dir) => (dir.startsWith(SRC_PREFIX) ? dir.slice(SRC_PREFIX.length) : undefined);

/** Highest NNNN of apps/master/migrations/*.sql file names (the schema version a build expects). */
export function migrationsHead(fileNames) {
  const versions = fileNames.map((f) => /^(\d{4})_[a-z0-9_]+\.sql$/.exec(f)?.[1]).filter(Boolean);
  return versions.length ? versions.sort().at(-1) : '';
}

export function emptyState(env) {
  return { env, current: null, history: [] };
}

/** Validates state read back from the host (it is data, never trusted for anything but bookkeeping). */
export function parseState(env, text) {
  if (!text || !text.trim()) return emptyState(env);
  const s = JSON.parse(text);
  if (s.env !== env || !Array.isArray(s.history)) throw new Error('deploy state file is malformed');
  for (const h of s.history) {
    assertTag(h.tag);
    if (!['active', 'superseded', 'failed', 'rolled_back'].includes(h.status)) {
      throw new Error(`deploy state: bad status ${String(h.status)}`);
    }
  }
  if (s.current !== null) assertTag(s.current);
  return s;
}

/** The release to roll back to: the newest healthy release other than `excludeTag`. */
export function previousRelease(state, excludeTag) {
  return (
    state.history.find((h) => h.tag !== excludeTag && (h.status === 'active' || h.status === 'superseded')) ??
    null
  );
}

/** Target of a manual `rollback`: an explicit healthy tag, or the newest healthy release before current. */
export function selectRollbackTarget(state, requested) {
  if (!state.current) throw new Error('nothing deployed in this environment');
  if (requested !== undefined) {
    assertTag(requested);
    if (requested === state.current) throw new Error(`${requested} is already the current release`);
    const h = state.history.find((x) => x.tag === requested);
    if (!h) throw new Error(`${requested} was never deployed to ${state.env}`);
    if (h.status === 'failed')
      throw new Error(`${requested} failed its health gate; refusing to roll back to it`);
    return h;
  }
  const prev = previousRelease(state, state.current);
  if (!prev) throw new Error('no previous healthy release to roll back to');
  return prev;
}

/**
 * What to do after the health gate. Migrations are forward-only and an older master refuses a newer schema
 * ("downgrade refused", apps/master/src/db/migrate.ts), so an automatic image rollback is only safe when the
 * deploy did not advance the schema; otherwise hold and tell the operator (restore the pre-deploy backup or
 * fix forward).
 */
export function decideRollback({ gateOk, previous, migrationsBefore, migrationsAfter }) {
  if (gateOk) return { action: 'keep', reason: 'health gate passed' };
  if (!previous) return { action: 'hold', reason: 'health gate failed and there is no previous release' };
  if (migrationsAfter !== migrationsBefore) {
    return {
      action: 'hold',
      reason: `health gate failed after the schema advanced ${migrationsBefore || '∅'} → ${migrationsAfter}; release ${previous.tag} would refuse to start (downgrade refused). Fix forward, or restore the pre-deploy backup (docs/ops/backups.md §7) and then roll back`,
    };
  }
  return { action: 'rollback', to: previous.tag, reason: 'health gate failed; schema unchanged' };
}

/**
 * Pre-deploy backup (docs/ops/backup-restore.md, docs/ops/backups.md): run the env's backup service (p10) or, without
 * it, the p1 backup unit before migrating. Without either, a deploy that applies migrations is refused (no way back),
 * one that does not only warns.
 */
export function backupPolicy({ serviceRunning = false, unitInstalled, pendingMigrations, skip }) {
  if (skip) return { action: 'skip', reason: '--skip-backup' };
  // p10-backup-restore: the compose backup service (preferred), else the p1 host unit.
  if (serviceRunning) return { action: 'run', via: 'service', reason: 'pre-deploy backup (backup service)' };
  if (unitInstalled) return { action: 'run', via: 'unit', reason: 'pre-deploy backup' };
  if (pendingMigrations) {
    return {
      action: 'abort',
      reason:
        'migrations are pending but the backup unit is not installed; install it (docs/ops/backups.md §5) or pass --skip-backup deliberately',
    };
  }
  return { action: 'warn', reason: 'backup unit not installed; no migrations pending' };
}

/** The tags each environment must keep: current + the newest (keep-1) other healthy releases. */
export function protectedTags(state, keep) {
  const out = new Set();
  if (state.current) out.add(state.current);
  for (const h of state.history) {
    if (out.size >= keep) break;
    if (h.status === 'active' || h.status === 'superseded') out.add(h.tag);
  }
  return out;
}

/** Tags (images + source dirs) that may be pruned: on the host, not protected by ANY environment. */
export function pruneList({ hostTags, states, keep, inFlight = [] }) {
  const keepSet = new Set(inFlight);
  for (const s of states) for (const t of protectedTags(s, keep)) keepSet.add(t);
  return [...new Set(hostTags)].filter((t) => TAG_RE.test(t) && !keepSet.has(t)).sort();
}

/**
 * Pin containers: a stopped container per release image (`docker create`, never started) so that an image
 * prune elsewhere on the host — Coolify's scheduled "Docker Cleanup" deletes every image no container uses and
 * that lacks its own label — cannot delete a freshly built image before the rollout, or a kept one before a
 * rollback. `docker rmi` without -f refuses an image a container references. Coolify removes only containers
 * labelled `coolify.managed=true`, so these stay.
 */
export const PIN_LABEL = 'tech.remyral.deploy.pin=true';

/** Container name of the pin for `<repo>:<tag>` (container names allow `[a-zA-Z0-9][a-zA-Z0-9_.-]*`). */
export function pinName(ref) {
  return `remyral-pin-${ref.replace(/[^a-zA-Z0-9_.-]/g, '-')}`;
}

/** Replace the pin of `ref` (a rebuilt tag points at a new image) — one shell line, idempotent. */
export function pinCommand(ref) {
  const name = pinName(ref);
  return `docker rm -f ${shq(name)} >/dev/null 2>&1; docker create --name ${shq(name)} --label ${shq(PIN_LABEL)} --network none ${shq(ref)} >/dev/null`;
}

/** New state after a deploy/rollback outcome (pure; history newest first, bounded). */
export function recordOutcome(state, { tag, outcome, at, images, migrations, srcDir }) {
  const history = state.history.filter((h) => h.tag !== tag).map((h) => ({ ...h }));
  const entry = { tag, status: outcome === 'active' ? 'active' : outcome, at, images, migrations, srcDir };
  if (outcome === 'active') {
    for (const h of history) if (h.status === 'active') h.status = 'superseded';
    return { env: state.env, current: tag, history: [entry, ...history].slice(0, 50) };
  }
  return { env: state.env, current: state.current, history: [entry, ...history].slice(0, 50) };
}

/** Rolling back re-activates an older release and marks the abandoned one. */
export function recordRollback(state, { from, to, at, fromStatus = 'rolled_back' }) {
  const history = state.history.map((h) => {
    if (h.tag === to) return { ...h, status: 'active', at };
    if (h.tag === from) return { ...h, status: fromStatus };
    if (h.status === 'active') return { ...h, status: 'superseded' };
    return { ...h };
  });
  const target = history.find((h) => h.tag === to);
  return { env: state.env, current: to, history: [target, ...history.filter((h) => h.tag !== to)] };
}

/** Health gate: containers healthy, running exactly the signed image IDs, and the routes behave. */
export function evaluateGate(obs, expected) {
  const failures = [];
  if (obs.masterHealth !== 'healthy') failures.push(`master container is ${obs.masterHealth}`);
  if (obs.webHealth !== 'healthy') failures.push(`web container is ${obs.webHealth}`);
  if (obs.masterImage !== expected.master)
    failures.push(`master runs ${obs.masterImage}, expected ${expected.master}`);
  if (obs.webImage !== expected.web) failures.push(`web runs ${obs.webImage}, expected ${expected.web}`);
  if (obs.session !== '401') failures.push(`GET /api/auth/session → ${obs.session} (expected 401)`);
  if (!(obs.rootMarkers >= 1)) failures.push('GET / does not serve the console (no id="root")');
  if (obs.healthz !== '404')
    failures.push(`GET /api/healthz → ${obs.healthz} (expected 404: probes are not public)`);
  return { ok: failures.length === 0, failures };
}

// ---------------------------------------------------------------- release records (image "signing")

/** Deterministic JSON: object keys sorted recursively; the signed bytes never depend on key order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 16-hex key id of an Ed25519 key (public KeyObject, or the public half of a private one). */
export function keyIdOf(key) {
  const pub = key.type === 'public' ? key : createPublicKey(key);
  const raw = pub.export({ format: 'jwk' }).x;
  return createHash('sha256').update(Buffer.from(raw, 'base64url')).digest('hex').slice(0, 16);
}

/** Images of a release record: master + web always; `backup` (p10-backup-restore) for releases that built it. */
export const recordImageKeys = (images) => ['master', 'web', ...(images?.backup ? ['backup'] : [])];

export function makeRecordPayload({ env, tag, commit, images, migrations, builtAt, host }) {
  assertTag(tag);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('commit must be a full sha');
  for (const k of recordImageKeys(images)) {
    if (!IMAGE_ID_RE.test(images?.[k] ?? '')) throw new Error(`image id for ${k} is not sha256:<64 hex>`);
  }
  if (migrations !== '' && !MIGRATION_RE.test(migrations)) throw new Error('bad migrations head');
  return {
    v: 1,
    env,
    tag,
    commit,
    images: Object.fromEntries(recordImageKeys(images).map((k) => [k, images[k]])),
    migrations,
    builtAt,
    host,
  };
}

/** Ed25519 over context ‖ canonical JSON (same construction as scripts/release/sign.mjs). */
export function signRecord(payload, privateKey) {
  const bytes = Buffer.from(RECORD_CONTEXT + canonicalJson(payload), 'utf8');
  return {
    payload,
    signature: {
      alg: 'ed25519',
      keyId: keyIdOf(privateKey),
      value: sign(null, bytes, privateKey).toString('base64url'),
    },
  };
}

/** Verifies a record against trusted public keys and (optionally) the image IDs observed on the host. */
export function verifyRecord(record, publicKeys, observed) {
  if (!record?.payload || record.signature?.alg !== 'ed25519')
    return { ok: false, reason: 'not a signed record' };
  const key = publicKeys.find((k) => keyIdOf(k) === record.signature.keyId);
  if (!key) return { ok: false, reason: `signed by untrusted key ${String(record.signature.keyId)}` };
  const bytes = Buffer.from(RECORD_CONTEXT + canonicalJson(record.payload), 'utf8');
  if (!verify(null, bytes, key, Buffer.from(record.signature.value, 'base64url'))) {
    return { ok: false, reason: 'signature does not verify' };
  }
  if (observed) {
    for (const k of recordImageKeys(record.payload.images)) {
      if (observed[k] !== record.payload.images[k]) {
        return {
          ok: false,
          reason: `${k} image on the host is ${String(observed[k])}, record says ${record.payload.images[k]}`,
        };
      }
    }
  }
  return { ok: true, reason: 'ok' };
}

// ---------------------------------------------------------------- remote shell commands

/** POSIX single-quote; remote commands are built only from validated values and quoted args. */
export function shq(arg) {
  const s = String(arg);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
}
export const cmdline = (args) => args.map(shq).join(' ');

/** release.env: the compose override pinning the app images by immutable ID. */
export function releaseEnvText({ tag, images }) {
  return [
    `REMYRAL_RELEASE_TAG=${assertTag(tag)}`,
    `REMYRAL_MASTER_IMAGE=${images.master}`,
    `REMYRAL_WEB_IMAGE=${images.web}`,
    // p10-backup-restore: the backup service image of this release (absent for older releases).
    ...(images.backup ? [`REMYRAL_BACKUP_IMAGE=${images.backup}`] : []),
    'REMYRAL_PULL_POLICY=never',
    '',
  ].join('\n');
}

/** p10-backup-restore: argv (with sudo) for a blocking backup inside the running backup service container. */
export function backupServiceRunArgs(containerId, reason = 'pre-deploy') {
  if (!/^[0-9a-f]{12,64}$/.test(containerId)) throw new Error('invalid container id');
  if (!/^[a-z0-9-]{1,40}$/.test(reason)) throw new Error('invalid backup reason');
  return ['docker', 'exec', containerId, 'remyral-backup', 'run', '--reason', reason];
}

/** docker compose argv for an environment, with the release override after stack.env (later wins). */
export function composeArgs(cfg, { srcDir, releaseEnv }) {
  return [
    'docker',
    'compose',
    '-p',
    cfg.project,
    '--project-directory',
    srcDir,
    '--env-file',
    cfg.stackEnv,
    '--env-file',
    releaseEnv,
    '-f',
    `${srcDir}/infra/coolify/compose.yaml`,
  ];
}

/** The compose source dir of the release that runs now (deploy state), to address its services. */
export function currentSrcDir(state) {
  if (!state.current)
    throw new Error(`nothing deployed in ${state.env} (no current release in the deploy state)`);
  const h = state.history.find((x) => x.tag === state.current);
  const dir = h?.srcDir;
  if (typeof dir !== 'string' || !(isManagedSrcDir(dir) || dir === '/opt/remyral-src')) {
    throw new Error(`deploy state has no usable source dir for ${state.current}`);
  }
  return dir;
}

/** `--rollout <stable|canary>[:<percent 0-100>]`, as the master's release-import CLI accepts it. */
export function assertRollout(rollout) {
  if (typeof rollout !== 'string' || !/^(stable|canary)(:(\d|[1-9]\d|100))?$/.test(rollout)) {
    throw new Error(`--rollout must be stable|canary[:<percent 0-100>] (got "${String(rollout)}")`);
  }
  return rollout;
}

/**
 * p6-release-import: argv (run with sudo on the host) that streams stdin into the release-import CLI
 * inside the running master container of an environment — the same compose project, files and env files
 * as the deploy's rollout.
 */
export function releaseImportArgs(cfg, { srcDir, rollout }) {
  if (rollout !== undefined && rollout !== null) assertRollout(rollout);
  return [
    ...composeArgs(cfg, { srcDir, releaseEnv: cfg.releaseEnv }),
    'exec',
    '-T',
    'master',
    'node',
    'dist/cli/release-import.js',
    ...(rollout ? ['--rollout', rollout] : []),
  ];
}
