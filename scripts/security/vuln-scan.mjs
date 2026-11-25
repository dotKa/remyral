#!/usr/bin/env node
// Vulnerability scan of the SBOMs against OSV.dev (p7-supply-chain, A-SEC-4; docs/design/p7-supply-chain.md §3):
//
//   node scripts/security/vuln-scan.mjs [--sbom-dir dist/sbom] [--allowlist scripts/security/vuln-allowlist.json]
//                                       [--report dist/sbom/vuln-report.json] [--fail-on-os-unfixed]
//
// Reads every *.cdx.json in the SBOM directory (written by sbom.mjs — the workspace SBOM *is* the pnpm
// lockfile), queries https://api.osv.dev/v1/querybatch for each distinct package (npm/PyPI by purl, Debian
// and Alpine by OSV ecosystem + source package), fetches each advisory's details and applies the
// allowlist. Gate (exit 1):
//   - any advisory affecting an npm or PyPI component (application, toolchain or runtime dependency);
//   - an OS-package advisory for which the distribution has published a fix (the image is stale: rebuild /
//     bump the base digest). Unfixed OS advisories are reported, and only gate with --fail-on-os-unfixed;
//   - an invalid or expired allowlist entry.
// The scanner is plain node (fetch): no scanner binary is downloaded or trusted (design note §3).
/* global fetch, setTimeout, AbortSignal */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { REPO, applyAllowlist, validateAllowlist } from './lib.mjs';

const OSV = 'https://api.osv.dev/v1';
const prop = (c, name) => c.properties?.find((p) => p.name === name)?.value;

/** The OSV query of one SBOM component, or null when OSV cannot answer for it. */
export function osvQuery(c) {
  const eco = prop(c, 'remyral:osv:ecosystem');
  if (eco) {
    return {
      key: `${eco}|${prop(c, 'remyral:osv:name')}|${prop(c, 'remyral:osv:version')}`,
      kind: 'os',
      query: {
        package: { ecosystem: eco, name: prop(c, 'remyral:osv:name') },
        version: prop(c, 'remyral:osv:version'),
      },
    };
  }
  const purl = c.purl ?? '';
  const m = /^pkg:(npm|pypi)\/([^?#]+)@([^?#@]+)/.exec(purl);
  if (!m) return null;
  return {
    key: `${m[1]}|${decodeURIComponent(m[2])}|${decodeURIComponent(m[3])}`,
    kind: m[1],
    query: { package: { purl: `pkg:${m[1]}/${m[2]}@${m[3]}` } },
  };
}

/** Collects distinct queries and remembers which SBOM files contain each package. */
export function collect(sboms) {
  const byKey = new Map();
  for (const { file, doc } of sboms) {
    for (const c of doc.components ?? []) {
      const q = osvQuery(c);
      if (!q) continue;
      const cur = byKey.get(q.key) ?? { ...q, name: c.name, version: c.version, files: new Set() };
      cur.files.add(file);
      byKey.set(q.key, cur);
    }
  }
  return [...byKey.values()];
}

/** Severity from OSV details: GHSA database_specific.severity, else the highest CVSS base score band. */
export function severityOf(vuln) {
  const db = vuln.database_specific?.severity;
  if (typeof db === 'string' && db) return db.toLowerCase() === 'moderate' ? 'moderate' : db.toLowerCase();
  const urg = vuln.database_specific?.urgency ?? vuln.affected?.[0]?.database_specific?.urgency;
  if (typeof urg === 'string' && urg && urg !== 'not yet assigned') return `debian:${urg}`;
  return 'unknown';
}

/**
 * Fixed versions the advisory names for this package *in this ecosystem* (empty: no fix published there).
 * The ecosystem matters for distributions: a Debian advisory may be fixed in Debian:14 but not in Debian:12.
 */
export function fixedVersions(vuln, pkgName, ecosystem) {
  const out = new Set();
  for (const a of vuln.affected ?? []) {
    if (a.package?.name && pkgName && a.package.name.toLowerCase() !== pkgName.toLowerCase()) continue;
    if (ecosystem && a.package?.ecosystem && a.package.ecosystem.toLowerCase() !== ecosystem.toLowerCase())
      continue;
    for (const r of a.ranges ?? []) for (const e of r.events ?? []) if (e.fixed) out.add(e.fixed);
  }
  return [...out];
}

/** Turns query results + advisory details into findings and applies the gate rules. */
export function evaluate(queries, results, details, allowEntries, { failOnOsUnfixed = false } = {}) {
  const findings = [];
  queries.forEach((q, i) => {
    for (const v of results[i] ?? []) {
      const d = details.get(v.id) ?? { id: v.id };
      const pkgName = q.kind === 'os' ? q.query.package.name : q.name;
      const ecosystem = q.kind === 'os' ? q.query.package.ecosystem : q.kind === 'npm' ? 'npm' : 'PyPI';
      const fixed = fixedVersions(d, pkgName, ecosystem);
      findings.push({
        id: v.id,
        aliases: d.aliases ?? [],
        kind: q.kind,
        package: pkgName,
        version: q.kind === 'os' ? q.query.version : q.version,
        ecosystem: q.kind === 'os' ? q.query.package.ecosystem : q.kind,
        severity: severityOf(d),
        fixed,
        summary: (d.summary ?? d.details ?? '').split('\n')[0].slice(0, 160),
        sboms: [...q.files].sort(),
        gating: q.kind !== 'os' || fixed.length > 0 || failOnOsUnfixed,
      });
    }
  });
  const gating = findings.filter((f) => f.gating);
  const { blocking, allowed, unused } = applyAllowlist(gating, allowEntries);
  return { findings, blocking, allowed, unused, informational: findings.filter((f) => !f.gating) };
}

async function postJson(url, body) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

/** Runs the OSV batch queries (500 per request, following page tokens). Returns vulns per query. */
export async function queryOsv(queries) {
  const results = [];
  for (let i = 0; i < queries.length; i += 500) {
    const chunk = queries.slice(i, i + 500);
    const res = await postJson(`${OSV}/querybatch`, { queries: chunk.map((q) => q.query) });
    for (const [j, r] of (res.results ?? []).entries()) {
      const vulns = [...(r.vulns ?? [])];
      let token = r.next_page_token;
      while (token) {
        const more = await postJson(`${OSV}/query`, { ...chunk[j].query, page_token: token });
        vulns.push(...(more.vulns ?? []));
        token = more.next_page_token;
      }
      results.push(vulns);
    }
  }
  return results;
}

async function fetchDetails(ids) {
  const details = new Map();
  const queue = [...ids];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let id = queue.shift(); id; id = queue.shift())
        details.set(id, await getJson(`${OSV}/vulns/${encodeURIComponent(id)}`));
    }),
  );
  return details;
}

export function loadSboms(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.cdx.json'))
    .sort()
    .map((file) => ({ file, doc: JSON.parse(readFileSync(join(dir, file), 'utf8')) }));
}

function line(f) {
  const fix = f.fixed.length ? `fixed in ${f.fixed.join(', ')}` : 'no fix';
  return `${f.id.padEnd(22)} ${f.severity.padEnd(10)} ${f.ecosystem}:${f.package}@${f.version} (${fix}) [${f.sboms.join(', ')}] ${f.summary}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      'sbom-dir': { type: 'string', default: join(REPO, 'dist', 'sbom') },
      allowlist: { type: 'string', default: join(REPO, 'scripts', 'security', 'vuln-allowlist.json') },
      report: { type: 'string' },
      'fail-on-os-unfixed': { type: 'boolean', default: false },
    },
  });
  const dir = resolve(values['sbom-dir']);
  const allow = JSON.parse(readFileSync(values.allowlist, 'utf8'));
  const allowProblems = validateAllowlist(allow);
  const sboms = loadSboms(dir);
  if (sboms.length === 0) throw new Error(`no *.cdx.json in ${dir} — run scripts/security/sbom.mjs first`);
  const queries = collect(sboms);
  const results = await queryOsv(queries);
  const ids = new Set(results.flatMap((r) => r.map((v) => v.id)));
  const details = await fetchDetails(ids);
  const r = evaluate(queries, results, details, allow.entries ?? [], {
    failOnOsUnfixed: values['fail-on-os-unfixed'],
  });
  const report = {
    scannedAt: new Date().toISOString(),
    source: 'osv.dev',
    sboms: sboms.map((s) => s.file),
    packages: queries.length,
    counts: {
      findings: r.findings.length,
      blocking: r.blocking.length,
      allowed: r.allowed.length,
      informational: r.informational.length,
    },
    blocking: r.blocking,
    allowed: r.allowed.map((f) => ({
      ...f,
      allowedBy: { reason: f.allowedBy.reason, expires: f.allowedBy.expires },
    })),
    informational: r.informational,
    unusedAllowlistEntries: r.unused.map((e) => e.id),
    allowlistProblems: allowProblems,
  };
  writeFileSync(values.report ?? join(dir, 'vuln-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    `OSV scan: ${sboms.length} SBOMs, ${queries.length} distinct packages, ${r.findings.length} advisories`,
  );
  for (const f of r.blocking) console.log(`  BLOCK ${line(f)}`);
  for (const f of r.allowed)
    console.log(`  ALLOW ${line(f)} — until ${f.allowedBy.expires}: ${f.allowedBy.reason}`);
  const byEco = {};
  for (const f of r.informational) byEco[f.ecosystem] = (byEco[f.ecosystem] ?? 0) + 1;
  for (const [eco, n] of Object.entries(byEco))
    console.log(`  INFO  ${n} unfixed OS advisories in ${eco} (no distribution fix yet; see the report)`);
  for (const id of report.unusedAllowlistEntries)
    console.log(`  WARN  allowlist entry ${id} matched nothing — remove it`);
  for (const p of allowProblems) console.log(`  FAIL  ${p}`);
  const failed = r.blocking.length > 0 || allowProblems.length > 0;
  console.log(failed ? 'vulnerability gate: FAILED' : 'vulnerability gate: passed');
  process.exitCode = failed ? 1 : 0;
}
