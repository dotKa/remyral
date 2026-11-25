// oss-sdk-external: what the worker bundles may contain, and the licence texts of what they do contain.
//  - No proprietary code: nothing from node_modules/@anthropic-ai/ (the Claude Agent SDK is loaded at run time
//    from the runtime the machine installed; packages/agent-adapters/src/runtimes/claude-code/sdk-loader.ts).
//  - Every third-party package esbuild put into a bundle is listed with its LICENSE / NOTICE files, appended to
//    that bundle as a trailing block of `//` line comments (before scripts/release/sign.mjs hashes and signs it).
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Inputs that must never be bundled (esbuild metafile input paths, `/`-separated). */
export const FORBIDDEN_INPUTS = [/(^|\/)node_modules\/@anthropic-ai\//];

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

/** Metafile inputs matching {@link FORBIDDEN_INPUTS}. */
export function forbiddenInputs(metafile) {
  return Object.keys(metafile.inputs).filter((p) =>
    FORBIDDEN_INPUTS.some((re) => re.test(p.replaceAll('\\', '/'))),
  );
}

/**
 * The third-party packages behind a metafile's inputs (the innermost `node_modules/<name>` of each input), with
 * their package.json name / version / licence and their licence files. Sorted by name, then version.
 */
export function bundledPackages(metafile, absWorkingDir) {
  const dirs = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const p = input.replaceAll('\\', '/');
    const at = p.lastIndexOf('node_modules/');
    if (at === -1) continue;
    const rest = p.slice(at + 'node_modules/'.length).split('/');
    const name = rest[0]?.startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
    if (name === undefined || name === '' || name.startsWith('.')) continue;
    const dir = resolve(absWorkingDir, p.slice(0, at + 'node_modules/'.length) + name);
    dirs.set(dir, name);
  }
  const packages = [];
  for (const [dir, name] of dirs) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const files = readdirSync(dir)
      .filter((f) => LICENSE_FILE.test(f))
      .sort()
      .map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }));
    packages.push({
      name: typeof pkg.name === 'string' ? pkg.name : name,
      version: typeof pkg.version === 'string' ? pkg.version : 'unknown',
      license: typeof pkg.license === 'string' ? pkg.license : 'UNKNOWN',
      dir,
      files,
    });
  }
  return packages.sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  );
}

/** Text as `//` line comments: no line terminator (LF, CR, U+2028, U+2029) can end the comment early. */
function commentLines(text) {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, ' ')
    .trimEnd()
    .split('\n')
    .map((l) => (l === '' ? '//' : `// ${l.trimEnd()}`));
}

/**
 * The trailing licence block of a bundle (starts and ends with a newline). Throws when a package ships no licence
 * file: its terms could not be reproduced.
 */
export function licenseNotice(bundleName, packages) {
  const missing = packages.filter((p) => p.files.length === 0);
  if (missing.length > 0) {
    throw new Error(
      `${bundleName}: no LICENSE / NOTICE file in ${missing.map((p) => `${p.name}@${p.version} (${p.dir})`).join(', ')}`,
    );
  }
  const rule = '='.repeat(76);
  const lines = [
    '',
    `// ${rule}`,
    `// Third-party software bundled in ${bundleName}`,
    '//',
    '// Remyral is licensed under the Apache License 2.0. This file also contains the',
    '// following third-party packages, each under its own licence reproduced below:',
    '//',
    ...packages.map((p) => `//   ${p.name}@${p.version} (${p.license})`),
    '//',
    '// The Claude Agent SDK is not included: it is loaded at run time from the',
    '// Claude Code runtime installed on the machine.',
    `// ${rule}`,
  ];
  for (const p of packages) {
    lines.push(
      '//',
      `// ---- ${p.name}@${p.version} (${p.license}) ${'-'.repeat(Math.max(4, 60 - p.name.length - p.version.length - p.license.length))}`,
    );
    for (const f of p.files) lines.push('//', `// [${f.file}]`, ...commentLines(f.text));
  }
  lines.push(`// ${rule}`, '');
  return lines.join('\n');
}
