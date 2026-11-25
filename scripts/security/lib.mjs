// Shared helpers of the supply-chain scripts (p7-supply-chain, docs/design/p7-supply-chain.md).
// Plain ESM, node built-ins only.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function readText(rel) {
  return readFileSync(join(REPO, rel), 'utf8');
}

export function readJson(rel) {
  return JSON.parse(readText(rel));
}

/** Tracked files (falls back to an empty list outside a git checkout). */
export function trackedFiles(cwd = REPO) {
  try {
    // Tracked plus new, not ignored files: a file is checked before its first commit too.
    return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 << 20,
    })
      .split('\0')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** YYYY-MM-DD of a Date (UTC). */
export function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Allowlist entries may not be granted for longer than this (docs/security/dependency-policy.md §5). */
export const MAX_ALLOW_DAYS = 90;

/**
 * Validates an allowlist document `{ entries: [{ id, package?, reason, expires, owner }] }`.
 * Every entry needs an advisory id, a real reason, an owner and an expiry date that is in the future and
 * no more than MAX_ALLOW_DAYS ahead. Returns problems (strings); empty = valid.
 */
export function validateAllowlist(doc, now = new Date()) {
  const problems = [];
  if (!doc || !Array.isArray(doc.entries)) return ['allowlist: missing "entries" array'];
  const today = isoDay(now);
  const max = isoDay(new Date(now.getTime() + MAX_ALLOW_DAYS * 86_400_000));
  doc.entries.forEach((e, i) => {
    const at = `allowlist entry ${i} (${e?.id ?? '?'})`;
    if (typeof e?.id !== 'string' || e.id.trim() === '') problems.push(`${at}: id is required`);
    if (typeof e?.reason !== 'string' || e.reason.trim().length < 20)
      problems.push(
        `${at}: reason is required (at least 20 characters: why it is not exploitable / why no fix)`,
      );
    if (typeof e?.owner !== 'string' || e.owner.trim() === '') problems.push(`${at}: owner is required`);
    if (typeof e?.expires !== 'string' || !DAY_RE.test(e.expires) || Number.isNaN(Date.parse(e.expires)))
      problems.push(`${at}: expires must be a YYYY-MM-DD date`);
    else if (e.expires < today) problems.push(`${at}: expired on ${e.expires} — re-review or fix`);
    else if (e.expires > max)
      problems.push(`${at}: expires ${e.expires} is more than ${MAX_ALLOW_DAYS} days ahead`);
  });
  return problems;
}

const globRe = (g) => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

/**
 * Does an allowlist entry cover a finding? An entry matches the advisory id or any alias, optionally a
 * package, and optionally only findings whose SBOMs all match one of `sboms` (globs such as
 * `image-runtime-*.cdx.json`) — so accepting a finding for one image never accepts it for another.
 */
export function entryMatches(entry, finding) {
  const ids = new Set([finding.id, ...(finding.aliases ?? [])]);
  if (!ids.has(entry.id)) return false;
  if (entry.package && entry.package !== finding.package) return false;
  if (Array.isArray(entry.sboms)) {
    const res = entry.sboms.map(globRe);
    if (!(finding.sboms ?? []).every((s) => res.some((r) => r.test(s)))) return false;
  }
  return true;
}

/** Splits findings into blocking / allowed and lists unused allowlist entries. */
export function applyAllowlist(findings, entries) {
  const used = new Set();
  const blocking = [];
  const allowed = [];
  for (const f of findings) {
    const idx = entries.findIndex((e) => entryMatches(e, f));
    if (idx === -1) blocking.push(f);
    else {
      used.add(idx);
      allowed.push({ ...f, allowedBy: entries[idx] });
    }
  }
  return { blocking, allowed, unused: entries.filter((_, i) => !used.has(i)) };
}
