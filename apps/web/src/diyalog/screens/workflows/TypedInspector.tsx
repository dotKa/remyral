import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { ApiIssue } from '../../../api/client';
import {
  listNodeRuns,
  type NodeTestResult,
  type Sample,
  testWorkflowNode,
  type WorkflowCatalog,
} from '../../../api/workflowEngine';
import { listWorkflowRuns } from '../../../api/workflows';
import { toApiError } from '../../../components/ui';
import { useT } from '../../../i18n/I18nProvider';
import { useErrorText } from '../../../i18n/errors';
import { DyChoice, DyFieldset, DyInput, DyNotice, DyTextarea } from '../kit';
import { DyButton } from '../parts';
import { previewText } from './ExpressionField';
import { IdField, Issues } from './Inspector';
import { cleanDoc, type Doc, type TypedNode } from './model';
import { makePortsOf, nodeTypeText, suggestionsFor, typeInfo } from './nodeCatalog';
import { type FieldContext, SchemaForm, withKey } from './SchemaForm';
import { CredentialPicker, QueueTimeoutField, WorkerNote } from './WorkerNodeParts';

/**
 * p14-workflow-engine 14.1 (docs/design/p14-workflow-engine.md §7.2, §7.4): the inspector of a typed node — identity,
 * label, the config form generated from the catalog's schema, the node-level policies (on error, retries and backoff,
 * timeout, join of a many-input node) and "Bu düğümü dene": the master evaluates the node (master-pure types only)
 * against sample data; nothing is stored. Sample data: the last run's input of this node when there is one, else the
 * declared inputs; editable as JSON.
 */

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function defaultSample(doc: Doc): Sample {
  return { input: null, inputs: Object.fromEntries(Object.keys(doc.inputs).map((k) => [k, ''])) };
}

/** The last run's recorded input of this node (sample data), when the workflow has a run of engine 2. */
function useLastRunSample(project: string, name: string, nodeId: string, enabled: boolean): unknown {
  const [input, setInput] = useState<unknown>(undefined);
  useEffect(() => {
    if (!enabled || name === '') return;
    let live = true;
    listWorkflowRuns()
      .then(async (runs) => {
        const run = runs.find((r) => r.project === project && r.name === name);
        if (run === undefined) return;
        const nr = await listNodeRuns(run.id, { node: nodeId, limit: 1 });
        const first = nr.nodeRuns[0];
        if (live && first !== undefined && first.input !== null) setInput(first.input);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [project, name, nodeId, enabled]);
  return input;
}

export function TypedNodeInspector(props: {
  readonly doc: Doc;
  readonly node: TypedNode;
  readonly catalog: WorkflowCatalog;
  readonly issues: readonly ApiIssue[];
  readonly readOnly: boolean;
  readonly project: string;
  /** The saved definition version (null: a new workflow — the single-node test needs a saved workflow). */
  readonly workflowId: string | null;
  readonly onRename: (to: string) => void;
  readonly onPatch: (patch: Readonly<Record<string, unknown>>, tag?: string) => void;
  readonly onDelete: () => void;
}): ReactNode {
  const t = useT();
  const w = t.workflows;
  const sayError = useErrorText();
  const { doc, node, catalog, readOnly } = props;
  const info = typeInfo(catalog, node.type);
  const label = nodeTypeText(w, node.type);
  const lastInput = useLastRunSample(props.project, doc.name, node.id, props.workflowId !== null);
  const [sampleText, setSampleText] = useState<string | null>(null);
  const [sampleBad, setSampleBad] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<NodeTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const baseSample: Sample = useMemo(
    () => (lastInput === undefined ? defaultSample(doc) : { ...defaultSample(doc), input: lastInput }),
    [doc, lastInput],
  );
  const sample: Sample = useMemo(() => {
    if (sampleText === null) return baseSample;
    try {
      const v = JSON.parse(sampleText) as unknown;
      return isObj(v) ? v : baseSample;
    } catch {
      return baseSample;
    }
  }, [sampleText, baseSample]);

  const suggestions = useMemo(() => suggestionsFor(doc, node.id, catalog), [doc, node.id, catalog]);
  // Issues on config fields (`nodes.<i>.config.<field>…`) show under the field; the rest at the top.
  const fieldErrors = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of props.issues) {
      const f = /^nodes\.\d+\.config\.(.+)$/.exec(i.path);
      if (f?.[1] !== undefined) {
        const code = i.code.split(':')[0] ?? i.code;
        m.set(f[1], (w.issues as Record<string, string>)[code] ?? i.code);
      }
    }
    return m;
  }, [props.issues, w.issues]);
  const ctx: FieldContext = {
    readOnly,
    suggestions,
    preview: props.project === '' ? null : { project: props.project, sample },
    errors: fieldErrors,
  };
  const manyInput = makePortsOf(catalog)(node).some((p) => p.direction === 'in' && p.many === true);
  const retry = isObj(node.retry) ? node.retry : {};
  const setRetry = (k: string, v: unknown): void => {
    const next = withKey(retry, k, v);
    props.onPatch({ retry: Object.keys(next).length === 0 ? undefined : next });
  };
  const num = (v: string): number | undefined => {
    const n = Number(v);
    return v.trim() === '' || !Number.isFinite(n) ? undefined : n;
  };

  const runTest = (): void => {
    if (props.workflowId === null) return;
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    const wire = cleanDoc({ ...doc, nodes: [node], edges: [] }).nodes[0] as unknown as Record<
      string,
      unknown
    >;
    const { input, ...rest } = sample;
    testWorkflowNode(props.workflowId, node.id, { node: wire, input, sample: rest }).then(
      (r) => {
        setTestResult(r);
        setTesting(false);
      },
      (err: unknown) => {
        setTestError(sayError(toApiError(err)));
        setTesting(false);
      },
    );
  };

  return (
    <div className="grid gap-5" data-testid="typed-inspector" data-type={node.type}>
      <Issues issues={props.issues.filter((i) => !/^nodes\.\d+\.config\./.test(i.path))} />
      <div className="grid gap-1">
        <p className="m-0 text-[0.9375rem] font-bold">{label?.label ?? node.type}</p>
        {label === undefined ? null : (
          <p className="m-0 text-[0.8125rem] text-dy-muted">{label.description}</p>
        )}
        {info?.untrustedOutput === true ? (
          <p className="m-0 text-[0.78125rem] text-dy-amber-ink">{w.inspector.untrusted}</p>
        ) : null}
        {info === undefined ? null : <WorkerNote info={info} catalog={catalog} node={node} />}
      </div>
      <DyFieldset legend={w.inspector.identity}>
        <IdField doc={doc} id={node.id} readOnly={readOnly} onRename={props.onRename} />
        <DyInput
          label={w.inspector.label}
          value={typeof node.label === 'string' ? node.label : ''}
          readOnly={readOnly}
          maxLength={80}
          onChange={(e) => {
            props.onPatch({ label: e.target.value === '' ? undefined : e.target.value }, `label:${node.id}`);
          }}
        />
      </DyFieldset>
      <DyFieldset legend={w.inspector.config}>
        <CredentialPicker
          node={node}
          readOnly={readOnly}
          onConfig={(next) => {
            props.onPatch({ config: next }, `config:${node.id}`);
          }}
        />
        {info === undefined ? (
          <DyNotice tone="amber">{w.inspector.unknownType}</DyNotice>
        ) : (
          <SchemaForm
            schema={info.config}
            fields={info.fields}
            value={node.config}
            ctx={ctx}
            onChange={(next) => {
              props.onPatch({ config: next }, `config:${node.id}`);
            }}
          />
        )}
      </DyFieldset>
      <DyFieldset legend={w.inspector.policy} sub={w.inspector.policySub}>
        <DyChoice
          label={w.inspector.onError}
          value={typeof node.onError === 'string' ? node.onError : ''}
          disabled={readOnly}
          options={[
            ['', w.inspector.onErrorDefault],
            ['fail', w.inspector.onErrorFail],
            ['continue', w.inspector.onErrorContinue],
            ['skip', w.inspector.onErrorSkip],
          ]}
          onChange={(v) => {
            props.onPatch({ onError: v === '' ? undefined : v });
          }}
        />
        <div className="grid grid-cols-2 gap-2">
          <DyInput
            label={w.inspector.retryMax}
            type="number"
            min={0}
            max={10}
            value={typeof retry.max === 'number' ? String(retry.max) : ''}
            readOnly={readOnly}
            onChange={(e) => {
              setRetry('max', num(e.target.value));
            }}
          />
          <DyChoice
            label={w.inspector.backoff}
            value={typeof retry.backoff === 'string' ? retry.backoff : ''}
            disabled={readOnly}
            options={[
              ['', w.inspector.backoffDefault],
              ['fixed', w.inspector.backoffFixed],
              ['exponential', w.inspector.backoffExponential],
            ]}
            onChange={(v) => {
              setRetry('backoff', v === '' ? undefined : v);
            }}
          />
          <DyInput
            label={w.inspector.initialSec}
            type="number"
            min={0}
            value={typeof retry.initialSec === 'number' ? String(retry.initialSec) : ''}
            readOnly={readOnly}
            onChange={(e) => {
              setRetry('initialSec', num(e.target.value));
            }}
          />
          <DyInput
            label={w.inspector.maxSec}
            type="number"
            min={0}
            value={typeof retry.maxSec === 'number' ? String(retry.maxSec) : ''}
            readOnly={readOnly}
            onChange={(e) => {
              setRetry('maxSec', num(e.target.value));
            }}
          />
        </div>
        <DyInput
          label={w.inspector.timeoutSec}
          type="number"
          min={1}
          value={typeof node.timeoutSec === 'number' ? String(node.timeoutSec) : ''}
          readOnly={readOnly}
          onChange={(e) => {
            props.onPatch({ timeoutSec: num(e.target.value) });
          }}
        />
        {info?.placement === 'worker' ? (
          <QueueTimeoutField node={node} readOnly={readOnly} onPatch={props.onPatch} />
        ) : null}
        {manyInput ? (
          <DyChoice
            label={w.inspector.join}
            value={typeof node.join === 'string' ? node.join : isObj(node.join) ? 'atLeast' : ''}
            disabled={readOnly}
            options={[
              ['', w.inspector.joinAll],
              ['any', w.inspector.joinAny],
              ['first', w.inspector.joinFirst],
              ['atLeast', w.inspector.joinAtLeast],
            ]}
            onChange={(v) => {
              props.onPatch({ join: v === '' ? undefined : v === 'atLeast' ? { atLeast: 2 } : v });
            }}
          />
        ) : null}
      </DyFieldset>
      {info?.testable === true ? (
        <DyFieldset legend={w.test.title} sub={w.test.sub}>
          <DyTextarea
            label={w.test.sample}
            value={sampleText ?? JSON.stringify(baseSample, null, 2)}
            spellCheck={false}
            className="font-dy-mono text-[0.78125rem]"
            error={sampleBad ? w.form.badJson : null}
            data-testid="node-test-sample"
            onChange={(e) => {
              setSampleText(e.target.value);
              try {
                JSON.parse(e.target.value);
                setSampleBad(false);
              } catch {
                setSampleBad(true);
              }
            }}
          />
          <DyButton
            variant="primary"
            icon="send"
            busy={testing}
            disabled={props.workflowId === null || sampleBad}
            data-testid="node-test-run"
            onClick={runTest}
          >
            {w.test.run}
          </DyButton>
          {props.workflowId === null ? (
            <p className="m-0 text-[0.78125rem] text-dy-muted">{w.test.saveFirst}</p>
          ) : null}
          {testError === null ? null : (
            <p role="alert" className="m-0 text-[0.8125rem] text-dy-red-ink">
              {testError}
            </p>
          )}
          {testResult === null ? null : <TestResult result={testResult} />}
        </DyFieldset>
      ) : null}
      {readOnly ? null : (
        <DyButton variant="danger" icon="trash" onClick={props.onDelete}>
          {w.inspector.delete}
        </DyButton>
      )}
    </div>
  );
}

function TestResult(props: { readonly result: NodeTestResult }): ReactNode {
  const w = useT().workflows;
  const r = props.result;
  const errorWords = (code: string): string =>
    (w.expr.errors as Record<string, string>)[code.split(':')[0] ?? code] ??
    (w.issues as Record<string, string>)[code.split(':')[0] ?? code] ??
    code;
  return (
    <div
      data-testid="node-test-result"
      className="grid gap-1 rounded-[10px] border border-dy-line bg-dy-sunk p-2.5 text-[0.8125rem]"
    >
      {!r.ok ? (
        <p role="alert" className="m-0 text-dy-red-ink">
          {r.error.position === null
            ? errorWords(r.error.code)
            : w.expr.errorAt({ error: errorWords(r.error.code), position: r.error.position })}{' '}
          <span className="font-dy-mono opacity-70">{r.error.code}</span>
        </p>
      ) : r.outcome === 'value' ? (
        <>
          <p className="m-0 font-bold">{w.test.valueOn({ port: r.port, ms: r.durationMs })}</p>
          {Object.entries(r.ports).map(([port, v]) => (
            <div key={port}>
              <p className="m-0 font-dy-mono text-dy-muted">{port}</p>
              <pre className="m-0 max-h-48 overflow-auto font-dy-mono text-[0.78125rem] whitespace-pre-wrap [overflow-wrap:anywhere]">
                {previewText(v)}
              </pre>
            </div>
          ))}
        </>
      ) : r.outcome === 'wait' ? (
        <p className="m-0">{w.test.wait({ kind: r.wait.kind, due: r.wait.dueAt ?? '—' })}</p>
      ) : (
        <>
          <p className="m-0 font-bold">{w.test.outcome[r.outcome]}</p>
          <pre className="m-0 max-h-48 overflow-auto font-dy-mono text-[0.78125rem] whitespace-pre-wrap">
            {previewText(r.detail)}
          </pre>
        </>
      )}
    </div>
  );
}
