#!/usr/bin/env node
// p7-secrets-scan: repository / history / build-output secret scan (docs/design/p7-hardening.md §2).
//
//   pnpm scan:secrets                      tracked + untracked (not ignored) files of the working tree
//   pnpm scan:secrets --history            … plus every line ever added in any commit (gitleaks default)
//   pnpm scan:secrets --bundle <dir>       a build output directory (web bundle): secrets, env leakage
//        [--canary-env NAME,NAME]          … and the values of these env variables must not appear
//   --json                                 machine-readable findings
//
// Rules: @remyral/observability (the runtime redaction rules + entropy, see src/scan/scanner.ts).
// Allowlist: scripts/security/secret-scan.allow.json (path globs and finding fingerprints, each with a
// reason); a line containing `secret-scan: allow` is skipped. Findings never print the secret itself.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanText } from '@remyral/observability';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const ALLOW_FILE = join(ROOT, 'scripts', 'security', 'secret-scan.allow.json');
const MAX_BYTES = 2 * 1024 * 1024;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const json = flag('--json');

/** Glob → RegExp (`**` any path, `*` within a segment). */
function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const allow = JSON.parse(readFileSync(ALLOW_FILE, 'utf8'));
for (const entry of [...allow.paths, ...allow.fingerprints]) {
  if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
    process.stderr.write(`secret-scan: every allowlist entry needs a reason (${JSON.stringify(entry)})\n`);
    process.exit(2);
  }
}
const allowedPaths = allow.paths.map((p) => ({ ...p, re: globRe(p.glob) }));
const allowedFingerprints = new Map(allow.fingerprints.map((f) => [f.fingerprint, f]));
const usedAllow = new Set();

function pathAllowed(path) {
  const hit = allowedPaths.find((p) => p.re.test(path));
  if (hit) usedAllow.add(hit.glob);
  return hit !== undefined;
}

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

const findings = [];
const skipped = [];
let scannedFiles = 0;

function scanContent(path, text, opts, origin) {
  for (const f of scanText(text, opts)) {
    if (f.rule !== 'canary' && allowedFingerprints.has(f.fingerprint)) {
      usedAllow.add(f.fingerprint);
      continue;
    }
    findings.push({ path, origin, ...f });
  }
}

function scanFile(abs, display, opts, { allowPaths = true } = {}) {
  if (allowPaths && pathAllowed(display)) return;
  let st;
  try {
    st = statSync(abs);
  } catch {
    return; // deleted in the working tree
  }
  if (!st.isFile()) return;
  if (st.size > MAX_BYTES) {
    skipped.push({ path: display, reason: `larger than ${String(MAX_BYTES)} bytes` });
    return;
  }
  const buf = readFileSync(abs);
  if (isBinary(buf)) return;
  scannedFiles++;
  scanContent(display, buf.toString('utf8'), opts, 'tree');
}

function git(...a) {
  return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const bundleDir = option('--bundle');
if (bundleDir !== undefined) {
  // Build output: no path allowlist (nothing in a bundle is a test fixture), plus env leakage checks.
  const dir = resolve(ROOT, bundleDir);
  const canaryNames = (option('--canary-env') ?? '').split(',').filter(Boolean);
  const canaries = [];
  for (const name of canaryNames) {
    const v = process.env[name];
    if (v === undefined || v.length < 8) {
      process.stderr.write(`secret-scan: canary variable ${name} is not set (or shorter than 8)\n`);
      process.exit(2);
    }
    canaries.push(v);
  }
  // Values of secret-looking variables in the build environment must never be inlined.
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= 8 && /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|PRIVATE/i.test(name))
      canaries.push(value);
  }
  // Server-side configuration names must not appear in client code.
  const serverEnv = readFileSync(join(ROOT, '.env.example'), 'utf8')
    .split('\n')
    .map((l) => /^([A-Z][A-Z0-9_]+)=/.exec(l)?.[1])
    .filter(Boolean);
  for (const abs of walk(dir)) {
    const display = relative(ROOT, abs).split(sep).join('/');
    const buf = readFileSync(abs);
    if (isBinary(buf)) continue;
    scannedFiles++;
    const text = buf.toString('utf8');
    scanContent(display, text, { canaries }, 'bundle');
    for (const name of serverEnv) {
      if (text.includes(name)) {
        findings.push({
          path: display,
          origin: 'bundle',
          rule: 'server-env-name',
          line: 0,
          column: 0,
          preview: name,
          fingerprint: `server-env-name:${name}`,
        });
      }
    }
    if (/\bprocess\.env\b/.test(text)) {
      findings.push({
        path: display,
        origin: 'bundle',
        rule: 'process-env-reference',
        line: 0,
        column: 0,
        preview: 'process.env',
        fingerprint: 'process-env-reference',
      });
    }
  }
} else {
  const files = git('ls-files', '-z', '--cached', '--others', '--exclude-standard')
    .split('\0')
    .filter(Boolean);
  for (const f of [...new Set(files)]) scanFile(join(ROOT, f), f, {});
  if (flag('--history')) {
    // Every added line of every commit, per file (allowlisted paths skipped).
    const log = git('log', '--all', '-p', '-U0', '--no-color', '--no-ext-diff', '--format=commit %H');
    let commit = '';
    let file = null;
    let added = [];
    const flush = () => {
      if (file !== null && added.length > 0 && !pathAllowed(file)) {
        for (const f of scanText(added.join('\n'), {})) {
          if (allowedFingerprints.has(f.fingerprint)) {
            usedAllow.add(f.fingerprint);
            continue;
          }
          findings.push({ path: file, origin: `history ${commit.slice(0, 12)}`, ...f, line: 0 });
        }
      }
      added = [];
    };
    for (const line of log.split('\n')) {
      if (line.startsWith('commit ')) {
        flush();
        commit = line.slice(7);
        file = null;
      } else if (line.startsWith('+++ ')) {
        flush();
        file = line === '+++ /dev/null' ? null : line.replace(/^\+\+\+ b\//, '');
      } else if (line.startsWith('+') && file !== null) added.push(line.slice(1));
    }
    flush();
  }
}

// History findings for content that is also in the tree are the same secret: report once.
const unique = [];
const keys = new Set();
for (const f of findings) {
  const key = `${f.path}|${f.fingerprint}|${f.origin.startsWith('history') ? 'h' : f.origin}`;
  if (keys.has(key)) continue;
  keys.add(key);
  unique.push(f);
}

const stale =
  bundleDir === undefined
    ? [...allowedPaths.map((p) => p.glob), ...allowedFingerprints.keys()].filter((k) => !usedAllow.has(k))
    : [];

if (json) {
  process.stdout.write(
    `${JSON.stringify({ scannedFiles, findings: unique, skipped, staleAllowlist: stale }, null, 2)}\n`,
  );
} else {
  for (const f of unique) {
    process.stdout.write(
      `${f.path}:${String(f.line)}:${String(f.column)}  ${f.rule}  ${f.preview}  ${f.fingerprint}  (${f.origin})\n`,
    );
  }
  for (const s of skipped) process.stdout.write(`skipped ${s.path}: ${s.reason}\n`);
  for (const s of stale) process.stdout.write(`note: allowlist entry no longer needed: ${s}\n`);
  process.stdout.write(`secret-scan: ${String(scannedFiles)} files, ${String(unique.length)} finding(s)\n`);
}
process.exit(unique.length > 0 ? 1 : 0);
