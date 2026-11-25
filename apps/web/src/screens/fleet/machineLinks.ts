/**
 * p6-ui-machines: the machine page's URL (`/machines/:id?tab=<tab>`) and the mapping of the older deep-link
 * sections (`/machines?worker=<id>&section=<card>`, as lib/reasons.ts `machineHref` and older pages build
 * them) to its tabs.
 */

export const MACHINE_TABS = [
  'overview',
  'runtimes',
  'tools',
  'sandbox',
  'configuration',
  'admin',
  'activity',
] as const;
export type MachineTab = (typeof MACHINE_TABS)[number];

/** Old card / section names → tab. Unknown sections land on Overview. */
const SECTION_TAB: Readonly<Record<string, MachineTab>> = {
  overview: 'overview',
  'remote-ops': 'runtimes',
  runtimes: 'runtimes',
  login: 'runtimes',
  tools: 'tools',
  sandbox: 'sandbox',
  policy: 'sandbox',
  'runtime-policy': 'sandbox',
  config: 'configuration',
  configuration: 'configuration',
  'machine-admin': 'admin',
  admin: 'admin',
  operations: 'activity',
  history: 'activity',
  logs: 'activity',
  activity: 'activity',
};

export function sectionTab(section: string | null | undefined): MachineTab {
  if (section === null || section === undefined) return 'overview';
  return SECTION_TAB[section] ?? 'overview';
}

/** `/machines/<id>` (Overview) or `/machines/<id>?tab=<tab>`. */
export function machinePath(workerId: string, tab: MachineTab = 'overview'): string {
  const base = `/machines/${encodeURIComponent(workerId)}`;
  return tab === 'overview' ? base : `${base}?tab=${tab}`;
}
