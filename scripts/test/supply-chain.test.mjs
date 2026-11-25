import { describe, expect, it } from 'vitest';
import { applyAllowlist, entryMatches, readJson, readText, validateAllowlist } from '../security/lib.mjs';
import {
  auditRepo,
  checkCompose,
  checkDockerfile,
  checkManifest,
  checkNpmLock,
  checkPnpmLock,
  checkWorkflow,
  checkWorkspace,
  pythonRequirements,
} from '../security/pin-audit.mjs';
import { checkPins, comparePolicy, tableRow, tsConst } from '../security/runtime-pins.mjs';
import { imageComponent, npmLockComponents, parseInspection } from '../security/sbom.mjs';
import { collect, evaluate, fixedVersions, osvQuery, severityOf } from '../security/vuln-scan.mjs';

const NOW = new Date('2026-10-14T12:00:00Z');

describe('pin audit', () => {
  it('the repository is fully pinned', () => {
    const { problems, counts } = auditRepo();
    expect(problems).toEqual([]);
    expect(counts.workflows).toBeGreaterThanOrEqual(2);
    expect(counts.dockerfiles).toBeGreaterThanOrEqual(10);
  });

  it('flags ranges, tags and unpinned package managers in package.json', () => {
    expect(
      checkManifest('p.json', {
        packageManager: 'pnpm@12',
        dependencies: { a: '^1.0.0', b: '1.2.3', c: 'workspace:*', d: 'latest' },
        devDependencies: { e: '~2.0.0' },
      }),
    ).toEqual([
      'p.json: dependencies.a = "^1.0.0" is not an exact version',
      'p.json: dependencies.d = "latest" is not an exact version',
      'p.json: devDependencies.e = "~2.0.0" is not an exact version',
      'p.json: packageManager "pnpm@12" is not exact',
    ]);
    expect(
      checkManifest('p.json', { packageManager: 'pnpm@12.11.2', dependencies: { x: '1.0.0-rc.1' } }),
    ).toEqual([]);
  });

  it('flags lockfile entries without integrity or from outside the registry', () => {
    const lock = [
      '  a@1.0.0:',
      '    resolution: {integrity: sha512-AAAA}',
      '  b@1.0.0:',
      '    resolution: {tarball: https://example.com/b.tgz}',
    ].join('\n');
    expect(checkPnpmLock('l', lock)).toHaveLength(2);
    expect(
      checkNpmLock('n', {
        packages: {
          '': {},
          'node_modules/a': {
            version: '1.0.0',
            integrity: 'sha512-x',
            resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz',
          },
          'node_modules/b': { version: '1.0.0', resolved: 'git+https://github.com/x/b.git' },
        },
      }),
    ).toEqual([
      'n: node_modules/b has no sha512 integrity',
      'n: node_modules/b is not resolved from registry.npmjs.org',
    ]);
  });

  it('flags tag-only base images, unpinned or script-running npm installs and unverified downloads', () => {
    const before = [
      '# Pi runtime image',
      'ARG BASE=remyral/runtime-base:0.1.0',
      'FROM ${BASE}',
      'RUN npm install --global --no-fund --no-audit @earendil-works/pi-coding-agent@1.1.0 \\',
      ' && npm cache clean --force',
    ].join('\n');
    expect(checkDockerfile('pi', before)).toEqual(['pi:4: npm install without --ignore-scripts']);
    const bad = [
      'ARG NODE_IMAGE=node:24-trixie-slim',
      'FROM ${NODE_IMAGE} AS build',
      'FROM build',
      'COPY --from=ghcr.io/astral-sh/uv:0.12.2 /uv /usr/local/bin/',
      'RUN npm install -g --ignore-scripts foo@^1.0.0 bar',
      'RUN uv tool install --python 3.12 "some-tool>=1.54" --with "some-lib==1.54.0"',
      'RUN curl -fsSL -o /tmp/x.tgz https://example.com/x.tgz && tar xzf /tmp/x.tgz',
    ].join('\n');
    expect(checkDockerfile('d', bad)).toEqual([
      'd:2: base image "node:24-trixie-slim" is not pinned by digest',
      'd:4: COPY --from image "ghcr.io/astral-sh/uv:0.12.2" is not pinned by digest',
      'd:5: npm package "foo@^1.0.0" is not an exact version',
      'd:5: npm package "bar" is not an exact version',
      'd:6: python package "some-tool>=1.54" is not pinned with ==',
      'd:7: download without a checksum verification in the same RUN',
    ]);
    // Installing the curl package is not a download; using it in the same RUN still is.
    const pkg =
      'FROM scratch\nRUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates';
    expect(checkDockerfile('p', pkg)).toEqual([]);
    expect(checkDockerfile('q', `${pkg} && curl -fsSLo /x https://example.com/x`)).toEqual([
      'q:2: download without a checksum verification in the same RUN',
    ]);
    const good = [
      'ARG NODE_IMAGE=node:24-trixie-slim@sha256:' + 'a'.repeat(64),
      'FROM ${NODE_IMAGE}',
      'RUN curl -fsSL -o /tmp/x.tgz https://e/x.tgz && echo "$sum  /tmp/x.tgz" | sha256sum -c -',
      'RUN npm ci --prefix /opt/r --ignore-scripts',
    ].join('\n');
    expect(checkDockerfile('g', good)).toEqual([]);
  });

  it('extracts python requirements, including --with values', () => {
    expect(pythonRequirements('uv tool install --python 3.12 "a==1.0" --with "b==2.0" --with c')).toEqual([
      'a==1.0',
      'b==2.0',
      'c',
    ]);
    expect(pythonRequirements('pip install -r req.txt x==1')).toEqual(['x==1']);
    expect(pythonRequirements('apt-get install -y git')).toEqual([]);
  });

  it('flags compose images and workflow actions that are not pinned', () => {
    expect(
      checkCompose('c', '  pg:\n    image: postgres:18.6-alpine\n    image: ${X:-remyral-master:local}\n'),
    ).toEqual(['c:2: image "postgres:18.6-alpine" is not pinned by digest']);
    const before =
      '      - uses: actions/checkout@v5\n      - uses: actions/setup-node@v5\n      - uses: ./local\n';
    expect(checkWorkflow('w', before)).toHaveLength(2);
    expect(checkWorkflow('w', `      - uses: actions/checkout@${'f'.repeat(40)} # v5\n`)).toEqual([]);
  });

  it('requires an explicit minimum release age', () => {
    expect(checkWorkspace('w', 'packages: []\n')).toEqual(['w: minimumReleaseAge must be set explicitly']);
    expect(checkWorkspace('w', 'minimumReleaseAge: 60\n')).toEqual([
      'w: minimumReleaseAge 60 < 1440 minutes',
    ]);
    expect(checkWorkspace('w', 'minimumReleaseAge: 1440\nblockExoticSubdeps: false\n')).toHaveLength(1);
    expect(checkWorkspace('w', readText('pnpm-workspace.yaml'))).toEqual([]);
  });
});

describe('allowlist', () => {
  const entry = {
    id: 'GHSA-1',
    package: 'p',
    reason: 'not reachable: only used at build time',
    owner: 'o',
    expires: '2026-11-01',
  };

  it('requires id, reason, owner and a near, future expiry', () => {
    expect(validateAllowlist({ entries: [entry] }, NOW)).toEqual([]);
    expect(validateAllowlist({ entries: [{ ...entry, expires: '2026-10-01' }] }, NOW)[0]).toMatch(/expired/);
    expect(validateAllowlist({ entries: [{ ...entry, expires: '2027-06-01' }] }, NOW)[0]).toMatch(
      /more than 90 days/,
    );
    expect(validateAllowlist({ entries: [{ ...entry, reason: 'ok' }] }, NOW)[0]).toMatch(
      /reason is required/,
    );
    expect(validateAllowlist({ entries: [{ id: 'x' }] }, NOW)).toHaveLength(3);
    expect(validateAllowlist({}, NOW)).toEqual(['allowlist: missing "entries" array']);
  });

  it('the committed allowlist is valid today', () => {
    expect(validateAllowlist(readJson('scripts/security/vuln-allowlist.json'), NOW)).toEqual([]);
  });

  it('matches by id or alias, package and SBOM scope', () => {
    const f = { id: 'GHSA-1', aliases: ['CVE-1'], package: 'p', sboms: ['image-runtime-pi.cdx.json'] };
    expect(entryMatches(entry, f)).toBe(true);
    expect(entryMatches({ ...entry, id: 'CVE-1' }, f)).toBe(true);
    expect(entryMatches({ ...entry, package: 'q' }, f)).toBe(false);
    expect(entryMatches({ ...entry, sboms: ['image-runtime-*.cdx.json'] }, f)).toBe(true);
    expect(
      entryMatches(
        { ...entry, sboms: ['image-runtime-*.cdx.json'] },
        { ...f, sboms: [...f.sboms, 'image-master.cdx.json'] },
      ),
    ).toBe(false);
    const r = applyAllowlist([f, { ...f, id: 'GHSA-2', aliases: [] }], [entry, { ...entry, id: 'GHSA-9' }]);
    expect(r.blocking.map((x) => x.id)).toEqual(['GHSA-2']);
    expect(r.allowed.map((x) => x.id)).toEqual(['GHSA-1']);
    expect(r.unused.map((x) => x.id)).toEqual(['GHSA-9']);
  });
});

describe('SBOM building blocks', () => {
  it('turns pinned image references into OCI purls', () => {
    const c = imageComponent(`node:24-bookworm-slim@sha256:${'d'.repeat(64)}`);
    expect(c.name).toBe('docker.io/library/node');
    expect(c.version).toBe('24-bookworm-slim');
    expect(c.purl).toBe(
      `pkg:oci/node@sha256%3A${'d'.repeat(64)}?repository_url=docker.io%2Flibrary%2Fnode&tag=24-bookworm-slim`,
    );
    expect(imageComponent(`ghcr.io/example/server:1.54.0-python@sha256:${'e'.repeat(64)}`).name).toBe(
      'ghcr.io/example/server',
    );
  });

  it('lists package-lock packages with their hashes', () => {
    const comps = npmLockComponents(readJson('infra/worker/images/codex/package-lock.json'));
    const top = comps.find((c) => c.name === '@openai/codex' && c.version === '0.164.0');
    expect(top.purl).toBe('pkg:npm/%40openai/codex@0.164.0');
    expect(top.hashes[0].alg).toBe('SHA-512');
  });

  it('parses an image inspection (dpkg with source packages, apk origins, npm, python)', () => {
    const out = [
      '---OS',
      'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"',
      'ID=debian',
      'VERSION_ID="12"',
      '---DPKG',
      'Package: libssl3',
      'Status: install ok installed',
      'Architecture: arm64',
      'Source: openssl (3.0.22-1~deb12u1)',
      'Version: 3.0.22-1~deb12u1',
      'Description: lib',
      ' continued',
      '',
      'Package: removed',
      'Status: deinstall ok config-files',
      'Version: 1',
      '',
      '---APK',
      '---PY',
      '/usr/lib/python3/dist-packages/Foo_Bar-1.2.dist-info',
      '---NPM',
      'undici\t6.27.0',
      '@scope/x\t1.0.0',
    ].join('\n');
    const { os, components } = parseInspection(out);
    expect(os.versionId).toBe('12');
    const ssl = components.find((c) => c.name === 'libssl3');
    expect(ssl.properties).toEqual([
      { name: 'remyral:osv:ecosystem', value: 'Debian:12' },
      { name: 'remyral:osv:name', value: 'openssl' },
      { name: 'remyral:osv:version', value: '3.0.22-1~deb12u1' },
    ]);
    expect(components.some((c) => c.name === 'removed')).toBe(false);
    expect(components.map((c) => c.purl)).toContain('pkg:pypi/foo-bar@1.2');
    expect(components.map((c) => c.purl)).toContain('pkg:npm/%40scope/x@1.0.0');
    const alpine = parseInspection(
      [
        '---OS',
        'ID=alpine',
        'VERSION_ID=3.24.1',
        '---APK',
        'P:libz',
        'V:1.3.2-r0',
        'A:aarch64',
        'o:zlib',
        '',
      ].join('\n'),
    );
    expect(alpine.components[0].properties[0].value).toBe('Alpine:v3.24');
    expect(alpine.components[0].properties[1].value).toBe('zlib');
  });
});

describe('vulnerability evaluation', () => {
  const sboms = [
    {
      file: 'app-master.cdx.json',
      doc: {
        components: [
          { name: 'undici', version: '6.27.0', purl: 'pkg:npm/undici@6.27.0' },
          { name: 'protocol' },
        ],
      },
    },
    {
      file: 'image-runtime-base.cdx.json',
      doc: {
        components: [
          {
            name: 'libssl3',
            version: '3.0.22',
            purl: 'pkg:deb/debian/libssl3@3.0.22',
            properties: [
              { name: 'remyral:osv:ecosystem', value: 'Debian:12' },
              { name: 'remyral:osv:name', value: 'openssl' },
              { name: 'remyral:osv:version', value: '3.0.22' },
            ],
          },
        ],
      },
    },
  ];

  it('builds one query per distinct package and skips components OSV cannot answer for', () => {
    const qs = collect(sboms);
    expect(qs.map((q) => q.key)).toEqual(['npm|undici|6.27.0', 'Debian:12|openssl|3.0.22']);
    expect(osvQuery({ name: 'x' })).toBeNull();
    expect(qs[1].query).toEqual({ package: { ecosystem: 'Debian:12', name: 'openssl' }, version: '3.0.22' });
  });

  it('reads severities and only counts fixes of the same ecosystem', () => {
    expect(severityOf({ database_specific: { severity: 'MODERATE' } })).toBe('moderate');
    expect(severityOf({})).toBe('unknown');
    const debian = {
      affected: [
        { package: { name: 'openssl', ecosystem: 'Debian:12' }, ranges: [{ events: [{ introduced: '0' }] }] },
        {
          package: { name: 'openssl', ecosystem: 'Debian:14' },
          ranges: [{ events: [{ introduced: '0' }, { fixed: '3.6' }] }],
        },
      ],
    };
    expect(fixedVersions(debian, 'openssl', 'Debian:12')).toEqual([]);
    expect(fixedVersions(debian, 'openssl', 'Debian:14')).toEqual(['3.6']);
  });

  it('gates application advisories and fixable OS advisories, reports unfixed OS advisories', () => {
    const qs = collect(sboms);
    const details = new Map([
      [
        'GHSA-a',
        {
          id: 'GHSA-a',
          database_specific: { severity: 'HIGH' },
          affected: [
            { package: { name: 'undici', ecosystem: 'npm' }, ranges: [{ events: [{ fixed: '6.28.0' }] }] },
          ],
        },
      ],
      [
        'DEBIAN-1',
        {
          id: 'DEBIAN-1',
          affected: [
            {
              package: { name: 'openssl', ecosystem: 'Debian:12' },
              ranges: [{ events: [{ introduced: '0' }] }],
            },
          ],
        },
      ],
      [
        'DEBIAN-2',
        {
          id: 'DEBIAN-2',
          affected: [
            {
              package: { name: 'openssl', ecosystem: 'Debian:12' },
              ranges: [{ events: [{ fixed: '3.0.23' }] }],
            },
          ],
        },
      ],
    ]);
    const results = [[{ id: 'GHSA-a' }], [{ id: 'DEBIAN-1' }, { id: 'DEBIAN-2' }]];
    const r = evaluate(qs, results, details, []);
    expect(r.blocking.map((f) => f.id)).toEqual(['GHSA-a', 'DEBIAN-2']);
    expect(r.informational.map((f) => f.id)).toEqual(['DEBIAN-1']);
    expect(r.blocking[0]).toMatchObject({
      severity: 'high',
      fixed: ['6.28.0'],
      sboms: ['app-master.cdx.json'],
    });
    expect(evaluate(qs, results, details, [], { failOnOsUnfixed: true }).blocking).toHaveLength(3);
    const allowed = evaluate(qs, results, details, [
      { id: 'GHSA-a', reason: 'x'.repeat(30), owner: 'o', expires: '2026-11-01' },
    ]);
    expect(allowed.blocking.map((f) => f.id)).toEqual(['DEBIAN-2']);
  });
});

describe('runtime pins', async () => {
  const { RUNTIME_PINS } = await import('../../packages/protocol/src/runtime-pins.ts');
  const checksums = readJson('infra/worker/images/runtime-checksums.json');

  it('pins.ts, adapters, docs, images and recorded checksums agree', () => {
    expect(checkPins({ pins: RUNTIME_PINS, checksums })).toEqual([]);
  });

  it('detects drift in any source', () => {
    const drifted = { ...RUNTIME_PINS, codex: { ...RUNTIME_PINS.codex, version: '0.163.0' } };
    const fails = checkPins({ pins: drifted, checksums });
    expect(fails.some((f) => f.includes('codex'))).toBe(true);
    expect(fails.some((f) => f.includes('CODEX_PIN'))).toBe(true);
    const badSum = JSON.parse(JSON.stringify(checksums));
    badSum.pi.npm.integrity = 'sha512-tampered';
    expect(checkPins({ pins: RUNTIME_PINS, checksums: badSum })).toEqual([
      'infra/worker/images/pi/package-lock.json @earendil-works/pi-coding-agent integrity differs from runtime-checksums.json',
    ]);
    const read = (f) =>
      f === 'docs/compat/README.md'
        ? readText(f).replace('opencode-ai@1.19.4', 'opencode-ai@1.20.0')
        : readText(f);
    expect(checkPins({ pins: RUNTIME_PINS, checksums, read })).toEqual([
      'docs/compat/README.md §1 OpenCode row lacks opencode-ai@1.19.4',
    ]);
  });

  it('helpers and policy comparison', () => {
    expect(tsConst("export const X_PIN = '1.2.3';", 'X_PIN')).toBe('1.2.3');
    expect(tableRow('| a | b |\n| Pi | x |', 'Pi')).toBe('| Pi | x |');
    expect(
      comparePolicy(
        {
          rules: [
            { runtime: 'pi', pin: '1.2.0' },
            { runtime: 'codex', pin: '0.164.0' },
          ],
        },
        RUNTIME_PINS,
      ),
    ).toEqual([
      'policy pins pi@1.2.0, compiled-in pin is 1.4.0 (staged upgrade? see p3-runtime-policy.md §7)',
    ]);
  });
});
