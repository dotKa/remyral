#!/usr/bin/env node
// p14-i18n-errors (i18n Phase 3, ADR-0053 §5): every `new HttpError(status, code, message, headers?, details?, params?)`
// in apps/master/src, read from the TypeScript sources (no build). For each site: the code(s) it can send and the
// params it sends, so check-catalogs.mjs can require a TR+EN `errors` entry per code and matching `{placeholders}`.
//
// A code is resolved statically when it is
//   - a string literal, or a conditional (`a ? 'x' : 'y'`) of string literals;
//   - a template with one identifier whose declared type is a union of string literals (`${what}_not_found`);
//   - an identifier bound in the same file to one of the above (`const code = …`), or a parameter of a function
//     whose calls in the same file pass one of the above (`conflict('self_change', …)`).
// Anything else (`err.code` of a domain error class, …) is "dynamic": reported, never failed — the console shows the
// master's English message for a code it does not know.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const MASTER_SRC = join(root, 'apps/master/src');

function sourceFiles(dir) {
  const out = [];
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function stringOf(e) {
  return ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : null;
}

function unwrap(e) {
  let x = e;
  while (x && (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x)))
    x = x.expression;
  return x;
}

/** String literals of a union type node (`'a' | 'b'`), or null. */
function literalUnion(type) {
  if (type === undefined) return null;
  const parts = ts.isUnionTypeNode(type) ? type.types : [type];
  const out = [];
  for (const p of parts) {
    if (ts.isLiteralTypeNode(p) && ts.isStringLiteral(p.literal)) out.push(p.literal.text);
    else return null;
  }
  return out;
}

/** The enclosing function-like node of `n`, if any. */
function enclosingFunction(n) {
  for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p;
  return undefined;
}

function functionName(fn) {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) return fn.name.getText();
  if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent))
    return fn.parent.name.getText();
  return null;
}

/** Calls in `sf` whose callee text ends with `name` (`f(…)`, `this.f(…)`, `this.#f(…)`). */
function callsTo(sf, name) {
  const out = [];
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const t = n.expression.getText();
      if (t === name || t.endsWith(`.${name}`)) out.push(n);
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/** The codes an expression can evaluate to, or null when not statically known. */
function resolveCodes(sf, expr, depth = 0) {
  const e = unwrap(expr);
  if (e === undefined || depth > 4) return null;
  const s = stringOf(e);
  if (s !== null) return [s];
  if (ts.isConditionalExpression(e)) {
    const a = resolveCodes(sf, e.whenTrue, depth + 1);
    const b = resolveCodes(sf, e.whenFalse, depth + 1);
    return a && b ? [...a, ...b] : null;
  }
  if (ts.isTemplateExpression(e) && e.templateSpans.length === 1) {
    const span = e.templateSpans[0];
    if (!ts.isIdentifier(span.expression)) return null;
    const values = identifierValues(sf, span.expression, depth + 1, true);
    return values === null ? null : values.map((v) => `${e.head.text}${v}${span.literal.text}`);
  }
  if (ts.isIdentifier(e)) return identifierValues(sf, e, depth + 1, false);
  return null;
}

/** The codes of the resolvable branches of a partly dynamic conditional (`x ? 'a' : err.code` → ['a']). */
function partialCodes(sf, expr) {
  const e = unwrap(expr);
  if (e === undefined) return [];
  const all = resolveCodes(sf, e);
  if (all !== null) return all;
  if (ts.isConditionalExpression(e))
    return [...partialCodes(sf, e.whenTrue), ...partialCodes(sf, e.whenFalse)];
  return [];
}

/** Values of identifier `id`: a typed parameter's literal union, a local const's codes, or a parameter's call args. */
function identifierValues(sf, id, depth, typeOnly) {
  const name = id.text;
  const fn = enclosingFunction(id);
  if (fn) {
    const i = fn.parameters.findIndex((p) => p.name.getText() === name);
    if (i >= 0) {
      const lit = literalUnion(fn.parameters[i].type);
      if (lit !== null) return lit;
      if (typeOnly) return null;
      const fname = functionName(fn);
      if (fname === null) return null;
      const calls = callsTo(sf, fname);
      if (calls.length === 0) return null;
      const out = [];
      for (const c of calls) {
        const arg = c.arguments[i];
        const v = arg === undefined ? null : resolveCodes(sf, arg, depth + 1);
        if (v === null) return null;
        out.push(...v);
      }
      return out;
    }
  }
  if (typeOnly) return null;
  // A `const name = …` in the enclosing function (or the file).
  let found = null;
  let seen = false;
  const visit = (n) => {
    if (seen) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
      seen = true;
      found = resolveCodes(sf, n.initializer, depth + 1);
      return;
    }
    n.forEachChild(visit);
  };
  if (fn) visit(fn);
  if (!seen) visit(sf);
  return found;
}

/** Keys of an object literal `{ a, b: x }` (null when it has spreads or computed keys); `reason` if a literal. */
function paramsOf(sf, expr) {
  const e = unwrap(expr);
  if (e === undefined) return { keys: [], reason: null };
  if (!ts.isObjectLiteralExpression(e)) return null;
  const keys = [];
  let reason = null;
  for (const p of e.properties) {
    if (ts.isShorthandPropertyAssignment(p)) keys.push(p.name.text);
    else if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
      keys.push(p.name.text);
      if (p.name.text === 'reason') {
        const r = resolveCodes(sf, p.initializer);
        reason = r === null ? undefined : r;
      }
    } else return null;
  }
  return { keys: keys.sort(), reason };
}

/**
 * Every HttpError site of `dir`: `{ file, line, codes (null: dynamic), partial (literal branches of a dynamic
 * code), message: 'literal'|'template'|'computed',
 * params: { keys, reason } | null (not a literal object) }`. `reason` is null (none), undefined (not literal) or
 * the list of literal values.
 */
export function masterErrorSites(dir = MASTER_SRC) {
  const sites = [];
  for (const file of sourceFiles(dir)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('HttpError(')) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (n) => {
      if (ts.isNewExpression(n) && n.expression.getText() === 'HttpError') {
        const a = n.arguments ?? [];
        const msg = a[2];
        sites.push({
          file: relative(root, file),
          line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
          codes: a[1] === undefined ? null : resolveCodes(sf, a[1]),
          partial: a[1] === undefined ? [] : partialCodes(sf, a[1]),
          message:
            msg === undefined || stringOf(msg) !== null
              ? 'literal'
              : ts.isTemplateExpression(msg)
                ? 'template'
                : 'computed',
          text: msg === undefined ? null : stringOf(msg),
          params: paramsOf(sf, a[5]),
        });
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }
  return sites;
}

/** The distinct statically known codes of `sites` (with the literal branches of partly dynamic ones), sorted. */
export function masterErrorCodes(sites) {
  return [...new Set(sites.flatMap((s) => s.codes ?? s.partial))].sort();
}
