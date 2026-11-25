import type { ReactNode } from 'react';
import { AccessPanel } from './admin-lifecycle';
import { MachineAdminSection } from './admin-machine';
import { RestartPanel } from './admin-restart';
import { UpdatePanel } from './admin-update';
import { RemovePanel } from './admin-remove';
import { type MachineTabProps, operable } from './types';

/**
 * p12-diyalog wave 2 (W3) — Makine → Yönetim in the Diyalog language: access (drain, rotate / approve key, revoke,
 * remove / unarchive) with the device keys, the version (p17-worker-managed: channel, pin, rollback, retry and the
 * updater's last result), restart the worker, and machine administration (owner switch, tasks,
 * elevated commands, machine memory). The same gates as the classic tab: restart and machine admin for owners and
 * admins on a paired, active machine; every change through its confirmation and step-up.
 */
export function AdminTab(props: MachineTabProps): ReactNode {
  const w = props.worker;
  const active = operable(w);
  return (
    <div className="flex flex-col gap-5">
      <AccessPanel worker={w} onChanged={props.onChanged} />
      {active ? (
        <UpdatePanel
          worker={w}
          overview={props.overview}
          isAdmin={props.isAdmin}
          onChanged={props.onChanged}
        />
      ) : null}
      {props.isAdmin && active ? <RestartPanel workerId={w.id} /> : null}
      {props.isAdmin && active ? <MachineAdminSection workerId={w.id} workerName={w.name} os={w.os} /> : null}
      {props.isAdmin && w.state !== 'pending' && w.archivedAt === null ? (
        <RemovePanel worker={w} onChanged={props.onChanged} />
      ) : null}
    </div>
  );
}
