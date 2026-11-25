import { CONFIG_RUNTIMES, type RuntimeSettings, type WorkerConfigSpec } from '../../api/workerConfig';

export type Mutable<T> = { -readonly [K in keyof T]: T[K] };
export type Draft = Mutable<WorkerConfigSpec>;

export function cloneSpec(spec: WorkerConfigSpec): Draft {
  const d = JSON.parse(JSON.stringify(spec)) as Draft;
  // ADR-0023: an older generation may still name OpenHands; an edit never carries it forward.
  const known = (r: string) => (CONFIG_RUNTIMES as readonly string[]).includes(r);
  d.allowedRuntimes = d.allowedRuntimes.filter(known);
  d.runtimes = Object.fromEntries(Object.entries(d.runtimes).filter(([r]) => known(r)));
  return d;
}

export function labelsText(labels: Readonly<Record<string, string>>): string {
  return Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

export function parseLabels(text: string): { labels: Record<string, string>; invalid: string[] } {
  const labels: Record<string, string> = {};
  const invalid: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const eq = line.indexOf('=');
    if (eq <= 0) {
      invalid.push(line);
      continue;
    }
    labels[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return { labels, invalid };
}

/** Drops empty strings/objects and settings of runtimes that are not allowed (the master refuses those). */
export function cleanSpec(draft: WorkerConfigSpec): WorkerConfigSpec {
  const prune = (v: unknown): unknown => {
    if (typeof v === 'string') return v.trim() === '' ? undefined : v.trim();
    if (Array.isArray(v) || v === null || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const p = prune(x);
      if (p === undefined) continue;
      if (typeof p === 'object' && p !== null && !Array.isArray(p) && Object.keys(p).length === 0) continue;
      out[k] = p;
    }
    return out;
  };
  const runtimes: Record<string, RuntimeSettings> = {};
  for (const r of draft.allowedRuntimes) {
    const s = draft.runtimes[r];
    if (s === undefined) continue;
    const p = prune(s) as RuntimeSettings;
    if (Object.keys(p).length > 0) runtimes[r] = p;
  }
  // p17-worker-managed: empty setting groups are dropped (null stays: `telemetry.otlpEndpoint: null` = off).
  const settings =
    draft.settings === undefined ? undefined : (prune(draft.settings) as WorkerConfigSpec['settings']);
  const { settings: _s, ...rest } = draft;
  return {
    ...rest,
    workspace: prune(draft.workspace) as WorkerConfigSpec['workspace'],
    runtimes,
    ...(settings === undefined || Object.keys(settings).length === 0 ? {} : { settings }),
  };
}
