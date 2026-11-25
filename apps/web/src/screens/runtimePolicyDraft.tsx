import { type PolicyDocument, type PolicyRule } from '../api/runtimePolicy';
import { isRetiredRuntime } from '../lib/reasons';

export interface DraftRow {
  readonly runtime: string;
  readonly allowed: boolean;
  readonly rule: PolicyRule;
}

export interface Draft {
  readonly name: string;
  /** Latest stored version (0: a new policy) — sent as `expectedVersion`. */
  readonly expectedVersion: number;
  readonly rows: readonly DraftRow[];
  readonly projectProfiles: PolicyDocument['projectProfiles'];
}

export function draftOf(
  name: string,
  doc: PolicyDocument,
  template: PolicyDocument,
  expectedVersion: number,
): Draft {
  // ADR-0023: a rule of a removed runtime (OpenHands) in a stored version is not carried into a new one.
  const runtimes = [
    ...Object.keys(template.runtimes),
    ...Object.keys(doc.runtimes).filter((r) => template.runtimes[r] === undefined),
  ].filter((r) => !isRetiredRuntime(r));
  return {
    name,
    expectedVersion,
    projectProfiles: doc.projectProfiles,
    rows: runtimes.flatMap((runtime): DraftRow[] => {
      const own = doc.runtimes[runtime];
      const base = template.runtimes[runtime];
      // The pinned version comes from the server's machine software, never from an old stored version: a policy
      // saved under an earlier release would otherwise keep every machine on that release's runtimes for good.
      if (own !== undefined)
        return [
          {
            runtime,
            allowed: true,
            // p17-update-channel: a held version is a deliberate choice and stays; a following rule shows the pin.
            rule: base === undefined || own.pin === 'hold' ? own : { ...own, version: base.version },
          },
        ];
      return base === undefined ? [] : [{ runtime, allowed: false, rule: base }];
    }),
  };
}

/** The document a draft saves: allowed runtimes only; project restrictions pruned to what still exists. */
export function documentOf(d: Draft): PolicyDocument {
  const runtimes: Record<string, PolicyRule> = {};
  for (const row of d.rows) {
    if (!row.allowed) continue;
    const r = row.rule;
    runtimes[row.runtime] = {
      version: r.version,
      ...(r.pin === 'hold'
        ? { pin: 'hold' as const, ...(r.hold === undefined ? {} : { hold: { ...r.hold } }) }
        : { pin: 'follow' as const }),
      authModes: [...r.authModes],
      allowUnpinned: r.allowUnpinned,
      allowUnverified: r.allowUnverified === true,
      modelProfiles: r.modelProfiles.map((p) => ({ ...p, params: { ...p.params } })),
      defaultProfile: r.defaultProfile,
    };
  }
  const projectProfiles: Record<string, Record<string, string[]>> = {};
  for (const [project, byRuntime] of Object.entries(d.projectProfiles)) {
    const kept: Record<string, string[]> = {};
    for (const [runtime, names] of Object.entries(byRuntime)) {
      const rule = runtimes[runtime];
      if (rule === undefined) continue;
      const allowed = names.filter((n) => rule.modelProfiles.some((p) => p.name === n));
      if (allowed.length > 0) kept[runtime] = allowed;
    }
    if (Object.keys(kept).length > 0) projectProfiles[project] = kept;
  }
  return { runtimes, projectProfiles };
}
