// Public-repository leak check (scripts/security/public-denylist.mjs) against synthetic repositories.
// Every sample is invented: RFC 2606 names (*.example), RFC 5737 addresses, made-up people and machines. Samples
// that the generic rules must catch are assembled from pieces so this file itself stays clean.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  compileConfig,
  globRe,
  ipv4Tokens,
  isPublicIPv4,
  parseExtra,
  run,
} from '../security/public-denylist.mjs';

// Synthetic private values, as a maintainer would list them in a private --extra file.
const PRIVATE_HOST = 'console.' + 'acme-ops.example';
const PRIVATE_IP = '203.0.113.' + '77';
const PRIVATE_MAIL = 'jo.maintainer@' + 'mailhost.example';
const PRIVATE_USER = 'jmaint' + 'ainer';
const FREE_MAIL = 'someone@' + 'gmail.com';
const PRIVATE_LIST = [
  '# synthetic private list',
  '[owner-domain]',
  're:(?:^|[^a-z0-9-])(?:[a-z0-9-]+\\.)*acme-ops\\.example\\b',
  '  allow: apps/master/migrations/0001_seed.sql',
  '[owner-infra]',
  `lit:${PRIVATE_IP}`,
  '[identity]',
  `re:\\b${PRIVATE_USER}\\b`,
  `  except: github\\.com/${PRIVATE_USER}/[a-z0-9._-]+|(?:\\d+\\+)?${PRIVATE_USER}@users\\.noreply\\.github\\.com`,
  PRIVATE_MAIL,
  '[private-path]',
  're:^notes/|notes/plan\\.md',
].join('\n');

const realDoc = JSON.parse(readFileSync(DEFAULT_CONFIG, 'utf8'));

/** The real rules and top-level list, without allow entries. */
function testConfig(overrides = {}) {
  return {
    ...realDoc,
    allow: [],
    rules: realDoc.rules.map((r) => ({ ...r, allow: [] })),
    ...overrides,
  };
}

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** A fresh repository with `files` committed (or only written when `commit` is false). */
function fakeRepo(files, { commit = true, email = 'dev@example.com' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'denylist-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, files);
  if (commit) commitAll(dir, 'initial', email);
  return dir;
}

function write(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

function commitAll(dir, message, email = 'dev@example.com') {
  git(dir, 'add', '-A');
  git(dir, '-c', `user.name=Dev`, '-c', `user.email=${email}`, 'commit', '-q', '-m', message);
}

/** Runs the CLI in-process; returns { code, out, findings } (findings from a --json run). */
function scan(dir, args = [], config = testConfig()) {
  const cfgDir = mkdtempSync(join(tmpdir(), 'denylist-cfg-'));
  dirs.push(cfgDir);
  const cfgPath = join(cfgDir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify(config));
  let out = '';
  const stdout = { write: (s) => (out += s) };
  const code = run(['--cwd', dir, '--config', cfgPath, ...args], { stdout });
  let json = '';
  run(['--cwd', dir, '--config', cfgPath, '--json', ...args], { stdout: { write: (s) => (json += s) } });
  return { code, out, ...JSON.parse(json) };
}

const rulesOf = (findings) => findings.map((f) => `${f.path} ${f.category}/${f.rule}`).sort();

/** Writes a private list outside the scanned repository and returns its path. */
function privateList(text = PRIVATE_LIST) {
  const dir = mkdtempSync(join(tmpdir(), 'denylist-extra-'));
  dirs.push(dir);
  const path = join(dir, 'private.txt');
  writeFileSync(path, text);
  return path;
}

describe('configuration', () => {
  it('the committed configuration compiles and carries only generic rules', () => {
    const cfg = compileConfig(realDoc);
    expect(realDoc.hashes).toBeUndefined();
    expect(realDoc.kdf).toBeUndefined();
    expect(cfg.rules.map((r) => r.category).sort()).toEqual(
      [
        ...Array(4).fill('cloud-id'),
        'commit-metadata',
        'host-access',
        'ipv4',
        'local-path',
        'local-path',
        'machine-name',
        'machine-name',
        'owner-note',
        'personal-mail',
        'top-level',
      ].sort(),
    );
  });

  it('refuses hashed literals: a short value is cheap to brute-force from a public hash', () => {
    const hashes = [{ kind: 'ipv4', length: 12, hash: 'a'.repeat(64), note: 'x' }];
    expect(() => compileConfig(testConfig({ hashes }))).toThrow(/hashes \/ kdf are not supported/);
    expect(() => compileConfig(testConfig({ kdf: { salt: 'x' } }))).toThrow(/not supported/);
  });

  it('rejects allow entries and exceptions without a real reason', () => {
    const doc = testConfig();
    doc.rules[0].allow = [{ glob: 'x/**', reason: 'because' }];
    expect(() => compileConfig(doc)).toThrow(/reason is required/);
    expect(() => compileConfig({ ...testConfig(), allow: [{ glob: 'y' }] })).toThrow(/reason is required/);
    const ex = testConfig();
    ex.rules.find((x) => x.id === 'home-path').except = [{ pattern: 'x', reason: 'short' }];
    expect(() => compileConfig(ex)).toThrow(/except\[0\]: reason is required/);
  });

  it('globs: ** spans directories, * stays within one', () => {
    expect(globRe('docs/**').test('docs/a/b.md')).toBe(true);
    expect(globRe('infra/worker/node/keys/*.asc').test('infra/worker/node/keys/A.asc')).toBe(true);
    expect(globRe('infra/*.asc').test('infra/x/A.asc')).toBe(false);
    expect(globRe('**/x.md').test('x.md')).toBe(true);
  });

  it('committed allow entries: the denylist itself, the vendored signing keys, one applied migration', () => {
    const globs = (id) => (realDoc.rules.find((r) => r.id === id).allow ?? []).map((a) => a.glob);
    expect(realDoc.allow.map((a) => a.glob)).toEqual(['scripts/security/public-denylist.json']);
    expect(globs('free-mail')).toEqual(['infra/worker/node/keys/*.asc']);
    expect(globs('windows-hostname')).toEqual(['apps/master/migrations/0166_worker_update_notice.sql']);
    const others = realDoc.rules.filter((r) => !['free-mail', 'windows-hostname'].includes(r.id));
    expect(others.flatMap((r) => r.allow ?? [])).toEqual([]);
  });
});

describe('address classes', () => {
  it('public vs private / documentation / special IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '52.10.20.30']) expect(isPublicIPv4(ip)).toBe(true);
    for (const ip of [
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '127.0.0.1',
      '169.254.169.254',
      '192.0.2.1',
      '198.51.100.9',
      '203.0.113.5',
      '100.64.0.1',
      '0.0.0.0',
      '255.255.255.255',
      '999.1.1.1',
    ])
      expect(isPublicIPv4(ip)).toBe(false);
  });

  it('finds addresses, not versions with a fifth part or package@version', () => {
    const t = ipv4Tokens('ubuntu@192.0.2.10 pkg@1.2.3 v1.2.3.4.5 x 10.0.0.300');
    expect(t.map((x) => x.value)).toEqual(['192.0.2.10']);
  });
});

describe('--tree: one positive and one negative case per generic rule', () => {
  const cases = [
    ['cloud-id/aws-arn-account', 'arn:aws:iam::' + '210987654321:role/x', 'arn:aws:iam::123456789012:role/x'],
    ['cloud-id/aws-resource-id', 'instance i-' + '0123456789abcdef0', 'instance i-<id>'],
    ['cloud-id/ec2-public-hostname', 'ec2-' + '203-0-113-9.compute-1.amazonaws.com', 'ec2 instance'],
    ['host-access/ssh-key-path', 'ssh -i ~/' + '.ssh/k ubuntu@host', 'ssh -i <key> ubuntu@host'],
    ['local-path/home-path', '/Users/' + 'jdoe/src', '/Users/alex/src'],
    ['local-path/home-path', 'cd /home/' + 'jdoe', 'cd /home/runner/work'],
    ['local-path/home-path', 'C:\\Users\\' + 'jdoe\\app', 'C:\\Users\\Public\\app'],
    ['local-path/home-path', 'cp x /Users/' + 'jdoe', 'GET /users/42/recovery and src/screens/home/x.ts'],
    [
      'local-path/app-support-path',
      'Library/Application ' + 'Support/SomeTool/x',
      '/Library/Application Support/RemyralWorker/bin',
    ],
    ['machine-name/mac-hostname', 'host Jo' + 's-MacBook-Pro' + '.local', 'host mac-1.local'],
    ['machine-name/windows-hostname', 'machine DESKTOP-' + 'Q7Z2K9X', 'machine DESKTOP-<id>'],
    ['personal-mail/free-mail', `contact ${FREE_MAIL}`, 'contact someone@example.org'],
  ];

  it.each(cases)('%s', (rule, positive, negative) => {
    const hit = scan(fakeRepo({ 'apps/a.txt': `${positive}\n` }));
    expect(rulesOf(hit.findings)).toEqual([`apps/a.txt ${rule}`]);
    expect(hit.code).toBe(1);
    const clean = scan(fakeRepo({ 'apps/a.txt': `${negative}\n` }));
    expect(clean.findings).toEqual([]);
    expect(clean.code).toBe(0);
  });

  it('home paths: generic and short names are placeholders', () => {
    const ok = [
      '/home/ubuntu/x',
      '/home/node/x',
      '/Users/w/x',
      '/home/u',
      'C:\\Users\\op\\x',
      '/home/.npmrc',
    ];
    expect(scan(fakeRepo({ 'apps/a.txt': ok.join('\n') + '\n' })).findings).toEqual([]);
  });

  it('EC2 internal host names fail; obviously synthetic ones pass', () => {
    const r = scan(
      fakeRepo({
        'docs/a.md': 'host ip-' + '172-31-20-5 up\nip-10-0-0-12 and ip-172-31-1-1 and ip-192-0-2-4\n',
      }),
    );
    expect(rulesOf(r.findings)).toEqual(['docs/a.md cloud-id/ec2-internal-hostname']);
    expect(r.findings[0].line).toBe(1);
    expect(r.code).toBe(1);
  });

  it('IPv4: any public address only warns, and only under docs/ops, infra, scripts/deploy', () => {
    const r = scan(
      fakeRepo({
        'docs/ops/a.md': 'resolver 8.8.8.8, lan 10.0.0.1, doc 203.0.113.9\n',
        'infra/b.sh': 'tool 2.56.0.3\n',
        'apps/c.ts': 'const dns = "8.8.8.8";\n',
      }),
    );
    expect(rulesOf(r.findings)).toEqual(['docs/ops/a.md ipv4/public-ipv4', 'infra/b.sh ipv4/public-ipv4']);
    expect(r.findings.every((f) => f.severity === 'warning')).toBe(true);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/0 finding\(s\), 2 warning\(s\)/);
  });

  it('public-IPv4 pattern exceptions: Cloudflare proxy ranges and MinGit versions, nothing else on the line', () => {
    const r = scan(
      fakeRepo({
        'infra/compose.yaml': 'X: ${TRUSTED_CLIENT_IP_SOURCES:-173.245.48.0/20,2400:cb00::/32}\n',
        'docs/ops/m.md': '| MinGit 2.56.0.3 | other 8.8.8.8 |\n',
      }),
    );
    expect(rulesOf(r.findings)).toEqual(['docs/ops/m.md ipv4/public-ipv4']);
  });

  it('owner-note markers only warn', () => {
    const r = scan(fakeRepo({ 'docs/adr/x.md': 'İstek' + ' (2026-10-01): do it\n' }));
    expect(rulesOf(r.findings)).toEqual(['docs/adr/x.md owner-note/owner-note']);
    expect(r.code).toBe(0);
  });

  it('a new top-level directory or root file fails until it is listed; untracked files count', () => {
    const dir = fakeRepo({ 'apps/a.txt': 'ok\n' });
    write(dir, { 'private-notes/x.md': 'hello\n', 'NOTES.md': 'x\n' });
    const r = scan(dir);
    expect(rulesOf(r.findings)).toEqual([
      'NOTES.md top-level/top-level',
      'private-notes/x.md top-level/top-level',
    ]);
    const cfg = testConfig();
    cfg.topLevel = { ...cfg.topLevel, entries: [...cfg.topLevel.entries, 'private-notes', 'NOTES.md'] };
    expect(scan(dir, [], cfg).findings).toEqual([]);
  });
});

describe('allowlists', () => {
  it('a rule-level allow entry covers only its rule and path glob; unused entries are reported', () => {
    const dir = fakeRepo({
      'infra/worker/node/keys/A1.asc': `uid Releaser <${FREE_MAIL}>\n`,
      'infra/other.txt': `mail ${FREE_MAIL}\n`,
    });
    const cfg = testConfig();
    cfg.rules.find((r) => r.id === 'free-mail').allow = [
      {
        glob: 'infra/worker/node/keys/*.asc',
        reason: 'vendored release signing keys carry public addresses',
      },
      { glob: 'nowhere/**', reason: 'an entry nothing matches any more (stale)' },
    ];
    const r = scan(dir, [], cfg);
    expect(rulesOf(r.findings)).toEqual(['infra/other.txt personal-mail/free-mail']);
    expect(r.staleAllowlist).toEqual(['rule free-mail:nowhere/**']);
    expect(r.out).toContain('note: allowlist entry no longer needed: rule free-mail:nowhere/**');
  });

  it('a global allow entry covers every public rule for its path, but not the private list', () => {
    const dir = fakeRepo({
      'scripts/security/list.json': `"${FREE_MAIL}" "/home/${'jdoe'}" ${PRIVATE_HOST}\n`,
    });
    const cfg = testConfig({
      allow: [{ glob: 'scripts/security/list.json', reason: 'the denylist names what it forbids' }],
    });
    expect(scan(dir, [], cfg).findings).toEqual([]);
    expect(scan(dir).findings.length).toBe(2);
    expect(rulesOf(scan(dir, ['--extra', privateList()], cfg).findings)).toEqual([
      'scripts/security/list.json owner-domain/private:L3',
    ]);
  });
});

describe('the private --extra list', () => {
  it('parses sections, literals, regexes, allow and except lines', () => {
    const rules = parseExtra(PRIVATE_LIST);
    expect(rules.map((r) => `${r.category} ${r.id}`)).toEqual([
      'owner-domain private:L3',
      'owner-infra private:L6',
      'identity private:L8',
      'identity private:L10',
      'private-path private:L12',
    ]);
    expect(rules[0].allow.map((a) => a.glob)).toEqual(['apps/master/migrations/0001_seed.sql']);
    expect(rules[2].except.length).toBe(1);
    expect(String(rules[1].re)).toBe('/203\\.0\\.113\\.77/giu');
  });

  it('keeps the original format: a bare line is a literal, re: a regex, # a comment', () => {
    const rules = parseExtra('# c\n\nfoo.bar\nre:ab+c\n');
    expect(rules.map((r) => String(r.re))).toEqual(['/foo\\.bar/giu', '/ab+c/giu']);
    expect(rules.map((r) => r.category)).toEqual(['extra', 'extra']);
  });

  it('reports a bad regex or an option without an entry, with the line number', () => {
    expect(() => parseExtra('re:(\n')).toThrow(/line 1: bad pattern/);
    expect(() => parseExtra('  allow: x/**\n')).toThrow(/line 1: allow before any entry/);
    expect(() => parseExtra('x\n  except: (\n')).toThrow(/line 2: bad except/);
  });

  it('applies to content and paths, honours its allow and except entries, reports stale ones', () => {
    const dir = fakeRepo({
      'apps/a.txt': `see https://${PRIVATE_HOST}/x\nping ${PRIVATE_IP}\n`,
      'apps/master/migrations/0001_seed.sql': `-- support@${'acme-ops.example'}\n`,
      'apps/b.txt': `https://github.com/${PRIVATE_USER}/tool and 1+${PRIVATE_USER}@users.noreply.github.com\n`,
      'apps/c.txt': `owner ${PRIVATE_USER}\n`,
      'notes/plan.md': 'hi\n',
    });
    const list = privateList(PRIVATE_LIST + '\n  allow: nowhere/**\n');
    const r = scan(dir, ['--extra', list]);
    expect(rulesOf(r.findings)).toEqual([
      'apps/a.txt owner-domain/private:L3',
      'apps/a.txt owner-infra/private:L6',
      'apps/c.txt identity/private:L8',
      'notes/plan.md private-path/private:L12',
      'notes/plan.md top-level/top-level',
    ]);
    expect(r.staleAllowlist).toEqual(['private L12:nowhere/**']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/\+ 5 private entries\)/);
  });
});

describe('output never contains a matched value', () => {
  it('prints file:line category/rule [fingerprint] only', () => {
    const secrets = [
      PRIVATE_HOST,
      PRIVATE_IP,
      PRIVATE_MAIL,
      PRIVATE_USER,
      FREE_MAIL,
      '8.8.4.4',
      '210987654321',
      'Jos-MacBook-Pro',
      'jdoe',
    ];
    const dir = fakeRepo({
      'docs/ops/host.md': [
        `ssh -i ~/` + `.ssh/k ubuntu@${PRIVATE_IP}`,
        `mail ${PRIVATE_MAIL} or ${FREE_MAIL}`,
        `https://${PRIVATE_HOST}/ resolver 8.8.4.4 for ${PRIVATE_USER}`,
        'arn:aws:iam::' + '210987654321:role/x on Jo' + 's-MacBook-Pro' + '.local in /home/' + 'jdoe',
      ].join('\n'),
    });
    const r = scan(dir, ['--extra', privateList()]);
    expect(r.findings.length).toBeGreaterThan(8);
    const everything = r.out + JSON.stringify(r.findings);
    for (const s of secrets) expect(everything).not.toContain(s);
    const lines = r.out.trim().split('\n').slice(0, -1);
    for (const line of lines.filter((l) => !l.startsWith('note: ')))
      expect(line).toMatch(/^(WARN )?docs\/ops\/host\.md:\d \S+\/\S+ \[[0-9a-f]{10}\]$/);
  });
});

describe('--staged and --history', () => {
  it('--staged checks the index, not unstaged edits', () => {
    const dir = fakeRepo({ 'apps/a.txt': 'ok\n' });
    write(dir, { 'apps/b.txt': `mail ${FREE_MAIL}\n` });
    expect(scan(dir, ['--staged']).findings).toEqual([]);
    git(dir, 'add', 'apps/b.txt');
    const r = scan(dir, ['--staged']);
    expect(rulesOf(r.findings)).toEqual(['apps/b.txt personal-mail/free-mail']);
    expect(r.findings[0].origin).toBe('staged');
  });

  it('--history finds content removed from the tree and commit messages', () => {
    const dir = fakeRepo({ 'apps/a.txt': `host ${PRIVATE_IP}\n` });
    write(dir, { 'apps/a.txt': 'host <address>\n' });
    commitAll(dir, `scrub; was on ${PRIVATE_HOST} from /home/${'jdoe'}`);
    const list = privateList();
    expect(scan(dir, ['--extra', list]).findings).toEqual([]);
    const r = scan(dir, ['--history', '--extra', list]);
    const got = rulesOf(r.findings);
    expect(got).toContain('apps/a.txt owner-infra/private:L6');
    expect(got.some((g) => g.endsWith('message) owner-domain/private:L3'))).toBe(true);
    expect(got.some((g) => g.endsWith('message) local-path/home-path'))).toBe(true);
    const hit = r.findings.find((f) => f.rule === 'private:L6');
    expect(hit.line).toBe(1);
    expect(hit.origin).toMatch(/^commit [0-9a-f]{12}$/);
    expect(r.code).toBe(1);
  });

  it('commit e-mails: made-up local addresses fail; contributors and noreply addresses pass', () => {
    const local = fakeRepo({ 'apps/a.txt': 'x\n' }, { email: 'jo@' + 'jos-laptop.local' });
    expect(rulesOf(scan(local, ['--history']).findings)).toEqual(['(commit) commit-metadata/commit-email']);
    const noreply = `12345+${PRIVATE_USER}@users.noreply.github.com`;
    const dir = fakeRepo({ 'apps/a.txt': 'one\n' }, { email: noreply });
    write(dir, { 'apps/a.txt': 'two\n' });
    commitAll(dir, `change\n\nSigned-off-by: Jo <${noreply}>\nSigned-off-by: C <${FREE_MAIL}>`, FREE_MAIL);
    expect(scan(dir, ['--history', '--extra', privateList()]).findings).toEqual([]);
  });

  it('commit e-mails and trailers: the private list catches the maintainer address', () => {
    const dir = fakeRepo({ 'apps/a.txt': 'one\n' }, { email: PRIVATE_MAIL });
    write(dir, { 'apps/a.txt': 'two\n' });
    commitAll(dir, `change\n\nSigned-off-by: Jo <${PRIVATE_MAIL}>`);
    expect(scan(dir, ['--history']).findings).toEqual([]);
    const got = rulesOf(scan(dir, ['--history', '--extra', privateList()]).findings);
    expect(got).toEqual([
      expect.stringMatching(/^\(commit [0-9a-f]{12} message\) identity\/private:L10$/),
      '(commit) identity/private:L10',
    ]);
  });
});
