#!/usr/bin/env node
// SBOM generation (p7-supply-chain, A-SEC-4; docs/design/p7-supply-chain.md §2):
//
//   node scripts/security/sbom.mjs [--out dist/sbom] [--inspect name=localImage[,name=localImage…]]
//                                  [--inspect-available] [--skip-inspect name[,name…]]
//
// Writes CycloneDX 1.7 JSON documents:
//   workspace.cdx.json        every dependency of the pnpm workspace (prod + dev: the CI toolchain counts)
//   app-<master|web|worker>.cdx.json   production dependency closure of each deployable
//   image-<name>.cdx.json     one per container image we build or deploy (IMAGES below)
//   manifest.json             file list with sha256 and the mode of each image SBOM
//
// Workspace and app SBOMs come from pnpm's built-in `pnpm sbom` (pnpm >= 11; the pinned packageManager),
// lockfile-only, so no extra SBOM tool is trusted or downloaded. Image SBOMs are, by default, *declared*:
// the pinned base image (by digest) + exactly what our Dockerfile adds from a lockfile (the app's
// production closure, or the runtime image's committed package-lock.json). With --inspect (or
// --inspect-available) a locally present image is opened (`docker run --network none`, no pull) and its
// real content is listed: Debian/Alpine OS packages (dpkg/apk databases), every node_modules package and
// Python dist-info — that is the *inspected* mode, which also covers the base image's OS layer.
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { REPO, readJson, readText } from './lib.mjs';

/** Finds the first `<name>@sha256:<digest>` image reference matching `prefix` in a repository file. */
export function findPinnedRef(file, prefix) {
  const text = readText(file);
  const esc = prefix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const m = new RegExp(`${esc}[A-Za-z0-9._-]*@sha256:[0-9a-f]{64}`).exec(text);
  if (!m) throw new Error(`no pinned ${prefix} reference in ${file}`);
  return m[0];
}

/** Image catalogue: what we build (declared from Dockerfile + lockfiles) and the third-party images we deploy. */
export function imageCatalogue() {
  const node = () => findPinnedRef('apps/master/Dockerfile', 'node:');
  return [
    { name: 'master', built: true, base: [node()], app: 'app-master', local: 'remyral-master:dev' },
    {
      name: 'web',
      built: true,
      base: [findPinnedRef('apps/web/Dockerfile', 'nginxinc/nginx-unprivileged:')],
      app: 'app-web',
      // the web app's production dependencies are bundled into static JS: not visible to inspection
      bundled: true,
      local: 'remyral-web:dev',
    },
    {
      name: 'runtime-base',
      built: true,
      base: [findPinnedRef('infra/worker/images/base/Dockerfile', 'node:')],
      local: 'remyral/runtime-base:0.1.0',
    },
    ...['pi', 'codex', 'opencode', 'claude-code'].map((rt) => ({
      name: `runtime-${rt}`,
      built: true,
      base: [findPinnedRef('infra/worker/images/base/Dockerfile', 'node:')],
      lock: `infra/worker/images/${rt}/package-lock.json`,
      local: `remyral/runtime-${rt}:0.1.0`,
    })),
    {
      name: 'egress-proxy',
      built: true,
      base: [findPinnedRef('infra/worker/images/base/Dockerfile', 'node:')],
      local: 'remyral/egress-proxy:0.1.0',
    },
    { name: 'postgres', ref: findPinnedRef('infra/coolify/compose.yaml', 'postgres:') },
    { name: 'redis', ref: findPinnedRef('infra/coolify/compose.yaml', 'redis:') },
    { name: 'traefik', ref: findPinnedRef('infra/coolify/local/proxy.compose.yaml', 'traefik:') },
    { name: 'garage', ref: findPinnedRef('infra/garage/compose.yaml', 'dxflrs/garage:') },
  ];
}

/** `name:tag@sha256:…` → CycloneDX container component with an OCI purl. */
export function imageComponent(ref) {
  const [nameTag, digest] = ref.split('@');
  const colon = nameTag.lastIndexOf(':');
  const repo = colon > nameTag.lastIndexOf('/') ? nameTag.slice(0, colon) : nameTag;
  const tag = colon > nameTag.lastIndexOf('/') ? nameTag.slice(colon + 1) : 'latest';
  const parts = repo.split('/');
  const registry = parts[0].includes('.') ? parts.shift() : 'docker.io';
  if (registry === 'docker.io' && parts.length === 1) parts.unshift('library');
  const last = parts[parts.length - 1];
  const purl = `pkg:oci/${last}@${encodeURIComponent(digest)}?repository_url=${encodeURIComponent(`${registry}/${parts.join('/')}`)}&tag=${encodeURIComponent(tag)}`;
  return {
    type: 'container',
    name: `${registry}/${parts.join('/')}`,
    version: tag,
    purl,
    'bom-ref': purl,
    hashes: [{ alg: 'SHA-256', content: digest.replace('sha256:', '') }],
  };
}

const npmPurl = (name, version) =>
  `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${version}`;

/** Components of an npm package-lock.json (v2/v3). */
export function npmLockComponents(lock) {
  const out = [];
  for (const [path, p] of Object.entries(lock.packages ?? {})) {
    if (path === '' || p.link || !p.version) continue;
    const name = p.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const purl = npmPurl(name, p.version);
    const c = { type: 'library', name, version: p.version, purl, 'bom-ref': purl };
    if (p.integrity?.startsWith('sha512-'))
      c.hashes = [{ alg: 'SHA-512', content: Buffer.from(p.integrity.slice(7), 'base64').toString('hex') }];
    if (p.optional) c.scope = 'optional';
    out.push(c);
  }
  return dedupe(out);
}

function dedupe(components) {
  const seen = new Map();
  for (const c of components) if (!seen.has(c['bom-ref'])) seen.set(c['bom-ref'], c);
  return [...seen.values()];
}

// ---------------------------------------------------------------- image inspection

const INSPECT_SCRIPT = String.raw`
echo '---OS'; cat /etc/os-release 2>/dev/null
echo '---DPKG'; cat /var/lib/dpkg/status 2>/dev/null
echo '---APK'; cat /lib/apk/db/installed 2>/dev/null
echo '---PY'; find / -xdev -type d -name '*.dist-info' 2>/dev/null
echo '---NPM'
if command -v node >/dev/null 2>&1; then node -e '
const fs = require("fs"), path = require("path"); const out = new Set();
function walk(dir, depth) {
  if (depth > 40) return; let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  const base = path.basename(dir), parent = path.basename(path.dirname(dir));
  const pkgDir = base === "node_modules" || (parent === "node_modules" && base.startsWith("@"));
  for (const e of ents) {
    if (!e.isDirectory()) continue; const f = path.join(dir, e.name);
    if (pkgDir && !e.name.startsWith(".") && !e.name.startsWith("@")) {
      try { const j = JSON.parse(fs.readFileSync(path.join(f, "package.json"), "utf8")); if (j.name && j.version) out.add(j.name + "\t" + j.version); } catch {}
    }
    walk(f, depth + 1);
  }
}
for (const r of ["/usr/local/lib/node_modules", "/usr/lib/node_modules", "/app", "/opt", "/srv", "/usr/src", "/home", "/workspace"]) walk(r, 0);
console.log([...out].join("\n"));'; fi
`;

/** Parses a Debian-style stanza file (dpkg status / apk installed uses `X:value` lines). */
function stanzas(text, sep) {
  return text
    .split(/\n\s*\n/)
    .map((block) => {
      const o = {};
      let last;
      for (const line of block.split('\n')) {
        if (sep === ': ' && /^\s/.test(line) && last) continue; // continuation lines (descriptions)
        const i = line.indexOf(sep);
        if (i <= 0) continue;
        last = line.slice(0, i);
        o[last] = line.slice(i + sep.length);
      }
      return o;
    })
    .filter((o) => Object.keys(o).length > 0);
}

/** Turns the inspection output of one image into CycloneDX components (+ OS info). */
export function parseInspection(text) {
  const sections = {};
  let cur;
  for (const line of text.split('\n')) {
    const m = /^---(OS|DPKG|APK|PY|NPM)$/.exec(line);
    if (m) {
      cur = m[1];
      sections[cur] = [];
    } else if (cur) sections[cur].push(line);
  }
  const osRel = Object.fromEntries(
    (sections.OS ?? [])
      .map((l) => /^([A-Z_]+)=("?)(.*)\2$/.exec(l))
      .filter(Boolean)
      .map((m) => [m[1], m[3]]),
  );
  const os = {
    id: osRel.ID ?? 'unknown',
    versionId: osRel.VERSION_ID ?? '',
    prettyName: osRel.PRETTY_NAME ?? '',
  };
  const components = [];
  if (os.id === 'debian') {
    for (const s of stanzas((sections.DPKG ?? []).join('\n'), ': ')) {
      if (!s.Package || !s.Version || !/installed$/.test(s.Status ?? '')) continue;
      const src = /^(\S+)(?: \((.+)\))?$/.exec(s.Source ?? '') ?? [];
      const sourceName = src[1] ?? s.Package;
      const sourceVersion = src[2] ?? s.Version;
      const purl = `pkg:deb/debian/${s.Package}@${encodeURIComponent(s.Version)}?arch=${s.Architecture}&distro=debian-${os.versionId}`;
      components.push({
        type: 'library',
        name: s.Package,
        version: s.Version,
        purl,
        'bom-ref': purl,
        properties: [
          { name: 'remyral:osv:ecosystem', value: `Debian:${os.versionId.split('.')[0]}` },
          { name: 'remyral:osv:name', value: sourceName },
          { name: 'remyral:osv:version', value: sourceVersion },
        ],
      });
    }
  }
  if (os.id === 'alpine') {
    const branch = `v${os.versionId.split('.').slice(0, 2).join('.')}`;
    for (const s of stanzas((sections.APK ?? []).join('\n'), ':')) {
      if (!s.P || !s.V) continue;
      const purl = `pkg:apk/alpine/${s.P}@${encodeURIComponent(s.V)}?arch=${s.A ?? ''}&distro=${os.versionId}`;
      components.push({
        type: 'library',
        name: s.P,
        version: s.V,
        purl,
        'bom-ref': purl,
        properties: [
          { name: 'remyral:osv:ecosystem', value: `Alpine:${branch}` },
          { name: 'remyral:osv:name', value: s.o ?? s.P },
          { name: 'remyral:osv:version', value: s.V },
        ],
      });
    }
  }
  for (const line of sections.PY ?? []) {
    const m = /\/([^/]+)-([^-/]+)\.dist-info$/.exec(line.trim());
    if (!m) continue;
    const name = m[1].toLowerCase().replace(/_/g, '-');
    const purl = `pkg:pypi/${name}@${m[2]}`;
    components.push({ type: 'library', name, version: m[2], purl, 'bom-ref': purl });
  }
  for (const line of sections.NPM ?? []) {
    const [name, version] = line.split('\t');
    if (!name || !version) continue;
    const purl = npmPurl(name, version);
    components.push({ type: 'library', name, version, purl, 'bom-ref': purl });
  }
  return { os, components: dedupe(components) };
}

function imageId(ref) {
  try {
    return execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', ref], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
    }).trim();
  } catch {
    return null;
  }
}

function inspectImage(ref) {
  const out = execFileSync(
    'docker',
    ['run', '--rm', '--network', 'none', '--user', '0', '--entrypoint', 'sh', ref, '-c', INSPECT_SCRIPT],
    { encoding: 'utf8', maxBuffer: 256 << 20, timeout: 5 * 60_000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return parseInspection(out);
}

// ---------------------------------------------------------------- documents

function bom(component, components, props = []) {
  return {
    $schema: 'http://cyclonedx.org/schema/bom-1.7.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.7',
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: { components: [{ type: 'application', name: 'remyral-sbom', version: '1' }] },
      component,
      properties: props,
    },
    components,
  };
}

function pnpmSbom(out, args) {
  execFileSync('pnpm', [...args, 'sbom', '--sbom-format', 'cyclonedx', '--lockfile-only', '--out', out], {
    cwd: REPO,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

export function generate({ outDir, inspect = {}, inspectAvailable = false, skip = [] }) {
  mkdirSync(outDir, { recursive: true });
  const files = [];
  const write = (name, doc, extra = {}) => {
    const p = join(outDir, name);
    const text = JSON.stringify(doc, null, 2) + '\n';
    writeFileSync(p, text);
    files.push({
      file: name,
      sha256: createHash('sha256').update(text).digest('hex'),
      components: doc.components.length,
      ...extra,
    });
  };
  const readBack = (name) => JSON.parse(readFileSync(join(outDir, name), 'utf8'));

  pnpmSbom(join(outDir, 'workspace.cdx.json'), []);
  const apps = { master: '@remyral/master', web: '@remyral/web', worker: '@remyral/worker' };
  for (const [short, pkg] of Object.entries(apps))
    pnpmSbom(join(outDir, `app-${short}.cdx.json`), ['--filter', pkg, '--prod']);
  for (const name of ['workspace.cdx.json', ...Object.keys(apps).map((a) => `app-${a}.cdx.json`)]) {
    const text = readFileSync(join(outDir, name), 'utf8');
    files.push({
      file: name,
      sha256: createHash('sha256').update(text).digest('hex'),
      components: JSON.parse(text).components.length,
      mode: 'lockfile',
    });
  }

  for (const img of imageCatalogue()) {
    const localRef = skip.includes(img.name)
      ? undefined
      : (inspect[img.name] ?? (inspectAvailable ? (img.local ?? img.ref) : undefined));
    const id = localRef ? imageId(localRef) : null;
    const top = img.ref
      ? imageComponent(img.ref)
      : {
          type: 'container',
          name: `remyral/${img.name}`,
          version: 'source',
          'bom-ref': `remyral-image:${img.name}`,
        };
    const props = [{ name: 'remyral:sbom:mode', value: id ? 'inspected' : 'declared' }];
    let components;
    if (id) {
      const { os, components: found } = inspectImage(localRef);
      props.push(
        { name: 'remyral:image:ref', value: localRef },
        { name: 'remyral:image:id', value: id },
        { name: 'remyral:image:os', value: os.prettyName || `${os.id} ${os.versionId}` },
      );
      components = [...(img.base ?? []).map(imageComponent), ...found];
      if (img.bundled && img.app) components.push(...readBack(`${img.app}.cdx.json`).components);
    } else {
      components = (img.base ?? []).map(imageComponent);
      if (img.app) components.push(...readBack(`${img.app}.cdx.json`).components);
      if (img.lock) components.push(...npmLockComponents(readJson(img.lock)));
      if (localRef && !id)
        props.push({ name: 'remyral:image:inspect-skipped', value: `${localRef} not present locally` });
    }
    write(`image-${img.name}.cdx.json`, bom(top, dedupe(components), props), {
      mode: id ? 'inspected' : 'declared',
      ...(id ? { imageRef: localRef, imageId: id } : {}),
    });
  }
  const manifest = { generatedAt: new Date().toISOString(), generator: 'scripts/security/sbom.mjs', files };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: join(REPO, 'dist', 'sbom') },
      inspect: { type: 'string', multiple: true, default: [] },
      'inspect-available': { type: 'boolean', default: false },
      'skip-inspect': { type: 'string', default: '' },
    },
  });
  const inspect = Object.fromEntries(
    values.inspect.flatMap((v) => v.split(',')).map((kv) => kv.split('=').map((s) => s.trim())),
  );
  const manifest = generate({
    outDir: resolve(values.out),
    inspect,
    inspectAvailable: values['inspect-available'],
    skip: values['skip-inspect'].split(',').filter(Boolean),
  });
  for (const f of manifest.files)
    console.log(`${f.file.padEnd(40)} ${String(f.components).padStart(5)} components  ${f.mode}`);
}
