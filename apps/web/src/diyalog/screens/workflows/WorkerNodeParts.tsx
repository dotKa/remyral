import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { type CredentialKind, listCredentials } from '../../../api/vault';
import type { NodeTypeInfo, WorkflowCatalog } from '../../../api/workflowEngine';
import { useT } from '../../../i18n/I18nProvider';
import { DyChoice, DyInput, DyNotice } from '../kit';
import type { TypedNode } from './model';
import { functionWorkerKind } from './nodeCatalog';

/**
 * p14-workflow-engine 14.3 (docs/design/p14-workflow-engine.md §3.5, §5.2): the inspector parts of worker nodes
 * (HTTP request, e-mail, code). They run as function jobs on a worker: the note says how many suitable workers are
 * online (catalog `functionWorkers`), warns when none is (the job waits and the node fails `no_worker` after its queue
 * timeout), edits the queue timeout and offers the vault credentials of the node's kind (http-auth / smtp) as a select
 * when the user may read the vault (else the config form's text field stays the way to name one).
 */

/** Default queue timeout of a worker node (master: `queueTimeoutSec` default 600 s). */
export const DEFAULT_QUEUE_TIMEOUT_SEC = 600;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function WorkerNote(props: {
  readonly info: NodeTypeInfo;
  readonly catalog: WorkflowCatalog;
  readonly node: TypedNode;
}): ReactNode {
  const w = useT().workflows.inspector.worker;
  const kind = functionWorkerKind(props.info);
  if (kind === null) return null;
  const online = props.catalog.functionWorkers?.[kind].online ?? 0;
  const codeNone = kind === 'code' && props.catalog.functionWorkers?.code.total === 0;
  const timeout =
    typeof props.node.queueTimeoutSec === 'number' ? props.node.queueTimeoutSec : DEFAULT_QUEUE_TIMEOUT_SEC;
  return (
    <div className="grid gap-1.5" data-testid="worker-node-note" data-online={String(online)}>
      <p className="m-0 text-[0.78125rem] text-dy-muted">{w.note({ n: online })}</p>
      {codeNone ? (
        // p14-code-images: no machine has the code images — point at the machine page action that builds them.
        <DyNotice tone="amber">
          <span data-testid="worker-node-code-not-ready">
            {w.codeNotReady}{' '}
            <Link to="/machines" className="font-bold text-dy-teal-ink underline">
              {w.codeNotReadyLink}
            </Link>
          </span>
        </DyNotice>
      ) : online === 0 ? (
        <DyNotice tone="amber">
          <span data-testid="worker-node-none">{w.noneOnline({ sec: timeout })}</span>
        </DyNotice>
      ) : null}
    </div>
  );
}

export function QueueTimeoutField(props: {
  readonly node: TypedNode;
  readonly readOnly: boolean;
  readonly onPatch: (patch: Readonly<Record<string, unknown>>) => void;
}): ReactNode {
  const w = useT().workflows.inspector.worker;
  const v = props.node.queueTimeoutSec;
  return (
    <DyInput
      label={w.queueTimeoutSec}
      hint={w.queueTimeoutHint}
      type="number"
      min={10}
      placeholder={String(DEFAULT_QUEUE_TIMEOUT_SEC)}
      value={typeof v === 'number' ? String(v) : ''}
      readOnly={props.readOnly}
      data-testid="queue-timeout"
      onChange={(e) => {
        const n = Number(e.target.value);
        props.onPatch({
          queueTimeoutSec: e.target.value.trim() === '' || !Number.isFinite(n) ? undefined : n,
        });
      }}
    />
  );
}

/** Which vault credential a node type names and where in its config (null: none). */
function credentialSlot(type: string): {
  kind: CredentialKind;
  get: (c: Record<string, unknown>) => string;
  set: (c: Record<string, unknown>, id: string) => Record<string, unknown>;
} | null {
  if (type === 'http.request')
    return {
      kind: 'http-auth',
      get: (c) => (isObj(c.auth) && typeof c.auth.credential === 'string' ? c.auth.credential : ''),
      set: (c, id) => {
        if (id === '') {
          const { auth: _auth, ...rest } = c;
          return rest;
        }
        const auth = isObj(c.auth) ? c.auth : { placement: 'bearer' };
        return { ...c, auth: { ...auth, credential: id } };
      },
    };
  if (type === 'email.send')
    return {
      kind: 'smtp',
      get: (c) => (isObj(c.smtp) && typeof c.smtp.credential === 'string' ? c.smtp.credential : ''),
      set: (c, id) => ({ ...c, smtp: { ...(isObj(c.smtp) ? c.smtp : {}), credential: id } }),
    };
  return null;
}

export function CredentialPicker(props: {
  readonly node: TypedNode;
  readonly readOnly: boolean;
  readonly onConfig: (next: Record<string, unknown>) => void;
}): ReactNode {
  const w = useT().workflows.inspector.worker;
  const slot = credentialSlot(props.node.type);
  const [list, setList] = useState<readonly { id: string; name: string }[] | null>(null);
  const kind = slot?.kind ?? null;
  useEffect(() => {
    if (kind === null) return;
    let live = true;
    listCredentials().then(
      (cs) => {
        if (live)
          setList(
            cs
              .filter((c) => c.kind === kind && c.state === 'active')
              .map((c) => ({ id: c.id, name: c.name })),
          );
      },
      // No vault.read for this user (or the vault is off): the config form's text field remains.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [kind]);
  if (slot === null || list === null) return null;
  const current = slot.get(props.node.config);
  const options: (readonly [string, string])[] = [
    ['', w.credentialPick],
    ...list.map((c) => [c.id, `${c.name} (${c.id})`] as const),
    ...(current !== '' && !list.some((c) => c.id === current) ? [[current, current] as const] : []),
  ];
  return (
    <div data-testid="credential-picker">
      <DyChoice
        label={w.credential}
        value={current}
        disabled={props.readOnly}
        hint={list.length === 0 ? w.credentialNone : undefined}
        options={options}
        onChange={(id) => {
          props.onConfig(slot.set(props.node.config, id));
        }}
      />
    </div>
  );
}
