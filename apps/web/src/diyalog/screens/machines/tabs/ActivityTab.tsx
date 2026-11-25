import type { ReactNode } from 'react';
import { HistoryPanel, OpsActivityPanels } from './activity-ops';
import { type MachineTabProps, operable } from './types';

/**
 * p12-diyalog wave 2 (W3) — Makine → Etkinlik in the Diyalog language: the lifecycle history for everyone; worker
 * logs, diagnostics and the remote-operation history for owners / admins on an operable machine (the classic gate).
 */
export function ActivityTab(props: MachineTabProps): ReactNode {
  const w = props.worker;
  return (
    <div className="flex flex-col gap-5">
      <HistoryPanel workerId={w.id} />
      {props.isAdmin && operable(w) ? <OpsActivityPanels workerId={w.id} workerName={w.name} /> : null}
    </div>
  );
}
