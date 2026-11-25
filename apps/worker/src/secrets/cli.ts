import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from '../config/load.js';
import { pathApi, type PathHost } from '../config/paths.js';
import type { FileOps } from '../fs/ops.js';
import { InsecurePermissionsError } from '../fs/permissions.js';
import { SecretError } from './errors.js';
import type { ExecFn } from './exec.js';
import { createSecretStore } from './factory.js';
import {
  SecretInputAbortedError,
  readAllStdin,
  readHiddenLine,
  type PromptOutput,
  type TtyInput,
} from './input.js';
import { assertSecretName, assertSecretValue } from './ref.js';
import { exposeJobSecret, readJobSecretExposure, unexposeJobSecret } from './exposure.js';
import { FileSecretStore, type SecretStore } from './store.js';

export const SECRET_USAGE = `Usage:
  remyral-worker secret set <name> [--stdin] [--config <path> | --data-dir <dir>]
  remyral-worker secret list [--json] [--config <path> | --data-dir <dir>]
  remyral-worker secret rm <name> [--config <path> | --data-dir <dir>]
  remyral-worker secret expose <name> [--project <id> ...] [--config <path> | --data-dir <dir>]
  remyral-worker secret unexpose <name> [--config <path> | --data-dir <dir>]

  Provider API keys (Anthropic, OpenAI, ...) stored on this worker (ADR-0006). The master
  and the console only ever see the reference  secret:<name>  (worker:<workerId>/secret:<name>).

  set <name>    Read the value from the terminal with echo off (or all of stdin with --stdin;
                one trailing newline is removed) and store it. Never pass the value as an argument.
  list          Names only. Values are never printed.
  rm <name>     Delete the secret.
  expose <name> Let jobs and services ask for this secret by name (spec secretRefs / service secretEnv
                "secret:<name>"), for every project or only the --project ones. Without it a job's
                reference to a local secret is not injected (default deny; the job's timeline says so).
                The runtime keys of runtimeAuth need no exposure.
  unexpose <name>  Stop exposing it.

  --config <path>   Worker config (selects the store: file, macos-keychain, windows-dpapi).
  --data-dir <dir>  Use the file store in this data directory instead of the config.

  Names: 1-64 characters of [A-Za-z0-9_-]. Values: 6 to 16384 characters. Names starting with
  "vault-" are reserved for credentials delivered from the panel vault and cannot be set here.
Exit codes: 0 ok, 1 not found, 2 bad arguments / aborted, 78 configuration / permission / store problem.
`;

export interface SecretCliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface SecretCliHost {
  ops: FileOps;
  pathHost: PathHost;
  /** Terminal input (default process.stdin). */
  tty?: TtyInput;
  /** Raw stdin for --stdin (default process.stdin). */
  stdin?: AsyncIterable<Buffer | string>;
  /** Where the prompt goes (default process.stderr). */
  prompt?: PromptOutput;
  exec?: ExecFn;
}

const EXIT_OK = 0;
const EXIT_NOT_FOUND = 1;
const EXIT_USAGE = 2;
const EXIT_CONFIG = 78;

/** `remyral-worker secret …`; returns the exit code. Never prints a secret value. */
export async function secretCommand(
  argv: readonly string[],
  io: SecretCliIo,
  host: SecretCliHost,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        stdin: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        config: { type: 'string' },
        'data-dir': { type: 'string' },
        project: { type: 'string', multiple: true },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n\n${SECRET_USAGE}`);
    return EXIT_USAGE;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout(SECRET_USAGE);
    return EXIT_OK;
  }
  const [sub, name, ...extra] = positionals;
  const needsName = sub === 'set' || sub === 'rm' || sub === 'expose' || sub === 'unexpose';
  if (
    (sub !== 'set' && sub !== 'list' && sub !== 'rm' && sub !== 'expose' && sub !== 'unexpose') ||
    (values.project !== undefined && sub !== 'expose') ||
    extra.length > 0 ||
    (needsName ? name === undefined : name !== undefined) ||
    (values.stdin && sub !== 'set') ||
    (values.json && sub !== 'list') ||
    (values.config !== undefined && values['data-dir'] !== undefined)
  ) {
    io.stderr(SECRET_USAGE);
    return EXIT_USAGE;
  }
  try {
    if (name !== undefined) assertSecretName(name);
    if (
      (sub === 'set' || sub === 'expose' || sub === 'unexpose') &&
      name !== undefined &&
      name.toLowerCase().startsWith('vault-')
    ) {
      // p5-credentials-models: `vault-<id>` is written only by the panel credential vault.
      io.stderr(
        'remyral-worker: names starting with "vault-" are reserved for panel vault credentials; choose another name\n',
      );
      return EXIT_USAGE;
    }
    const { store, dataDir } = await openStore(host, values.config, values['data-dir']);
    switch (sub) {
      case 'list': {
        const names = await store.list();
        const exposure = await readJobSecretExposure(host.ops, dataDir);
        const jobs = (n: string): string => {
          if (!Object.hasOwn(exposure.entries, n)) return '';
          const p = exposure.entries[n];
          return p === null || p === undefined ? '  (jobs: all projects)' : `  (jobs: ${p.join(', ')})`;
        };
        if (exposure.problem !== null) io.stderr(`remyral-worker: ${exposure.problem}\n`);
        io.stdout(
          values.json
            ? `${JSON.stringify({ store: store.kind, location: store.location, names, exposedToJobs: exposure.entries }, null, 2)}\n`
            : names.map((n) => `${n}${jobs(n)}\n`).join(''),
        );
        return EXIT_OK;
      }
      case 'expose': {
        const projects = values.project ?? null;
        for (const p of projects ?? []) {
          if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(p)) {
            io.stderr(`remyral-worker: invalid project id ${JSON.stringify(p)}\n`);
            return EXIT_USAGE;
          }
        }
        await exposeJobSecret(host.ops, dataDir, name ?? '', projects);
        const stored = (await store.list()).includes(name ?? '');
        io.stdout(
          `jobs ${projects === null ? 'of every project' : `of ${projects.join(', ')}`} may now use secret:${name ?? ''}${stored ? '' : ' (not stored yet: remyral-worker secret set)'}\n`,
        );
        return EXIT_OK;
      }
      case 'unexpose': {
        if (!(await unexposeJobSecret(host.ops, dataDir, name ?? ''))) {
          io.stderr(`remyral-worker: secret "${name ?? ''}" is not exposed to jobs\n`);
          return EXIT_NOT_FOUND;
        }
        io.stdout(`jobs may no longer use secret:${name ?? ''}\n`);
        return EXIT_OK;
      }
      case 'rm': {
        const removed = await store.delete(name ?? '');
        if (!removed) {
          io.stderr(`remyral-worker: no secret named "${name ?? ''}" in ${store.location}\n`);
          return EXIT_NOT_FOUND;
        }
        io.stdout(`removed secret ${name ?? ''}\n`);
        return EXIT_OK;
      }
      default: {
        const value = values.stdin
          ? await readAllStdin(host.stdin ?? process.stdin)
          : await readHiddenLine(
              host.tty ?? process.stdin,
              host.prompt ?? process.stderr,
              `Value for secret ${name ?? ''} (input hidden): `,
            );
        assertSecretValue(value);
        await store.set(name ?? '', value);
        io.stdout(
          `stored secret ${name ?? ''} in ${store.location}${store.accessControlVerified ? '' : ' (access control UNVERIFIED on this platform)'}\nreference: secret:${name ?? ''}\n`,
        );
        return EXIT_OK;
      }
    }
  } catch (error) {
    if (error instanceof SecretInputAbortedError) {
      io.stderr('remyral-worker: aborted\n');
      return EXIT_USAGE;
    }
    if (
      error instanceof SecretError ||
      error instanceof ConfigError ||
      error instanceof InsecurePermissionsError
    ) {
      io.stderr(`remyral-worker: ${error.message}\n`);
      return EXIT_CONFIG;
    }
    // Message only; a stack is not needed to act on it.
    io.stderr(`remyral-worker secret crashed: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_USAGE;
  }
}

async function openStore(
  host: SecretCliHost,
  configPath: string | undefined,
  dataDir: string | undefined,
): Promise<{ store: SecretStore; dataDir: string }> {
  if (dataDir !== undefined) {
    const dir = pathApi(host.pathHost.platform).resolve(dataDir);
    return { store: new FileSecretStore(host.ops, dir), dataDir: dir };
  }
  const config = await loadConfig(host.ops, host.pathHost, { explicitPath: configPath });
  return { store: createSecretStore(config, host.ops, host.exec), dataDir: config.dataDir };
}
