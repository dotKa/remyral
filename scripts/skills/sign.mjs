#!/usr/bin/env node
// Skills signing tool (p6-skills, docs/design/p6-skills.md). Offline; no dependencies.
//
//   node scripts/skills/sign.mjs keygen --out <dir>
//       New Ed25519 skills key: <dir>/skills-key.pem (0600, keep OFFLINE) + skills-key.pub.
//   node scripts/skills/sign.mjs pack --dir <skill-dir> --version 1.2.0 --runtimes claude-code,codex
//                                     --key <pem> [--title "Release notes"] --out <bundle.json>
//       Reads <skill-dir>/SKILL.md (frontmatter `name` = skill id, `description`) and every file under
//       scripts/, references/, resources/, assets/ (UTF-8 text only), writes the signed upload document
//       { manifest (base64, exact signed bytes), signature, files } for POST /skills.
//   node scripts/skills/sign.mjs verify --bundle <bundle.json> --public-key <pub>[,<pub>]
//
// The skills key is separate from the release key (scripts/release/sign.mjs), the master's lease-signing
// key and device keys. The master never sees it: it verifies uploads against SKILLS_PUBLIC_KEYS, and every
// worker verifies again against `skills.publicKeys` in its own config before using a skill.
// The rules below mirror @remyral/protocol `skills.ts`; scripts/skills/sign.test.ts pins them together.
import { Buffer } from 'node:buffer';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const CONTEXT = 'remana-skill/v1\n';
const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const SKILL_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DIRS = ['scripts', 'references', 'resources', 'assets'];
const PATH = new RegExp(
  `^(${DIRS.join('|')})(/[A-Za-z0-9_-]{1,64}){0,2}/[A-Za-z0-9_-]{1,64}(\\.[A-Za-z0-9]{1,16})?$`,
);
// ADR-0023: OpenHands was removed; new skills target the four remaining runtimes.
const RUNTIMES = ['claude-code', 'codex', 'pi', 'opencode'];
const MAX_FILES = 32;
const MAX_FILE = 64 * 1024;
const MAX_TOTAL = 128 * 1024;
const PUB = /^[A-Za-z0-9_-]{43}$/;

function die(message) {
  process.stderr.write(`skills/sign.mjs: ${message}\n`);
  process.exit(1);
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const keyId = (pub) => sha256(Buffer.from(pub, 'base64url')).slice(0, 16);
const payload = (manifestBytes) => Buffer.concat([Buffer.from(CONTEXT, 'utf8'), manifestBytes]);

function loadKey(path) {
  if (path === undefined) die('--key <skills-key.pem> is required');
  const st = statSync(path);
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    die(`${path} is readable by group/others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`);
  }
  const key = createPrivateKey(readFileSync(path));
  const jwk = createPublicKey(key).export({ format: 'jwk' });
  if (jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') die('the key is not an Ed25519 key');
  return { key, pub: jwk.x };
}

/** Minimal YAML frontmatter reader: `key: value` lines between the leading `---` fences. */
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (m === null) return {};
  const out = {};
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = (kv[2] ?? '').replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

function utf8(bytes, path) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes) || text.includes('\u0000')) {
    die(`${path} is not UTF-8 text (skills carry text files only)`);
  }
  return text;
}

function collect(root) {
  const files = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const p = rel === '' ? name : `${rel}/${name}`;
      const st = lstatSync(join(root, p));
      if (st.isSymbolicLink()) die(`${p} is a symbolic link (not allowed in a skill)`);
      if (st.isDirectory()) {
        if (rel === '' && !DIRS.includes(name))
          die(`unexpected directory ${p}/ (allowed: ${DIRS.join(', ')})`);
        walk(p);
      } else if (st.isFile()) {
        if (rel === '' && name !== 'SKILL.md') die(`unexpected top-level file ${p} (only SKILL.md)`);
        if (p !== 'SKILL.md' && !PATH.test(p)) die(`file path not allowed: ${p}`);
        files.push({ path: p, mode: st.mode });
      } else {
        die(`${p} is not a regular file`);
      }
    }
  };
  walk('');
  return files;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    dir: { type: 'string' },
    version: { type: 'string' },
    runtimes: { type: 'string' },
    title: { type: 'string' },
    key: { type: 'string' },
    bundle: { type: 'string' },
    'public-key': { type: 'string' },
    'created-at': { type: 'string' },
  },
});

switch (positionals[0]) {
  case 'keygen': {
    const out = resolve(values.out ?? die('--out <dir> is required'));
    mkdirSync(out, { recursive: true, mode: 0o700 });
    const pem = join(out, 'skills-key.pem');
    if (existsSync(pem)) die(`${pem} exists; refusing to overwrite a skills key`);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    writeFileSync(pem, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
    chmodSync(pem, 0o600);
    const pub = publicKey.export({ format: 'jwk' }).x;
    writeFileSync(join(out, 'skills-key.pub'), `${pub}\n`, { mode: 0o644 });
    process.stdout.write(
      `skills public key: ${pub}\nkey id:            ${keyId(pub)}\nprivate key:       ${pem} (keep offline)\n`,
    );
    break;
  }
  case 'pack': {
    const { key, pub } = loadKey(values.key);
    const root = resolve(values.dir ?? die('--dir <skill-dir> is required'));
    const version = values.version ?? die('--version is required');
    if (!SEMVER.test(version)) die(`--version must be a semantic version (got ${version})`);
    const runtimes = (values.runtimes ?? die('--runtimes is required (e.g. claude-code,codex)'))
      .split(',')
      .map((r) => r.trim());
    for (const r of runtimes) if (!RUNTIMES.includes(r)) die(`unknown runtime ${r}`);
    if (new Set(runtimes).size !== runtimes.length) die('--runtimes has duplicates');
    const listed = collect(root);
    if (!listed.some((f) => f.path === 'SKILL.md')) die('SKILL.md is required');
    if (listed.length > MAX_FILES) die(`more than ${String(MAX_FILES)} files`);
    const files = {};
    const entries = [];
    let total = 0;
    for (const f of listed) {
      const bytes = readFileSync(join(root, f.path));
      if (bytes.byteLength > MAX_FILE) die(`${f.path} is larger than ${String(MAX_FILE)} bytes`);
      total += bytes.byteLength;
      files[f.path] = utf8(bytes, f.path);
      entries.push({
        path: f.path,
        sha256: sha256(bytes),
        size: bytes.byteLength,
        executable: f.path.startsWith('scripts/') && (f.mode & 0o111) !== 0,
      });
    }
    if (total > MAX_TOTAL) die(`skill is larger than ${String(MAX_TOTAL)} bytes`);
    const fm = frontmatter(files['SKILL.md']);
    const id = fm.name ?? die('SKILL.md frontmatter needs `name` (the skill id)');
    if (!SKILL_ID.test(id) || id.length > 64)
      die(`skill id "${id}" must be lowercase letters, digits and hyphens`);
    const description = fm.description ?? die('SKILL.md frontmatter needs `description`');
    const manifest = {
      schema: 1,
      kind: 'remana.skill',
      id,
      title: values.title ?? fm.title ?? id,
      version,
      description: description.slice(0, 1024),
      runtimes,
      files: entries,
      createdAt: values['created-at'] ?? new Date().toISOString(),
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const signature = {
      keyId: keyId(pub),
      signature: sign(null, payload(manifestBytes), key).toString('base64url'),
    };
    const out = resolve(values.out ?? die('--out <bundle.json> is required'));
    writeFileSync(
      out,
      `${JSON.stringify({ manifest: manifestBytes.toString('base64'), signature, files })}\n`,
      {
        mode: 0o644,
      },
    );
    process.stdout.write(
      `signed skill ${id}@${version} (${String(entries.length)} files) → ${out}\n  manifest sha256 ${sha256(manifestBytes)}\n  key id ${signature.keyId}\n`,
    );
    break;
  }
  case 'verify': {
    const bundle = JSON.parse(readFileSync(values.bundle ?? die('--bundle is required'), 'utf8'));
    const keys = (values['public-key'] ?? die('--public-key is required')).split(',');
    for (const k of keys) if (!PUB.test(k)) die(`not a base64url Ed25519 public key: ${k}`);
    const manifestBytes = Buffer.from(bundle.manifest, 'base64');
    const key = keys.find((k) => keyId(k) === bundle.signature?.keyId) ?? die('signed by an unknown key');
    const pubKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key }, format: 'jwk' });
    if (!verify(null, payload(manifestBytes), pubKey, Buffer.from(bundle.signature.signature, 'base64url'))) {
      die('BAD signature');
    }
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const paths = Object.keys(bundle.files ?? {}).sort();
    const expected = manifest.files.map((f) => f.path).sort();
    if (paths.join('\n') !== expected.join('\n')) die('file set does not match the manifest');
    for (const f of manifest.files) {
      const bytes = Buffer.from(bundle.files[f.path], 'utf8');
      if (bytes.byteLength !== f.size || sha256(bytes) !== f.sha256)
        die(`${f.path} does not match the manifest`);
    }
    process.stdout.write(`OK skill ${manifest.id}@${manifest.version} signed by ${bundle.signature.keyId}\n`);
    break;
  }
  default:
    die('usage: sign.mjs keygen|pack|verify … (see the header of this file)');
}
