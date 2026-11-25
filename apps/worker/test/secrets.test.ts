import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { Redactor, SecretSet } from '@remyral/observability';
import { MAX_LOG_CHUNK } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { secretCommand } from '../src/secrets/cli.js';
import { PROTECT_SCRIPT, UNPROTECT_SCRIPT, WindowsDpapiSecretStore } from '../src/secrets/dpapi.js';
import { planJobEnv, resolveJobEnv } from '../src/secrets/env.js';
import {
  ForeignSecretRefError,
  InvalidSecretNameError,
  InvalidSecretRefError,
  InvalidSecretValueError,
  JobEnvError,
  SecretNotFoundError,
  SecretStoreUnavailableError,
} from '../src/secrets/errors.js';
import type { ExecFn } from '../src/secrets/exec.js';
import { createSecretStore } from '../src/secrets/factory.js';
import { readHiddenLine, type TtyInput } from '../src/secrets/input.js';
import { JobOutputRedaction } from '../src/secrets/job-output.js';
import { MacKeychainSecretStore } from '../src/secrets/keychain.js';
import { SecretString, formatSecretRef, parseSecretRef } from '../src/secrets/ref.js';
import { SecretRegistry } from '../src/secrets/registry.js';
import { FileSecretStore, type SecretStore } from '../src/secrets/store.js';
import { InsecurePermissionsError } from '../src/fs/permissions.js';
import { FakeSystem } from './fake-system.js';
import { isWindows, nodeOps, pathHost, patchOps, tempDir } from './helpers.js';

const VALUE = 'sk-ant-api03-not-a-real-key-0123456789';

describe('secret references (ADR-0006 §2)', () => {
  it('parses full and short references', () => {
    expect(parseSecretRef('worker:w-1/secret:anthropic')).toEqual({ workerId: 'w-1', name: 'anthropic' });
    expect(parseSecretRef('secret:openai_key')).toEqual({ workerId: null, name: 'openai_key' });
    expect(formatSecretRef('w-1', 'anthropic')).toBe('worker:w-1/secret:anthropic');
    for (const bad of [
      'anthropic',
      'worker:/secret:x',
      'worker:w 1/secret:x',
      'secret:',
      'secret:../x',
      'secret:a.b',
      'secret:a/b',
    ]) {
      expect(() => parseSecretRef(bad), bad).toThrow(/invalid secret/);
    }
  });

  it('SecretString never prints its value', () => {
    const s = new SecretString(VALUE);
    expect(String(s)).toBe('[REDACTED]');
    expect(JSON.stringify({ s })).toBe('{"s":"[REDACTED]"}');
    expect(inspect(s)).toBe('[REDACTED]');
    expect(s.reveal()).toBe(VALUE);
  });
});

async function storeContract(store: SecretStore): Promise<void> {
  expect(await store.list()).toEqual([]);
  expect(await store.get('anthropic')).toBeNull();
  await store.set('anthropic', VALUE);
  await store.set('openai', 'second-secret-value\nwith newline "quotes" $x é');
  expect((await store.get('anthropic'))?.reveal()).toBe(VALUE);
  expect((await store.get('openai'))?.reveal()).toBe('second-secret-value\nwith newline "quotes" $x é');
  await store.set('anthropic', 'rotated-value-123456');
  expect((await store.get('anthropic'))?.reveal()).toBe('rotated-value-123456');
  expect(await store.list()).toEqual(['anthropic', 'openai']);
  expect(await store.delete('openai')).toBe(true);
  expect(await store.delete('openai')).toBe(false);
  expect(await store.list()).toEqual(['anthropic']);
  await expect(store.set('bad name', VALUE)).rejects.toThrow(InvalidSecretNameError);
  await expect(store.set('short', '12345')).rejects.toThrow(InvalidSecretValueError);
  await expect(store.get('../device-key')).rejects.toThrow(InvalidSecretNameError);
}

describe('FileSecretStore', () => {
  it('satisfies the store contract', async () => {
    await storeContract(new FileSecretStore(nodeOps(), await tempDir('rw-sec-')));
  });

  it.skipIf(isWindows)(
    'creates 0700 dir and 0600 files, and refuses loose permissions and symlinks',
    async () => {
      const dir = await tempDir('rw-sec-');
      const store = new FileSecretStore(nodeOps(), dir);
      await store.set('anthropic', VALUE);
      const { stat } = await import('node:fs/promises');
      expect((await stat(join(dir, 'secrets'))).mode & 0o777).toBe(0o700);
      expect((await stat(join(dir, 'secrets', 'anthropic.json'))).mode & 0o777).toBe(0o600);
      await chmod(join(dir, 'secrets', 'anthropic.json'), 0o644);
      await expect(store.get('anthropic')).rejects.toThrow(InsecurePermissionsError);
      await writeFile(
        join(dir, 'elsewhere.json'),
        JSON.stringify({ version: 1, value: 'planted-value', updatedAt: 'x' }),
        { mode: 0o600 },
      );
      await symlink(join(dir, 'elsewhere.json'), join(dir, 'secrets', 'planted.json'));
      await expect(store.get('planted')).rejects.toThrow(InsecurePermissionsError);
      await chmod(join(dir, 'secrets'), 0o770);
      await expect(store.list()).rejects.toThrow(InsecurePermissionsError);
    },
  );

  it('removes leftovers of interrupted writes and ignores foreign files', async () => {
    const dir = await tempDir('rw-sec-');
    const store = new FileSecretStore(nodeOps(), dir);
    await store.set('anthropic', VALUE);
    await writeFile(join(dir, 'secrets', 'anthropic.json.tmp-1-abcd'), 'partial', { mode: 0o600 });
    await writeFile(join(dir, 'secrets', 'README'), 'x', { mode: 0o600 });
    expect(await store.list()).toEqual(['anthropic']);
    expect((await readdir(join(dir, 'secrets'))).sort()).toEqual(['README', 'anthropic.json']);
  });

  it('a corrupt file error does not quote the content', async () => {
    const dir = await tempDir('rw-sec-');
    const store = new FileSecretStore(nodeOps(), dir);
    await store.set('anthropic', VALUE);
    await writeFile(join(dir, 'secrets', 'anthropic.json'), `{"value": "${VALUE}"`, { mode: 0o600 });
    const err = await store.get('anthropic').catch((e: unknown) => e);
    expect(String(err)).toMatch(/not a valid secret file/);
    expect(String(err)).not.toContain(VALUE);
  });
});

const hasSecurity =
  process.platform === 'darwin' && spawnSync('/usr/bin/security', ['help']).error === undefined;

describe.runIf(hasSecurity)(
  'MacKeychainSecretStore (real `security`, temporary keychain)',
  { timeout: 60_000 },
  () => {
    it('satisfies the store contract and never passes the value in argv', async () => {
      const dir = await tempDir('rw-kc-');
      const keychain = join(dir, 'test.keychain-db');
      const pw = 'test-keychain-password';
      expect(spawnSync('/usr/bin/security', ['create-keychain', '-p', pw, keychain]).status).toBe(0);
      try {
        expect(spawnSync('/usr/bin/security', ['unlock-keychain', '-p', pw, keychain]).status).toBe(0);
        const argvs: string[][] = [];
        const { nodeExec } = await import('../src/secrets/exec.js');
        const recording: ExecFn = (cmd, args, opts) => {
          argvs.push([cmd, ...args]);
          return nodeExec(cmd, args, opts);
        };
        const store = new MacKeychainSecretStore({
          keychainPath: keychain,
          service: `remyral-worker-test-${String(process.pid)}`,
          exec: recording,
        });
        await storeContract(store);
        expect(argvs.flat().join(' ')).not.toContain(VALUE);
        expect(argvs.flat().join(' ')).not.toContain('rotated-value');
        // Stored encoded: a raw dump of the item attributes does not reveal the value either.
        const dump = spawnSync('/usr/bin/security', ['dump-keychain', keychain], { encoding: 'utf8' }).stdout;
        expect(dump).not.toContain('rotated-value');
      } finally {
        spawnSync('/usr/bin/security', ['delete-keychain', keychain]);
      }
    });

    it('refuses a keychain path that would need quoting', () => {
      expect(() => new MacKeychainSecretStore({ keychainPath: '/tmp/my keychain' })).toThrow(
        /must not contain/,
      );
    });
  },
);

describe('MacKeychainSecretStore parsing (fake security)', () => {
  it('lists only worker items of the configured service and rejects foreign item formats', async () => {
    const dump = [
      'keychain: "/k"',
      'class: "genp"',
      'attributes:',
      '    "acct"<blob>="anthropic"',
      '    "svce"<blob>="remana-worker"',
      'keychain: "/k"',
      'class: "genp"',
      'attributes:',
      '    "acct"<blob>="someone"',
      '    "svce"<blob>="other-app"',
      'keychain: "/k"',
      'class: "inet"',
      'attributes:',
      '    "acct"<blob>="web"',
      '    "svce"<blob>="remana-worker"',
    ].join('\n');
    const exec: ExecFn = (_cmd, args) =>
      Promise.resolve(
        args[0] === 'dump-keychain'
          ? { code: 0, stdout: dump, stderr: '' }
          : { code: 0, stdout: 'plain-value-not-ours\n', stderr: '' },
      );
    const store = new MacKeychainSecretStore({ exec });
    expect(await store.list()).toEqual(['anthropic']);
    await expect(store.get('anthropic')).rejects.toThrow(/not written by remyral-worker/);
  });
});

describe('WindowsDpapiSecretStore (fake PowerShell — Windows UNVERIFIED)', () => {
  /** Simulates DPAPI: "encrypts" to hex of a reversed buffer; asserts values only travel on stdin. */
  function fakePowerShell(argvs: string[][]): ExecFn {
    return (cmd, args, opts) => {
      argvs.push([cmd, ...args]);
      const script = args.at(-1) ?? '';
      const input = (opts?.input ?? '').trim();
      if (script === PROTECT_SCRIPT) {
        const plain = Buffer.from(input, 'base64');
        return Promise.resolve({
          code: 0,
          stdout: `${Buffer.from(plain).reverse().toString('hex')}00000000000000000000000000000000\r\n`,
          stderr: '',
        });
      }
      if (script === UNPROTECT_SCRIPT) {
        const plain = Buffer.from(input.slice(0, -32), 'hex').reverse();
        return Promise.resolve({ code: 0, stdout: `${plain.toString('base64')}\r\n`, stderr: '' });
      }
      return Promise.resolve({ code: 1, stdout: '', stderr: 'unexpected script' });
    };
  }

  it('satisfies the store contract; plaintext never in argv or on disk', async () => {
    const dir = await tempDir('rw-dpapi-');
    const argvs: string[][] = [];
    const store = new WindowsDpapiSecretStore(nodeOps(), dir, { exec: fakePowerShell(argvs) });
    await storeContract(store);
    expect(argvs.flat().join(' ')).not.toContain(VALUE);
    expect(argvs[0]?.slice(0, 5)).toEqual([
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
    ]);
    const blob = await readFile(join(dir, 'secrets-dpapi', 'anthropic.dpapi'), 'utf8');
    expect(blob).not.toContain('rotated-value');
    expect(store.accessControlVerified).toBe(false);
    expect(PROTECT_SCRIPT).toContain('ConvertFrom-SecureString');
    expect(UNPROTECT_SCRIPT).toContain('ConvertTo-SecureString');
  });

  it('surfaces PowerShell failures without the value', async () => {
    const dir = await tempDir('rw-dpapi-');
    const exec: ExecFn = () =>
      Promise.resolve({
        code: 1,
        stdout: '',
        stderr: 'ConvertTo-SecureString : Key not valid for use in specified state.\r\nmore',
      });
    const store = new WindowsDpapiSecretStore(nodeOps(), dir, { exec });
    const err = await store.set('anthropic', VALUE).catch((e: unknown) => e);
    expect(String(err)).toMatch(/Key not valid/);
    expect(String(err)).not.toContain(VALUE);
  });
});

describe('createSecretStore', () => {
  it('selects the backend and fails closed on the wrong OS', async () => {
    const dir = await tempDir('rw-sec-');
    expect(createSecretStore({ secretStore: 'file', dataDir: dir }, nodeOps()).kind).toBe('file');
    const linux = patchOps({ platform: 'linux' });
    expect(() => createSecretStore({ secretStore: 'macos-keychain', dataDir: dir }, linux)).toThrow(
      SecretStoreUnavailableError,
    );
    expect(() => createSecretStore({ secretStore: 'windows-dpapi', dataDir: dir }, linux)).toThrow(
      SecretStoreUnavailableError,
    );
    expect(
      createSecretStore({ secretStore: 'macos-keychain', dataDir: dir }, patchOps({ platform: 'darwin' }))
        .kind,
    ).toBe('macos-keychain');
    expect(
      createSecretStore({ secretStore: 'windows-dpapi', dataDir: dir }, patchOps({ platform: 'win32' })).kind,
    ).toBe('windows-dpapi');
  });
});

describe('job env builder', () => {
  async function storeWith(values: Record<string, string>): Promise<FileSecretStore> {
    const store = new FileSecretStore(nodeOps(), await tempDir('rw-env-'));
    for (const [k, v] of Object.entries(values)) await store.set(k, v);
    return store;
  }

  it('injects the runtime default env var and registers the value for redaction', async () => {
    const store = await storeWith({ openai: VALUE });
    const secrets = new SecretSet();
    const registry = new SecretRegistry(secrets);
    const plan = planJobEnv(
      {
        runtime: 'codex',
        auth: { mode: 'secret-ref', ref: 'secret:openai' },
        env: { CODEX_HOME: '/job/codex' },
      },
      'w-1',
    );
    expect(plan.secrets).toEqual([{ env: 'CODEX_API_KEY', name: 'openai', ref: 'secret:openai' }]);
    const resolved = await resolveJobEnv(plan, {
      store,
      lease: registry.lease(),
      sourceEnv: {
        PATH: '/bin',
        HOME: '/home/w',
        LANG: 'C.UTF-8',
        GITHUB_TOKEN: 'ghp_daemon',
        OPENAI_API_KEY: 'sk-daemon',
        RANDOM_VAR: 'x',
      },
    });
    expect(resolved.env).toEqual({
      PATH: '/bin',
      HOME: '/home/w',
      LANG: 'C.UTF-8',
      CODEX_HOME: '/job/codex',
      CODEX_API_KEY: VALUE,
    });
    expect(resolved.publicEnv).toEqual({
      PATH: '/bin',
      HOME: '/home/w',
      LANG: 'C.UTF-8',
      CODEX_HOME: '/job/codex',
    });
    expect(resolved.secretEnv.CODEX_API_KEY?.reveal()).toBe(VALUE);
    expect(new Redactor({ secrets }).redact(`x ${VALUE} y`)).toBe('x [REDACTED:CODEX_API_KEY] y');
    expect(JSON.stringify(resolved)).not.toContain(VALUE);
    expect(inspect(resolved)).not.toContain(VALUE);
  });

  it('extra secret refs, explicit names and conflicts', async () => {
    const store = await storeWith({ anthropic: VALUE, gw: 'gateway-key-123456' });
    const plan = planJobEnv(
      {
        runtime: 'opencode',
        auth: { mode: 'secret-ref', ref: 'worker:w-1/secret:anthropic', env: 'ANTHROPIC_API_KEY' },
        secretRefs: { GATEWAY_KEY: 'secret:gw' },
      },
      'w-1',
    );
    const resolved = await resolveJobEnv(plan, {
      store,
      lease: new SecretRegistry(new SecretSet()).lease(),
      sourceEnv: {},
    });
    expect(resolved.names.secrets).toEqual(['ANTHROPIC_API_KEY', 'GATEWAY_KEY']);
    expect(() =>
      planJobEnv({ runtime: 'opencode', auth: { mode: 'secret-ref', ref: 'secret:a' } }, 'w-1'),
    ).toThrow(/must name the env variable/);
    expect(() =>
      planJobEnv(
        { runtime: 'codex', auth: { mode: 'secret-ref', ref: 'secret:a' }, env: { CODEX_API_KEY: 'x' } },
        'w-1',
      ),
    ).toThrow(/override an injected secret/);
    expect(() =>
      planJobEnv(
        {
          runtime: 'codex',
          auth: { mode: 'secret-ref', ref: 'secret:a' },
          secretRefs: { CODEX_API_KEY: 'secret:b' },
        },
        'w-1',
      ),
    ).toThrow(/injected twice/);
  });

  it('refuses foreign worker references, subscription token targets and secret-looking passthrough', () => {
    expect(() =>
      planJobEnv({ runtime: 'codex', auth: { mode: 'secret-ref', ref: 'worker:w-2/secret:openai' } }, 'w-1'),
    ).toThrow(ForeignSecretRefError);
    expect(() =>
      planJobEnv({ runtime: 'codex', auth: { mode: 'secret-ref', ref: 'worker:w-1/secret:openai' } }, null),
    ).toThrow(ForeignSecretRefError);
    expect(() => planJobEnv({ runtime: 'codex', auth: { mode: 'secret-ref', ref: 'nope' } }, 'w-1')).toThrow(
      InvalidSecretRefError,
    );
    expect(() =>
      planJobEnv({ runtime: 'claude-code', secretRefs: { CLAUDE_CODE_OAUTH_TOKEN: 'secret:sub' } }, 'w-1'),
    ).toThrow(/subscription token/);
    expect(() =>
      planJobEnv({ runtime: 'claude-code', env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' } }, 'w-1'),
    ).toThrow(JobEnvError);
    for (const name of [
      'AWS_SECRET_ACCESS_KEY',
      'GITHUB_TOKEN',
      'DB_PASSWORD',
      'SSH_AUTH_SOCK',
      'MY_API_KEY',
    ]) {
      expect(() => planJobEnv({ runtime: 'pi', passthrough: ['PATH', name] }, 'w-1'), name).toThrow(
        /looks like a credential/,
      );
    }
  });

  it('a missing secret fails at spawn time with a remedy, without registering anything', async () => {
    const store = await storeWith({});
    const registry = new SecretRegistry(new SecretSet());
    const plan = planJobEnv(
      { runtime: 'claude-code', auth: { mode: 'secret-ref', ref: 'secret:anthropic' } },
      'w-1',
    );
    await expect(resolveJobEnv(plan, { store, lease: registry.lease(), sourceEnv: {} })).rejects.toThrow(
      SecretNotFoundError,
    );
    await expect(resolveJobEnv(plan, { store, lease: registry.lease(), sourceEnv: {} })).rejects.toThrow(
      /remyral-worker secret set anthropic/,
    );
    expect(registry.size).toBe(0);
  });

  it('local-login passes only the login context, never a credential', async () => {
    const store = await storeWith({});
    const plan = planJobEnv({ runtime: 'claude-code', auth: { mode: 'local-login' } }, 'w-1');
    const resolved = await resolveJobEnv(plan, {
      store,
      lease: new SecretRegistry(new SecretSet()).lease(),
      sourceEnv: {
        PATH: '/bin',
        HOME: '/Users/w',
        USER: 'w',
        CLAUDE_CONFIG_DIR: '/Users/w/.claude-alt',
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxxxxxxxxxxxxxxxxxxxxxxx',
        ANTHROPIC_API_KEY: 'sk-ant-api03-yyyyyyyyyyyyyyyyyy',
      },
    });
    expect(resolved.env).toEqual({
      PATH: '/bin',
      HOME: '/Users/w',
      USER: 'w',
      CLAUDE_CONFIG_DIR: '/Users/w/.claude-alt',
    });
    expect(resolved.authMode).toBe('local-login');
  });
});

describe('secret registry (shared exact-value redaction)', () => {
  it('reference-counts values shared by concurrent jobs', () => {
    const secrets = new SecretSet();
    const registry = new SecretRegistry(secrets);
    const redactor = new Redactor({ secrets, rules: [] });
    const a = registry.lease();
    const b = registry.lease();
    a.add(VALUE, 'ANTHROPIC_API_KEY');
    b.add(VALUE, 'ANTHROPIC_API_KEY');
    a.release();
    expect(redactor.redact(VALUE)).toBe('[REDACTED:ANTHROPIC_API_KEY]');
    b.release();
    expect(redactor.redact(VALUE)).toBe(VALUE);
    b.release();
    expect(() => {
      a.add('another-value', 'X');
    }).toThrow(/released/);
    expect(JSON.stringify({ registry, a })).not.toContain(VALUE);
  });
});

describe('job output redaction', () => {
  it('cuts redacted output into LOG_CHUNK-sized pieces with increasing chunkSeq', () => {
    const secrets = new SecretSet();
    secrets.add(VALUE, 'K');
    const out = new JobOutputRedaction(new Redactor({ secrets }));
    const big = `${'a'.repeat(MAX_LOG_CHUNK)}${VALUE}${'b'.repeat(100)}`;
    const chunks = [...out.push('stdout', big), ...out.end('stdout')];
    expect(chunks.every((c) => c.data.length <= MAX_LOG_CHUNK && c.redacted)).toBe(true);
    expect(chunks.map((c) => c.chunkSeq)).toEqual(chunks.map((_, i) => i));
    const text = chunks.map((c) => c.data).join('');
    expect(text).not.toContain(VALUE);
    expect(text).toContain('[REDACTED:K]');
  });
});

describe('remyral-worker secret CLI', () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) } };
  }
  async function* stdinOf(text: string) {
    await Promise.resolve();
    yield Buffer.from(text);
  }

  it('set --stdin, list, rm (file store via --data-dir); never prints the value', async () => {
    const dir = await tempDir('rw-cli-');
    const host = { ops: nodeOps(), pathHost: pathHost() };
    const a = io();
    expect(
      await secretCommand(['set', 'anthropic', '--stdin', '--data-dir', dir], a.io, {
        ...host,
        stdin: stdinOf(`${VALUE}\n`),
      }),
    ).toBe(0);
    expect(a.out.join('')).toContain('reference: secret:anthropic');
    expect(a.out.join('') + a.err.join('')).not.toContain(VALUE);
    expect((await new FileSecretStore(nodeOps(), dir).get('anthropic'))?.reveal()).toBe(VALUE);
    const l = io();
    expect(await secretCommand(['list', '--data-dir', dir], l.io, host)).toBe(0);
    expect(l.out.join('')).toBe('anthropic\n');
    const j = io();
    expect(await secretCommand(['list', '--json', '--data-dir', dir], j.io, host)).toBe(0);
    expect(JSON.parse(j.out.join(''))).toMatchObject({ store: 'file', names: ['anthropic'] });
    expect(j.out.join('')).not.toContain(VALUE);
    const r = io();
    expect(await secretCommand(['rm', 'anthropic', '--data-dir', dir], r.io, host)).toBe(0);
    const r2 = io();
    expect(await secretCommand(['rm', 'anthropic', '--data-dir', dir], r2.io, host)).toBe(1);
  });

  it('expose / unexpose: jobs may name a local secret only when exposed; list shows it; vault names refused', async () => {
    const dir = await tempDir('rw-cli-');
    const host = { ops: nodeOps(), pathHost: pathHost() };
    await secretCommand(['set', 'gateway', '--stdin', '--data-dir', dir], io().io, {
      ...host,
      stdin: stdinOf(`${VALUE}\n`),
    });
    const e = io();
    expect(
      await secretCommand(['expose', 'gateway', '--project', 'acme', '--data-dir', dir], e.io, host),
    ).toBe(0);
    expect(e.out.join('')).toContain('of acme may now use secret:gateway');
    const l = io();
    expect(await secretCommand(['list', '--data-dir', dir], l.io, host)).toBe(0);
    expect(l.out.join('')).toBe('gateway  (jobs: acme)\n');
    const j = io();
    expect(await secretCommand(['list', '--json', '--data-dir', dir], j.io, host)).toBe(0);
    expect(JSON.parse(j.out.join(''))).toMatchObject({ exposedToJobs: { gateway: ['acme'] } });
    expect(await secretCommand(['expose', 'vault-abc', '--data-dir', dir], io().io, host)).toBe(2);
    expect(await secretCommand(['list', '--project', 'acme', '--data-dir', dir], io().io, host)).toBe(2);
    expect(await secretCommand(['unexpose', 'gateway', '--data-dir', dir], io().io, host)).toBe(0);
    expect(await secretCommand(['unexpose', 'gateway', '--data-dir', dir], io().io, host)).toBe(1);
    const l2 = io();
    await secretCommand(['list', '--data-dir', dir], l2.io, host);
    expect(l2.out.join('')).toBe('gateway\n');
  });

  it('refuses a value given as an argument, bad names, short values and mixed options', async () => {
    const dir = await tempDir('rw-cli-');
    const host = { ops: nodeOps(), pathHost: pathHost() };
    expect(await secretCommand(['set', 'anthropic', VALUE, '--data-dir', dir], io().io, host)).toBe(2);
    expect(
      await secretCommand(['set', '../x', '--stdin', '--data-dir', dir], io().io, {
        ...host,
        stdin: stdinOf(VALUE),
      }),
    ).toBe(78);
    expect(
      await secretCommand(['set', 'x', '--stdin', '--data-dir', dir], io().io, {
        ...host,
        stdin: stdinOf('123\n'),
      }),
    ).toBe(78);
    expect(await secretCommand(['list', '--stdin', '--data-dir', dir], io().io, host)).toBe(2);
    expect(await secretCommand(['list', '--config', '/x', '--data-dir', dir], io().io, host)).toBe(2);
    expect(await secretCommand(['get', 'x'], io().io, host)).toBe(2);
    const h = io();
    expect(await secretCommand(['--help'], h.io, host)).toBe(0);
    expect(h.out.join('')).toContain('secret set <name>');
  });

  it('is reachable through the main CLI', async () => {
    const dir = await tempDir('rw-cli-');
    await new FileSecretStore(nodeOps(), dir).set('anthropic', VALUE);
    const c = io();
    const sys = new FakeSystem({ platform: process.platform, env: {} });
    expect(await main(['secret', 'list', '--data-dir', dir], sys, c.io, { ops: nodeOps() })).toBe(0);
    expect(c.out.join('')).toBe('anthropic\n');
    const h = io();
    expect(await main(['--help'], sys, h.io)).toBe(0);
    expect(h.out.join('')).toContain('remyral-worker secret set|list|rm');
  });

  it('uses the configured store from the worker config', async () => {
    const dir = await tempDir('rw-cli-');
    const dataDir = join(dir, 'data');
    await mkdir(dataDir, { mode: 0o700 });
    const config = join(dir, 'config.json');
    await writeFile(
      config,
      JSON.stringify({ masterUrl: 'wss://m.example/v1/worker', workspaceRoot: join(dir, 'work'), dataDir }),
      { mode: 0o600 },
    );
    const host = { ops: nodeOps(), pathHost: pathHost() };
    expect(
      await secretCommand(['set', 'gw', '--stdin', '--config', config], io().io, {
        ...host,
        stdin: stdinOf('gateway-key-123456'),
      }),
    ).toBe(0);
    expect(await new FileSecretStore(nodeOps(), dataDir).list()).toEqual(['gw']);
  });

  it('reads from a TTY with echo off and restores the terminal mode', async () => {
    class FakeTty extends EventEmitter implements TtyInput {
      readonly isTTY = true;
      modes: boolean[] = [];
      setRawMode(mode: boolean) {
        this.modes.push(mode);
        return this;
      }
      setEncoding() {
        return this;
      }
      resume() {
        return this;
      }
      pause() {
        return this;
      }
    }
    const tty = new FakeTty();
    const written: string[] = [];
    const p = readHiddenLine(tty, { write: (t: string) => written.push(t) }, 'Value: ');
    tty.emit('data', 'sk-ant-xx');
    tty.emit('data', '\u007f\u007fyy-123');
    tty.emit('data', '\r');
    expect(await p).toBe('sk-ant-yy-123');
    expect(tty.modes).toEqual([true, false]);
    expect(written.join('')).toBe('Value: \n');

    const tty2 = new FakeTty();
    const p2 = readHiddenLine(tty2, { write: () => undefined }, '');
    tty2.emit('data', 'abc\u0003');
    await expect(p2).rejects.toThrow(/aborted/);
    expect(tty2.modes).toEqual([true, false]);

    const notTty: TtyInput = {
      setEncoding: () => undefined,
      on: () => undefined,
      removeListener: () => undefined,
      resume: () => undefined,
      pause: () => undefined,
    };
    await expect(readHiddenLine(notTty, { write: () => undefined }, '')).rejects.toThrow(/--stdin/);
  });
});
