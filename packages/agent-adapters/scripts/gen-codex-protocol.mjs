#!/usr/bin/env node
// Vendors the Codex app-server protocol types the adapter uses, generated from the
// PINNED binary (ADR-0012: "protocol types generated from the pinned binary").
//
//   node packages/agent-adapters/scripts/gen-codex-protocol.mjs [--codex <bin>] [--check]
//
// 1. checks `codex --version` == the pin;
// 2. runs `codex app-server generate-ts --out <tmp>` (verified subcommand of 0.164.0);
// 3. copies the import closure of ROOTS into src/runtimes/codex/protocol/generated/,
//    rewriting relative imports to NodeNext `.js` specifiers and prepending a header;
// 4. records sha256 of every *raw* generated file in manifest.json.
// `--check` regenerates and fails if the vendored files differ (drift after a bump).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CODEX_PIN = '0.164.0';

/** Entry types (paths relative to the generate-ts output, without extension). */
export const ROOTS = [
  'RequestId',
  'InitializeParams',
  'InitializeResponse',
  'ServerRequest',
  'ApplyPatchApprovalResponse',
  'ExecCommandApprovalResponse',
  'v2/GetAccountParams',
  'v2/GetAccountResponse',
  // p11-limit-visibility: the plan's usage windows (read-only; no model request).
  'v2/GetAccountRateLimitsParams',
  'v2/GetAccountRateLimitsResponse',
  'v2/AccountRateLimitsUpdatedNotification',
  'v2/ThreadStartParams',
  'v2/ThreadStartResponse',
  'v2/ThreadResumeParams',
  'v2/ThreadResumeResponse',
  'v2/TurnStartParams',
  'v2/TurnStartResponse',
  'v2/TurnSteerParams',
  'v2/TurnSteerResponse',
  'v2/TurnInterruptParams',
  'v2/TurnInterruptResponse',
  'v2/ThreadStartedNotification',
  'v2/TurnStartedNotification',
  'v2/TurnCompletedNotification',
  'v2/ItemStartedNotification',
  'v2/ItemCompletedNotification',
  'v2/ThreadTokenUsageUpdatedNotification',
  'v2/TurnDiffUpdatedNotification',
  'v2/ErrorNotification',
  'v2/CommandExecutionRequestApprovalResponse',
  'v2/FileChangeRequestApprovalResponse',
  'v2/PermissionsRequestApprovalResponse',
  'v2/McpServerElicitationRequestResponse',
  'v2/ToolRequestUserInputResponse',
];

const HEADER = (version) =>
  `// Generated from codex-cli ${version} \`codex app-server generate-ts\` by\n// packages/agent-adapters/scripts/gen-codex-protocol.mjs — do not edit by hand.\n`;

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'src', 'runtimes', 'codex', 'protocol', 'generated');

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Relative import specifiers of a generated file. */
export function importsOf(source) {
  return [...source.matchAll(/from "(\.{1,2}\/[^"]+)"/g)].map((m) => m[1]);
}

/** NodeNext needs explicit extensions; type-only imports are erased at runtime. */
export function transform(source, version) {
  const body = source.replace(/from "(\.{1,2}\/[^"]+)"/g, (_m, spec) => `from "${spec}.js"`);
  return HEADER(version) + body;
}

/** Import closure of ROOTS inside a generate-ts output directory. */
export function closure(genDir, roots = ROOTS) {
  const seen = new Set();
  const stack = [...roots];
  while (stack.length > 0) {
    const rel = stack.pop();
    if (seen.has(rel)) continue;
    const file = join(genDir, `${rel}.ts`);
    if (!existsSync(file)) throw new Error(`generated type ${rel} not found`);
    seen.add(rel);
    for (const spec of importsOf(readFileSync(file, 'utf8'))) {
      stack.push(posix.normalize(posix.join(posix.dirname(rel), spec)));
    }
  }
  return [...seen].sort();
}

export function generate(codexBin) {
  const version = /(\d+\.\d+\.\d+)/.exec(execFileSync(codexBin, ['--version'], { encoding: 'utf8' }))?.[1];
  if (version !== CODEX_PIN) throw new Error(`codex ${String(version)} is not the pinned ${CODEX_PIN}`);
  // Not under /tmp: Codex refuses helper aliases there on Linux (handson 2026-10-13 finding 3).
  const base = join(homedir(), '.cache', 'remyral');
  mkdirSync(base, { recursive: true });
  const tmp = mkdtempSync(join(base, 'codex-gen-'));
  const codexHome = join(tmp, 'codex-home');
  mkdirSync(codexHome);
  const out = join(tmp, 'ts');
  execFileSync(codexBin, ['app-server', 'generate-ts', '--out', out], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmp, CODEX_HOME: codexHome },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return { version, dir: out, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

async function main() {
  const args = process.argv.slice(2);
  const codexBin = args.includes('--codex')
    ? args[args.indexOf('--codex') + 1]
    : (process.env.REMYRAL_CODEX_BIN ?? 'codex');
  const check = args.includes('--check');
  const gen = generate(codexBin);
  try {
    const files = closure(gen.dir);
    const manifest = {
      codexVersion: gen.version,
      generator: 'codex app-server generate-ts',
      roots: ROOTS,
      files: {},
    };
    const outputs = new Map();
    for (const rel of files) {
      const raw = readFileSync(join(gen.dir, `${rel}.ts`), 'utf8');
      manifest.files[`${rel}.ts`] = sha256(raw);
      outputs.set(`${rel}.ts`, transform(raw, gen.version));
    }
    const prettier = await import('prettier');
    const config = (await prettier.resolveConfig(join(OUT, 'x.ts'))) ?? {};
    if (check) {
      const vendored = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'));
      const a = JSON.stringify(vendored.files);
      const b = JSON.stringify(manifest.files);
      if (a !== b) {
        console.error('codex protocol drift: vendored types differ from the pinned binary output');
        process.exit(1);
      }
      console.log(`codex protocol types match codex-cli ${gen.version} (${String(files.length)} files)`);
      return;
    }
    rmSync(OUT, { recursive: true, force: true });
    for (const [rel, text] of outputs) {
      const target = join(OUT, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, await prettier.format(text, { ...config, filepath: target }));
    }
    // Generated code trips a few strict lint rules (e.g. `string | null | null`): disable lint only in those files.
    const { ESLint } = await import('eslint');
    const results = await new ESLint({ cwd: join(here, '..', '..', '..') }).lintFiles([OUT]);
    for (const r of results) {
      if (r.errorCount > 0)
        writeFileSync(
          r.filePath,
          `/* eslint-disable -- generated code */\n${readFileSync(r.filePath, 'utf8')}`,
        );
    }
    writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`wrote ${String(files.length)} files to ${relative(process.cwd(), OUT)}`);
  } finally {
    gen.cleanup();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
