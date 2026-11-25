import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { resumeNodeRun } from '../../../api/workflowEngine';
import type { SideEffect, WorkflowNode } from '../../../api/workflows';
import { useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import type { Tone } from '../../tone';
import { DyApiError, DyTextarea } from '../kit';
import { DyButton, Pill } from '../parts';

/**
 * p14-workflow-engine 14.2 (docs/design/p14-workflow-engine.md §7.5): what a run's master integrations did — one line
 * per side effect of a node (kind, state, a link to the job / deploy record / chat / external page) — and the manual
 * resume of a webhook wait (testing / fallback; the data is untrusted). Values are workflow data: rendered as text,
 * external links open without referrer or opener.
 */

const EFFECT_TONE: Readonly<Record<string, Tone>> = {
  pending: 'neutral',
  requested: 'teal',
  succeeded: 'green',
  failed: 'red',
  refused: 'red',
  cancelled: 'neutral',
};

const str = (d: Readonly<Record<string, unknown>> | null, k: string): string | null => {
  const v = d?.[k];
  return typeof v === 'string' && v !== '' ? v : null;
};

/** Node types whose side effect is a function job on a worker (14.3). */
const FUNCTION_KINDS: ReadonlySet<string> = new Set(['http.request', 'email.send', 'code.js', 'code.python']);

/** An http(s) URL only (never `javascript:` or relative tricks). */
function externalUrl(v: string | null): string | null {
  if (v === null) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function EffectLink(props: { readonly effect: SideEffect }): ReactNode {
  const r = useT().workflows.run;
  const e = props.effect;
  const cls =
    'text-[0.8125rem] text-dy-teal-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline';
  // p14-workflow-engine 14.3: worker function nodes are jobs too (their external ref is the function job).
  const jobId =
    str(e.detail, 'jobId') ?? (e.kind === 'jobs.create' || FUNCTION_KINDS.has(e.kind) ? e.externalRef : null);
  if (jobId !== null)
    return (
      <Link to={`/jobs/${encodeURIComponent(jobId)}`} className={cls} data-testid="side-effect-job">
        {r.openJob}
      </Link>
    );
  const actionId =
    str(e.detail, 'actionId') ??
    (e.kind.startsWith('deploy') || e.kind === 'dns.change' ? e.externalRef : null);
  if (actionId !== null)
    return (
      <Link to={`/deploys/${encodeURIComponent(actionId)}`} className={cls} data-testid="side-effect-deploy">
        {r.openDeploy}
      </Link>
    );
  const threadId = str(e.detail, 'threadId');
  if (threadId !== null)
    return (
      <Link to={`/chat/${encodeURIComponent(threadId)}`} className={cls} data-testid="side-effect-chat">
        {r.openChat}
      </Link>
    );
  const url = externalUrl(str(e.detail, 'url'));
  if (url !== null)
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={cls}
        data-testid="side-effect-external"
      >
        {r.openExternal}
      </a>
    );
  return null;
}

export function NodeSideEffects(props: { readonly effects: readonly SideEffect[] }): ReactNode {
  const r = useT().workflows.run;
  if (props.effects.length === 0) return null;
  return (
    <div data-testid="workflow-node-side-effects">
      <p className="m-0 text-[0.78125rem] text-dy-muted">{r.sideEffects}</p>
      <ul className="m-0 mt-1 grid list-none gap-1.5 p-0">
        {props.effects.map((e) => (
          <li
            key={`${e.nodeRunId}:${e.kind}`}
            className="flex flex-wrap items-center gap-2 text-[0.84375rem]"
            data-testid="side-effect"
          >
            <span className="font-dy-mono">{e.kind}</span>
            <Pill tone={EFFECT_TONE[e.state] ?? 'neutral'}>
              {(r.sideEffectStates as Record<string, string | undefined>)[e.state] ?? e.state}
            </Pill>
            {e.scope === '' ? null : <span className="font-dy-mono text-dy-muted">{e.scope}</span>}
            <EffectLink effect={e} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The run header's words for what started it (engine 2), or null. */
export function TriggerFacts(props: {
  readonly triggerKind: string | null;
  readonly sourceTrust: 'trusted' | 'untrusted' | null;
}): ReactNode {
  const r = useT().workflows.run;
  if (props.triggerKind === null) return null;
  const kind = (r.triggerKinds as Record<string, string | undefined>)[props.triggerKind] ?? props.triggerKind;
  return (
    <>
      <span data-testid="workflow-run-trigger">
        <Pill tone="neutral" icon="send">
          {r.trigger({ kind })}
        </Pill>
      </span>
      {props.sourceTrust === 'untrusted' ? (
        <span data-testid="workflow-run-untrusted">
          <Pill tone="amber" icon="shield">
            {r.untrusted}
          </Pill>
        </span>
      ) : null}
    </>
  );
}

/** "Elle devam ettir" for a node waiting for a webhook (operator+): optional JSON data, untrusted. */
export function ResumeWait(props: {
  readonly runId: string;
  readonly node: WorkflowNode;
  readonly onChanged: () => void;
}): ReactNode {
  const r = useT().workflows.run;
  const act = useSubmit();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);
  const nodeRunId = props.node.nodeRunId;
  if (nodeRunId === undefined || props.node.nodeRunState !== 'waiting' || props.node.waitKind !== 'webhook')
    return null;
  if (!open)
    return (
      <div>
        <DyButton
          icon="retry"
          data-testid="workflow-resume"
          onClick={() => {
            setOpen(true);
          }}
        >
          {r.resume}
        </DyButton>
      </div>
    );
  const submit = (): void => {
    let data: unknown;
    if (text.trim() !== '') {
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        setBad(true);
        return;
      }
    }
    setBad(false);
    void act
      .run(async () => {
        await resumeNodeRun(props.runId, nodeRunId, data);
      })
      .then((ok) => {
        if (ok) {
          setOpen(false);
          props.onChanged();
        }
      });
  };
  return (
    <div className="grid gap-2 rounded-[12px] bg-dy-sunk p-3" role="group" data-testid="workflow-resume-form">
      <DyTextarea
        label={r.resumeData}
        value={text}
        spellCheck={false}
        className="font-dy-mono text-[0.78125rem]"
        error={bad ? r.badJson : null}
        onChange={(e) => {
          setText(e.target.value);
        }}
      />
      <p className="m-0 text-[0.78125rem] text-dy-muted">{r.resumeHint}</p>
      <div className="flex flex-wrap gap-2">
        <DyButton
          variant="primary"
          icon="check"
          busy={act.busy}
          disabled={act.blocked}
          data-testid="workflow-resume-confirm"
          onClick={submit}
        >
          {r.resumeConfirm}
        </DyButton>
        <DyButton
          variant="ghost"
          onClick={() => {
            setOpen(false);
          }}
        >
          {r.keep}
        </DyButton>
      </div>
      <DyApiError error={act.error} retryLeft={act.retryLeft} />
    </div>
  );
}
