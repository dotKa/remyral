#!/usr/bin/env node
// Public-repository leak check: installation- and person-specific content must never enter the public tree or history.
//
//   node scripts/security/public-denylist.mjs [--tree | --staged | --history] [--extra <file>] [--json]
//                                             [--config <file>] [--cwd <dir>]
//
//   --tree      tracked + untracked (not ignored) files of the working tree (default)
//   --staged    the index (what the next commit would contain): staged paths and their staged content
//   --history   every line added by any commit reachable from HEAD, every path a commit touched, commit
//               messages, and author / committer e-mails
//   --extra     a maintainer's private list kept OUTSIDE the repository (see parseExtra for the format)
//   --json      machine-readable findings and counts
//
// The generic rules live in scripts/security/public-denylist.json (cloud ids, host access, IPv4, local paths,
// machine names, personal mail, commit metadata, owner-note markers, top-level paths). They name no installation:
// a maintainer's own domains, addresses, hosts and names belong in the private --extra list, never in this
// repository, not even hashed (short values such as an IPv4 address are cheap to brute-force from a hash).
// Output is `file:line category/rule [fingerprint]` — the matched value is NEVER printed; the fingerprint is a
// keyed hash with a per-run random key, so equal values can be recognised within one run and nothing can be
// recovered from a log. Exit 1 on hard findings, 0 with a summary when only warnings remain, 2 on a usage or
// configuration error.
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const DEFAULT_CONFIG = join(HERE, 'public-denylist.json');
const MAX_BYTES = 8 * 1024 * 1024;
const MIN_REASON = 20;
const TYPES = ['text', 'path', 'public-ipv4', 'top-level', 'commit-email'];

/** Glob → RegExp: `**` any path (also empty), `*` within one segment, `?` one character. */
export function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const reFlags = (flags) => `${flags ?? ''}gu`.replace(/(.)(?=.*\1)/g, '');

/** Validates and compiles a configuration document; throws with every problem listed. */
export function compileConfig(doc) {
  const problems = [];
  const allowList = (list, where) =>
    (list ?? []).map((a, i) => {
      if (typeof a?.glob !== 'string' || a.glob === '')
        problems.push(`${where} allow[${i}]: glob is required`);
      if (typeof a?.reason !== 'string' || a.reason.trim().length < MIN_REASON)
        problems.push(
          `${where} allow[${i}] (${a?.glob}): reason is required (at least ${MIN_REASON} characters)`,
        );
      return { glob: a.glob, reason: a.reason, re: globRe(String(a.glob)), key: `${where}:${a.glob}` };
    });
  // Hashed literals were removed on purpose: a public hash of a short value (an IPv4 address, an e-mail at a known
  // domain, a key file name) is a brute-force target. Refuse them so they cannot come back by accident.
  if (doc.hashes !== undefined || doc.kdf !== undefined)
    problems.push(
      'hashes / kdf are not supported: keep installation-specific values in the private --extra list',
    );
  const rules = (doc.rules ?? []).map((r, i) => {
    const where = `rule ${r?.id ?? i}`;
    if (typeof r?.id !== 'string' || typeof r.category !== 'string')
      problems.push(`${where}: id and category are required`);
    if (!['error', 'warning'].includes(r?.severity))
      problems.push(`${where}: severity must be error | warning`);
    const type = r?.type ?? 'text';
    if (!TYPES.includes(type)) problems.push(`${where}: unknown type ${type}`);
    let re = null;
    if (type === 'text' || type === 'path' || type === 'commit-email') {
      try {
        re = new RegExp(r.pattern, reFlags(r.flags));
      } catch (e) {
        problems.push(`${where}: bad pattern (${e.message})`);
      }
    }
    // Pattern-level exceptions: a match lying inside a span of an `except` pattern is not reported.
    const except = (r?.except ?? []).map((x, k) => {
      if (typeof x?.reason !== 'string' || x.reason.trim().length < MIN_REASON)
        problems.push(`${where} except[${k}]: reason is required (at least ${MIN_REASON} characters)`);
      try {
        return new RegExp(x.pattern, reFlags(x.flags));
      } catch (e) {
        problems.push(`${where} except[${k}]: bad pattern (${e.message})`);
        return null;
      }
    });
    return {
      ...r,
      type,
      re,
      except: except.filter(Boolean),
      scope: (r.scope ?? []).map(globRe),
      allow: allowList(r.allow, where),
    };
  });
  const top = doc.topLevel ?? {};
  if (!Array.isArray(top.entries)) problems.push('topLevel.entries is required');
  if (typeof top.reason !== 'string' || top.reason.length < MIN_REASON)
    problems.push('topLevel.reason is required');
  const allow = allowList(doc.allow, 'global');
  if (problems.length > 0) throw new Error(`public-denylist config:\n  ${problems.join('\n  ')}`);
  return { rules, topLevel: new Set(top.entries), allow };
}

/**
 * Parses a private --extra list into rules. Line format (`#` comments and blank lines are ignored):
 *
 *   [category]        following entries are reported as `<category>/private:L<line>` (default category: extra)
 *   re:<regex>        a regular expression (JavaScript syntax, case-insensitive)
 *   lit:<text>        a literal (case-insensitive)
 *   <text>            a literal, as `lit:` (the original one-entry-per-line format)
 *     allow: <glob>   indented, attaches to the entry above: the entry does not apply to paths matching the glob
 *     except: <regex> indented: a match lying inside a match of this regex is not reported (case-insensitive)
 *
 * Every entry applies to file content, file paths, commit messages (trailers included) and commit e-mails.
 */
export function parseExtra(text) {
  const out = [];
  let category = 'extra';
  const problems = [];
  const lines = text.split('\n');
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const at = `line ${n + 1}`;
    const indented = /^\s/.test(raw);
    const opt = indented ? /^(allow|except):\s*(.+)$/.exec(line) : null;
    if (opt) {
      const entry = out.at(-1);
      if (!entry) {
        problems.push(`${at}: ${opt[1]} before any entry`);
        continue;
      }
      if (opt[1] === 'allow') {
        const glob = opt[2].trim();
        entry.allow.push({ glob, re: globRe(glob), key: `private L${entry.line}:${glob}` });
      } else {
        try {
          entry.except.push(new RegExp(opt[2].trim(), 'giu'));
        } catch (e) {
          problems.push(`${at}: bad except (${e.message})`);
        }
      }
      continue;
    }
    const section = /^\[([a-z0-9][a-z0-9-]*)\]$/i.exec(line);
    if (section) {
      category = section[1].toLowerCase();
      continue;
    }
    let source;
    if (line.startsWith('re:')) source = line.slice(3);
    else source = (line.startsWith('lit:') ? line.slice(4) : line).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let re;
    try {
      re = new RegExp(source, 'giu');
    } catch (e) {
      problems.push(`${at}: bad pattern (${e.message})`);
      continue;
    }
    out.push({
      id: `private:L${n + 1}`,
      line: n + 1,
      category,
      severity: 'error',
      type: 'text',
      private: true,
      re,
      except: [],
      allow: [],
      scope: [],
    });
  }
  if (problems.length > 0) throw new Error(`--extra list:\n  ${problems.join('\n  ')}`);
  return out;
}

const IPV4 = /(?<![\w.-])(\d{1,3}(?:\.\d{1,3}){3})(?![\w-]|\.\d)/g;

const validIPv4 = (ip) =>
  ip.split('.').every((o) => Number(o) <= 255 && !(o.length > 1 && o.startsWith('0')));

/** Public = not private (RFC 1918), CGNAT, loopback, link-local, documentation, benchmark, multicast, reserved. */
export function isPublicIPv4(ip) {
  if (!validIPv4(ip)) return false;
  const [a, b, c] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

/** Valid IPv4 address tokens of one line (version strings with a fifth part are skipped). */
export function ipv4Tokens(line) {
  if (!/\d\.\d/.test(line)) return []; // cheap pre-check: the token regex backtracks on long minified lines
  return [...line.matchAll(IPV4)]
    .filter((m) => validIPv4(m[1]))
    .map((m) => ({ value: m[1], index: m.index }));
}

export class Scanner {
  constructor(config, { extra = [] } = {}) {
    this.cfg = config;
    this.extra = extra;
    this.key = randomBytes(32);
    this.fpCache = new Map();
    this.findings = [];
    this.seen = new Set();
    this.usedAllow = new Set();
  }

  /** Short fingerprint of a matched value (never the value itself), keyed with a per-run random key. */
  fp(value) {
    let h = this.fpCache.get(value);
    if (h === undefined) {
      h = createHmac('sha256', this.key).update(value).digest('hex').slice(0, 10);
      this.fpCache.set(value, h);
    }
    return h;
  }

  allowed(rule, path) {
    for (const a of [...(rule.private ? [] : this.cfg.allow), ...rule.allow]) {
      if (a.re.test(path)) {
        this.usedAllow.add(a.key);
        return true;
      }
    }
    return false;
  }

  inScope(rule, path) {
    return rule.scope.length === 0 || rule.scope.some((re) => re.test(path));
  }

  report(rule, path, line, value, { fp, origin, dedupe } = {}) {
    if (path !== null && this.allowed(rule, path)) return;
    const f = {
      path: path ?? '(commit)',
      line,
      category: rule.category,
      rule: rule.id,
      severity: rule.severity,
      fp: fp ?? this.fp(value),
      origin: origin ?? null,
    };
    // One finding per line and category (a home path also contains the user name).
    const key = dedupe ?? `${f.path}|${f.line}|${f.category}|${f.origin}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.findings.push(f);
  }

  /** Path rules (path patterns, top-level allowlist, private entries) for one path. */
  scanPath(path, origin) {
    for (const rule of this.cfg.rules) {
      if (!this.inScope(rule, path)) continue;
      if (rule.type === 'path') {
        const m = firstMatch(rule, path);
        if (m) this.report(rule, path, 0, m[0], { origin, dedupe: `${path}|${rule.id}|path` });
      } else if (rule.type === 'top-level') {
        const top = path.split('/')[0];
        if (!this.cfg.topLevel.has(top)) this.report(rule, path, 0, top, { origin, dedupe: `top|${top}` });
      }
    }
    for (const rule of this.extra) {
      const m = firstMatch(rule, path);
      if (m) this.report(rule, path, 0, m[0], { origin, dedupe: `${path}|${rule.id}|path` });
    }
  }

  /**
   * Content rules for one text; `lineNumbers` maps the text's lines to file lines (history hunks). With
   * `onlyExtra`, only the private entries apply (commit trailers name contributors, whose addresses are theirs).
   */
  scanText(path, text, { origin = null, lineNumbers = null, dedupeHistory = false, onlyExtra = false } = {}) {
    const lines = text.split('\n');
    const rules = onlyExtra ? this.extra : [...this.cfg.rules, ...this.extra];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === '') continue;
      const lineNo = lineNumbers ? lineNumbers[i] : i + 1;
      const dd = (rule, fp) => (dedupeHistory ? `${path}|${rule.id}|${fp}` : undefined);
      for (const rule of rules) {
        if (!this.inScope(rule, path)) continue;
        if (rule.type === 'text') {
          const m = firstMatch(rule, line);
          if (m) {
            const fp = this.fp(m[0]);
            this.report(rule, path, lineNo, m[0], { fp, origin, dedupe: dd(rule, fp) });
          }
        } else if (rule.type === 'public-ipv4') {
          for (const t of ipv4Tokens(line)) {
            if (!isPublicIPv4(t.value) || excepted(rule, line, t.index, t.value.length)) continue;
            const fp = this.fp(t.value);
            this.report(rule, path, lineNo, t.value, { fp, origin, dedupe: dd(rule, fp) });
          }
        }
      }
    }
  }

  /** Author / committer e-mails of one commit (history mode). */
  scanCommitEmails(sha, emails) {
    const rules = [...this.cfg.rules.filter((r) => r.type === 'commit-email'), ...this.extra];
    for (const rule of rules)
      for (const e of emails) {
        const m = firstMatch(rule, e);
        if (m)
          this.report(rule, null, 0, e, {
            origin: `commit ${sha.slice(0, 12)}`,
            dedupe: `email|${rule.id}|${this.fp(e.toLowerCase())}`,
          });
      }
  }

  staleAllow() {
    return [
      ...this.cfg.allow,
      ...this.cfg.rules.flatMap((r) => r.allow),
      ...this.extra.flatMap((r) => r.allow),
    ]
      .filter((a) => !this.usedAllow.has(a.key))
      .map((a) => a.key);
  }
}

/** First match of a rule's pattern in `text` that no `except` span covers. */
function firstMatch(rule, text) {
  rule.re.lastIndex = 0;
  return [...text.matchAll(rule.re)].find((x) => !excepted(rule, text, x.index, x[0].length)) ?? null;
}

/** Is the match [index, index+length) inside a span of one of the rule's `except` patterns? */
function excepted(rule, line, index, length) {
  for (const re of rule.except ?? [])
    for (const m of line.matchAll(re))
      if (m.index <= index && index + length <= m.index + m[0].length) return true;
  return false;
}

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, ...opts });
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

export function scanTree(scanner, cwd) {
  const files = git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter(Boolean);
  let scanned = 0;
  for (const f of [...new Set(files)]) {
    scanner.scanPath(f, null);
    let st;
    try {
      st = lstatSync(join(cwd, f));
    } catch {
      continue; // deleted in the working tree
    }
    if (!st.isFile() || st.size > MAX_BYTES) continue; // symlinks are not followed
    const buf = readFileSync(join(cwd, f));
    if (isBinary(buf)) continue;
    scanned++;
    scanner.scanText(f, buf.toString('utf8'));
  }
  return { files: files.length, scanned };
}

export function scanStaged(scanner, cwd) {
  const files = git(cwd, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'])
    .split('\0')
    .filter(Boolean);
  let scanned = 0;
  for (const f of files) {
    scanner.scanPath(f, 'staged');
    const buf = execFileSync('git', ['show', `:${f}`], { cwd, maxBuffer: 256 * 1024 * 1024 });
    if (buf.length > MAX_BYTES || isBinary(buf)) continue;
    scanned++;
    scanner.scanText(f, buf.toString('utf8'), { origin: 'staged' });
  }
  return { files: files.length, scanned };
}

export function scanHistory(scanner, cwd) {
  // Commit metadata and messages.
  const meta = git(cwd, ['log', 'HEAD', '--format=%H%x1f%ae%x1f%ce%x1f%B%x1e']).split('\x1e');
  let commits = 0;
  for (const rec of meta) {
    const [sha, ae, ce, body] = rec.replace(/^\n/, '').split('\x1f');
    if (!sha) continue;
    commits++;
    scanner.scanCommitEmails(sha, [ae, ce].filter(Boolean));
    // Trailers (Signed-off-by, Co-authored-by, …) name contributors: only the private list applies to them.
    const lines = (body ?? '').split('\n');
    const trailer = (l) => /^[A-Za-z][A-Za-z-]*-by:\s/.test(l);
    const at = `(commit ${sha.slice(0, 12)} message)`;
    const opts = { origin: `commit ${sha.slice(0, 12)}`, dedupeHistory: true };
    scanner.scanText(at, lines.map((l) => (trailer(l) ? '' : l)).join('\n'), opts);
    scanner.scanText(at, lines.map((l) => (trailer(l) ? l : '')).join('\n'), { ...opts, onlyExtra: true });
  }
  // Every added line of every commit, with its line number in the new file.
  const log = git(cwd, [
    'log',
    'HEAD',
    '-p',
    '-U0',
    '--no-color',
    '--no-ext-diff',
    '--no-renames',
    '--format=commit %H',
  ]);
  let sha = '';
  let file = null;
  let lines = [];
  let numbers = [];
  let next = 0;
  const flush = () => {
    if (file !== null && lines.length > 0)
      scanner.scanText(file, lines.join('\n'), {
        origin: `commit ${sha.slice(0, 12)}`,
        lineNumbers: numbers,
        dedupeHistory: true,
      });
    lines = [];
    numbers = [];
  };
  for (const line of log.split('\n')) {
    if (line.startsWith('commit ')) {
      flush();
      sha = line.slice(7);
      file = null;
    } else if (line.startsWith('+++ ')) {
      flush();
      file = line === '+++ /dev/null' ? null : line.replace(/^\+\+\+ b\//, '');
      if (file !== null) scanner.scanPath(file, `commit ${sha.slice(0, 12)}`);
    } else if (line.startsWith('@@ ')) {
      next = Number(/\+(\d+)/.exec(line)?.[1] ?? 0);
    } else if (line.startsWith('+') && file !== null) {
      lines.push(line.slice(1));
      numbers.push(next++);
    }
  }
  flush();
  return { commits };
}

export function summarize(findings) {
  const byCategory = {};
  const byTop = {};
  for (const f of findings) {
    const k = `${f.category} (${f.severity})`;
    byCategory[k] = (byCategory[k] ?? 0) + 1;
    const top = f.path.startsWith('(')
      ? '(commit)'
      : f.path.includes('/')
        ? f.path.split('/')[0] + '/'
        : f.path;
    byTop[top] = (byTop[top] ?? 0) + 1;
  }
  return { byCategory, byTop };
}

export function formatFinding(f) {
  const at = f.line > 0 ? `${f.path}:${f.line}` : f.path;
  const origin = f.origin ? ` (${f.origin})` : '';
  const sev = f.severity === 'warning' ? 'WARN ' : '';
  return `${sev}${at} ${f.category}/${f.rule} [${f.fp}]${origin}`;
}

export function run(argv, { stdout = process.stdout } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      tree: { type: 'boolean' },
      staged: { type: 'boolean' },
      history: { type: 'boolean' },
      extra: { type: 'string' },
      config: { type: 'string' },
      cwd: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const modes = ['tree', 'staged', 'history'].filter((m) => values[m]);
  if (modes.length > 1) throw new UsageError('choose one of --tree, --staged, --history');
  const mode = modes[0] ?? 'tree';
  const cwd = resolve(values.cwd ?? git(process.cwd(), ['rev-parse', '--show-toplevel']).trim());
  const config = compileConfig(JSON.parse(readFileSync(values.config ?? DEFAULT_CONFIG, 'utf8')));
  const extra = values.extra ? parseExtra(readFileSync(values.extra, 'utf8')) : [];
  const scanner = new Scanner(config, { extra });
  const stats =
    mode === 'tree'
      ? scanTree(scanner, cwd)
      : mode === 'staged'
        ? scanStaged(scanner, cwd)
        : scanHistory(scanner, cwd);
  const errors = scanner.findings.filter((f) => f.severity === 'error');
  const warnings = scanner.findings.filter((f) => f.severity === 'warning');
  const stale = mode === 'tree' ? scanner.staleAllow() : [];
  const { byCategory, byTop } = summarize(scanner.findings);
  if (values.json) {
    stdout.write(
      `${JSON.stringify({ mode, stats, byCategory, byTop, staleAllowlist: stale, findings: scanner.findings }, null, 2)}\n`,
    );
  } else {
    for (const f of [...errors, ...warnings]) stdout.write(`${formatFinding(f)}\n`);
    for (const s of stale) stdout.write(`note: allowlist entry no longer needed: ${s}\n`);
    const cats = Object.entries(byCategory)
      .map(([k, n]) => `${k}: ${n}`)
      .join(', ');
    stdout.write(
      `public-denylist (${mode}${extra.length ? ` + ${extra.length} private entr${extra.length === 1 ? 'y' : 'ies'}` : ''}): ` +
        `${errors.length} finding(s), ${warnings.length} warning(s)${cats ? ` — ${cats}` : ''}\n`,
    );
  }
  return errors.length > 0 ? 1 : 0;
}

class UsageError extends Error {}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`public-denylist: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
  }
}
