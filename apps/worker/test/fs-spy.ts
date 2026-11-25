import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Records every path the *worker process* hands to node:fs (sync, callback and
 * promise APIs) and every command it spawns, by patching the builtin modules and
 * re-syncing their ESM named exports — so modules that did
 * `import { open } from 'node:fs/promises'` are observed too. Calls pass through.
 */
export interface FsSpy {
  readonly paths: string[];
  readonly commands: string[];
  restore(): void;
}

const FS_FUNCS = [
  'open',
  'openSync',
  'readFile',
  'readFileSync',
  'stat',
  'statSync',
  'lstat',
  'lstatSync',
  'access',
  'accessSync',
  'existsSync',
  'readdir',
  'readdirSync',
  'realpath',
  'realpathSync',
  'opendir',
  'createReadStream',
  'copyFile',
  'copyFileSync',
] as const;

const PROMISE_FUNCS = [
  'open',
  'readFile',
  'stat',
  'lstat',
  'access',
  'readdir',
  'realpath',
  'opendir',
  'copyFile',
] as const;
const CP_FUNCS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'] as const;

function toPath(arg: unknown): string | null {
  if (typeof arg === 'string') return arg;
  if (arg instanceof URL) return fileURLToPath(arg);
  if (Buffer.isBuffer(arg)) return arg.toString('utf8');
  return null;
}

export function spyOnFs(): FsSpy {
  const paths: string[] = [];
  const commands: string[] = [];
  const restores: (() => void)[] = [];
  const patch = (target: Record<string, unknown>, name: string, record: (args: unknown[]) => void) => {
    const original = target[name];
    if (typeof original !== 'function') return;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      record(args);
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
    target[name] = wrapped;
    restores.push(() => {
      target[name] = original;
    });
  };
  const fsTarget = fs as unknown as Record<string, unknown>;
  const promisesTarget = fs.promises as unknown as Record<string, unknown>;
  // Default imports are the mutable CommonJS module objects behind the ESM namespaces.
  const cpTarget = childProcess as unknown as Record<string, unknown>;
  for (const name of FS_FUNCS)
    patch(fsTarget, name, (args) => {
      const p = toPath(args[0]);
      if (p !== null) paths.push(p);
    });
  for (const name of PROMISE_FUNCS)
    patch(promisesTarget, name, (args) => {
      const p = toPath(args[0]);
      if (p !== null) paths.push(p);
    });
  for (const name of CP_FUNCS)
    patch(cpTarget, name, (args) => {
      commands.push(String(args[0]));
    });
  syncBuiltinESMExports();
  return {
    paths,
    commands,
    restore() {
      for (const r of restores.splice(0).reverse()) r();
      syncBuiltinESMExports();
    },
  };
}
