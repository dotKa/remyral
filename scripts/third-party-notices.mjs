#!/usr/bin/env node
// Regenerates the dependency section of THIRD_PARTY_NOTICES.md from the installed production dependency tree
// (`pnpm -r licenses list --prod --json`, offline). Only the text between the BEGIN / END markers is rewritten.
//
//   node scripts/third-party-notices.mjs           # rewrite the section
//   node scripts/third-party-notices.mjs --check   # fail if the section is out of date
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('../THIRD_PARTY_NOTICES.md', import.meta.url);
const BEGIN = '<!-- BEGIN GENERATED DEPENDENCIES (scripts/third-party-notices.mjs) -->';
const END = '<!-- END GENERATED DEPENDENCIES -->';

/** @type {Record<string, { name: string; versions: string[] }[]>} */
const byLicence = JSON.parse(
  execFileSync('pnpm', ['-r', 'licenses', 'list', '--prod', '--json'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
);

const groups = Object.entries(byLicence)
  .map(([licence, pkgs]) => ({
    licence,
    pkgs: pkgs.map((p) => `${p.name}@${p.versions.join(', ')}`).sort((a, b) => a.localeCompare(b)),
  }))
  .sort((a, b) => b.pkgs.length - a.pkgs.length || a.licence.localeCompare(b.licence));
const total = groups.reduce((n, g) => n + g.pkgs.length, 0);

const lines = [
  BEGIN,
  '',
  `${String(total)} packages. Licence as declared by each package's \`package.json\` ("Unknown": no SPDX identifier, see the note above).`,
  '',
];
for (const g of groups) {
  lines.push(`### ${g.licence} (${String(g.pkgs.length)})`, '', ...g.pkgs.map((p) => `- ${p}`), '');
}
lines.push(END);
const section = lines.join('\n');

const current = readFileSync(FILE, 'utf8');
const start = current.indexOf(BEGIN);
const stop = current.indexOf(END);
if (start < 0 || stop < start) throw new Error('THIRD_PARTY_NOTICES.md: generated-section markers not found');
const next = current.slice(0, start) + section + current.slice(stop + END.length);

if (process.argv.includes('--check')) {
  if (next !== current) {
    console.error('third-party notices: out of date, run node scripts/third-party-notices.mjs');
    process.exit(1);
  }
  console.log(`third-party notices: up to date (${String(total)} packages)`);
} else {
  writeFileSync(FILE, next);
  console.log(`third-party notices: ${String(total)} packages written`);
}
