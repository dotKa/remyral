import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { ApiError } from '../../../api/client';
import type { Project } from '../../../api/directory';
import {
  continueMcpInstall,
  discardMcpPreview,
  getMcpPreviewProgress,
  MCP_ALL_PROJECTS,
  type McpFinding,
  type McpPreview,
  type McpPreviewProgress,
  type McpProposalFacts,
  type McpPublishResult,
  type McpWarning,
  publishMcpPreview,
  saveMcpToolPolicy,
} from '../../../api/mcp';
import { toApiError } from '../../../components/ui';
import { useT } from '../../../i18n/I18nProvider';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { KeyValue } from '../../KeyValue';
import type { Tone } from '../../tone';
import { DyApiError, DyCheck, DyNotice } from '../forms';
import { DyButton, DySelect, Pill, SkeletonRows } from '../parts';
import { useDoneToast } from '../../toast/useDoneToast';

/**
 * p14-mcp-chat (ADR-0054 P5, docs/design/p14-mcp-skills.md §4.3, §15): the pieces Yetenekler → Keşfet and the chat
 * `mcp_install` card share — the proposal the master resolved (every value from a registry is untrusted text and
 * renders as text), the confirmation with a fresh authenticator code, and the install progress (publish → canary →
 * the other machines after another fresh code → tool discovery, with read-only suggestions the person applies).
 */

type Messages = ReturnType<typeof useT>;
type InstallT = Messages['mcp']['install'];

const WARNING_CODES = [
  'typosquat',
  'scope_mismatch',
  'new_package',
  'low_downloads',
  'deprecated',
  'no_repository',
] as const;
const FINDING_CODES = [
  'header_dropped',
  'env_dropped',
  'env_needs_value',
  'arguments_required',
  'bin_guessed',
  'bin_chosen',
  'format_dropped',
  'sse_runtimes',
  'no_egress_hosts',
  'egress_suggested',
  'windows_egress',
  'stdio_package_chosen',
] as const;

export function mcpWarningText(t: InstallT, w: McpWarning): string {
  const code = WARNING_CODES.find((c) => c === w.code);
  if (code === undefined) return t.warning.other({ code: w.code });
  return t.warning[code]({
    similar: w.similarTo ?? '',
    days: w.days ?? 0,
    weekly: w.weekly ?? 0,
    status: w.status ?? '',
  });
}

export function mcpWarningTone(w: McpWarning): Tone {
  return w.code === 'typosquat' || w.code === 'scope_mismatch' ? 'red' : 'amber';
}

export function mcpFindingText(t: InstallT, f: McpFinding): string {
  const code = FINDING_CODES.find((c) => c === f.code);
  if (code === undefined) return t.finding.other({ name: f.code });
  return t.finding[code]({ name: f.name ?? f.detail ?? '' });
}

export function McpWarningPills(props: { readonly warnings: readonly McpWarning[] }): ReactNode {
  const t = useT().mcp.install;
  if (props.warnings.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1.5">
      {props.warnings.map((w) => (
        <span key={w.code} data-testid={`mcp-warning-${w.code}`} className="max-w-full">
          <Pill tone={mcpWarningTone(w)} icon="shield" className="whitespace-normal">
            {mcpWarningText(t, w)}
          </Pill>
        </span>
      ))}
    </span>
  );
}

function valueLine(v: string | { readonly secret: string; readonly format?: string }): string {
  return typeof v === 'string' ? v : v.secret;
}

/** The facts a confirmation signs: source, pin, integrity, hosts, token slots, warnings, findings, machines. */
export function McpProposalView(props: { readonly facts: McpProposalFacts }): ReactNode {
  const t = useT().mcp.install;
  const transportT = useT().mcp.transport;
  const p = t.proposal;
  const f = props.facts;
  const server = f.reuse
    ? p.serverReuse({ id: f.serverId, version: f.version })
    : f.latest === null
      ? p.serverNew({ id: f.serverId, version: f.version })
      : p.serverNext({ id: f.serverId, version: f.version, latest: f.latest });
  const suggested = new Set(f.egressSuggested);
  const rows = [
    { k: p.server, v: server, mono: true },
    { k: p.source, v: p.sourceLine({ kind: f.sourceKind, ref: f.ref }), mono: true },
    ...(f.pinnedVersion === null ? [] : [{ k: p.pinned, v: f.pinnedVersion, mono: true }]),
    ...(f.package === null
      ? []
      : [
          { k: p.package, v: `${f.package.manager}:${f.package.name}@${f.package.version}`, mono: true },
          { k: p.integrity, v: f.package.integrity, mono: true },
          { k: p.bin, v: f.package.bin, mono: true },
        ]),
    { k: p.transport, v: transportT[f.transport] },
    ...(f.url === null ? [] : [{ k: p.url, v: f.url, mono: true }]),
    { k: p.runtimes, v: f.runtimes.join(', '), mono: true },
    { k: p.license, v: f.license ?? p.noLicense },
    {
      k: p.hosts,
      v:
        f.egressHosts.length === 0 ? (
          p.hostsNone
        ) : (
          <span className="flex flex-wrap gap-1.5">
            {f.egressHosts.map((h) => (
              <span key={h} className="inline-flex items-center gap-1.5 font-dy-mono">
                {h}
                {suggested.has(h) ? <Pill tone="amber">{p.suggested}</Pill> : null}
              </span>
            ))}
          </span>
        ),
    },
  ];
  const envSecrets = f.package === null ? [] : Object.entries(f.package.env);
  return (
    <div className="grid gap-3" data-testid="mcp-proposal">
      {f.description === '' ? null : (
        <p
          className="m-0 text-[0.875rem] text-dy-muted [overflow-wrap:anywhere]"
          data-testid="mcp-proposal-desc"
        >
          {f.description}
        </p>
      )}
      <McpWarningPills warnings={f.warnings} />
      <KeyValue rows={rows} />
      <div className="grid gap-1" data-testid="mcp-proposal-secrets">
        <span className="text-[0.8125rem] font-bold">{p.secrets}</span>
        {f.secrets.length === 0 ? (
          <span className="text-[0.8125rem] text-dy-muted">{p.secretsNone}</span>
        ) : (
          <ul className="m-0 list-disc pl-5 text-[0.8125rem]">
            {f.secrets.map((s) => (
              <li key={s.slot} className="[overflow-wrap:anywhere]">
                {p.secretLine({ slot: s.slot, why: s.why })}
              </li>
            ))}
          </ul>
        )}
        {f.secrets.length === 0 ? null : (
          <span className="text-[0.78125rem] text-dy-muted">{p.secretsNote}</span>
        )}
        {envSecrets.length === 0 && Object.keys(f.headers).length === 0 ? null : (
          <span className="font-dy-mono text-[0.78125rem] text-dy-muted [overflow-wrap:anywhere]">
            {[...envSecrets, ...Object.entries(f.headers)]
              .map(([k, v]) => `${k}=${valueLine(v)}`)
              .join(' · ')}
          </span>
        )}
      </div>
      {f.findings.length === 0 ? null : (
        <div className="grid gap-1" data-testid="mcp-proposal-findings">
          <span className="text-[0.8125rem] font-bold">{p.findings}</span>
          <ul className="m-0 list-disc pl-5 text-[0.8125rem]">
            {f.findings.map((x, i) => (
              // Findings may repeat a code: the index is part of the identity.
              <li key={`${x.code}-${String(i)}`} className="[overflow-wrap:anywhere]">
                {mcpFindingText(t, x)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <DyNotice tone="teal" testId="mcp-proposal-policy">
        {p.policy}
      </DyNotice>
      <div className="grid gap-1" data-testid="mcp-proposal-machines">
        <span className="text-[0.8125rem] font-bold">{p.machines}</span>
        {!f.install.needed ? (
          <span className="text-[0.8125rem] text-dy-muted">{p.machinesRemote}</span>
        ) : f.install.machines.length === 0 ? (
          <span className="text-[0.8125rem] text-dy-amber-ink">{p.machinesNone}</span>
        ) : (
          <span className="flex flex-wrap gap-1.5">
            {[...f.install.machines]
              .sort((a, b) => Number(b.canary) - Number(a.canary))
              .map((m) => (
                <span key={m.id} className="inline-flex items-center gap-1 text-[0.8125rem]">
                  {m.name}
                  {m.canary ? <Pill tone="teal">{p.canary}</Pill> : null}
                  {m.connected ? null : <Pill tone="neutral">{p.offline}</Pill>}
                </span>
              ))}
          </span>
        )}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------------------------- progress

type StepState = 'done' | 'waiting' | 'running' | 'failed' | 'held' | 'skipped' | 'none';

const STEP_TONE: Readonly<Record<StepState, Tone>> = {
  done: 'green',
  waiting: 'neutral',
  running: 'teal',
  failed: 'red',
  held: 'amber',
  skipped: 'amber',
  none: 'neutral',
};

function targetsState(targets: readonly { readonly state: string }[]): StepState {
  if (targets.length === 0) return 'none';
  if (targets.every((x) => x.state === 'succeeded' || x.state === 'skipped')) return 'done';
  if (targets.some((x) => x.state === 'failed' || x.state === 'expired')) return 'failed';
  if (targets.some((x) => x.state === 'held')) return 'held';
  return 'running';
}

interface Steps {
  readonly publish: StepState;
  readonly canary: StepState;
  readonly rest: StepState;
  readonly probe: StepState;
}

function stepsOf(p: McpPreviewProgress, installError: string | null): Steps {
  const published = p.preview.published;
  const stdio = p.preview.facts.transport === 'stdio';
  const targets = p.action?.targets ?? [];
  const canary = !stdio
    ? 'none'
    : installError !== null
      ? 'failed'
      : p.action === null
        ? 'waiting'
        : targetsState(targets.filter((x) => x.phase === 1));
  const rest = !stdio || p.action === null ? 'none' : targetsState(targets.filter((x) => x.phase === 2));
  const lastProbe = p.probes[0];
  const probe: StepState =
    p.tools.length > 0
      ? 'done'
      : published?.probeSkipped != null
        ? 'skipped'
        : lastProbe?.state === 'failed'
          ? 'failed'
          : lastProbe !== undefined || published?.probeOpId != null
            ? 'running'
            : 'waiting';
  return { publish: published === null ? 'waiting' : 'done', canary, rest, probe };
}

/** Polling stops once nothing is moving on its own (held steps wait for a person). */
function settled(s: Steps): boolean {
  const moving = (x: StepState): boolean => x === 'running' || x === 'waiting';
  return !moving(s.publish) && !moving(s.canary) && !moving(s.rest) && !moving(s.probe);
}

async function guarded(
  stepUp: ReturnType<typeof useStepUp>,
  fn: () => Promise<void>,
  reason: string,
  setError: (e: ApiError | null) => void,
): Promise<boolean> {
  setError(null);
  try {
    await stepUp.run(fn, reason);
    return true;
  } catch (err) {
    if (!(err instanceof StepUpCancelledError)) setError(toApiError(err));
    return false;
  }
}

export const MCP_PROGRESS_POLL_MS = 4000;

export function McpInstallProgress(props: {
  readonly previewId: string;
  readonly admin: boolean;
  readonly installError?: string | null | undefined;
  readonly assignError?: string | null | undefined;
  readonly pollMs?: number | undefined;
}): ReactNode {
  const all = useT();
  const t = all.mcp.install.progress;
  const stepUp = useStepUp();
  const [data, setData] = useState<McpPreviewProgress | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<'continue' | 'policy' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useDoneToast(notice);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const installError = props.installError ?? null;
  const pollMs = props.pollMs ?? MCP_PROGRESS_POLL_MS;

  const load = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    getMcpPreviewProgress(props.previewId).then(
      (d) => {
        setData(d);
        if (!settled(stepsOf(d, installError))) {
          timer.current = setTimeout(load, pollMs);
        }
      },
      (err: unknown) => {
        setError(toApiError(err));
      },
    );
  }, [props.previewId, installError, pollMs]);

  useEffect(() => {
    load();
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [load]);

  if (data === null) {
    return (
      <div data-testid="mcp-progress">
        <DyApiError error={error} />
        {error === null ? <SkeletonRows label={t.loading} rows={2} /> : null}
      </div>
    );
  }
  const steps = stepsOf(data, installError);
  const published = data.preview.published;
  const serverId = published?.serverId ?? data.preview.facts.serverId;
  const suggested = data.tools.filter((x) => x.suggestedAllow);
  const canApply = props.admin && suggested.some((x) => x.effect !== 'allow');

  async function continueRest(actionId: string): Promise<void> {
    setBusy('continue');
    const ok = await guarded(
      stepUp,
      async () => {
        await continueMcpInstall(actionId);
      },
      t.stepUpContinue,
      setError,
    );
    setBusy(null);
    if (ok) {
      setNotice(t.continued);
      load();
    }
  }

  async function allowSuggested(): Promise<void> {
    if (data === null) return;
    setBusy('policy');
    const rules = data.tools.map((x) => ({
      tool: x.name,
      effect: x.suggestedAllow
        ? ('allow' as const)
        : x.effect === 'deny'
          ? ('deny' as const)
          : ('ask' as const),
    }));
    const ok = await guarded(
      stepUp,
      async () => {
        await saveMcpToolPolicy(serverId, MCP_ALL_PROJECTS, rules);
      },
      t.stepUpPolicy,
      setError,
    );
    setBusy(null);
    if (ok) {
      setNotice(t.policySaved);
      load();
    }
  }

  const stepRow = (key: keyof Steps, label: string, extra?: ReactNode): ReactNode => (
    <li key={key} className="flex flex-col gap-1 border-t border-dy-line py-2 first:border-t-0">
      <span className="flex flex-wrap items-center gap-2 text-[0.875rem]" data-testid={`mcp-step-${key}`}>
        <span className="font-bold">{label}</span>
        <Pill tone={STEP_TONE[steps[key]]}>{t.state[steps[key]]}</Pill>
      </span>
      {extra}
    </li>
  );
  const targets = (phase: 1 | 2): ReactNode => {
    const list = (data.action?.targets ?? []).filter((x) => x.phase === phase);
    if (list.length === 0) return null;
    return (
      <span className="text-[0.8125rem] text-dy-muted [overflow-wrap:anywhere]">
        {list.map((x) => t.targetLine({ name: x.name, state: x.state })).join(' · ')}
      </span>
    );
  };
  const hintKey =
    installError === 'no_canary_machine' || installError === 'mcp_install_unsupported'
      ? installError
      : 'other';
  const skipped = published?.probeSkipped ?? null;

  return (
    <div className="grid gap-3" data-testid="mcp-progress">
      <DyApiError error={error} />
      {props.assignError == null ? null : (
        <DyNotice tone="amber" testId="mcp-progress-assign-error">
          {t.assignError({ code: props.assignError })}
        </DyNotice>
      )}
      <ul className="m-0 list-none p-0" aria-label={t.title}>
        {stepRow('publish', t.steps.publish)}
        {stepRow(
          'canary',
          t.steps.canary,
          installError === null ? (
            targets(1)
          ) : (
            <DyNotice tone="red" testId="mcp-progress-install-error">
              {`${t.installError({ code: installError })} ${t.installHint[hintKey]}`}
            </DyNotice>
          ),
        )}
        {stepRow(
          'rest',
          t.steps.rest,
          <>
            {targets(2)}
            {steps.rest === 'held' && data.action !== null ? (
              <span className="flex flex-col gap-1.5">
                <span className="text-[0.8125rem] text-dy-muted">{t.heldHint}</span>
                {props.admin && steps.canary === 'done' ? (
                  <span>
                    <DyButton
                      variant="primary"
                      icon="rocket"
                      busy={busy === 'continue'}
                      data-testid="mcp-progress-continue"
                      onClick={() => void continueRest(data.action?.id ?? '')}
                    >
                      {t.continue}
                    </DyButton>
                  </span>
                ) : null}
              </span>
            ) : null}
          </>,
        )}
        {stepRow(
          'probe',
          t.steps.probe,
          skipped !== null ? (
            <span className="text-[0.8125rem] text-dy-amber-ink" data-testid="mcp-progress-probe-skipped">
              {skipped === 'mcp_secret_unbound' || skipped === 'no_machine'
                ? t.probeSkipped[skipped]
                : t.probeSkipped.other({ reason: skipped })}
            </span>
          ) : steps.probe === 'waiting' && data.preview.facts.transport === 'stdio' ? (
            <span className="text-[0.8125rem] text-dy-muted">{t.probeAfterCanary}</span>
          ) : null,
        )}
      </ul>
      <div className="grid gap-1.5" data-testid="mcp-progress-tools">
        <span className="text-[0.8125rem] font-bold">{t.toolsTitle}</span>
        {data.tools.length === 0 ? (
          <span className="text-[0.8125rem] text-dy-muted">{t.toolsNone}</span>
        ) : (
          <ul className="m-0 grid list-none gap-1 p-0">
            {data.tools.map((x) => (
              <li
                key={x.name}
                data-testid="mcp-progress-tool"
                className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[0.8125rem]"
              >
                <span className="font-dy-mono">{x.name}</span>
                <Pill tone={x.effect === 'allow' ? 'green' : x.effect === 'deny' ? 'red' : 'amber'}>
                  {t.effects[x.effect]}
                </Pill>
                {x.suggestedAllow ? <Pill tone="teal">{t.suggested}</Pill> : null}
                <span className="w-full text-dy-muted [overflow-wrap:anywhere]">{x.description}</span>
              </li>
            ))}
          </ul>
        )}
        {canApply ? (
          <span className="flex flex-col gap-1">
            <span>
              <DyButton
                icon="check"
                busy={busy === 'policy'}
                data-testid="mcp-progress-allow-suggested"
                onClick={() => void allowSuggested()}
              >
                {t.allowSuggested}
              </DyButton>
            </span>
            <span className="text-[0.78125rem] text-dy-muted">{t.allowSuggestedHint}</span>
          </span>
        ) : null}
      </div>
      <Link to="/skills?tab=mcp" className="text-[0.8125rem] font-medium text-dy-teal-ink">
        {t.serverLink}
      </Link>
    </div>
  );
}

// ------------------------------------------------------------------------------------- Keşfet: confirm a preview

export function McpPreviewConfirm(props: {
  readonly preview: McpPreview;
  readonly projects: readonly Project[];
  readonly onClosed: (message: string | null) => void;
}): ReactNode {
  const t = useT().mcp.install.proposal;
  const stepUp = useStepUp();
  const [project, setProject] = useState('');
  const [enable, setEnable] = useState(false);
  const [busy, setBusy] = useState<'confirm' | 'discard' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<McpPublishResult | null>(null);
  const pv = props.preview;

  async function confirm(): Promise<void> {
    setBusy('confirm');
    await guarded(
      stepUp,
      async () => {
        setResult(
          await publishMcpPreview(pv.id, {
            proposalSha256: pv.proposalSha256,
            project: project === '' ? null : project,
            enableProject: project !== '' && enable,
          }),
        );
      },
      t.stepUpPublish,
      setError,
    );
    setBusy(null);
  }

  async function discard(): Promise<void> {
    setBusy('discard');
    setError(null);
    try {
      await discardMcpPreview(pv.id);
      props.onClosed(t.discarded);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(null);
    }
  }

  if (result !== null) {
    return (
      <div className="grid gap-3" data-testid="mcp-preview-published">
        <DyNotice tone="green" live>
          {t.published({ id: result.serverId, version: result.version })}
        </DyNotice>
        <McpInstallProgress
          previewId={result.previewId}
          admin
          installError={result.installError}
          assignError={result.assignError}
        />
      </div>
    );
  }
  return (
    <div className="grid gap-3" data-testid="mcp-preview">
      <McpProposalView facts={pv.facts} />
      <DySelect
        label={t.project}
        value={project}
        options={[
          ['', t.noProject] as const,
          ...props.projects.map((pr) => [pr.id, pr.name === '' ? pr.id : pr.name] as const),
        ]}
        onChange={(v) => {
          setProject(v);
          if (v === '') setEnable(false);
        }}
      />
      {project === '' ? null : (
        <DyCheck
          label={t.enableProject}
          hint={t.enableProjectHint}
          checked={enable}
          onChange={setEnable}
          testId="mcp-preview-enable-project"
        />
      )}
      <DyApiError error={error} />
      <span className="flex flex-wrap gap-2">
        <DyButton
          variant="primary"
          icon="check"
          busy={busy === 'confirm'}
          disabled={busy !== null}
          data-testid="mcp-preview-confirm"
          onClick={() => void confirm()}
        >
          {t.confirm}
        </DyButton>
        <DyButton
          variant="ghost"
          busy={busy === 'discard'}
          disabled={busy !== null}
          data-testid="mcp-preview-discard"
          onClick={() => void discard()}
        >
          {t.discard}
        </DyButton>
      </span>
    </div>
  );
}
