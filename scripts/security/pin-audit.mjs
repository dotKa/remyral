#!/usr/bin/env node
// Pin audit (p7-supply-chain, A-SEC-4; docs/security/dependency-policy.md §1):
//
//   node scripts/security/pin-audit.mjs [--json]
//
// Fails (exit 1) unless every external input of the build is pinned exactly:
//   - package.json: every dependency spec is an exact version or `workspace:*`; packageManager is exact
//   - pnpm-lock.yaml: every package resolution carries an integrity hash and comes from the registry
//   - committed package-lock.json files (runtime images): integrity + registry.npmjs.org for every package
//   - Dockerfiles: every external base image (FROM, COPY --from) by @sha256 digest (ARG defaults resolved);
//     npm installs exact and with --ignore-scripts; pip/uv installs with ==; curl/wget downloads verified
//     by sha256sum in the same RUN
//   - compose files: every external `image:` by digest
//   - GitHub workflows: every `uses:` action by full commit SHA
//   - pnpm-workspace.yaml: minimumReleaseAge explicit and >= 1440, blockExoticSubdeps not disabled
// Locally built images (`remyral/…`, `remyral-…`) are exempt: they are built from pinned bases.
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readText, trackedFiles } from './lib.mjs';

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DIGEST = /@sha256:[0-9a-f]{64}$/;
const LOCAL_IMAGE = /^remyral[/-]/;

export function checkManifest(file, pkg) {
  const out = [];
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (spec === 'workspace:*' || EXACT.test(spec)) continue;
      out.push(`${file}: ${field}.${name} = "${spec}" is not an exact version`);
    }
  }
  if (
    pkg.packageManager !== undefined &&
    !/^[a-z]+@\d+\.\d+\.\d+(\+sha(256|512)\.[0-9a-f]+)?$/.test(pkg.packageManager)
  )
    out.push(`${file}: packageManager "${pkg.packageManager}" is not exact`);
  return out;
}

export function checkPnpmLock(file, text) {
  const out = [];
  for (const [i, line] of text.split('\n').entries()) {
    if (!/^\s+resolution: \{/.test(line)) continue;
    if (!/integrity: sha512-/.test(line)) out.push(`${file}:${i + 1}: resolution without sha512 integrity`);
    if (/tarball:|type: (git|directory)|repo:/.test(line))
      out.push(`${file}:${i + 1}: non-registry resolution`);
  }
  return out;
}

export function checkNpmLock(file, lock) {
  const out = [];
  for (const [path, p] of Object.entries(lock.packages ?? {})) {
    if (path === '' || p.link) continue;
    if (!/^sha512-/.test(p.integrity ?? '')) out.push(`${file}: ${path} has no sha512 integrity`);
    if (!String(p.resolved ?? '').startsWith('https://registry.npmjs.org/'))
      out.push(`${file}: ${path} is not resolved from registry.npmjs.org`);
  }
  return out;
}

/** Joins backslash-continued Dockerfile lines; returns [{ line, text }]. */
function dockerInstructions(text) {
  const out = [];
  let buf = '';
  let start = 0;
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    if (buf === '' && /^\s*(#|$)/.test(line)) return;
    if (buf === '') start = i + 1;
    if (/^\s*#/.test(line)) return; // comment inside a continued instruction
    if (line.endsWith('\\')) buf += line.slice(0, -1) + ' ';
    else {
      out.push({ line: start, text: (buf + line).trim() });
      buf = '';
    }
  });
  if (buf) out.push({ line: start, text: buf.trim() });
  return out;
}

const subst = (s, args) =>
  s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => args.get(a ?? b) ?? m);

/** Package specs of an `npm install|i|ci` command (tokens that are not flags or flag values). */
function npmSpecs(cmd) {
  const toks = cmd.trim().split(/\s+/);
  const i = toks.findIndex((t, k) => t === 'npm' && /^(install|i|add)$/.test(toks[k + 1] ?? ''));
  if (i === -1) return [];
  const specs = [];
  for (let k = i + 2; k < toks.length; k++) {
    const t = toks[k];
    if (/^(&&|;|\|\||\|)$/.test(t) || t.endsWith(';')) break;
    if (t === '--prefix') {
      k++;
      continue;
    }
    if (t.startsWith('-')) continue;
    const spec = t.replace(/^"|"$/g, '');
    // shell positional arguments of a helper function: its call sites are checked as quoted specs
    if (/^\$[@*0-9]$/.test(spec)) continue;
    specs.push(spec);
  }
  return specs;
}

/** Requirement tokens of a `pip install` / `uv pip install` / `uv tool install` command. */
export function pythonRequirements(cmd) {
  const toks = cmd
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^["']|["']$/g, ''));
  const i = toks.findIndex(
    (t, k) =>
      t === 'install' &&
      (/^pip3?$/.test(toks[k - 1] ?? '') || (toks[k - 2] === 'uv' && /^(pip|tool)$/.test(toks[k - 1] ?? ''))),
  );
  if (i === -1) return [];
  const reqs = [];
  for (let k = i + 1; k < toks.length; k++) {
    const t = toks[k];
    if (t === '--with') {
      if (toks[k + 1]) reqs.push(toks[k + 1]);
      k++;
    } else if (t.startsWith('-')) {
      // flags with a separate value (--python 3.12, -r file, --index-url …) consume the next token
      if (
        !t.includes('=') &&
        /^(--python|-p|-r|--requirement|-c|--constraint|--index-url|-i|--extra-index-url|--target|--prefix)$/.test(
          t,
        )
      )
        k++;
    } else reqs.push(t);
  }
  return reqs;
}

export function checkDockerfile(file, text) {
  const out = [];
  const args = new Map();
  const stages = new Set();
  for (const { line, text: ins } of dockerInstructions(text)) {
    const at = `${file}:${line}`;
    const [kw] = ins.split(/\s+/, 1);
    const KW = kw.toUpperCase();
    if (KW === 'ARG') {
      const m = /^ARG\s+([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/i.exec(ins);
      if (m?.[2] !== undefined) args.set(m[1], m[2].replace(/^"|"$/g, ''));
      continue;
    }
    if (KW === 'FROM') {
      const toks = ins
        .split(/\s+/)
        .slice(1)
        .filter((t) => !t.startsWith('--'));
      const ref = subst(toks[0], args);
      if (toks[1]?.toUpperCase() === 'AS' && toks[2]) stages.add(toks[2]);
      if (stages.has(ref) || LOCAL_IMAGE.test(ref) || ref === 'scratch') continue;
      if (!DIGEST.test(ref)) out.push(`${at}: base image "${ref}" is not pinned by digest`);
      continue;
    }
    if (KW === 'COPY') {
      const m = /--from=(\S+)/.exec(ins);
      if (m) {
        const ref = subst(m[1], args);
        if (!stages.has(ref) && !LOCAL_IMAGE.test(ref) && !DIGEST.test(ref) && !/^[a-z0-9_-]+$/.test(ref))
          out.push(`${at}: COPY --from image "${ref}" is not pinned by digest`);
      }
      continue;
    }
    if (KW !== 'RUN') continue;
    const cmd = subst(ins, args);
    if (/\bnpm\b/.test(cmd)) {
      // quoted package specs anywhere in an npm RUN (e.g. passed to a helper function)
      for (const m of cmd.matchAll(/"(@?[a-z0-9._-]+(?:\/[a-z0-9._-]+)?)@([^"\s]+)"/g))
        if (!EXACT.test(m[2])) out.push(`${at}: npm package "${m[1]}@${m[2]}" is not an exact version`);
    }
    for (const segment of cmd.split(/&&|;/)) {
      const specs = npmSpecs(segment);
      if (specs.length > 0) {
        for (const spec of specs) {
          const m = /^(@?[^@\s]+)@(.+)$/.exec(spec);
          if (!m || !EXACT.test(m[2])) out.push(`${at}: npm package "${spec}" is not an exact version`);
        }
        if (!/--ignore-scripts/.test(segment)) out.push(`${at}: npm install without --ignore-scripts`);
      }
      if (/\bnpm (ci|install)\b/.test(segment) && !/--ignore-scripts/.test(segment) && specs.length === 0)
        out.push(`${at}: npm ci/install without --ignore-scripts`);
      for (const req of pythonRequirements(segment))
        if (!/^[A-Za-z0-9_.-]+(\[[^\]]*\])?==[^=\s,;]+$/.test(req))
          out.push(`${at}: python package "${req}" is not pinned with ==`);
    }
    // Installing the curl/wget *package* (apt-get/apk/dnf install) is not a download.
    const downloads = cmd
      .split(/&&|;/)
      .some(
        (seg) =>
          /\b(curl|wget)\b/.test(seg) && !/\b(apt-get|apt|apk|dnf|yum) (-\S+ )*(install|add)\b/.test(seg),
      );
    if (downloads && !/sha(256|512)sum -c|--checksum/.test(cmd))
      out.push(`${at}: download without a checksum verification in the same RUN`);
  }
  return out;
}

export function checkCompose(file, text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    const m = /^\s*image:\s*['"]?([^'"#\s]+)['"]?/.exec(line);
    if (!m) return;
    let ref = m[1];
    const v = /^\$\{[A-Za-z_][A-Za-z0-9_]*:-(.+)\}$/.exec(ref);
    if (v) ref = v[1];
    if (LOCAL_IMAGE.test(ref)) return;
    if (!DIGEST.test(ref)) out.push(`${file}:${i + 1}: image "${ref}" is not pinned by digest`);
  });
  return out;
}

export function checkWorkflow(file, text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    const m = /^\s*(?:-\s+)?uses:\s*['"]?([^'"#\s]+)/.exec(line);
    if (!m) return;
    const ref = m[1];
    if (ref.startsWith('./')) return;
    if (ref.startsWith('docker://')) {
      if (!DIGEST.test(ref)) out.push(`${file}:${i + 1}: ${ref} is not pinned by digest`);
      return;
    }
    if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(ref))
      out.push(`${file}:${i + 1}: action "${ref}" is not pinned to a full commit SHA`);
  });
  return out;
}

export function checkWorkspace(file, text) {
  const out = [];
  const age = /^minimumReleaseAge:\s*(\d+)\s*$/m.exec(text);
  if (!age) out.push(`${file}: minimumReleaseAge must be set explicitly`);
  else if (Number(age[1]) < 1440) out.push(`${file}: minimumReleaseAge ${age[1]} < 1440 minutes`);
  if (/^blockExoticSubdeps:\s*false/m.test(text))
    out.push(`${file}: blockExoticSubdeps must not be disabled`);
  return out;
}

export function auditRepo(files = trackedFiles()) {
  const problems = [];
  const counts = { manifests: 0, lockfiles: 0, dockerfiles: 0, compose: 0, workflows: 0 };
  for (const f of files) {
    const name = basename(f);
    if (f.includes('node_modules/') || f.includes('/fixtures/')) continue;
    if (name === 'package.json') {
      counts.manifests++;
      problems.push(...checkManifest(f, JSON.parse(readText(f))));
    } else if (name === 'pnpm-lock.yaml') {
      counts.lockfiles++;
      problems.push(...checkPnpmLock(f, readText(f)));
    } else if (name === 'package-lock.json') {
      counts.lockfiles++;
      problems.push(...checkNpmLock(f, JSON.parse(readText(f))));
    } else if (/^Dockerfile(\..+)?$|\.Dockerfile$/.test(name)) {
      counts.dockerfiles++;
      problems.push(...checkDockerfile(f, readText(f)));
    } else if (/^(compose|docker-compose)(\.[\w-]+)?\.ya?ml$|\.compose\.ya?ml$/.test(name)) {
      counts.compose++;
      problems.push(...checkCompose(f, readText(f)));
    } else if (/^\.github\/workflows\/.+\.ya?ml$/.test(f)) {
      counts.workflows++;
      problems.push(...checkWorkflow(f, readText(f)));
    } else if (f === 'pnpm-workspace.yaml') {
      problems.push(...checkWorkspace(f, readText(f)));
    }
  }
  return { problems, counts };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { problems, counts } = auditRepo();
  if (process.argv.includes('--json')) console.log(JSON.stringify({ counts, problems }, null, 2));
  else {
    console.log(
      `pin audit: ${counts.manifests} package.json, ${counts.lockfiles} lockfiles, ${counts.dockerfiles} Dockerfiles, ` +
        `${counts.compose} compose files, ${counts.workflows} workflows`,
    );
    for (const p of problems) console.log(`  FAIL ${p}`);
    console.log(problems.length === 0 ? 'all pinned' : `${problems.length} problem(s)`);
  }
  process.exitCode = problems.length === 0 ? 0 : 1;
}
