import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { RECORD_TYPES, type RecordType, runtimeName } from '../../../../api/memoryRecords';
import {
  acceptSuggestion,
  agentSummaryPrompt,
  AUTO_LEARN_MODES,
  type AutoLearnMode,
  backfillSuggestions,
  bulkSuggestions,
  dismissSuggestion,
  getSuggestionSettings,
  listSuggestions,
  type MemorySuggestion,
  type OutcomeCounts,
  RULE_TEXT,
  runAutoLearn,
  setAutoLearn,
  setSuggestionMode,
  type SuggestionMode,
  type SuggestionSettings,
  type SuggestionState,
  undoSuggestion,
} from '../../../../api/memorySuggestions';
import type { PrefillState } from '../../../../screens/composer/prefill';
import { useSubmit } from '../../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../../stepup/StepUpProvider';
import { RuntimeMark } from '../../../RuntimeMark';
import { DyApiError, DyCheck, DyField, DyNotice, DyTextarea, FormActions } from '../../forms';
import { DyButton, DySelect, EmptyLine, Panel, Pill, SkeletonRows } from '../../parts';
import { reasonText } from './memory-records';
import type { Messages } from '@remyral/i18n';
import { useT } from '../../../../i18n/I18nProvider';
import { RelatedContextSetting } from '../../../related/RelatedWork';

type SuggestionWords = Messages['projectTabs']['suggestions'];

/**
 * p12-diyalog wave 2 (W3) — Projeler → Hafıza → Hafıza önerileri in the Diyalog language (p10-semantic-memory): the
 * mode (admins, step-up; `expectedVersion`), "read earlier jobs", the assisted-mode summarising job (opens the
 * composer prefilled), and the inbox (waiting / accepted / dismissed) with accept, edit-and-accept (type, scope,
 * review date, replace) and dismiss for operators and up. Same requests and bodies as the classic
 * `MemorySuggestionsPanel`. Suggestion text is job output: plain text only.
 */

const RULE_KEY: Readonly<Record<string, keyof SuggestionWords['rule']>> = {
  marker: 'marker',
  section: 'section',
  'package-manager': 'packageManager',
  command: 'command',
  color: 'color',
  'deploy-note': 'deployNote',
  decision: 'decision',
  chat: 'chat',
  agent: 'agent',
};

function ruleText(t: SuggestionWords, rule: string): string {
  const key = RULE_KEY[rule];
  return key === undefined ? (RULE_TEXT[rule] ?? rule) : t.rule[key];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** p17-auto-learning: the inbox views — the suggestion states plus "learned automatically". */
type InboxView = SuggestionState | 'auto';

/** p17-auto-learning: a policy reason in words (`instruction:<flag>`, `known:<method>`, `accept_failed:<x>` …). */
export function autoReasonText(t: SuggestionWords['auto'], reason: string): string {
  const [head = '', tail = ''] = reason.split(':');
  if (head === 'instruction') {
    const key = Object.keys(t.instruction).find((k) => k === tail);
    return key === undefined ? reason : t.instruction[key as keyof typeof t.instruction];
  }
  const key = Object.keys(t.reason).find((k) => k === head);
  return key === undefined ? reason : t.reason[key as keyof typeof t.reason];
}

function sumCounts(c: OutcomeCounts): Record<keyof OutcomeCounts, number> {
  return { merged: c.merged, known: c.known, accepted: c.accepted, expiring: c.expiring, human: c.human };
}

export function SuggestionsPanels(props: { readonly project: string; readonly role: string }): ReactNode {
  const canDecide = props.role !== 'viewer';
  const isAdmin = props.role === 'admin' || props.role === 'owner';
  const t = useT().projectTabs.suggestions;
  const MODE_TR: Readonly<Record<SuggestionMode, string>> = t.mode;
  const [params] = useSearchParams();
  const [settings, setSettings] = useState<SuggestionSettings | null>(null);
  // p17-auto-learning: the daily digest links here with ?auto=1 ("learned automatically").
  const [state, setState] = useState<InboxView>(params.get('auto') === '1' ? 'auto' : 'pending');
  const [items, setItems] = useState<MemorySuggestion[] | null>(null);
  const [total, setTotal] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const load = useSubmit();
  const act = useSubmit();
  const stepUp = useStepUp();

  useEffect(() => {
    void load.run(async () => {
      const [s, list] = await Promise.all([
        getSuggestionSettings(props.project),
        listSuggestions(props.project, state === 'auto' ? 'accepted' : state, {
          limit: 100,
          ...(state === 'auto' ? { auto: true } : {}),
        }),
      ]);
      setSettings(s);
      setItems(list.items);
      setTotal(list.total);
      setSelected(new Set());
    });
    // load.run is stable; reload re-reads after a decision.
  }, [props.project, state, reload]);

  const refresh = useCallback(() => {
    setReload((n) => n + 1);
  }, []);

  const changeMode = (mode: SuggestionMode): void => {
    if (settings === null || mode === settings.mode) return;
    setNotice(null);
    void act.run(async () => {
      try {
        await stepUp.run(async () => {
          const next = await setSuggestionMode({
            project: props.project,
            mode,
            expectedVersion: settings.version,
          });
          setSettings(next);
          setNotice(mode === 'off' ? t.off : t.on);
        }, t.modeStepUp);
      } catch (err) {
        if (!(err instanceof StepUpCancelledError)) throw err;
      }
    });
  };

  return (
    <>
      <Panel title={t.title} sub={t.sub} testId="dy-memory-suggestions">
        <DyApiError error={load.error} retryLeft={load.retryLeft} />
        {settings === null ? (
          load.error === null ? (
            <SkeletonRows label={t.loading} rows={2} />
          ) : null
        ) : (
          <div className="flex flex-col gap-3">
            <p
              className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.875rem]"
              data-testid="memory-mode"
            >
              <Pill tone={settings.mode === 'off' ? 'neutral' : 'teal'}>{MODE_TR[settings.mode]}</Pill>
              <span className="tabular-nums">{t.pending({ n: settings.pending })}</span>
              <span className="text-dy-muted">· {settings.semanticDedupe ? t.semantic : t.lexical}</span>
            </p>
            {isAdmin ? (
              <div className="flex flex-wrap items-end gap-2">
                <DySelect
                  label={t.modeLabel}
                  value={settings.mode}
                  options={(['off', 'rules', 'assisted'] as const).map((m) => [m, MODE_TR[m]] as const)}
                  onChange={(v) => {
                    if (v === 'off' || v === 'rules' || v === 'assisted') changeMode(v);
                  }}
                  className="min-w-64"
                />
                {settings.mode !== 'off' ? (
                  <DyButton
                    icon="retry"
                    busy={act.busy}
                    onClick={() => {
                      setNotice(null);
                      void act.run(async () => {
                        const r = await backfillSuggestions(props.project, 30);
                        setNotice(
                          t.backfilled({ jobs: r.jobs, proposed: r.proposed, duplicates: r.duplicates }),
                        );
                        refresh();
                      });
                    }}
                  >
                    {t.backfill}
                  </DyButton>
                ) : null}
              </div>
            ) : null}
            <DyApiError error={act.error} retryLeft={act.retryLeft} />
            {notice !== null ? (
              <DyNotice tone="green" live>
                <span data-testid="memory-notice">{notice}</span>
              </DyNotice>
            ) : null}
            {settings.mode === 'assisted' && canDecide ? <AgentSummaryForm /> : null}
          </div>
        )}
      </Panel>

      {settings !== null ? (
        <AutoLearnPanel
          project={props.project}
          settings={settings}
          isAdmin={isAdmin}
          onSettings={setSettings}
          onChanged={(text) => {
            setNotice(text);
            refresh();
          }}
        />
      ) : null}
      {/* p17-embeddings: similar successful jobs as hints in this project's job contexts. */}
      <RelatedContextSetting project={props.project} isAdmin={isAdmin} />

      <Panel
        title={t.inbox}
        count={items === null ? undefined : String(total)}
        countLabel={t.count({ n: total })}
        aside={
          <DySelect
            label={t.show}
            value={state}
            options={[
              ['pending', t.statePending],
              ['auto', t.auto.stateAuto],
              ['accepted', t.stateAccepted],
              ['merged', t.auto.stateMerged],
              ['dismissed', t.stateDismissed],
            ]}
            onChange={(v) => {
              if (v === 'pending' || v === 'accepted' || v === 'dismissed' || v === 'merged' || v === 'auto')
                setState(v);
            }}
            className="min-w-48"
          />
        }
        flush
        testId="dy-memory-inbox"
      >
        {items === null ? (
          load.error === null ? (
            <SkeletonRows label={t.itemsLoading} rows={2} />
          ) : null
        ) : items.length === 0 ? (
          <EmptyLine testId="memory-empty">{state === 'pending' ? t.noPending : t.nothing}</EmptyLine>
        ) : (
          <>
            {state === 'pending' && canDecide ? (
              <BulkBar
                project={props.project}
                items={items}
                selected={selected}
                onSelect={setSelected}
                onDone={(text) => {
                  setNotice(text);
                  refresh();
                }}
              />
            ) : null}
            <ol className="m-0 flex list-none flex-col p-0" data-testid="memory-inbox">
              {items.map((s) => (
                <SuggestionRow
                  key={s.id}
                  suggestion={s}
                  canDecide={canDecide && s.state === 'pending'}
                  canUndo={canDecide}
                  selected={state === 'pending' && canDecide ? selected.has(s.id) : undefined}
                  onSelect={(on) => {
                    setSelected((cur) => {
                      const next = new Set(cur);
                      if (on) next.add(s.id);
                      else next.delete(s.id);
                      return next;
                    });
                  }}
                  onDecided={(text) => {
                    setNotice(text);
                    refresh();
                  }}
                />
              ))}
            </ol>
          </>
        )}
        {items !== null && total > items.length ? (
          <p className="m-0 px-4 pb-3 text-[0.8125rem] text-dy-muted">
            {t.showing({ total, shown: items.length })}
          </p>
        ) : null}
      </Panel>
    </>
  );
}

/** "a conversation of <user>, <date>" — whose and when; reviewers never get the conversation itself. */
function chatOrigin(t: SuggestionWords, s: MemorySuggestion): string {
  const c = s.chat;
  if (c === null) return t.fromChat;
  const who = c.ownerName === null ? t.fromChat : t.fromChatOf({ owner: c.ownerName });
  const by =
    c.origin === 'assistant' ? t.byAssistantRequest : c.author === 'assistant' ? t.assistantReply : '';
  return t.chatOrigin({ who, date: c.at.slice(0, 10), by });
}

/**
 * p17-auto-learning: "Otomatik öğrenme" — the project's setting (admins, step-up), what it learned and what waits,
 * and "Bekleyenlere uygula" (admins): preview (dry run, nothing changes) and apply (step-up).
 */
function AutoLearnPanel(props: {
  readonly project: string;
  readonly settings: SuggestionSettings;
  readonly isAdmin: boolean;
  readonly onSettings: (s: SuggestionSettings) => void;
  readonly onChanged: (notice: string) => void;
}): ReactNode {
  const t = useT().projectTabs.suggestions.auto;
  const s = props.settings;
  const act = useSubmit();
  const stepUp = useStepUp();
  const [preview, setPreview] = useState<string | null>(null);

  const change = (mode: AutoLearnMode): void => {
    if (mode === s.autoLearn) return;
    void act.run(async () => {
      try {
        await stepUp.run(async () => {
          const next = await setAutoLearn({
            project: props.project,
            autoLearn: mode,
            expectedVersion: s.version,
          });
          props.onSettings(next);
          props.onChanged(t.changed({ mode: t.mode[mode] }));
        }, t.stepUp);
      } catch (err) {
        if (!(err instanceof StepUpCancelledError)) throw err;
      }
    });
  };

  const run = (dryRun: boolean): void => {
    void act.run(async () => {
      if (dryRun) {
        const r = await runAutoLearn(props.project, true);
        setPreview(t.previewResult(sumCounts(r.totals)));
        return;
      }
      try {
        await stepUp.run(async () => {
          const r = await runAutoLearn(props.project, false);
          setPreview(null);
          props.onChanged(t.applied(sumCounts(r.totals)));
        }, t.runStepUp);
      } catch (err) {
        if (!(err instanceof StepUpCancelledError)) throw err;
      }
    });
  };

  return (
    <Panel title={t.title} sub={t.hint} testId="dy-memory-autolearn">
      <div className="flex flex-col gap-3">
        <p
          className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.875rem]"
          data-testid="autolearn-status"
        >
          <Pill tone={s.autoLearn === 'off' || !s.autoLearnAvailable ? 'neutral' : 'violet'} icon="brain">
            {t.mode[s.autoLearn]}
          </Pill>
          <span className="tabular-nums">{t.learned({ n: s.autoLearned })}</span>
          <span className="text-dy-muted tabular-nums">· {t.needsHuman({ n: s.needsHuman })}</span>
        </p>
        {!s.autoLearnAvailable ? (
          <p className="m-0 text-[0.8125rem] text-dy-amber-ink" data-testid="autolearn-unavailable">
            {t.unavailable}
          </p>
        ) : null}
        {props.isAdmin ? (
          <div className="flex flex-wrap items-end gap-2">
            <DySelect
              label={t.label}
              value={s.autoLearn}
              options={AUTO_LEARN_MODES.map((m) => [m, t.mode[m]] as const)}
              onChange={(v) => {
                const next = AUTO_LEARN_MODES.find((m) => m === v);
                if (next !== undefined) change(next);
              }}
              className="min-w-72"
            />
            {s.autoLearnAvailable && s.autoLearn !== 'off' && s.pending > 0 ? (
              <>
                <DyButton
                  icon="search"
                  busy={act.busy}
                  onClick={() => {
                    run(true);
                  }}
                >
                  {t.preview}
                </DyButton>
                <DyButton
                  variant="primary"
                  icon="check"
                  busy={act.busy}
                  onClick={() => {
                    run(false);
                  }}
                >
                  {t.run}
                </DyButton>
              </>
            ) : null}
          </div>
        ) : null}
        {props.isAdmin && s.autoLearnAvailable && s.autoLearn !== 'off' && s.pending > 0 ? (
          <p className="m-0 text-[0.8125rem] text-dy-muted">{t.runSub}</p>
        ) : null}
        {preview !== null ? (
          <DyNotice tone="green" live>
            <span data-testid="autolearn-preview">{preview}</span>
          </DyNotice>
        ) : null}
        <DyApiError error={act.error} retryLeft={act.retryLeft} />
      </div>
    </Panel>
  );
}

/** p17-auto-learning: bulk review of what waits — select many, accept / decline / merge (keep one). */
function BulkBar(props: {
  readonly project: string;
  readonly items: readonly MemorySuggestion[];
  readonly selected: ReadonlySet<string>;
  readonly onSelect: (next: ReadonlySet<string>) => void;
  readonly onDone: (notice: string) => void;
}): ReactNode {
  const t = useT().projectTabs.suggestions.auto;
  const act = useSubmit();
  const chosen = props.items.filter((s) => props.selected.has(s.id));
  const [keep, setKeep] = useState('');
  const keepId = chosen.some((s) => s.id === keep) ? keep : (chosen[0]?.id ?? '');
  const all = props.items.length > 0 && chosen.length === props.items.length;
  const go = (action: 'accept' | 'dismiss' | 'merge'): void => {
    void act.run(async () => {
      const r = await bulkSuggestions({
        project: props.project,
        ids: chosen.map((s) => s.id),
        action,
        ...(action === 'merge' ? { keep: keepId } : {}),
      });
      props.onDone(t.bulkDone({ done: r.done.length, failed: r.failed.length }));
    });
  };
  return (
    <div
      role="group"
      aria-label={t.bulkLabel}
      className="flex flex-wrap items-end gap-2 border-b border-dy-line px-4 py-2.5"
      data-testid="memory-bulk"
    >
      <DyCheck
        label={t.selectAll}
        checked={all}
        onChange={(on) => {
          props.onSelect(new Set(on ? props.items.map((s) => s.id) : []));
        }}
        testId="memory-select-all"
      />
      <span className="pb-2 text-[0.8125rem] text-dy-muted tabular-nums" data-testid="memory-selected">
        {t.selected({ n: chosen.length })}
      </span>
      {chosen.length > 0 ? (
        <>
          <DyButton
            variant="primary"
            icon="check"
            busy={act.busy}
            onClick={() => {
              go('accept');
            }}
          >
            {t.bulkAccept}
          </DyButton>
          <DyButton
            variant="ghost"
            busy={act.busy}
            onClick={() => {
              go('dismiss');
            }}
          >
            {t.bulkDismiss}
          </DyButton>
        </>
      ) : null}
      {chosen.length > 1 ? (
        <>
          <DySelect
            label={t.keep}
            value={keepId}
            options={chosen.map((s) => [s.id, s.title] as const)}
            onChange={setKeep}
            className="min-w-56"
          />
          <DyButton
            icon="merge"
            busy={act.busy}
            onClick={() => {
              go('merge');
            }}
          >
            {t.bulkMerge}
          </DyButton>
        </>
      ) : null}
      <DyApiError error={act.error} retryLeft={act.retryLeft} className="basis-full" />
    </div>
  );
}

function SuggestionRow(props: {
  readonly suggestion: MemorySuggestion;
  readonly canDecide: boolean;
  /** p17-auto-learning: may undo what the system learned (operators and up). */
  readonly canUndo?: boolean;
  /** p17-auto-learning bulk review: selected (undefined: not selectable). */
  readonly selected?: boolean | undefined;
  readonly onSelect?: (on: boolean) => void;
  readonly onDecided: (notice: string) => void;
}): ReactNode {
  const s = props.suggestion;
  const all = useT().projectTabs;
  const t = all.suggestions;
  const tm = all.memory;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(s.title);
  const [content, setContent] = useState(s.content);
  const defaultType: RecordType = s.recordType ?? 'fact';
  const [type, setType] = useState<RecordType>(defaultType);
  const [scope, setScope] = useState<'project' | 'project+runtime'>('project');
  const [reviewBy, setReviewBy] = useState('');
  const [replace, setReplace] = useState(false);
  const act = useSubmit();
  const source =
    s.source === 'chat'
      ? chatOrigin(t, s)
      : s.source === 'agent_summary'
        ? t.fromSummary
        : s.source === 'agent'
          ? null
          : t.fromJob;
  const replacesTitle = s.replaces === null ? '' : (s.replaces.title ?? s.replaces.documentId.slice(0, 8));

  const accept = (edited: boolean): void => {
    void act.run(async () => {
      const r = await acceptSuggestion(
        s.id,
        edited
          ? {
              title: title.trim(),
              content: content.trim(),
              ...(type === defaultType ? {} : { type }),
              ...(scope === 'project' ? {} : { scope }),
              ...(reviewBy === '' ? {} : { reviewBy }),
              ...(replace && s.replaces !== null ? { supersedes: s.replaces.documentId } : {}),
            }
          : {},
      );
      setEditing(false);
      props.onDecided(
        r.record === null
          ? t.added({ doc: r.documentId.slice(0, 8) })
          : t.addedAs({ type: tm.typeLower[r.record.type], doc: r.documentId.slice(0, 8) }),
      );
    });
  };

  const ta = t.auto;
  const undoable =
    props.canUndo === true && s.autoAccepted && s.undoneAt === null && s.recordStatus === 'active';
  return (
    <li
      className="min-w-0 border-t border-dy-line px-4 py-3.5 first:border-t-0"
      data-testid="memory-suggestion"
      data-suggestion-id={s.id}
    >
      <div className="flex flex-wrap items-center gap-2">
        {props.selected !== undefined ? (
          <input
            type="checkbox"
            className="size-4 shrink-0 accent-[var(--dy-teal)]"
            aria-label={ta.select({ title: s.title })}
            data-testid="memory-select"
            checked={props.selected}
            onChange={(e) => {
              props.onSelect?.(e.target.checked);
            }}
          />
        ) : null}
        <span className="min-w-0 font-bold [overflow-wrap:anywhere]">{s.title}</span>
        {s.autoAccepted ? (
          <span data-testid="memory-auto-badge">
            <Pill tone={s.undoneAt === null ? 'violet' : 'neutral'} icon="brain">
              {s.undoneAt === null ? ta.badge : ta.undone}
            </Pill>
          </span>
        ) : null}
        {s.source === 'chat' ? (
          <span data-testid="memory-chat-badge">
            <Pill tone="violet" icon="bubble">
              {t.chat}
            </Pill>
          </span>
        ) : null}
        <span data-testid="memory-type-badge">
          <Pill tone="neutral">{tm.type[s.recordType ?? 'fact']}</Pill>
        </span>
        {s.runtime !== null ? (
          <span data-testid="memory-runtime-badge" className="text-[0.8125rem]">
            <RuntimeMark runtime={s.runtime} />
          </span>
        ) : null}
      </div>
      <p className="m-0 mt-0.5 text-[0.8125rem] text-dy-muted" data-testid="memory-source">
        {s.source === 'agent' ? (
          <>
            {t.agentSuggestion({ runtime: s.runtime === null ? '' : `${runtimeName(s.runtime)} ` })}
            {s.jobId !== null ? ' ·' : ''}
          </>
        ) : (
          <>
            {ruleText(t, s.rule)} · {source}
          </>
        )}
        {s.jobId !== null ? (
          <>
            {' '}
            <Link
              to={`/jobs/${encodeURIComponent(s.jobId)}`}
              className="text-dy-teal-ink [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
            >
              {t.job({ id: s.jobId.slice(0, 8) })}
            </Link>
          </>
        ) : null}
      </p>
      {editing ? (
        <form
          className="mt-3 flex flex-col gap-3"
          aria-label={t.editForm({ title: s.title })}
          onSubmit={(e) => {
            e.preventDefault();
            accept(true);
          }}
        >
          <DyField label={t.titleField} value={title} maxLength={160} onChange={setTitle} />
          <DyTextarea label={t.learning} value={content} rows={3} maxLength={1000} onChange={setContent} />
          <div className="grid gap-3 sm:grid-cols-3">
            <DySelect
              label={t.type}
              value={type}
              options={RECORD_TYPES.map((x) => [x, tm.type[x]] as const)}
              onChange={(v) => {
                const next = RECORD_TYPES.find((x) => x === v);
                if (next !== undefined) setType(next);
              }}
            />
            {s.runtime !== null ? (
              <DySelect
                label={t.scope}
                value={scope}
                options={[
                  ['project', t.everyRuntime],
                  ['project+runtime', t.onlyRuntime({ runtime: runtimeName(s.runtime) })],
                ]}
                onChange={(v) => {
                  setScope(v === 'project+runtime' ? 'project+runtime' : 'project');
                }}
              />
            ) : null}
            <DyField label={t.reviewOptional} type="date" value={reviewBy} onChange={setReviewBy} />
          </div>
          {s.replaces !== null ? (
            <DyCheck
              label={t.replaceLabel({ title: replacesTitle })}
              hint={t.replaceHint}
              checked={replace}
              onChange={setReplace}
            />
          ) : null}
          <FormActions>
            <DyButton
              type="submit"
              variant="primary"
              busy={act.busy}
              disabled={title.trim() === '' || content.trim() === ''}
            >
              {t.editAccept}
            </DyButton>
            <DyButton
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setTitle(s.title);
                setContent(s.content);
                setType(defaultType);
                setScope('project');
                setReviewBy('');
                setReplace(false);
              }}
            >
              {t.cancel}
            </DyButton>
          </FormActions>
        </form>
      ) : (
        <p
          className="m-0 mt-1.5 text-[0.9375rem] whitespace-pre-wrap [overflow-wrap:anywhere]"
          data-testid="memory-content"
        >
          {s.content}
        </p>
      )}
      {s.chat?.snippet != null && !editing ? (
        <blockquote
          className="m-0 mt-1.5 border-l-2 border-dy-line pl-2.5 text-[0.8125rem] text-dy-muted [overflow-wrap:anywhere]"
          data-testid="memory-chat-snippet"
        >
          {s.chat.snippet}
        </blockquote>
      ) : null}
      {s.replaces !== null ? (
        <p className="m-0 mt-1.5 text-[0.8125rem] text-dy-amber-ink" data-testid="memory-replaces">
          {t.mayReplace}
          <b>“{replacesTitle}”</b> ({reasonText(tm, s.replaces.reason)})
        </p>
      ) : null}
      {s.state === 'pending' && s.auto?.outcome === 'human' && s.auto.reasons.length > 0 ? (
        <p className="m-0 mt-1.5 text-[0.8125rem] text-dy-amber-ink" data-testid="memory-auto-why">
          {ta.why}
          {s.auto.reasons.map((r) => autoReasonText(ta, r)).join(', ')}
        </p>
      ) : null}
      {s.autoAccepted && s.recordExpiresAt !== null && s.undoneAt === null ? (
        <p className="m-0 mt-1.5 text-[0.8125rem] text-dy-muted" data-testid="memory-auto-expiry">
          {ta.expiresOn({ date: s.recordExpiresAt.slice(0, 10) })}
        </p>
      ) : null}
      {s.mergedSources.length > 0 ? (
        <p
          className="m-0 mt-1.5 text-[0.8125rem] text-dy-muted [overflow-wrap:anywhere]"
          data-testid="memory-merged"
        >
          {ta.mergedHere({
            n: s.mergedSources.length,
            list: s.mergedSources.map((m) => `“${m.title}”`).join(', '),
          })}
        </p>
      ) : null}
      {s.state === 'merged' ? (
        <p className="m-0 mt-1.5 text-[0.8125rem] text-dy-muted" data-testid="memory-merged-into">
          {s.mergedInto !== null ? ta.mergedInto : ta.mergedKnown}
        </p>
      ) : null}
      {s.similar !== null && s.replaces === null ? (
        <p className="m-0 mt-1.5 text-[0.8125rem] text-dy-muted" data-testid="memory-similar">
          {t.similarA}
          <b>“{s.similar.title ?? s.similar.documentId.slice(0, 8)}”</b>
          {t.similarB({
            method: s.similar.method === 'semantic' ? t.semanticWord : t.lexicalWord,
            score: s.similar.score.toFixed(2),
          })}
        </p>
      ) : null}
      <DyApiError error={act.error} retryLeft={act.retryLeft} className="mt-2" />
      {undoable ? (
        <div className="mt-2.5 flex flex-wrap gap-2">
          <DyButton
            variant="danger"
            icon="retry"
            busy={act.busy}
            onClick={() => {
              void act.run(async () => {
                await undoSuggestion(s.id);
                props.onDecided(ta.undoneNotice({ title: s.title }));
              });
            }}
          >
            {ta.undo}
          </DyButton>
        </div>
      ) : null}
      {props.canDecide && !editing ? (
        <div className="mt-2.5 flex flex-wrap gap-2">
          <DyButton
            variant="primary"
            icon="check"
            busy={act.busy}
            onClick={() => {
              accept(false);
            }}
          >
            {t.accept}
          </DyButton>
          <DyButton
            icon="pen"
            onClick={() => {
              setEditing(true);
            }}
          >
            {t.edit}
          </DyButton>
          <DyButton
            variant="ghost"
            busy={act.busy}
            onClick={() => {
              void act.run(async () => {
                await dismissSuggestion(s.id);
                props.onDecided(t.dismissed);
              });
            }}
          >
            {t.dismiss}
          </DyButton>
        </div>
      ) : null}
    </li>
  );
}

/** Assisted mode: opens an ordinary job that summarises a finished job in the composer (reviewed, then submitted). */
function AgentSummaryForm(): ReactNode {
  const t = useT().projectTabs.suggestions;
  const [jobId, setJobId] = useState('');
  const act = useSubmit();
  const navigate = useNavigate();
  const valid = UUID_RE.test(jobId.trim());
  return (
    <form
      className="flex flex-col gap-2 border-t border-dy-line pt-3 sm:flex-row sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        void act.run(async () => {
          const { project, prompt } = await agentSummaryPrompt(jobId.trim());
          const state: PrefillState = { prefill: { project, spec: { prompt } } };
          void navigate('/jobs/new', { state });
        });
      }}
    >
      <DyField
        label={t.summarize}
        hint={t.summarizeHint}
        placeholder={t.jobId}
        value={jobId}
        mono
        onChange={setJobId}
        wrapClassName="min-w-0 flex-1"
      />
      <DyButton type="submit" busy={act.busy} disabled={!valid}>
        {t.openForm}
      </DyButton>
      <DyApiError error={act.error} retryLeft={act.retryLeft} className="basis-full" />
    </form>
  );
}
