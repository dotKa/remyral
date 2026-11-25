import { type ReactNode, type SubmitEvent, useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  type FallbackReason,
  findContext,
  type FoundContext,
  getKnowledgeDefaults,
  getSearchSettings,
  type KnowledgeDefaults,
  putKnowledgeDefaults,
  reindexSearch,
  type SearchSettings,
  setSearchConsent,
} from '../../../api/search';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyApiError, DyCheck, DyField, DyNotice, FormActions } from '../forms';
import { DyButton, DySelect, EmptyLine, Panel, Pill, SkeletonRows } from '../parts';
import type { Messages } from '@remyral/i18n';
import { useT } from '../../../i18n/I18nProvider';

/**
 * p12-diyalog wave 2 (W3) — Bağlam: semantic search (p6-vector / p10-semantic-memory) — the namespace's capture
 * consent and index rebuild (owners / admins, step-up), provider facts, and for a project namespace the search box
 * (by meaning where capture is on, otherwise by keywords, said next to the results); and the defaults for new
 * projects (owners / admins, step-up). Same calls and rules as the classic `ContextSearchPanel` /
 * `KnowledgeDefaultsCard`; collapsed until opened, so nothing is requested for people who never use it.
 */

type SearchWords = Messages['knowledge']['search'];

function fallbackText(t: SearchWords, r: FallbackReason): string {
  return t.fallback[r];
}

function sourceText(t: SearchWords, source: string): string {
  if (source === 'panel') return t.source.panel;
  if (source === 'environment') return t.source.environment;
  if (source === 'instance role') return t.source.instanceRole;
  return source;
}

export function ContextSearchPanel(props: {
  readonly namespace: string;
  readonly isAdmin: boolean;
}): ReactNode {
  const t = useT().knowledge.search;
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<SearchSettings | null>(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<FoundContext | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useSubmit();
  const find = useSubmit();
  const act = useSubmit();
  const stepUp = useStepUp();
  const project = props.namespace.startsWith('project:') ? props.namespace.slice('project:'.length) : null;

  const privileged = async (fn: () => Promise<void>, why: string): Promise<void> => {
    await act.run(async () => {
      try {
        await stepUp.run(fn, why);
      } catch (err) {
        if (!(err instanceof StepUpCancelledError)) throw err;
      }
    });
  };

  if (!open)
    return (
      <div>
        <DyButton
          icon="search"
          onClick={() => {
            setOpen(true);
            void load.run(async () => {
              setSettings(await getSearchSettings(props.namespace));
            });
          }}
        >
          {t.title}
        </DyButton>
      </div>
    );

  const onSearch = (e: SubmitEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (project === null || q.trim() === '') return;
    void find.run(async () => {
      setFound(await findContext(project, q.trim()));
    });
  };

  return (
    <Panel title={t.title} testId="dy-context-search">
      <div className="flex flex-col gap-3">
        <DyApiError error={load.error} retryLeft={load.retryLeft} />
        {settings === null ? (
          load.error === null ? (
            <SkeletonRows label={t.loading} rows={2} />
          ) : null
        ) : (
          <>
            {!settings.available ? (
              <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="context-search-unavailable">
                {t.unavailable}
              </p>
            ) : (
              <>
                <p className="m-0 text-[0.8125rem] text-dy-muted">
                  {t.captureLead}
                  <span className="font-dy-mono">{settings.namespace}</span>
                  {t.captureMiddle({ jobs: project !== null })}
                  <span className="font-dy-mono">{settings.model}</span>
                  {t.captureTail}
                </p>
                <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="context-search-provider">
                  {t.provider}
                  <span className="font-dy-mono">{settings.provider ?? t.unknown}</span>
                  {t.model}
                  <span className="font-dy-mono">{settings.model}</span>
                  {settings.dims === null ? '' : t.dims({ n: settings.dims })}
                  {settings.region === null ? (
                    ''
                  ) : (
                    <>
                      {t.region}
                      <span className="font-dy-mono">{settings.region}</span>
                    </>
                  )}
                  {settings.source === null ? '' : t.sourceLine({ source: sourceText(t, settings.source) })}
                  {t.providerTail}
                </p>
                <p
                  className="m-0 flex flex-wrap items-center gap-2 text-[0.875rem]"
                  data-testid="context-search-status"
                >
                  <Pill
                    tone={settings.enabled ? 'green' : 'neutral'}
                    icon={settings.enabled ? 'checkc' : 'pause'}
                  >
                    {settings.enabled ? t.captureOn : t.captureOff}
                  </Pill>
                  <span>{t.indexed({ n: settings.indexed })}</span>
                  {settings.origin === 'platform_default' ? (
                    <span className="text-[0.8125rem] text-dy-muted">{t.originDefault}</span>
                  ) : settings.origin === 'create' ? (
                    <span className="text-[0.8125rem] text-dy-muted">{t.originCreate}</span>
                  ) : null}
                </p>
                {props.isAdmin ? (
                  <div className="flex flex-wrap gap-2">
                    <DyButton
                      variant={settings.enabled ? 'secondary' : 'primary'}
                      busy={act.busy}
                      onClick={() => {
                        setNotice(null);
                        void privileged(async () => {
                          const next = await setSearchConsent({
                            namespace: settings.namespace,
                            enabled: !settings.enabled,
                            expectedVersion: settings.version,
                          });
                          setSettings(next);
                          setFound(null);
                          setNotice(next.enabled ? t.allowed : t.stopped);
                        }, t.consentStepUp);
                      }}
                    >
                      {settings.enabled ? t.stop : t.allow}
                    </DyButton>
                    {settings.enabled ? (
                      <DyButton
                        icon="retry"
                        busy={act.busy}
                        onClick={() => {
                          setNotice(null);
                          void privileged(async () => {
                            const r = await reindexSearch(settings.namespace);
                            setSettings(await getSearchSettings(settings.namespace));
                            setNotice(t.rebuilt({ docs: r.indexedDocs, jobs: r.indexedJobs }));
                          }, t.reindexStepUp);
                        }}
                      >
                        {t.reindex}
                      </DyButton>
                    ) : null}
                  </div>
                ) : null}
                <DyApiError error={act.error} retryLeft={act.retryLeft} />
                {notice !== null ? (
                  <DyNotice tone="green" live>
                    <span data-testid="context-search-notice">{notice}</span>
                  </DyNotice>
                ) : null}
              </>
            )}
            {project !== null ? (
              <form
                className="flex flex-col gap-2 sm:flex-row sm:items-end"
                onSubmit={onSearch}
                role="search"
              >
                <DyField label={t.field} value={q} maxLength={500} onChange={setQ} wrapClassName="flex-1" />
                <DyButton type="submit" icon="search" busy={find.busy} disabled={q.trim() === ''}>
                  {t.button}
                </DyButton>
              </form>
            ) : (
              <p className="m-0 text-[0.8125rem] text-dy-muted">{t.perProject}</p>
            )}
            <DyApiError error={find.error} retryLeft={find.retryLeft} />
            {found === null ? null : (
              <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="context-search-mode">
                {found.mode === 'semantic'
                  ? t.semantic
                  : t.keywords({
                      why: found.fallbackReason === null ? '' : fallbackText(t, found.fallbackReason),
                    })}
              </p>
            )}
            {found === null ? null : found.items.length === 0 ? (
              <EmptyLine>{t.noMatch}</EmptyLine>
            ) : (
              <ol className="m-0 flex list-none flex-col gap-2 p-0" data-testid="context-search-results">
                {found.items.map((h) => (
                  <li
                    key={`${h.type}:${h.id}`}
                    className="rounded-[10px] border border-dy-line p-3"
                    data-testid="context-search-hit"
                  >
                    <div className="flex flex-wrap items-baseline gap-2 text-[0.875rem]">
                      <span className="font-bold [overflow-wrap:anywhere]">{h.title}</span>
                      <span className="text-[0.78125rem] text-dy-muted">
                        {h.type === 'context_doc'
                          ? t.hitDoc({ namespace: h.namespace, version: h.version })
                          : h.type === 'chat_message' && h.chat !== undefined
                            ? t.hitChat({
                                assistant: h.chat.author === 'assistant',
                                date: h.chat.at.slice(0, 10),
                              })
                            : t.hitJob}
                      </span>
                      <span className="ml-auto font-dy-mono text-[0.75rem] text-dy-muted tabular-nums">
                        {h.score.toFixed(3)}
                      </span>
                    </div>
                    <p className="m-0 mt-1 text-[0.8125rem] whitespace-pre-wrap text-dy-muted [overflow-wrap:anywhere]">
                      {h.snippet}
                    </p>
                    {h.chat?.threadId != null ? (
                      <Link
                        to={`/chat/${h.chat.threadId}`}
                        className="text-[0.8125rem] font-medium text-dy-teal-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
                      >
                        {t.openChat}
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}

/** p10-semantic-defaults-chat: what the create-project form pre-checks (owners / admins; step-up). */
export function KnowledgeDefaultsPanel(): ReactNode {
  const t = useT().knowledge.defaults;
  const [d, setD] = useState<KnowledgeDefaults | null>(null);
  const [capture, setCapture] = useState(true);
  const [mode, setMode] = useState<KnowledgeDefaults['memoryMode']>('rules');
  const [saved, setSaved] = useState(false);
  const load = useSubmit();
  const save = useSubmit();
  const stepUp = useStepUp();
  const loadRun = load.run;
  useEffect(() => {
    void loadRun(async () => {
      const v = await getKnowledgeDefaults();
      setD(v);
      setCapture(v.projectCapture);
      setMode(v.memoryMode);
    });
  }, [loadRun]);
  // An older master (no defaults route) or a failed read: left out rather than shown broken (classic).
  if (load.error !== null) return null;
  return (
    <Panel title={t.title} sub={t.sub} testId="dy-knowledge-defaults">
      {d === null ? (
        <SkeletonRows label={t.loading} rows={2} />
      ) : (
        <div className="flex flex-col gap-3">
          <DyCheck label={t.capture} hint={t.captureHint} checked={capture} onChange={setCapture} />
          <DySelect
            label={t.memory}
            value={mode}
            className="sm:max-w-sm"
            options={[
              ['rules', t.rules],
              ['assisted', t.assisted],
              ['off', t.off],
            ]}
            onChange={(v) => {
              setMode(v === 'assisted' ? 'assisted' : v === 'off' ? 'off' : 'rules');
            }}
          />
          <FormActions>
            <DyButton
              variant="primary"
              busy={save.busy}
              onClick={() => {
                setSaved(false);
                void save.run(async () => {
                  try {
                    const next = await stepUp.run(
                      () =>
                        putKnowledgeDefaults({
                          projectCapture: capture,
                          memoryMode: mode,
                          expectedVersion: d.version,
                        }),
                      t.stepUp,
                    );
                    setD(next);
                    setSaved(true);
                  } catch (err) {
                    if (!(err instanceof StepUpCancelledError)) throw err;
                  }
                });
              }}
            >
              {t.save}
            </DyButton>
            {saved ? (
              <span role="status" className="text-[0.8125rem] font-medium text-dy-green">
                {t.saved}
              </span>
            ) : null}
          </FormActions>
          <DyApiError error={save.error} retryLeft={save.retryLeft} />
        </div>
      )}
    </Panel>
  );
}
