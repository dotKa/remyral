#!/usr/bin/env node
// p14-i18n-foundation (docs/design/i18n-plan.md §1, §7.1): hard-coded user-visible strings per file, and the ratchet
// that keeps them from growing while Diyalog moves to the catalog (packages/i18n).
//
//   node scripts/i18n/inventory.mjs                 per-file counts of apps/web/src/diyalog (top 20) and the total
//   node scripts/i18n/inventory.mjs --check         fail when a file has more strings than scripts/i18n/baseline.json
//                                                   allows (a new file counts from 0)
//   node scripts/i18n/inventory.mjs --update        write the current counts as the new baseline (after moving strings
//                                                   to the catalog; a RISE in the diff needs a reviewer's OK)
//   node scripts/i18n/inventory.mjs --json [dir…]   counts as JSON (any directory, for the plan's inventory)
//
// What counts (a TypeScript-compiler walk, deterministic, ~95 % real UI text on a hand-checked sample): JSX text with a
// letter; string/template literals in text attributes (aria-label, title, placeholder, label, …); other string and
// template literals that read like prose (two words, a Turkish letter, or a capitalised word). Skipped: imports,
// object keys, type positions, `case` labels, `===` operands, console/log calls, className-like lists, non-text JSX
// attributes (className, href, to, data-*, on*, …), `// i18n-ignore` on the line.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const BASELINE = join(root, 'scripts/i18n/baseline.json');
/** The ratchet's scope (plan §7.1): the Diyalog console; the dev harness is fixture data, not UI. */
export const SCOPE = 'apps/web/src/diyalog';
const EXCLUDE_DIRS = new Set(['harness', 'node_modules', 'dist']);

export const TEXT_ATTRS = new Set([
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
  'title',
  'placeholder',
  'label',
  'alt',
  'hint',
  'description',
  'legend',
  'sub',
  'summary',
  'question',
  'confirmLabel',
  'emptyText',
]);

// p14-web-perf: `lazyScreen(load, 'ExportName')` names a module export, not text.
const SKIP_CALLEES =
  /^(console\.\w+|\w*[Ll]og(ger)?\.\w+|describe|it|test|expect|require|import|new URL|URLSearchParams|lazyScreen)$/;
const TR_LETTER = /[çğıöşüÇĞİÖŞÜ]/;
const LETTER = /\p{L}/u;
/** Tokens of a class list, a path, an id or a CSS value. */
const TECH_TOKEN = /^[\w@:./\\[\]()%#,>&*+=~!?'"$-]+$/;

/** Does a literal's text read like something a person is meant to read? */
export function looksLikeProse(text) {
  const t = text.trim();
  if (!LETTER.test(t)) return false;
  if (TR_LETTER.test(t)) return true;
  const tokens = t.split(/\s+/);
  const technical = tokens.every((w) => TECH_TOKEN.test(w)) && tokens.some((w) => /[-:[\]/.@_=]/.test(w));
  if (technical) return false;
  if (/^[a-z][\w.-]*$/.test(t)) return false; // identifier, key, enum value, kebab-case
  if (/^[A-Z0-9_]+$/.test(t)) return false; // CONSTANT, HTTP method
  if (/^[a-z]+[A-Z]\w*$/.test(t)) return false; // camelCase
  const words = tokens.filter((w) => LETTER.test(w));
  return words.length >= 2 || /^\p{Lu}\p{Ll}/u.test(t);
}

function calleeText(call) {
  return call.expression.getText().replace(/\s+/g, ' ');
}

function attrName(a) {
  return a.name.getText();
}

/** Why a literal does not count (or null when it might). */
function skippedByContext(node) {
  let child = node;
  for (let p = node.parent; p !== undefined; child = p, p = p.parent) {
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isImportTypeNode(p)) return 'import';
    if (ts.isLiteralTypeNode(p) || ts.isTypeNode(p)) return 'type';
    if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isEnumMember(p)) && p.name === child)
      return 'key';
    if (ts.isCaseClause(p) && p.expression === child) return 'case';
    if (ts.isElementAccessExpression(p) && p.argumentExpression === child) return 'key';
    if (
      ts.isBinaryExpression(p) &&
      [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.InKeyword,
      ].includes(p.operatorToken.kind)
    )
      return 'compare';
    if (ts.isCallExpression(p) && SKIP_CALLEES.test(calleeText(p))) return 'call';
    if (ts.isNewExpression(p) && /^(URL|RegExp)$/.test(p.expression.getText())) return 'call';
    if (ts.isJsxAttribute(p)) return TEXT_ATTRS.has(attrName(p)) ? null : 'attribute';
    if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxFragment(p)) return null;
  }
  return null;
}

function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');
  return null;
}

/** Candidate hard-coded strings of one source text. Exported for the script tests. */
export function countStrings(fileName, text) {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const lines = text.split('\n');
  const ignored = (node) =>
    /i18n-ignore/.test(lines[sf.getLineAndCharacterOfPosition(node.getStart()).line] ?? '');
  let n = 0;
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      if (LETTER.test(node.text) && !ignored(node)) n += 1;
      return;
    }
    const s = literalText(node);
    if (s !== null) {
      const ctx = skippedByContext(node);
      const inTextAttr =
        ctx === null && ts.isJsxAttribute(node.parent) && TEXT_ATTRS.has(attrName(node.parent));
      if (ctx === null && !ignored(node) && (inTextAttr ? LETTER.test(s) : looksLikeProse(s))) n += 1;
      if (ts.isTemplateExpression(node)) node.templateSpans.forEach((sp) => visit(sp.expression));
      return;
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return n;
}

function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!EXCLUDE_DIRS.has(name)) walkFiles(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts'))
      out.push(p);
  }
  return out;
}

/** `{ "apps/web/src/diyalog/x.tsx": count }` for every file with at least one string, sorted by path. */
export function inventory(dirs = [SCOPE]) {
  const files = {};
  for (const d of dirs)
    for (const f of walkFiles(join(root, d))) {
      const c = countStrings(f, readFileSync(f, 'utf8'));
      if (c > 0) files[relative(root, f).split(sep).join('/')] = c;
    }
  return files;
}

/** Files whose count is above the baseline (a file missing from the baseline is allowed 0). */
export function ratchet(current, baseline) {
  const rises = [];
  const drops = [];
  for (const [f, c] of Object.entries(current)) {
    const allowed = baseline[f] ?? 0;
    if (c > allowed) rises.push({ file: f, allowed, now: c });
    else if (c < allowed) drops.push({ file: f, allowed, now: c });
  }
  for (const [f, allowed] of Object.entries(baseline))
    if (!(f in current)) drops.push({ file: f, allowed, now: 0 });
  return { rises, drops };
}

function readBaseline() {
  return JSON.parse(readFileSync(BASELINE, 'utf8')).files ?? {};
}

function writeBaseline(files) {
  const body = {
    $comment:
      'i18n ratchet (scripts/i18n/inventory.mjs, ADR-0053): hard-coded UI strings per Diyalog file. A count may only go down; run `node scripts/i18n/inventory.mjs --update` after moving strings to packages/i18n.',
    scope: SCOPE,
    total: Object.values(files).reduce((a, b) => a + b, 0),
    files,
  };
  writeFileSync(BASELINE, `${JSON.stringify(body, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes('--json')) {
    const dirs = args.filter((a) => !a.startsWith('--'));
    console.log(JSON.stringify(inventory(dirs.length > 0 ? dirs : [SCOPE]), null, 2));
  } else if (args.includes('--update')) {
    const files = inventory();
    writeBaseline(files);
    console.log(`i18n: baseline written (${String(Object.keys(files).length)} files)`);
  } else if (args.includes('--check')) {
    const { rises, drops } = ratchet(inventory(), readBaseline());
    if (rises.length > 0) {
      console.error(
        `i18n: hard-coded strings rose in ${String(rises.length)} Diyalog file(s) — move the new text to packages/i18n ` +
          `(useT()) or, if it is not user-visible, mark the line \`// i18n-ignore\`:\n  ` +
          rises.map((r) => `${r.file}: ${String(r.now)} (baseline ${String(r.allowed)})`).join('\n  '),
      );
      process.exit(1);
    }
    const note =
      drops.length > 0 ? `; ${String(drops.length)} file(s) went down — run --update to lock it in` : '';
    console.log(`i18n: no Diyalog file gained hard-coded strings${note}`);
  } else {
    const files = inventory();
    const total = Object.values(files).reduce((a, b) => a + b, 0);
    for (const [f, c] of Object.entries(files)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20))
      console.log(`${String(c).padStart(5)}  ${f}`);
    console.log(`${String(total).padStart(5)}  total in ${String(Object.keys(files).length)} files`);
  }
}
