#!/usr/bin/env node
// p14-web-perf (docs/design/p14-web-perf.md §2): the bundle visualizer of the web console, without a dependency.
// Builds the production bundle (vite build, the real config) and prints:
//   - per route: the JavaScript it needs before it can render (the entry's static imports + the route's lazy chunk and
//     its static imports), raw / gzip -9 / brotli — the "initial JS" budget (Diyalog home < 350 KB gzip);
//   - the biggest modules of the entry, and of a route's own chunks (who pulls them in: `--why <module suffix>`).
//
//   node apps/web/scripts/bundle-report.mjs                 # report (writes apps/web/dist as `vite build` does)
//   node apps/web/scripts/bundle-report.mjs --json out.json # also the raw module/chunk table
//   node apps/web/scripts/bundle-report.mjs --budget 350    # exit 1 when the Diyalog home needs more (KB gzip)
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { build } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};

/** Lazy chunks to report, by the chunk name rolldown gives them (the screen module's name). */
const ROUTES = [
  ['Diyalog home (/)', 'DiyalogHome'],
  ['Sohbet (/chat)', 'SohbetScreen'],
  ['İşler (/jobs)', 'JobsScreen'],
  ['Makineler (/machines)', 'MachinesScreen'],
  ['Job detail (/jobs/:id)', 'DiyalogJob'],
  // p19-ide W1: the code viewer / reviewer route (CodeMirror lives here, never in the home closure).
  ['Kod (/projects/:id/code)', 'CodeScreen'],
];

const modules = [];
const report = {
  name: 'remyral-bundle-report',
  apply: 'build',
  generateBundle(_o, bundle) {
    for (const [file, c] of Object.entries(bundle)) {
      if (c.type !== 'chunk') continue;
      for (const [id, m] of Object.entries(c.modules))
        modules.push({
          chunk: file,
          id,
          len: m.renderedLength,
          imports: c.imports,
          entry: c.isEntry,
          importedIds: this.getModuleInfo(id)?.importedIds ?? [],
        });
    }
  },
};

await build({ root: webRoot, logLevel: 'warn', plugins: [report] });
const dist = join(webRoot, 'dist');

const chunks = new Map();
for (const m of modules) {
  if (!chunks.has(m.chunk)) chunks.set(m.chunk, { imports: m.imports, entry: m.entry, mods: [] });
  chunks.get(m.chunk).mods.push(m);
}
const entry = [...chunks.keys()].find((c) => chunks.get(c).entry && basename(c).startsWith('index-'));
const sizes = new Map();
const sizeOf = (c) => {
  if (!sizes.has(c)) {
    const buf = readFileSync(join(dist, c));
    sizes.set(c, {
      raw: buf.length,
      gz: gzipSync(buf, { level: 9 }).length,
      br: brotliCompressSync(buf).length,
    });
  }
  return sizes.get(c);
};
const closure = (roots) => {
  const seen = new Set();
  const visit = (c) => {
    if (seen.has(c) || !chunks.has(c)) return;
    seen.add(c);
    for (const i of chunks.get(c).imports) visit(i);
  };
  roots.forEach(visit);
  return seen;
};
const kb = (n) => (n / 1024).toFixed(1).padStart(7);
const total = (set) =>
  [...set].reduce(
    (a, c) => {
      const s = sizeOf(c);
      return { raw: a.raw + s.raw, gz: a.gz + s.gz, br: a.br + s.br, n: a.n + 1 };
    },
    { raw: 0, gz: 0, br: 0, n: 0 },
  );

const allJs = total(new Set(chunks.keys()));
console.log(
  `\nAll JavaScript: ${kb(allJs.raw)} KB raw, ${kb(allJs.gz)} KB gzip, ${kb(allJs.br)} KB brotli in ${String(allJs.n)} chunks`,
);
const base = closure([entry]);
const b = total(base);
console.log(
  `Entry + static imports: ${kb(b.raw)} KB raw ${kb(b.gz)} KB gz ${kb(b.br)} KB br (${String(b.n)} chunks)\n`,
);
console.log('Initial JS per route (entry closure + the route chunk closure):');
let homeGz = 0;
for (const [label, prefix] of ROUTES) {
  const chunk = [...chunks.keys()].find((c) => basename(c).startsWith(`${prefix}-`));
  if (chunk === undefined) {
    console.log(`  ${label.padEnd(26)} (no chunk ${prefix})`);
    continue;
  }
  const t = total(closure([entry, chunk]));
  if (prefix === 'DiyalogHome') homeGz = t.gz;
  console.log(
    `  ${label.padEnd(26)} ${kb(t.raw)} KB raw ${kb(t.gz)} KB gz ${kb(t.br)} KB br (${String(t.n)} chunks)`,
  );
}

const group = (id) => {
  const k = id
    .replace(/.*node_modules\/\.pnpm\/[^/]+\/node_modules\//, 'npm:')
    .replace(/.*\/apps\/web\/src\//, 'src/')
    .replace(/.*\/packages\//, 'pkg:');
  const p = k.split('/');
  return k.startsWith('npm:') ? p.slice(0, p[0].startsWith('npm:@') ? 2 : 1).join('/') : k;
};
const top = (set, n) => {
  const g = new Map();
  for (const c of set)
    for (const m of chunks.get(c).mods) g.set(group(m.id), (g.get(group(m.id)) ?? 0) + m.len);
  return [...g.entries()].sort((x, y) => y[1] - x[1]).slice(0, n);
};
console.log('\nTop modules needed by the Diyalog home (rendered size before minification):');
const home = [...chunks.keys()].find((c) => basename(c).startsWith('DiyalogHome-'));
for (const [k, v] of top(closure(home ? [entry, home] : [entry]), 25)) console.log(`  ${kb(v)} KB  ${k}`);

const why = opt('--why');
if (why !== undefined) {
  const byId = new Map(modules.map((m) => [m.id, m]));
  console.log(`\nWho imports *${why}:`);
  for (const m of modules)
    for (const i of m.importedIds)
      if (i.endsWith(why))
        console.log(
          `  ${group(m.id)} (${basename(m.chunk)}) -> ${group(i)} (${basename(byId.get(i)?.chunk ?? '?')})`,
        );
}
const json = opt('--json');
if (json !== undefined) writeFileSync(json, JSON.stringify(modules));
const budget = opt('--budget');
if (budget !== undefined && homeGz / 1024 > Number(budget)) {
  console.error(`\nDiyalog home needs ${kb(homeGz)} KB gzip, over the ${budget} KB budget`);
  process.exit(1);
}
