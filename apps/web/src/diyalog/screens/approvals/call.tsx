import { type ReactNode, useId, useState } from 'react';
import { formatCommand, guessShell, oneLine, splitCommand } from '@remyral/protocol/approval-details';
import type { ApprovalDetails, ApprovalHeadline, ApprovalHints } from '../../../api/approvalDetails';
import type { ApprovalRequest, Risk } from '../../../api/approvals';
import { cx } from '../../../components/ui';
import { actionLabel } from '../../../screens/approvals/actionLabel';
import { COLLAPSE_LINES } from '../../../screens/approvals/call';
import { DyIcon, type IconName } from '../../icons';
import { DyCopy } from '../kit';
import { Pill } from '../parts';
import type { Tone } from '../../tone';
import { messagesFor, type Messages } from '@remyral/i18n';
import { useT } from '../../../i18n/I18nProvider';

/**
 * p12-diyalog-w2: the readable approval call in the Diyalog language (the classic `ApprovalCall` rules, same
 * protocol helpers): the agent's own words labelled as unverified, the command exactly as it will run (wrapped,
 * collapsed after 12 lines, copyable, optionally broken at its top-level separators), the call's fields, the static
 * "what this touches" reading and the raw text. Every string is untrusted runtime text, rendered as React text only.
 */

const COLLAPSE_CHARS = COLLAPSE_LINES * 100;

type ActionKey = keyof Messages['needs']['actions'];

/** Actions whose words live in the `needs` catalog; unknown actions keep the classic label (or the raw id). */
const ACTION_KEY: Readonly<Record<string, ActionKey>> = {
  'git.push_protected': 'gitPushProtected',
  'git.merge': 'gitMerge',
  'git.force_push': 'gitForcePush',
  deploy: 'deploy',
  'fs.delete_outside_workspace': 'fsDeleteOutsideWorkspace',
  'network.egress_non_allowlisted': 'networkEgress',
  'secret.read': 'secretRead',
  'runtime.dangerous_tool': 'runtimeDangerousTool',
  'job.budget_increase': 'jobBudgetIncrease',
  'machine.admin': 'machineAdmin',
};

/** An approval action in `t`'s language (p14-mcp-core: `tool.mcp`); unknown actions keep the classic label. */
export function actionText(action: string, t: Messages): string {
  if (action === 'tool.mcp') return t.mcp.approvalAction;
  const key = ACTION_KEY[action];
  return key === undefined ? actionLabel(action) : t.needs.actions[key];
}

/** `actionText` in the user's language. */
export function useActionText(): (action: string) => string {
  const t = useT();
  return (action) => actionText(action, t);
}

const RISK_TONE: Readonly<Record<Risk, Tone>> = {
  critical: 'red',
  high: 'amber',
  medium: 'neutral',
  low: 'neutral',
};

export function RiskPill(props: { readonly risk: Risk }): ReactNode {
  const t = useT();
  return (
    <span data-testid="risk-badge" className="inline-flex">
      <Pill tone={RISK_TONE[props.risk]} icon="shield">
        {t.needs.risk[props.risk]}
      </Pill>
    </span>
  );
}

export const STATUS_LOOK: Readonly<Record<ApprovalRequest['status'], { tone: Tone; icon: IconName }>> = {
  pending: { tone: 'amber', icon: 'clock' },
  approved: { tone: 'green', icon: 'checkc' },
  denied: { tone: 'red', icon: 'xc' },
  expired: { tone: 'neutral', icon: 'clock' },
  cancelled: { tone: 'neutral', icon: 'xc' },
};

export function StatusPill(props: { readonly status: ApprovalRequest['status'] }): ReactNode {
  const t = useT();
  const s = STATUS_LOOK[props.status];
  return (
    <Pill tone={s.tone} icon={s.icon}>
      {t.needs.status[props.status]}
    </Pill>
  );
}

/** p10-approval-pause: "İş duraklatıldı" (its slot is free) or "Bayat" (waiting long). */
export function PausePills(props: { readonly request: ApprovalRequest }): ReactNode {
  const t = useT();
  const r = props.request;
  if (r.jobPaused || r.pauseRequestedAt !== null)
    return (
      <span data-testid="badge-job-paused" className="inline-flex">
        <Pill tone="violet" icon="pause">
          {t.needs.call.jobPaused}
        </Pill>
      </span>
    );
  if (r.staleAt !== null)
    return (
      <span data-testid="badge-stale" className="inline-flex">
        <Pill tone="amber" icon="clock">
          {t.needs.call.stale}
        </Pill>
      </span>
    );
  return null;
}

/** "Ajan diyor ki" — the agent's own explanation, labelled as its unverified claim. */
export function AgentSays(props: { readonly text: string }): ReactNode {
  const t = useT();
  return (
    <blockquote
      data-testid="agent-says"
      className="m-0 rounded-[10px] bg-dy-sunk px-3.5 py-2.5 text-[0.9375rem]"
    >
      <small className="mb-0.5 block text-[0.75rem] font-bold text-dy-muted">{t.needs.call.agentSays}</small>
      <span className="[overflow-wrap:anywhere]">“{props.text}”</span>
    </blockquote>
  );
}

/** The command on the dark plate: real newlines, wrap, collapse after 12 lines, copy, "Parçalara böl". */
export function CommandPlate(props: {
  readonly command: string;
  readonly shell?: ApprovalDetails['shell'];
  readonly tool?: string;
  readonly truncated?: boolean;
}): ReactNode {
  const c = useT().needs.call;
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [formatted, setFormatted] = useState(false);
  const shell = props.shell ?? guessShell(props.tool ?? '', props.command);
  const pieces = splitCommand(props.command, shell).length;
  const shown = formatted ? formatCommand(props.command, shell) : props.command;
  const lines = shown.split('\n').length;
  const long = lines > COLLAPSE_LINES || shown.length > COLLAPSE_CHARS;
  const collapsed = long && !expanded;
  return (
    <div className="grid gap-1.5" data-testid="command-block">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[0.8125rem] font-bold text-dy-muted">
          {props.tool === undefined ? c.command : c.commandWithTool({ tool: props.tool })}
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          {pieces > 1 ? (
            <button
              type="button"
              aria-pressed={formatted}
              data-testid="command-formatted"
              onClick={() => {
                setFormatted((v) => !v);
              }}
              className={cx(
                'dy-press inline-flex min-h-9 items-center gap-1.5 rounded-[9px] border px-3 text-[0.8125rem] font-medium',
                formatted
                  ? 'border-dy-teal bg-dy-teal-soft text-dy-teal-ink'
                  : 'border-dy-line-2 bg-dy-card text-dy-ink',
              )}
            >
              <DyIcon name="term" className="size-3.5" />
              {formatted ? c.splitOn : c.split}
            </button>
          ) : null}
          <DyCopy text={props.command} label={c.copy} />
        </span>
      </div>
      <pre
        id={id}
        data-testid="request-command"
        data-collapsed={collapsed ? 'true' : 'false'}
        className={cx(
          'm-0 overflow-hidden rounded-[10px] bg-[#141a26] px-3.5 py-3 font-dy-mono text-[0.8125rem] leading-[1.6] whitespace-pre-wrap text-[#e7ecf5] [overflow-wrap:anywhere]',
          collapsed && 'max-h-60',
        )}
      >
        {shown}
      </pre>
      {long ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          data-testid="command-toggle"
          onClick={() => {
            setExpanded((v) => !v);
          }}
          className="dy-press inline-flex min-h-8 items-center self-start rounded-lg px-1 text-[0.8125rem] font-bold text-dy-teal-ink"
        >
          {expanded ? c.showLess : c.showAll({ lines })}
        </button>
      ) : null}
      {formatted ? (
        <p className="m-0 text-[0.78125rem] text-dy-muted">
          {c.splitBefore} <code className="font-dy-mono">;</code>,{' '}
          <code className="font-dy-mono">{'&&'}</code>, <code className="font-dy-mono">||</code> {c.splitAnd}{' '}
          <code className="font-dy-mono">|</code> {c.splitAfter}
        </p>
      ) : null}
      {props.truncated === true ? (
        <p className="m-0 text-[0.78125rem] font-medium text-dy-amber-ink" data-testid="command-truncated">
          {c.truncated}
        </p>
      ) : null}
    </div>
  );
}

function Mono(props: { readonly items: readonly string[] }): ReactNode {
  return (
    <span className="flex flex-wrap gap-1">
      {props.items.map((x, i) => (
        <code
          key={`${String(i)}-${x}`}
          className="rounded-[6px] bg-dy-sunk px-1.5 py-px font-dy-mono text-[0.78125rem] [overflow-wrap:anywhere]"
        >
          {x}
        </code>
      ))}
    </span>
  );
}

function Fields(props: {
  readonly rows: readonly (readonly [string, ReactNode])[];
  readonly testId?: string;
}): ReactNode {
  return (
    <dl
      data-testid={props.testId}
      className="m-0 grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] text-[0.875rem]"
    >
      {props.rows.map(([k, v], i) => (
        <div key={k} className="contents">
          <dt className={cx('py-1.5 pr-4 text-dy-muted', i > 0 && 'border-t border-dy-line')}>{k}</dt>
          <dd className={cx('m-0 min-w-0 py-1.5', i > 0 && 'border-t border-dy-line')}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function CallFields(props: { readonly details: ApprovalDetails }): ReactNode {
  const c = useT().needs.call;
  const d = props.details;
  const paths = d.paths ?? [];
  const rows: [string, ReactNode][] = [];
  if (d.cwd !== undefined) rows.push([c.cwd, <Mono key="c" items={[d.cwd]} />]);
  if (paths.length > 0)
    rows.push([
      paths.length === 1 ? c.file : c.files,
      <span key="p" className="grid gap-1">
        <Mono items={paths} />
        {d.morePaths === undefined ? null : (
          <span className="text-[0.78125rem] text-dy-muted">{c.morePaths({ n: d.morePaths })}</span>
        )}
      </span>,
    ]);
  if (d.url !== undefined) rows.push(['URL', <Mono key="u" items={[d.url]} />]);
  return rows.length === 0 ? null : <Fields rows={rows} testId="call-fields" />;
}

/** "Neye dokunuyor": the master's static reading (not a guarantee). */
function TouchHints(props: { readonly hints: ApprovalHints }): ReactNode {
  const c = useT().needs.call;
  const h = props.hints;
  const outside = new Set(h.outside);
  const rows: [IconName, string, string[]][] = [
    ['term', c.runs, h.runs],
    ['globe', c.reaches, h.reaches],
    ['file', c.writes, h.writes],
    ['xc', c.deletes, h.deletes],
    ['plus', c.installs, h.installs],
    ['key', c.envVars, h.envVars],
  ];
  const shown = rows.filter(([, , items]) => items.length > 0);
  if (shown.length === 0 && h.outside.length === 0 && !h.elevated && h.safeVerdict === null) return null;
  return (
    <section
      aria-label={c.touchTitle}
      data-testid="touch-hints"
      className="rounded-[12px] border border-dy-line p-3.5"
    >
      <h3 className="m-0 text-[0.9375rem] font-bold">{c.touchTitle}</h3>
      <p className="m-0 mt-0.5 mb-2 text-[0.78125rem] text-dy-muted">{c.touchNote}</p>
      <ul className="m-0 grid list-none gap-1.5 p-0 text-[0.84375rem]">
        {shown.map(([icon, verb, items]) => (
          <li
            key={verb}
            className="grid grid-cols-[18px_minmax(6.5rem,auto)_minmax(0,1fr)] items-start gap-2"
          >
            <DyIcon name={icon} className="mt-0.5 size-3.5 text-dy-muted" />
            <span className="text-dy-muted">{verb}</span>
            <span className="flex flex-wrap gap-1">
              {items.map((x, i) => (
                <code
                  key={`${String(i)}-${x}`}
                  className={cx(
                    'rounded-[6px] px-1.5 py-px font-dy-mono text-[0.78125rem] [overflow-wrap:anywhere]',
                    outside.has(x) ? 'bg-dy-amber-soft text-dy-amber-ink' : 'bg-dy-sunk',
                  )}
                >
                  {x}
                  {outside.has(x) ? c.outsideTag : ''}
                </code>
              ))}
            </span>
          </li>
        ))}
        {h.outside.filter((x) => !shown.some(([, , items]) => items.includes(x))).length > 0 ? (
          <li className="grid grid-cols-[18px_minmax(6.5rem,auto)_minmax(0,1fr)] items-start gap-2">
            <DyIcon name="flag" className="mt-0.5 size-3.5 text-dy-amber-ink" />
            <span className="text-dy-muted">{c.outside}</span>
            <Mono items={h.outside.filter((x) => !shown.some(([, , items]) => items.includes(x)))} />
          </li>
        ) : null}
        {h.elevated ? (
          <li className="rounded-[8px] bg-dy-red-soft px-2.5 py-1.5 font-medium text-dy-red-ink">
            {c.elevated}
          </li>
        ) : null}
      </ul>
      {h.safeVerdict === null ? null : (
        <p className="m-0 mt-2 text-[0.78125rem] text-dy-muted">
          {h.safeVerdict === 'read' ? c.safeRead : c.safeWorkspaceWrite}
        </p>
      )}
      {h.partial ? <p className="m-0 mt-1 text-[0.78125rem] text-dy-muted">{c.partial}</p> : null}
    </section>
  );
}

function Raw(props: { readonly summary: string }): ReactNode {
  const t = useT();
  return (
    <pre
      data-testid="request-summary"
      className="m-0 max-h-64 overflow-auto rounded-[10px] border border-dy-line bg-dy-sunk p-3 font-dy-mono text-[0.78125rem] whitespace-pre-wrap [overflow-wrap:anywhere]"
    >
      {props.summary === '' ? t.needs.call.noSummary : props.summary}
    </pre>
  );
}

/** The whole "what the agent wants to do" block (structured when the machine sent details). */
export function ReadableCall(props: {
  readonly details: ApprovalDetails | null;
  readonly hints: ApprovalHints | null;
  readonly summary: string;
}): ReactNode {
  const c = useT().needs.call;
  const d = props.details;
  if (d === null) return <Raw summary={props.summary} />;
  return (
    <div className="grid gap-3" data-testid="approval-call">
      {d.description === undefined ? null : <AgentSays text={d.description} />}
      {d.command === undefined ? (
        <p className="m-0 text-[0.875rem]">
          {c.tool} <code className="font-dy-mono">{d.tool}</code>
        </p>
      ) : (
        <CommandPlate
          command={d.command}
          tool={d.tool}
          {...(d.shell === undefined ? {} : { shell: d.shell })}
          {...(d.commandTruncated === true ? { truncated: true } : {})}
        />
      )}
      <CallFields details={d} />
      {props.hints === null ? null : <TouchHints hints={props.hints} />}
      <details className="text-[0.8125rem] text-dy-muted">
        <summary className="w-fit cursor-pointer font-medium">{c.raw}</summary>
        <div className="mt-1.5">
          <Raw summary={props.summary} />
        </div>
      </details>
    </div>
  );
}

/** One line for rows: the agent's words (labelled) or the summary, plus a one-line command preview. */
export function HeadlineLine(props: {
  readonly headline: ApprovalHeadline;
  readonly details: ApprovalDetails | null;
}): ReactNode {
  const c = useT().needs.call;
  const h = props.headline;
  const cmd = props.details?.command;
  const preview =
    h.source === 'agent' && cmd !== undefined
      ? oneLine(
          splitCommand(cmd, props.details?.shell ?? guessShell(props.details?.tool ?? '', cmd))[0]?.text ??
            cmd,
        )
      : null;
  return (
    <span className="mt-0.5 grid min-w-0 gap-0.5" data-testid="approval-headline">
      <span className="line-clamp-2 text-[0.875rem] text-dy-muted [overflow-wrap:anywhere]">
        {h.source === 'agent' ? (
          <>
            <span className="text-[0.78125rem]">{c.agentSaysInline}</span>
            <span className="text-dy-ink">“{h.text}”</span>
          </>
        ) : h.text === '' ? (
          c.noSummary
        ) : (
          h.text
        )}
      </span>
      {preview === null ? null : (
        <code
          className="block truncate font-dy-mono text-[0.78125rem] text-dy-muted"
          data-testid="approval-command-preview"
        >
          {preview}
        </code>
      )}
    </span>
  );
}

const TR_UNTIL = messagesFor('tr').needs.until;

/**
 * "42 dk sonra" / "2 sa sonra" (coarse, future). `w` is the language's words (`t.needs.until`); Turkish by default
 * for callers whose own sentence is still Turkish (deploys/health).
 */
export function untilText(
  iso: string,
  now: number = Date.now(),
  w: Messages['needs']['until'] = TR_UNTIL,
): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const s = Math.round((t - now) / 1000);
  if (s <= 0) return w.now;
  if (s < 60) return w.withinMinute;
  const m = Math.round(s / 60);
  if (m < 60) return w.minutes({ n: m });
  const h = Math.round(m / 60);
  if (h < 48) return w.hours({ n: h });
  return w.days({ n: Math.round(h / 24) });
}
