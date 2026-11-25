import type { SpawnContext } from '../../contract.js';
import type { ProcessConfiner } from '../../process/confinement.js';

/**
 * Execution sandbox hook (ADR-0007, docs/design/p3-sandbox.md): either a fixed
 * confiner or a per-attempt factory (`SandboxRunner.confiner(ctx)`). `undefined`
 * runs the runtime unconfined (only acceptable where the selected profile says so).
 */
export type ConfinerOption =
  | ProcessConfiner
  | ((ctx: SpawnContext) => ProcessConfiner | undefined | Promise<ProcessConfiner | undefined>);

export async function resolveConfiner(
  option: ConfinerOption | undefined,
  ctx: SpawnContext,
): Promise<ProcessConfiner | undefined> {
  if (option === undefined) return undefined;
  return typeof option === 'function' ? await option(ctx) : option;
}

/** Race a promise against a timeout; resolves `undefined` on timeout (the promise keeps running). */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(undefined);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Runtime session ids become path components: only canonical lowercase UUIDs are accepted. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
