import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { ApiIssue } from '../../../api/client';
import type { Project } from '../../../api/directory';
import { runtimeName } from '../../../lib/reasons';
import { RUNTIMES, SANDBOX_PROFILES, APPROVAL_POLICIES } from '../../../screens/composer/draft';
import { type ChoiceWords, choiceWords } from '../../compose/labels';
import { DyIcon } from '../../icons';
import { DyCheck, DyChoice, DyField, DyFieldset, DyInput, DyNotice, DyTextarea } from '../kit';
import { DyButton } from '../parts';
import type { Messages } from '@remyral/i18n';
import { useT } from '../../../i18n/I18nProvider';
import { RunSettingsFields } from './RunSettings';
import { MODEL_RUNTIMES, type ModelRuntime } from '../../../api/models';
import { DyModelPicker, useRuntimeModels } from '../shared/ModelPicker';
import {
  type Doc,
  type DocNode,
  INPUT_NAME,
  issueTextWith,
  renameRefusal,
  roleHint,
  roleName,
  ROLES,
  setUpstream,
  templateChoices,
  upstreamOf,
  upstreamRef,
  WORKFLOW_NAME,
  without,
} from './model';

/** p15-model-picker: the runtime whose models a step offers (unknown / unset: Claude Code, the workflow default). */
function pickerRuntime(r: string | undefined): ModelRuntime {
  return r !== undefined && (MODEL_RUNTIMES as readonly string[]).includes(r)
    ? (r as ModelRuntime)
    : 'claude-code';
}

/**
 * p13-workflows-ui (docs/design/p13-workflows-ui.md §3.3): the right-hand inspector — the selected step (identity,
 * role, prompt with `{{…}}` chips, upstream steps, runtime / model / sandbox / limits like the job composer, failure
 * policy, approval gate, planner and integrator settings, what it hands downstream) or, with nothing selected, the
 * workflow's own settings (project, name, description, inputs, defaults). Every change is one `Doc → Doc` edit.
 */

type Edit = (next: Doc, tag?: string) => void;

const INHERIT = '';

const num = (v: string): number | undefined => {
  if (v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export function Issues(props: { readonly issues: readonly ApiIssue[] }): ReactNode {
  const w = useT().workflows;
  if (props.issues.length === 0) return null;
  return (
    <DyNotice tone="red" testId="inspector-issues">
      <ul className="m-0 grid list-none gap-0.5 p-0">
        {props.issues.map((i) => (
          <li key={`${i.path}:${i.code}`}>{issueTextWith(w.issues, w.model)(i)}</li>
        ))}
      </ul>
    </DyNotice>
  );
}

/** Commits on blur / Enter (ids are referenced elsewhere: renaming on every keystroke would churn edges). */
export function IdField(props: {
  readonly doc: Doc;
  readonly id: string;
  readonly readOnly: boolean;
  readonly onRename: (to: string) => void;
}): ReactNode {
  const w = useT().workflows;
  const [v, setV] = useState(props.id);
  useEffect(() => {
    setV(props.id);
  }, [props.id]);
  const err = renameRefusal(props.doc, props.id, v, w.model);
  const commit = (): void => {
    if (err === null && v !== props.id) props.onRename(v);
    else setV(props.id);
  };
  return (
    <DyInput
      label={w.step.id}
      value={v}
      readOnly={props.readOnly}
      maxLength={48}
      spellCheck={false}
      autoComplete="off"
      className="font-dy-mono"
      hint={w.step.idHint}
      error={v !== props.id ? err : null}
      onChange={(e) => {
        setV(e.target.value.trim());
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
        if (e.key === 'Escape') setV(props.id);
      }}
    />
  );
}

function Limits(props: {
  readonly value: Record<string, unknown> | undefined;
  readonly fallbackDuration: number;
  readonly readOnly: boolean;
  readonly inheritHint: boolean;
  readonly onChange: (v: Record<string, unknown> | undefined) => void;
}): ReactNode {
  const t = useT().workflows.step;
  const v = props.value ?? {};
  const set = (k: string, raw: string): void => {
    const n = num(raw);
    const next: Record<string, unknown> = n === undefined ? without(v, k) : { ...v, [k]: n };
    const keys = Object.keys(next).filter((x) => x !== 'maxDurationSec');
    if (
      props.inheritHint &&
      keys.length === 0 &&
      (next.maxDurationSec === undefined || (k === 'maxDurationSec' && n === undefined))
    ) {
      props.onChange(undefined);
      return;
    }
    // The schema needs a duration whenever limits are set.
    if (next.maxDurationSec === undefined) next.maxDurationSec = props.fallbackDuration;
    props.onChange(next);
  };
  const field = (k: string, label: string, hint?: string): ReactNode => (
    <DyInput
      label={label}
      inputMode="numeric"
      value={typeof v[k] === 'number' ? String(v[k]) : ''}
      placeholder={props.inheritHint ? t.inherit : undefined}
      readOnly={props.readOnly}
      hint={hint}
      onChange={(e) => {
        set(k, e.target.value);
      }}
    />
  );
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {field('maxDurationSec', t.maxDuration)}
      {field('maxTokens', t.maxTokens)}
      {field('maxCostUsd', t.maxCost)}
      {field('maxTurns', t.maxTurns)}
    </div>
  );
}

function PromptField(props: {
  readonly doc: Doc;
  readonly node: DocNode;
  readonly readOnly: boolean;
  readonly hidden: boolean;
  readonly onChange: (v: string) => void;
}): ReactNode {
  const t = useT().workflows.step;
  const ref = useRef<HTMLTextAreaElement>(null);
  const choices = templateChoices(props.doc, props.node.id);
  const insert = (token: string): void => {
    const el = ref.current;
    const cur = props.node.prompt;
    const at = el === null ? cur.length : el.selectionStart;
    const end = el === null ? cur.length : el.selectionEnd;
    props.onChange(cur.slice(0, at) + token + cur.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + token.length, at + token.length);
    });
  };
  if (props.hidden) {
    return <DyNotice tone="neutral">{t.promptsHidden}</DyNotice>;
  }
  return (
    <div className="grid gap-1.5">
      <DyField label={t.prompt} hint={t.promptHint}>
        {(f) => (
          <textarea
            ref={ref}
            id={f.id}
            aria-describedby={f.describedBy}
            value={props.node.prompt}
            readOnly={props.readOnly}
            rows={7}
            maxLength={65536}
            data-testid="inspector-prompt"
            className="min-h-24 w-full min-w-0 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 py-2 font-dy-mono text-[0.8125rem] leading-normal text-dy-ink"
            onChange={(e) => {
              props.onChange(e.target.value);
            }}
          />
        )}
      </DyField>
      {props.readOnly || choices.length === 0 ? null : (
        <div className="flex flex-wrap gap-1" aria-label={t.insertTemplate} role="group">
          {choices.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => {
                insert(c);
              }}
              className="dy-press rounded-full border border-dy-line bg-dy-sunk px-2 py-0.5 font-dy-mono text-[0.75rem] text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-teal [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
            >
              {c}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type StepText = Messages['workflows']['step'];

function inheritLabel(t: StepText, value: string | undefined): string {
  return value === undefined ? t.defaultOption : t.defaultOptionOf({ value });
}

function runtimeOptions(t: StepText, def: string | undefined): (readonly [string, string])[] {
  return [
    [INHERIT, inheritLabel(t, def === undefined ? undefined : runtimeName(def))],
    ...RUNTIMES.map((r) => [r, runtimeName(r)] as const),
  ];
}

function sandboxOptions(
  t: StepText,
  words: ChoiceWords,
  def: string | undefined,
): (readonly [string, string])[] {
  return [
    [INHERIT, inheritLabel(t, def === undefined ? undefined : (words.sandbox[def]?.label ?? def))],
    ...SANDBOX_PROFILES.map((p) => [p, words.sandbox[p]?.label ?? p] as const),
  ];
}

// ------------------------------------------------------------------------------------------------ node

export function NodeInspector(props: {
  readonly doc: Doc;
  readonly node: DocNode;
  readonly issues: readonly ApiIssue[];
  readonly readOnly: boolean;
  readonly promptsHidden: boolean;
  readonly onEdit: Edit;
  readonly onRename: (to: string) => void;
  readonly onPatch: (patch: Readonly<Record<string, unknown>>, tag?: string) => void;
  readonly onDelete: () => void;
}): ReactNode {
  const { doc, node, readOnly } = props;
  const all = useT();
  const w = all.workflows;
  const t = w.step;
  const words = choiceWords(all);
  const [refusal, setRefusal] = useState<string | null>(null);
  const catalog = useRuntimeModels();
  const ups = new Set(upstreamOf(doc, node.id));
  const others = doc.nodes.filter((n) => n.id !== node.id);
  const defaults = doc.defaults;
  const approval = node.approval as { approverRole?: string } | undefined;
  const dynamic = node.dynamic as { maxNodes?: number } | undefined;
  const deploy = node.deploy as { kind?: string; env?: string } | undefined;
  const policy = typeof node.failurePolicy === 'string' ? node.failurePolicy : 'fail-fast';
  return (
    <div className="grid gap-5" data-testid="node-inspector">
      <Issues issues={props.issues} />
      <DyFieldset legend={t.legend}>
        <IdField doc={doc} id={node.id} readOnly={readOnly} onRename={props.onRename} />
        <DyChoice
          label={t.role}
          value={node.role}
          disabled={readOnly}
          options={ROLES.map((r) => [r, roleName(w.model, r)] as const)}
          hint={roleHint(w.model, node.role)}
          onChange={(v) => {
            props.onPatch({ role: v, ...(v === 'planner' ? {} : { dynamic: undefined }) });
          }}
        />
        <PromptField
          doc={doc}
          node={node}
          readOnly={readOnly}
          hidden={props.promptsHidden}
          onChange={(v) => {
            props.onPatch({ prompt: v }, `prompt:${node.id}`);
          }}
        />
      </DyFieldset>

      <DyFieldset legend={t.upstream} sub={t.upstreamSub}>
        {others.length === 0 ? (
          <p className="m-0 text-[0.84375rem] text-dy-muted">{t.noOthers}</p>
        ) : (
          <div className="grid gap-1.5" data-testid="inspector-upstream">
            {others.map((o) => (
              <DyCheck
                key={o.id}
                label={<span className="font-dy-mono">{o.id}</span>}
                checked={ups.has(o.id)}
                disabled={readOnly}
                onChange={(on) => {
                  const next = on ? [...ups, o.id] : [...ups].filter((u) => u !== o.id);
                  const r = setUpstream(doc, node.id, next);
                  if (typeof r === 'string')
                    setRefusal((w.refusals as Readonly<Record<string, string | undefined>>)[r] ?? r);
                  else {
                    setRefusal(null);
                    props.onEdit(r);
                  }
                }}
              />
            ))}
          </div>
        )}
        {refusal === null ? null : (
          <p role="alert" className="m-0 text-[0.8125rem] font-medium text-dy-red-ink">
            {refusal}
          </p>
        )}
      </DyFieldset>

      <DyFieldset legend={t.run} sub={t.runSub}>
        <DyChoice
          label={t.runtime}
          value={typeof node.runtime === 'string' ? node.runtime : INHERIT}
          disabled={readOnly}
          options={runtimeOptions(t, typeof defaults.runtime === 'string' ? defaults.runtime : undefined)}
          onChange={(v) => {
            props.onPatch({ runtime: v === INHERIT ? undefined : v });
          }}
        />
        {/* p15-model-picker: the step's model from the list of its runtime (empty = the workflow default). */}
        <DyModelPicker
          label={t.model}
          runtimes={[
            pickerRuntime(
              typeof node.runtime === 'string'
                ? node.runtime
                : typeof defaults.runtime === 'string'
                  ? defaults.runtime
                  : undefined,
            ),
          ]}
          value={typeof node.model === 'string' ? node.model : ''}
          valueKind="model"
          disabled={readOnly}
          catalog={catalog}
          defaultLabel={t.inherit}
          testId="step-model-picker"
          onChange={(v) => {
            props.onPatch({ model: v === '' ? undefined : v }, `model:${node.id}`);
          }}
        />
        <DyChoice
          label={t.sandbox}
          value={typeof node.sandboxProfile === 'string' ? node.sandboxProfile : INHERIT}
          disabled={readOnly}
          options={sandboxOptions(
            t,
            words,
            typeof defaults.sandboxProfile === 'string' ? defaults.sandboxProfile : undefined,
          )}
          hint={
            typeof node.sandboxProfile === 'string' ? words.sandbox[node.sandboxProfile]?.text : undefined
          }
          onChange={(v) => {
            props.onPatch({ sandboxProfile: v === INHERIT ? undefined : v });
          }}
        />
        <Limits
          value={node.limits as Record<string, unknown> | undefined}
          fallbackDuration={
            typeof (defaults.limits as { maxDurationSec?: unknown } | undefined)?.maxDurationSec === 'number'
              ? (defaults.limits as { maxDurationSec: number }).maxDurationSec
              : 1800
          }
          readOnly={readOnly}
          inheritHint
          onChange={(v) => {
            props.onPatch({ limits: v }, `limits:${node.id}`);
          }}
        />
      </DyFieldset>

      <DyFieldset legend={t.onError}>
        <DyChoice
          label={t.failurePolicy}
          value={policy}
          disabled={readOnly}
          options={[
            ['fail-fast', t.failFast],
            ['continue', t.continue],
            ['retry-safe', t.retrySafe],
          ]}
          hint={policy === 'retry-safe' ? t.retrySafeHint : undefined}
          onChange={(v) => {
            props.onPatch({
              failurePolicy: v === 'fail-fast' ? undefined : v,
              maxRetries:
                v === 'retry-safe' ? (typeof node.maxRetries === 'number' ? node.maxRetries : 1) : undefined,
            });
          }}
        />
        {policy === 'retry-safe' ? (
          <DyChoice
            label={t.maxRetries}
            value={String(typeof node.maxRetries === 'number' ? node.maxRetries : 1)}
            disabled={readOnly}
            options={[
              ['1', '1'],
              ['2', '2'],
              ['3', '3'],
            ]}
            onChange={(v) => {
              props.onPatch({ maxRetries: Number(v) });
            }}
          />
        ) : null}
      </DyFieldset>

      <DyFieldset legend={t.gate} sub={t.gateSub}>
        <DyCheck
          label={t.gateAsk}
          checked={approval !== undefined}
          disabled={readOnly}
          onChange={(on) => {
            props.onPatch({ approval: on ? { approverRole: 'admin' } : undefined });
          }}
        />
        {approval === undefined ? null : (
          <DyChoice
            label={t.approver}
            value={approval.approverRole ?? 'admin'}
            disabled={readOnly}
            options={[
              ['operator', t.approverOperator],
              ['admin', t.approverAdmin],
              ['owner', t.approverOwner],
            ]}
            onChange={(v) => {
              props.onPatch({ approval: { approverRole: v } });
            }}
          />
        )}
      </DyFieldset>

      {node.role === 'planner' ? (
        <DyFieldset legend={w.model.roles.planner} sub={t.plannerSub}>
          <DyCheck
            label={t.dynamic}
            checked={dynamic !== undefined}
            disabled={readOnly}
            onChange={(on) => {
              props.onPatch({ dynamic: on ? { maxNodes: 5 } : undefined });
            }}
          />
          {dynamic === undefined ? null : (
            <DyInput
              label={t.maxNew}
              inputMode="numeric"
              value={String(dynamic.maxNodes ?? 5)}
              readOnly={readOnly}
              onChange={(e) => {
                const n = num(e.target.value);
                if (n !== undefined)
                  props.onPatch({ dynamic: { maxNodes: Math.max(1, Math.min(10, Math.round(n))) } });
              }}
            />
          )}
        </DyFieldset>
      ) : null}

      {node.role === 'integrator' || node.role === 'verifier' ? (
        <DyFieldset
          legend={node.role === 'integrator' ? w.model.roles.integrator : w.model.roles.verifier}
          sub={node.role === 'integrator' ? t.integratorSub : t.verifierSub}
        >
          <DyChoice
            label={t.deployAfter}
            value={deploy?.kind ?? ''}
            disabled={readOnly}
            options={[
              ['', t.deployNone],
              ['coolify.deploy', t.deployCoolify],
              ['coolify.restart', t.deployRestart],
              ['pages.deploy', t.deployPages],
            ]}
            onChange={(v) => {
              props.onPatch({
                deploy:
                  v === ''
                    ? undefined
                    : { kind: v, ...(v === 'pages.deploy' ? {} : { env: deploy?.env ?? 'preview' }) },
              });
            }}
          />
          {deploy?.kind !== undefined && deploy.kind !== 'pages.deploy' ? (
            <DyChoice
              label={t.env}
              value={deploy.env ?? 'preview'}
              disabled={readOnly}
              options={[
                ['preview', t.envPreview],
                ['production', t.envProduction],
              ]}
              onChange={(v) => {
                props.onPatch({ deploy: { ...deploy, env: v } });
              }}
            />
          ) : null}
        </DyFieldset>
      ) : null}

      <DyFieldset legend={t.outputs}>
        <p className="m-0 text-[0.84375rem] text-dy-muted">
          {t.outputsBefore}{' '}
          <code className="font-dy-mono text-[0.78125rem]">{upstreamRef(node.id, 'summary')}</code>{' '}
          {t.outputsAnd}{' '}
          <code className="font-dy-mono text-[0.78125rem]">{upstreamRef(node.id, 'branch')}</code>{' '}
          {t.outputsAfter}
        </p>
      </DyFieldset>

      {readOnly ? null : (
        <DyButton variant="danger" icon="trash" onClick={props.onDelete} data-testid="inspector-delete">
          {t.delete}
        </DyButton>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ workflow

export function WorkflowSettings(props: {
  readonly doc: Doc;
  readonly isNew: boolean;
  readonly project: string;
  readonly projects: readonly Project[];
  readonly issues: readonly ApiIssue[];
  readonly readOnly: boolean;
  readonly onProject: (p: string) => void;
  readonly onEdit: Edit;
  /** p14 14.4: the new engine runs this workflow — its run settings are editable. */
  readonly v2?: boolean | undefined;
}): ReactNode {
  const { doc, readOnly } = props;
  const all = useT();
  const w = all.workflows;
  const t = w.step;
  const words = choiceWords(all);
  const ws = w.workflowSettings;
  const d = doc.defaults;
  const setDefault = (k: string, v: unknown, tag?: string): void => {
    const next = v === undefined ? without(d, k) : { ...d, [k]: v };
    props.onEdit({ ...doc, defaults: next }, tag);
  };
  const [newInput, setNewInput] = useState('');
  const catalog = useRuntimeModels(props.project === '' ? undefined : props.project);
  const repo = d.repository as { url?: string; baseRef?: string } | undefined;
  const inputErr = newInput !== '' && (!INPUT_NAME.test(newInput) || newInput in doc.inputs);
  return (
    <div className="grid gap-5" data-testid="workflow-settings">
      <Issues issues={props.issues} />
      <DyFieldset legend={w.editor.workflow}>
        {props.isNew ? (
          <DyChoice
            label={w.list.project}
            value={props.project}
            options={[
              ['', ws.pickProject],
              ...props.projects.map((p) => [p.id, p.name === p.id ? p.id : `${p.name} (${p.id})`] as const),
            ]}
            onChange={props.onProject}
          />
        ) : null}
        <DyInput
          label={ws.name}
          value={doc.name}
          readOnly={readOnly || !props.isNew}
          maxLength={64}
          spellCheck={false}
          autoComplete="off"
          className="font-dy-mono"
          hint={props.isNew ? ws.nameHint : undefined}
          error={doc.name !== '' && !WORKFLOW_NAME.test(doc.name) ? w.model.workflowNameInvalid : null}
          onChange={(e) => {
            props.onEdit({ ...doc, name: e.target.value.trim() }, 'name');
          }}
        />
        <DyTextarea
          label={ws.description}
          value={doc.description ?? ''}
          readOnly={readOnly}
          rows={2}
          maxLength={1000}
          className="min-h-16"
          onChange={(e) => {
            props.onEdit({ ...doc, description: e.target.value }, 'description');
          }}
        />
      </DyFieldset>

      <DyFieldset legend={ws.inputs} sub={ws.inputsSub}>
        {Object.keys(doc.inputs).length === 0 ? (
          <p className="m-0 text-[0.84375rem] text-dy-muted">{ws.noInputs}</p>
        ) : (
          <ul className="m-0 grid list-none gap-2 p-0" data-testid="workflow-inputs">
            {Object.entries(doc.inputs).map(([name, spec]) => (
              <li key={name} className="grid gap-1.5 rounded-[10px] border border-dy-line p-2.5">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-dy-mono text-[0.84375rem] font-bold">
                    {name}
                  </span>
                  {readOnly ? null : (
                    <DyButton
                      variant="ghost"
                      icon="trash"
                      aria-label={ws.removeInput({ name })}
                      onClick={() => {
                        props.onEdit({ ...doc, inputs: without(doc.inputs, name) });
                      }}
                    />
                  )}
                </div>
                <DyCheck
                  label={ws.required}
                  checked={spec.required === true}
                  disabled={readOnly}
                  onChange={(on) => {
                    props.onEdit({ ...doc, inputs: { ...doc.inputs, [name]: { ...spec, required: on } } });
                  }}
                />
                <DyInput
                  label={ws.description}
                  value={spec.description ?? ''}
                  readOnly={readOnly}
                  maxLength={500}
                  onChange={(e) => {
                    const v = e.target.value;
                    const next = { ...spec };
                    if (v === '') delete next.description;
                    else next.description = v;
                    props.onEdit({ ...doc, inputs: { ...doc.inputs, [name]: next } }, `input:${name}`);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        {readOnly ? null : (
          <div className="flex items-end gap-2">
            <DyInput
              label={ws.newInput}
              value={newInput}
              maxLength={32}
              spellCheck={false}
              autoComplete="off"
              wrapClassName="flex-1"
              className="font-dy-mono"
              error={inputErr ? ws.badInput : null}
              onChange={(e) => {
                setNewInput(e.target.value.trim());
              }}
            />
            <DyButton
              icon="plus"
              disabled={newInput === '' || inputErr}
              onClick={() => {
                props.onEdit({ ...doc, inputs: { ...doc.inputs, [newInput]: { required: false } } });
                setNewInput('');
              }}
            >
              {ws.add}
            </DyButton>
          </div>
        )}
      </DyFieldset>

      <DyFieldset legend={ws.defaults} sub={ws.defaultsSub}>
        <DyChoice
          label={t.runtime}
          value={typeof d.runtime === 'string' ? d.runtime : 'claude-code'}
          disabled={readOnly}
          options={RUNTIMES.map((r) => [r, runtimeName(r)] as const)}
          onChange={(v) => {
            setDefault('runtime', v);
          }}
        />
        <DyModelPicker
          label={t.model}
          runtimes={[pickerRuntime(typeof d.runtime === 'string' ? d.runtime : undefined)]}
          value={typeof d.model === 'string' ? d.model : ''}
          valueKind="model"
          disabled={readOnly}
          catalog={catalog}
          defaultLabel={ws.modelDefault}
          testId="workflow-model-picker"
          onChange={(v) => {
            setDefault('model', v === '' ? undefined : v, 'd:model');
          }}
        />
        <DyChoice
          label={t.sandbox}
          value={typeof d.sandboxProfile === 'string' ? d.sandboxProfile : 'container'}
          disabled={readOnly}
          options={SANDBOX_PROFILES.map((p) => [p, words.sandbox[p]?.label ?? p] as const)}
          hint={typeof d.sandboxProfile === 'string' ? words.sandbox[d.sandboxProfile]?.text : undefined}
          onChange={(v) => {
            setDefault('sandboxProfile', v);
          }}
        />
        <DyChoice
          label={ws.approvalPolicy}
          value={typeof d.approvalPolicy === 'string' ? d.approvalPolicy : 'ask-sensitive'}
          disabled={readOnly}
          options={APPROVAL_POLICIES.map((p) => [p, words.approval[p]?.label ?? p] as const)}
          hint={typeof d.approvalPolicy === 'string' ? words.approval[d.approvalPolicy]?.text : undefined}
          onChange={(v) => {
            setDefault('approvalPolicy', v);
          }}
        />
        <DyChoice
          label={ws.source}
          value={d.sourceTrust === 'trusted' ? 'trusted' : 'untrusted'}
          disabled={readOnly}
          options={[
            ['untrusted', ws.untrusted],
            ['trusted', ws.trusted],
          ]}
          onChange={(v) => {
            setDefault('sourceTrust', v);
          }}
        />
        <Limits
          value={d.limits as Record<string, unknown> | undefined}
          fallbackDuration={1800}
          readOnly={readOnly}
          inheritHint={false}
          onChange={(v) => {
            setDefault('limits', v ?? { maxDurationSec: 1800 }, 'd:limits');
          }}
        />
        <DyInput
          label={ws.repo}
          value={repo?.url ?? ''}
          readOnly={readOnly}
          maxLength={2048}
          spellCheck={false}
          placeholder={ws.repoPlaceholder}
          onChange={(e) => {
            const url = e.target.value.trim();
            setDefault(
              'repository',
              url === '' ? undefined : { url, baseRef: repo?.baseRef ?? 'main' },
              'd:repo',
            );
          }}
        />
        {repo === undefined ? null : (
          <DyInput
            label={ws.baseRef}
            value={repo.baseRef ?? 'main'}
            readOnly={readOnly}
            maxLength={255}
            spellCheck={false}
            onChange={(e) => {
              setDefault('repository', { ...repo, baseRef: e.target.value.trim() }, 'd:ref');
            }}
          />
        )}
      </DyFieldset>
      {props.v2 === true ? (
        <RunSettingsFields doc={doc} project={props.project} readOnly={readOnly} onEdit={props.onEdit} />
      ) : null}
      <p className="m-0 flex items-center gap-1.5 text-[0.78125rem] text-dy-muted">
        <DyIcon name="shield" className="size-3.5" />
        {ws.noSecrets}
      </p>
    </div>
  );
}

export function EdgeInspector(props: {
  readonly from: string;
  readonly to: string;
  readonly issues: readonly ApiIssue[];
  readonly readOnly: boolean;
  readonly onDelete: () => void;
}): ReactNode {
  const e = useT().workflows.edgeInspector;
  return (
    <div className="grid gap-4" data-testid="edge-inspector">
      <Issues issues={props.issues} />
      <p className="m-0 text-[0.9375rem]">
        <span className="font-dy-mono font-bold">{props.from}</span> {e.finishes}{' '}
        <span className="font-dy-mono font-bold">{props.to}</span> {e.starts}
      </p>
      {props.readOnly ? null : (
        <DyButton variant="danger" icon="trash" onClick={props.onDelete}>
          {e.delete}
        </DyButton>
      )}
    </div>
  );
}
