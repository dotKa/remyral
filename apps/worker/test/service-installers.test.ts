import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INFRA } from './service-files.js';
import { tempDir } from './helpers.js';

// Installer dry-runs against the real scripts. On macOS, dscl/launchctl are replaced by
// read-only fakes (test/fixtures/fake-macos-bin) that fail loudly on any write, so these
// tests can never create an account or load a daemon. The real Linux install runs in
// infra/worker/linux/test/systemd-e2e.sh.

const FAKE_BIN = fileURLToPath(new URL('./fixtures/fake-macos-bin', import.meta.url));

async function fakeBundle(): Promise<{ path: string; sha256: string }> {
  const dir = await tempDir();
  const path = join(dir, 'remyral-worker.mjs');
  const content = '#!/usr/bin/env node\nconsole.log("fake bundle")\n';
  await writeFile(path, content);
  return { path, sha256: createHash('sha256').update(content).digest('hex') };
}

function runMac(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(
    '/bin/bash',
    [`${INFRA}macos/install.sh`, '--dry-run', '--node', process.execPath, ...args],
    {
      encoding: 'utf8',
      env: {
        PATH: `${FAKE_BIN}:/usr/bin:/bin:/usr/sbin:/sbin`,
        FAKE_TAKEN_IDS: '',
        FAKE_ROLE_USER: '',
        FAKE_LOADED: '0',
        ...env,
      },
    },
  );
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const actions = (out: string) => out.split('\n').filter((l) => l.startsWith('[dry-run] '));

describe.skipIf(process.platform !== 'darwin')(
  'macOS installer --dry-run (fake dscl/launchctl)',
  // Each case runs a real bash installer (dozens of processes); generous under CI load.
  { timeout: 30_000 },
  () => {
    it('fresh machine: creates a hidden role account with the first free id, layout, plist, bootstrap', async () => {
      const bundle = await fakeBundle();
      const r = runMac(
        [
          '--bundle',
          bundle.path,
          '--bundle-sha256',
          bundle.sha256,
          '--master-url',
          'wss://m.example.com/v1/worker',
        ],
        { FAKE_TAKEN_IDS: '400 401 403' },
      );
      expect(r.err).not.toMatch(/write attempted/);
      expect(r.code).toBe(0);
      const a = actions(r.out);
      expect(a).toContain('[dry-run] dscl . -create /Users/_remyralworker UniqueID 402');
      expect(a).toContain('[dry-run] dscl . -create /Groups/_remyralworker PrimaryGroupID 402');
      expect(a).toContain('[dry-run] dscl . -create /Users/_remyralworker UserShell /usr/bin/false');
      expect(a).toContain('[dry-run] dscl . -create /Users/_remyralworker IsHidden 1');
      expect(a).toContain("[dry-run] dscl . -create /Users/_remyralworker Password '*'");
      expect(a).toContain(
        "[dry-run] install -d -o _remyralworker -g _remyralworker -m 0700 '/Library/Application Support/RemyralWorker/data'",
      );
      expect(a).toContain(
        "[dry-run] install -d -o root -g _remyralworker -m 0750 '/Library/Application Support/RemyralWorker'",
      );
      expect(a.some((l) => /install -o root -g _remyralworker -m 0640 .*config\.json'$/.test(l))).toBe(true);
      expect(
        a.some((l) =>
          /install -o root -g wheel -m 0644 .* \/Library\/LaunchDaemons\/com\.remyral\.worker\.plist$/.test(
            l,
          ),
        ),
      ).toBe(true);
      expect(a.slice(-2)).toEqual([
        '[dry-run] launchctl enable system/com.remyral.worker',
        '[dry-run] launchctl bootstrap system /Library/LaunchDaemons/com.remyral.worker.plist',
      ]);
      // The rendered plist carries the resolved node path.
      expect(r.out).toContain(`[dry-run]   | \t\t<string>${process.execPath}</string>`);
      expect(r.out).toContain('bundle SHA-256 verified');
      expect(r.out).toContain('dry-run: nothing was changed');
    });

    it('signed install (p2-signed-updates): verified adopt, versions layout, updater LaunchDaemon', async () => {
      const bundle = await fakeBundle();
      const dir = join(bundle.path, '..');
      await writeFile(join(dir, 'remyral-worker-updater.mjs'), '// updater\n');
      await writeFile(join(dir, 'manifest.json'), '{}\n');
      await writeFile(join(dir, 'manifest.sig.json'), '{}\n');
      const r = runMac(
        [
          '--bundle',
          bundle.path,
          '--manifest',
          join(dir, 'manifest.json'),
          '--signature',
          join(dir, 'manifest.sig.json'),
          '--master-url',
          'wss://m.example.com/v1/worker',
        ],
        { FAKE_TAKEN_IDS: '' },
      );
      expect(r.err).not.toMatch(/write attempted/);
      expect(r.code).toBe(0);
      const a = actions(r.out);
      const bin = "'/Library/Application Support/RemyralWorker/bin";
      expect(a).toContain(`[dry-run] install -d -o root -g wheel -m 0755 ${bin}/versions'`);
      expect(a).toContain(`[dry-run] install -d -o root -g wheel -m 0755 ${bin}/state'`);
      expect(a).toContain(
        "[dry-run] install -d -o _remyralworker -g _remyralworker -m 0700 '/Library/Application Support/RemyralWorker/data/updates'",
      );
      expect(
        a.some(
          (l) =>
            l.includes(`install -o root -g wheel -m 0644`) &&
            l.endsWith(`${bin}/remyral-worker-updater.mjs'`),
        ),
      ).toBe(true);
      expect(
        a.some((l) => l.includes(`remyral-worker-updater.mjs' adopt --install-dir ${bin}' --bundle`)),
      ).toBe(true);
      // The unsigned copy path is not used for a signed install.
      expect(a.some((l) => l.endsWith(`${bin}/remyral-worker.mjs'`) && l.includes('install -o root'))).toBe(
        false,
      );
      // Security fix (helper binding): an enrolled worker is bound to the helper on every run (installer mode).
      expect(a.at(-1)).toMatch(/remyral-worker-updater\.mjs'? admin-bind --if-unbound --config /);
      expect(a.slice(-5, -1)).toEqual([
        '[dry-run] launchctl enable system/com.remyral.worker.updater',
        '[dry-run] launchctl bootstrap system /Library/LaunchDaemons/com.remyral.worker.updater.plist',
        // p5-machine-admin: the elevated broker's LaunchDaemon (WatchPaths on the session request).
        '[dry-run] launchctl enable system/com.remyral.worker.admin',
        '[dry-run] launchctl bootstrap system /Library/LaunchDaemons/com.remyral.worker.admin.plist',
      ]);
      expect(r.out).toContain(
        '<string>/Library/Application Support/RemyralWorker/data/updates/request.json</string>',
      );
    });

    it('reuses an existing role account; refuses one with a login shell or a visible uid', async () => {
      const bundle = await fakeBundle();
      const ok = runMac(['--bundle', bundle.path, '--master-url', 'wss://m.example.com/v1/worker'], {
        FAKE_ROLE_USER: '450:/usr/bin/false',
      });
      expect(ok.code).toBe(0);
      expect(ok.out).toContain('exists (uid 450)');
      expect(actions(ok.out).some((l) => l.includes('dscl'))).toBe(false);

      const shell = runMac(['--bundle', bundle.path], { FAKE_ROLE_USER: '450:/bin/zsh' });
      expect(shell.code).not.toBe(0);
      expect(shell.err).toContain('has a login shell (/bin/zsh)');

      const visible = runMac(['--bundle', bundle.path], { FAKE_ROLE_USER: '501:/usr/bin/false' });
      expect(visible.code).not.toBe(0);
      expect(visible.err).toContain('uid 501');
    });

    it('without a config it does not install or load the LaunchDaemon (no exit-78 loop at boot)', async () => {
      const bundle = await fakeBundle();
      const r = runMac(['--bundle', bundle.path]);
      expect(r.code).toBe(0);
      expect(r.out).toContain('not installing the LaunchDaemon yet: no config');
      expect(actions(r.out).some((l) => l.includes('launchctl') || l.includes('LaunchDaemons'))).toBe(false);
    });

    it('an already loaded daemon whose plist changes is booted out and bootstrapped again', async () => {
      const bundle = await fakeBundle();
      const r = runMac(['--bundle', bundle.path, '--master-url', 'wss://m.example.com/v1/worker'], {
        FAKE_LOADED: '1',
      });
      expect(r.code).toBe(0);
      expect(actions(r.out).slice(-3)).toEqual([
        '[dry-run] launchctl bootout system/com.remyral.worker',
        '[dry-run] launchctl enable system/com.remyral.worker',
        '[dry-run] launchctl bootstrap system /Library/LaunchDaemons/com.remyral.worker.plist',
      ]);
    });

    it('rejects bad input before doing anything', async () => {
      const bundle = await fakeBundle();
      const http = runMac(['--bundle', bundle.path, '--master-url', 'http://m.example.com']);
      expect(http.code).not.toBe(0);
      expect(http.err).toContain('must start with wss://');
      const sha = runMac(['--bundle', bundle.path, '--bundle-sha256', '0'.repeat(64)]);
      expect(sha.code).not.toBe(0);
      expect(sha.err).toContain('bundle SHA-256 mismatch');
      const home = runMac(['--bundle', bundle.path, '--workspace-root', '/Users/someone/work']);
      expect(home.code).not.toBe(0);
      expect(home.err).toContain("inside a user's home");
      const missing = runMac(['--bundle', '/nonexistent/remyral-worker.mjs']);
      expect(missing.code).not.toBe(0);
      expect(missing.err).toContain('worker bundle not found');
    });

    it('p5-worker-onboarding: --private-node plans the pinned, verified Node under the program dir; minimal config', async () => {
      const bundle = await fakeBundle();
      const pin = await import('node:fs').then((fs) => fs.readFileSync(`${INFRA}node/pin.env`, 'utf8'));
      const version = /^NODE_VERSION=(.+)$/m.exec(pin)?.[1] ?? '';
      const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
      const r = spawnSync(
        '/bin/bash',
        [
          `${INFRA}macos/install.sh`,
          '--dry-run',
          '--private-node',
          '--bundle',
          bundle.path,
          '--bundle-sha256',
          bundle.sha256,
          '--master-url',
          'wss://m.example.com/v1/worker',
        ],
        {
          encoding: 'utf8',
          env: {
            PATH: `${FAKE_BIN}:/usr/bin:/bin:/usr/sbin:/sbin`,
            FAKE_TAKEN_IDS: '',
            FAKE_ROLE_USER: '',
            FAKE_LOADED: '0',
          },
        },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(
        `[dry-run] download https://nodejs.org/dist/v${version}/{SHASUMS256.txt,SHASUMS256.txt.sig,node-v${version}-darwin-${arch}.tar.gz}`,
      );
      const privateNode = `/Library/Application Support/RemyralWorker/node/node-v${version}-darwin-${arch}/bin/node`;
      expect(r.stdout).toContain(`<string>${privateNode}</string>`); // the LaunchDaemon runs the private Node
      expect(r.stdout).not.toMatch(/maxParallelJobs|allowedRuntimes|logLevel/);
      expect(r.stdout).toContain('"masterUrl": "wss://m.example.com/v1/worker"');
      const both = runMac(['--private-node', '--bundle', bundle.path]);
      expect(both.code).not.toBe(0);
      expect(both.err).toContain('exclude each other');
    });

    it('--no-machine-admin / --allow-machine-admin write the local ceiling into a new config; not both', async () => {
      const bundle = await fakeBundle();
      const base = ['--bundle', bundle.path, '--master-url', 'wss://m.example.com/v1/worker'];
      const veto = runMac([...base, '--no-machine-admin', '--max-parallel-jobs', '2']);
      expect(veto.code, veto.err).toBe(0);
      expect(veto.out).toContain('"localCeiling": { "maxParallelJobs": 2, "allowMachineAdmin": false }');
      const allow = runMac([...base, '--allow-machine-admin']);
      expect(allow.code, allow.err).toBe(0);
      expect(allow.out).toContain('"localCeiling": { "allowMachineAdmin": true }');
      // Without either flag the key is not written: the default stays the dashboard's decision.
      const none = runMac(base);
      expect(none.out).not.toContain('allowMachineAdmin');
      const both = runMac([...base, '--allow-machine-admin', '--no-machine-admin']);
      expect(both.code).not.toBe(0);
      expect(both.err).toContain('exclude each other');
    });

    it('uninstall --dry-run --purge performs no writes', () => {
      const r = spawnSync('/bin/bash', [`${INFRA}macos/uninstall.sh`, '--dry-run', '--purge'], {
        encoding: 'utf8',
        env: {
          PATH: `${FAKE_BIN}:/usr/bin:/bin:/usr/sbin:/sbin`,
          FAKE_ROLE_USER: '450:/usr/bin/false',
          FAKE_LOADED: '1',
        },
      });
      expect(r.status).toBe(0);
      expect(r.stderr).not.toMatch(/write attempted/);
      expect(r.stdout).toContain('[dry-run] launchctl bootout system/com.remyral.worker');
      expect(r.stdout).toContain('[dry-run] dscl . -delete /Users/_remyralworker');
      expect(r.stdout).toContain('[dry-run] dscl . -delete /Groups/_remyralworker');
    });
  },
);

describe.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/getent'))(
  'Linux installer --dry-run',
  { timeout: 30_000 },
  () => {
    it('prints the plan and changes nothing', async () => {
      const bundle = await fakeBundle();
      const r = spawnSync(
        '/bin/bash',
        [
          `${INFRA}linux/install.sh`,
          '--dry-run',
          '--allow-unsafe-node',
          '--node',
          process.execPath,
          '--bundle',
          bundle.path,
          '--master-url',
          'wss://m.example.com/v1/worker',
        ],
        { encoding: 'utf8' },
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('[dry-run]   | ProtectSystem=strict');
      expect(r.stdout).toContain('dry-run: nothing was changed');
    });
  },
);
