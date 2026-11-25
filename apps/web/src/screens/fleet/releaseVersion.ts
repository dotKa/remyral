/**
 * p17-worker-managed: release version order in the browser (the protocol's `compareReleaseVersions` lives in a module
 * that needs node:crypto). Semver precedence: numeric core first, then a prerelease sorts before its release.
 * Unparsable input compares as equal (never a downgrade claim on garbage).
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string): { core: number[]; pre: string[] | null } | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v);
    if (m === null) return null;
    return {
      core: [Number(m[1]), Number(m[2]), Number(m[3])],
      pre: m[4] === undefined ? null : m[4].split('.'),
    };
  };
  const x = parse(a);
  const y = parse(b);
  if (x === null || y === null) return 0;
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre === null && y.pre === null) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const np = /^\d+$/.test(p);
    const nq = /^\d+$/.test(q);
    if (np && nq) {
      const d = Number(p) - Number(q);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (np !== nq) {
      return np ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

/** The last update attempt ended badly in a way the machine list flags (rolled back by the updater, or failed). */
export function updateTrouble(
  last: { readonly status: string } | null | undefined,
): 'rolled_back' | 'failed' | null {
  if (last === null || last === undefined) return null;
  if (last.status === 'rolled_back') return 'rolled_back';
  if (last.status === 'failed') return 'failed';
  return null;
}
