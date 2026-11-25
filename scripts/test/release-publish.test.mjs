// p6-release-import: scripts/release/publish.mjs (local verification, remote command construction,
// dry run, streaming over ssh) against a fake `ssh` — the real host is never contacted.
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { assertRollout, currentSrcDir, envConfig, releaseImportArgs } from '../deploy/plan.mjs';
import { keyId, verifyReleaseDocument } from '../release/verify.mjs';

const SCRIPT = fileURLToPath(new URL('../release/publish.mjs', import.meta.url));
const TAG = 'aaaaaaaaaaaa';
const SRC = `/opt/remyral-src-${TAG}`;
const work = mkdtempSync(join(tmpdir(), 'remyral-publish-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const sha = (b) => createHash('sha256').update(b).digest('hex');
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ format: 'jwk' }).x, privateKey };
}
const k = keypair();
const foreign = keypair();

function releaseDoc(key, version, { tamperArtifact = false, tamperKit = false, kits = true } = {}) {
  const artifact = Buffer.from(`// remyral-worker ${version}\n`);
  const manifest = Buffer.from(
    `${JSON.stringify({ schema: 1, name: 'remyral-worker', version, channel: 'stable', protocolVersions: ['1.0'], minNode: '24.11.0', sha256: sha(artifact), size: artifact.length, createdAt: '2026-10-15T10:00:00.000Z' }, null, 2)}\n`,
  );
  const sig = (ctx, bytes) => ({
    keyId: keyId(key.pub),
    signature: sign(null, Buffer.concat([Buffer.from(ctx), bytes]), key.privateKey).toString('base64url'),
  });
  const doc = {
    manifest: manifest.toString('base64'),
    signature: sig('remyral-worker-release/v1\n', manifest),
    artifact: (tamperArtifact ? Buffer.from('evil') : artifact).toString('base64'),
  };
  if (kits) {
    const list = ['linux', 'macos', 'windows'].map((os) => ({ os, bytes: Buffer.from(`kit ${os}`) }));
    const index = Buffer.from(
      `${JSON.stringify({ schema: 1, name: 'remyral-worker-installers', version, releaseManifestSha256: sha(manifest), node: { version: '24.21.0' }, kits: list.map((x) => ({ os: x.os, file: `remyral-worker-${version}-${x.os}.tar.gz`, sha256: sha(x.bytes), size: x.bytes.length })) })}\n`,
    );
    doc.installers = {
      index: index.toString('base64'),
      signature: sig('remyral-worker-installers/v1\n', index),
      kits: list.map((x) => ({
        os: x.os,
        content: (tamperKit && x.os === 'macos' ? Buffer.from('evil') : x.bytes).toString('base64'),
      })),
    };
  }
  return doc;
}
function releaseDir(name, doc) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'release.json'), `${JSON.stringify(doc)}\n`);
  return dir;
}

const state = {
  env: 'prod',
  current: TAG,
  history: [{ tag: TAG, status: 'active', migrations: '0041', srcDir: SRC }],
};
const stateFile = join(work, 'state.json');
writeFileSync(stateFile, JSON.stringify({ prod: state }));

// Fake ssh: records its argv; the state read gets the state; release-import gets stdin saved + a result.
const bin = join(work, 'bin');
mkdirSync(bin);
const calls = join(work, 'ssh-calls');
const received = join(work, 'received.json');
writeFileSync(join(work, 'state-only.json'), JSON.stringify(state));
writeFileSync(
  join(bin, 'ssh'),
  `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
case "$*" in
  *release-import.js*) cat > '${received}'; echo 'ok'; echo '{"version":"1.0.17","created":true,"channel":"stable","rollout":{"channel":"stable","rolloutPercent":100}}' ;;
  *releases.json*) cat '${join(work, 'state-only.json')}' ;;
  *) exit 99 ;;
esac
`,
);
chmodSync(join(bin, 'ssh'), 0o755);

function publish(args, env = {}) {
  const base = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: work };
  for (const k of Object.keys(base)) if (k.startsWith('REMYRAL_DEPLOY_')) delete base[k];
  base.REMYRAL_DEPLOY_HOST = 'deploy.example.test';
  delete base.REMYRAL_RELEASE_PUBLIC_KEYS;
  delete base.REMYRAL_ENV;
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { env: { ...base, ...env } }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }),
    );
  });
}
const reset = () => {
  rmSync(calls, { force: true });
  rmSync(received, { force: true });
};

const EXPECTED_REMOTE = [
  'sudo docker compose -p remyral-prod',
  `--project-directory ${SRC}`,
  '--env-file /data/remyral/prod/stack.env --env-file /data/remyral/prod/deploy/release.env',
  `-f ${SRC}/infra/coolify/compose.yaml`,
  'exec -T master node dist/cli/release-import.js --rollout stable:100',
].join(' ');

describe('publish.mjs plan helpers', () => {
  it('builds the release-import command in the deploy compose project and validates --rollout', () => {
    const cfg = envConfig('prod');
    expect(releaseImportArgs(cfg, { srcDir: SRC, rollout: 'stable:100' }).join(' ')).toBe(
      EXPECTED_REMOTE.replace('sudo ', ''),
    );
    expect(releaseImportArgs(envConfig('staging'), { srcDir: SRC }).join(' ')).toMatch(
      /-p remyral-staging .* exec -T master node dist\/cli\/release-import\.js$/,
    );
    for (const ok of ['stable', 'canary', 'stable:0', 'stable:25', 'canary:100'])
      expect(assertRollout(ok)).toBe(ok);
    for (const bad of ['beta', 'stable:101', 'stable:', 'stable:05', 'stable;rm -rf /', '']) {
      expect(() => assertRollout(bad), bad).toThrow(/--rollout/);
    }
    expect(currentSrcDir(state)).toBe(SRC);
    expect(() => currentSrcDir({ env: 'prod', current: null, history: [] })).toThrow(/nothing deployed/);
    expect(() => currentSrcDir({ ...state, history: [{ ...state.history[0], srcDir: '/etc' }] })).toThrow(
      /no usable source dir/,
    );
  });

  it('verifies a release document like sign.mjs verify / verify-installers', () => {
    expect(verifyReleaseDocument(releaseDoc(k, '1.0.17'), [k.pub])).toMatchObject({
      version: '1.0.17',
      channel: 'stable',
      kits: 3,
    });
    expect(() => verifyReleaseDocument(releaseDoc(foreign, '1.0.17'), [k.pub])).toThrow(/unknown key/);
    expect(() => verifyReleaseDocument(releaseDoc(k, '1.0.17', { tamperArtifact: true }), [k.pub])).toThrow(
      /artifact does not match/,
    );
    expect(() => verifyReleaseDocument(releaseDoc(k, '1.0.17', { tamperKit: true }), [k.pub])).toThrow(
      /does not match the signed installer index/,
    );
    const unsigned = releaseDoc(k, '1.0.17');
    delete unsigned.signature;
    expect(() => verifyReleaseDocument(unsigned, [k.pub])).toThrow(/signature document is missing/);
  });
});

describe('publish.mjs', () => {
  const good = releaseDir('good', releaseDoc(k, '1.0.17'));

  it('--dry-run --offline verifies locally and prints the exact remote command, contacting nothing', async () => {
    reset();
    const r = await publish([
      '--dir',
      good,
      '--public-key',
      k.pub,
      '--rollout',
      'stable:100',
      '--dry-run',
      '--offline',
      '--state-file',
      stateFile,
    ]);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(
      /verified remyral-worker 1\.0\.17 \(stable\) signed by [0-9a-f]{16}, 3 installer kit/,
    );
    expect(r.stdout).toContain('DRY RUN');
    expect(r.stdout).toContain(
      `$ ssh -o ControlMaster=no -o ControlPath=none -o BatchMode=yes -o ConnectTimeout=15 deploy.example.test -- ${EXPECTED_REMOTE} < ${join(good, 'release.json')}`,
    );
    expect(existsSync(calls)).toBe(false);
  });

  it('streams release.json over ssh into release-import and prints its result', async () => {
    reset();
    const r = await publish(['--dir', good, '--rollout', 'stable:100'], {
      REMYRAL_RELEASE_PUBLIC_KEYS: k.pub,
    });
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split('\n').at(-1)).toBe(
      '{"version":"1.0.17","created":true,"channel":"stable","rollout":{"channel":"stable","rolloutPercent":100}}',
    );
    expect(readFileSync(received)).toEqual(readFileSync(join(good, 'release.json')));
    const sshCalls = readFileSync(calls, 'utf8').trim().split('\n');
    // p17: probe the host layout, read the deploy state, then the import
    expect(sshCalls).toHaveLength(3);
    expect(sshCalls[0]).toContain('/etc/remyral/deploy.env');
    expect(sshCalls[2]).toBe(
      `-o ControlMaster=no -o ControlPath=none -o BatchMode=yes -o ConnectTimeout=15 deploy.example.test -- ${EXPECTED_REMOTE}`,
    );
    // No secret material on any command line: only public values.
    expect(sshCalls.join('\n')).not.toMatch(/PRIVATE|password|token|BEGIN/i);
  });

  it('reads the public key from ~/remyral-release-key/release-key.pub and honours --host / --env', async () => {
    reset();
    mkdirSync(join(work, 'remyral-release-key'), { recursive: true });
    writeFileSync(join(work, 'remyral-release-key', 'release-key.pub'), `${k.pub}\n`);
    const staging = join(work, 'state-staging.json');
    writeFileSync(staging, JSON.stringify({ staging: { ...state, env: 'staging' } }));
    const r = await publish([
      '--dir',
      good,
      '--env',
      'staging',
      '--host',
      'other-alias',
      '--dry-run',
      '--offline',
      '--state-file',
      staging,
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/other-alias -- sudo docker compose -p remyral-staging .*release-import\.js < /);
    rmSync(join(work, 'remyral-release-key'), { recursive: true });
  });

  it('needs a deploy host (--host or REMYRAL_DEPLOY_HOST) and says so before contacting anything', async () => {
    reset();
    const r = await publish(['--dir', good, '--dry-run', '--offline'], { REMYRAL_DEPLOY_HOST: '' });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(
      /publish: no deploy host: pass --host <ssh alias> or export REMYRAL_DEPLOY_HOST=/,
    );
    expect(existsSync(calls)).toBe(false);
  });

  it('refuses tampered, foreign-signed or oversize documents and bad arguments before contacting the host', async () => {
    reset();
    const cases = [
      [
        [
          '--dir',
          releaseDir('tampered', releaseDoc(k, '1.0.18', { tamperArtifact: true })),
          '--public-key',
          k.pub,
        ],
        /artifact does not match the manifest — not published/,
      ],
      [
        ['--dir', releaseDir('kit', releaseDoc(k, '1.0.18', { tamperKit: true })), '--public-key', k.pub],
        /does not match the signed installer index/,
      ],
      [
        ['--dir', releaseDir('foreign', releaseDoc(foreign, '1.0.18')), '--public-key', k.pub],
        /signed by unknown key/,
      ],
      [['--dir', good], /no release public key/],
      [['--dir', good, '--public-key', k.pub, '--rollout', 'stable:150'], /--rollout must be/],
      [['--dir', good, '--public-key', k.pub, '--offline'], /--offline is only valid with --dry-run/],
      [['--dir', join(work, 'missing'), '--public-key', k.pub], /release\.json not found/],
      [['--public-key', k.pub], /--dir .* is required/],
      [['--dir', good, '--bogus'], /Unknown option/],
    ];
    for (const [args, message] of cases) {
      const r = await publish(args);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.stderr, args.join(' ')).toMatch(message);
    }
    const big = join(work, 'big');
    mkdirSync(big);
    writeFileSync(join(big, 'release.json'), Buffer.alloc(48 * 1024 * 1024 + 1, 0x20));
    const r = await publish(['--dir', big, '--public-key', k.pub]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/at most 50331648/);
    expect(existsSync(calls)).toBe(false);
  });

  it('reports a refusal of the master with a non-zero exit', async () => {
    reset();
    const failing = join(work, 'bin-fail');
    mkdirSync(failing);
    writeFileSync(
      join(failing, 'ssh'),
      `#!/bin/sh\ncase "$*" in *release-import.js*) cat >/dev/null; echo 'error: release refused (signature_invalid): nope' >&2; exit 1 ;; *deploy.env*) ;; *) cat '${join(work, 'state-only.json')}' ;; esac\n`,
    );
    chmodSync(join(failing, 'ssh'), 0o755);
    const r = await publish(['--dir', good, '--public-key', k.pub], {
      PATH: `${failing}:${process.env.PATH ?? ''}`,
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('error: release refused (signature_invalid): nope');
    expect(r.stderr).toMatch(/the master refused the release/);
  });
});
