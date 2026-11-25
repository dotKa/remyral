import { useCallback, useEffect, useRef, useState } from 'react';
import {
  compareVersions,
  getOp,
  getOpsStatus,
  installRuntime,
  type ManagedRuntime,
  type Op,
  type OpsStatus,
  removeRuntime,
  restartRuntime,
  RUNTIME_NAME,
  TERMINAL_STATES,
} from '../../api/remoteOps';
import { toApiError } from '../../components/ui';

/**
 * Machine page → Runtimes / Admin / Activity (p5-remote-ops, ADR-0017; p6-ui-machines splits the former
 * "Remote operations" card over the machine page's tabs). For machines nobody can touch:
 *  - Runtimes tab: install / upgrade / roll back (previous pin only) / repair / remove each runtime at a pinned,
 *    checksummed version; restart a runtime; subscription login for Claude Code and Codex. When an operation
 *    ends, the panel reloads until the machine's next report shows the change (no stale "not installed").
 *  - Login: the runtime's own login runs on the worker; this dialog shows only its sign-in link / device code
 *    and relays a code the sign-in page shows back to it. The resulting credential never leaves the machine.
 *  - Admin tab: restart the worker (optionally draining jobs first). Activity tab: logs, diagnostics, history.
 * Every action goes through step-up (login: a code from the last 10 minutes, always).
 */

const POLL_MS = 1_200;

/** The machine's remote-operations status (report + recent operations). */
export function useOpsStatus(workerId: string): {
  readonly status: OpsStatus | null;
  readonly error: ReturnType<typeof toApiError> | null;
  readonly load: () => Promise<OpsStatus | null>;
} {
  const [status, setStatus] = useState<OpsStatus | null>(null);
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null);
  const load = useCallback(async (): Promise<OpsStatus | null> => {
    try {
      const s = await getOpsStatus(workerId);
      setStatus(s);
      setError(null);
      return s;
    } catch (err) {
      setError(toApiError(err));
      return null;
    }
  }, [workerId]);
  useEffect(() => {
    void load();
  }, [load]);
  return { status, error, load };
}

/** Polls one operation until it ends (logs: accumulates lines by cursor). */
export function useOp(workerId: string, initial: Op | null): { op: Op | null; lines: string[] } {
  const [op, setOp] = useState<Op | null>(initial);
  const [lines, setLines] = useState<string[]>([]);
  const cursor = useRef(0);
  useEffect(() => {
    setOp(initial);
    setLines([]);
    cursor.current = 0;
    if (initial === null) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const next = await getOp(workerId, initial.id, cursor.current);
        if (!live) return;
        if (next.logs !== null) {
          const add = next.logs.lines;
          if (add.length > 0) setLines((prev) => [...prev, ...add]);
          cursor.current = next.logs.next;
        }
        setOp(next);
        const done = TERMINAL_STATES.has(next.state) && (next.logs === null || next.logs.complete);
        if (!done) timer = setTimeout(() => void tick(), POLL_MS);
      } catch {
        if (live) timer = setTimeout(() => void tick(), POLL_MS * 3);
      }
    };
    void tick();
    return () => {
      live = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [workerId, initial]);
  return { op, lines };
}

// ---------------------------------------------------------------------------------------- runtimes

export interface RuntimeAction {
  readonly key: string;
  readonly label: string;
  readonly variant: 'secondary' | 'danger';
  readonly run: () => Promise<Op>;
  readonly why: string;
  readonly confirm?: string;
}

export function runtimeActions(workerId: string, r: ManagedRuntime): RuntimeAction[] {
  const out: RuntimeAction[] = [];
  const name = RUNTIME_NAME[r.runtime];
  const can = (v: string) => r.available.includes(v);
  const active = r.active;
  const activeInstall = r.installed.find((i) => i.version === active);
  if (active === null) {
    if (can(r.pinned)) {
      out.push({
        key: 'install',
        label: `Install ${r.pinned}`,
        variant: 'secondary',
        run: () => installRuntime(workerId, r.runtime, r.pinned),
        why: `Install ${name} ${r.pinned}`,
      });
    }
  } else {
    if (compareVersions(r.pinned, active) > 0 && can(r.pinned)) {
      out.push({
        key: 'upgrade',
        label: `Upgrade to ${r.pinned}`,
        variant: 'secondary',
        run: () => installRuntime(workerId, r.runtime, r.pinned),
        why: `Upgrade ${name} to ${r.pinned}`,
      });
    }
    if (r.previous !== undefined && compareVersions(r.previous, active) < 0 && can(r.previous)) {
      const prev = r.previous;
      out.push({
        key: 'rollback',
        label: `Roll back to ${prev}`,
        variant: 'secondary',
        run: () => installRuntime(workerId, r.runtime, prev),
        why: `Roll ${name} back to ${prev}`,
        confirm: `Roll ${name} back to ${prev}?`,
      });
    }
    if (activeInstall?.integrity === 'modified' || activeInstall === undefined) {
      out.push({
        key: 'repair',
        label: `Reinstall ${active}`,
        variant: 'secondary',
        run: () => installRuntime(workerId, r.runtime, active),
        why: `Reinstall ${name} ${active}`,
      });
    }
  }
  out.push({
    key: 'restart',
    label: 'Restart',
    variant: 'secondary',
    run: () => restartRuntime(workerId, r.runtime),
    why: `Restart ${name}`,
  });
  for (const i of r.installed) {
    out.push({
      key: `remove-${i.version}`,
      label: `Remove ${i.version}`,
      variant: 'danger',
      run: () => removeRuntime(workerId, r.runtime, i.version),
      why: `Remove ${name} ${i.version}`,
      confirm: `Remove ${name} ${i.version}${i.version === active ? ' (in use: the runtime stops being available here)' : ''}?`,
    });
  }
  return out;
}

/** Which runtime an operation acts on, and whether the machine's report must show its result first. */
export function reportReflects(op: Op, s: OpsStatus): boolean {
  const since = op.finishedAt ?? op.updatedAt;
  const fresh = s.reportedAt !== null && Date.parse(s.reportedAt) >= Date.parse(since);
  const rt = s.report?.runtimes.find((r) => r.runtime === op.params.runtime);
  const version = typeof op.params.version === 'string' ? op.params.version : null;
  if (op.kind === 'runtime.install' && rt !== undefined && version !== null) {
    return fresh || rt.active === version;
  }
  if (op.kind === 'runtime.remove' && rt !== undefined && version !== null) {
    return fresh || !rt.installed.some((i) => i.version === version);
  }
  return true;
}
