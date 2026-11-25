import { isRetiredRuntime } from '@remyral/protocol';

/**
 * ADR-0023: OpenHands was removed. A worker config file written for an older build may still name it
 * (`allowedRuntimes`, `localCeiling.allowedRuntimes`, `runtimeAuth.openhands`, `runtimes.openhands`,
 * `sandbox.container.images.openhands`) or carry `remoteOps.pypiIndex` (used only by the OpenHands installer).
 * The strict schema would refuse such a file and the worker would not start; instead these entries are dropped
 * before validation and returned as notices the daemon logs as warnings. Anything else unknown still fails.
 * Pure: returns a cleaned copy, never mutates the input.
 */
export function dropRetiredConfig(json: unknown): { json: unknown; notices: string[] } {
  const notices: string[] = [];
  if (!isObject(json)) return { json, notices };
  const root: Record<string, unknown> = { ...json };

  const list = (owner: Record<string, unknown>, key: string, path: string): void => {
    const v = owner[key];
    if (!Array.isArray(v) || !v.some(isRetiredRuntime)) return;
    owner[key] = v.filter((x) => !isRetiredRuntime(x));
    notices.push(`${path}: dropped retired runtime(s) ${v.filter(isRetiredRuntime).join(', ')} (ADR-0023)`);
  };
  const keys = (owner: Record<string, unknown>, key: string, path: string): void => {
    const v = owner[key];
    if (!isObject(v)) return;
    const retired = Object.keys(v).filter(isRetiredRuntime);
    if (retired.length === 0) return;
    owner[key] = Object.fromEntries(Object.entries(v).filter(([k]) => !isRetiredRuntime(k)));
    for (const k of retired) notices.push(`${path}.${k}: dropped, the runtime was removed (ADR-0023)`);
  };

  list(root, 'allowedRuntimes', 'allowedRuntimes');
  keys(root, 'runtimeAuth', 'runtimeAuth');
  keys(root, 'runtimes', 'runtimes');
  if (isObject(root.localCeiling)) {
    const ceiling = { ...root.localCeiling };
    root.localCeiling = ceiling;
    list(ceiling, 'allowedRuntimes', 'localCeiling.allowedRuntimes');
  }
  if (isObject(root.sandbox) && isObject(root.sandbox.container)) {
    const container = { ...root.sandbox.container };
    root.sandbox = { ...root.sandbox, container };
    keys(container, 'images', 'sandbox.container.images');
  }
  if (isObject(root.remoteOps) && 'pypiIndex' in root.remoteOps) {
    const { pypiIndex: _drop, ...rest } = root.remoteOps;
    root.remoteOps = rest;
    notices.push('remoteOps.pypiIndex: ignored, only the removed OpenHands installer used it (ADR-0023)');
  }
  return { json: root, notices };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
