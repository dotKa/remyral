/**
 * p9-ui-names-sweep: console links to a machine page, as the web console names them (sidebar "Machines",
 * `/machines/<workerId>?tab=<tab>`; apps/web/src/screens/fleet/machineLinks.ts). Master texts and links must
 * use these instead of the retired Fleet screen (`/fleet?worker=…&section=…`, which only redirects).
 */
export type MachineTab =
  'overview' | 'runtimes' | 'tools' | 'sandbox' | 'configuration' | 'admin' | 'activity';

/** `/machines/<id>` (Overview) or `/machines/<id>?tab=<tab>`. */
export function machineLink(workerId: string, tab: MachineTab = 'overview'): string {
  const base = `/machines/${encodeURIComponent(workerId)}`;
  return tab === 'overview' ? base : `${base}?tab=${tab}`;
}
