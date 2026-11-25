import { useErrorText } from '../../../i18n/errors';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ApiError } from '../../../api/client';
import {
  listSuggestions,
  listTemplates,
  type Suggestion,
  suggestionFeedback,
  type Template,
} from '../../../api/templates';
import { cx, toApiError } from '../../../components/ui';
import { useResetPageOn } from '../../../lib/pageReset';
import { useClientPage } from '../../../lib/pager';
import { useNow } from '../../../lib/now';
import { refineState, type SuggestionPrefill } from '../../../screens/templates/suggestions';
import { DyIcon } from '../../icons';
import {
  agoText,
  DyButton,
  DyButtonLink,
  DySearch,
  EmptyLine,
  ErrorLine,
  Panel,
  Pill,
  Row,
  Rows,
  SkeletonRows,
} from '../parts';
import { ScreenFrame } from '../ScreenFrame';
import { Pager, PARAM_TYPE_TR, ScopePill, statsText } from './parts';
import { LibraryFilter, LibraryPills, type LibraryScope, useReadableProjects } from './LibraryParts';

/**
 * p12-diyalog-w1: `/jobs/templates` in the Diyalog language — saved templates (project and global) with their usage,
 * and the suggestions the server found among recent jobs and chat drafts ("Şablon oluştur" opens the form prefilled,
 * "Gizle" / "Benzer değil" teach it, "Ajanla iyileştir" only prefills the composer). Same calls as the classic page.
 */

type Shown = 'active' | 'archived';
type Sort = 'updated' | 'title';

function SuggestionCard(props: {
  readonly s: Suggestion;
  readonly now: number;
  readonly onDone: () => void;
}): ReactNode {
  const sayError = useErrorText();
  const { s } = props;
  const navigate = useNavigate();
  const [busy, setBusy] = useState<'dismiss' | 'not' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const feedback = async (kind: 'dismissed' | 'not_similar'): Promise<void> => {
    setBusy(kind === 'dismissed' ? 'dismiss' : 'not');
    setError(null);
    try {
      await suggestionFeedback({
        project: s.project,
        suggestionId: s.id,
        kind,
        ...(kind === 'not_similar' ? { members: s.members.map((m) => `${m.kind}:${m.id}`) } : {}),
      });
      props.onDone();
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <article
      data-testid="dy-suggestion"
      aria-label={`Öneri: ${s.title}`}
      className="flex min-w-0 flex-col gap-2.5 rounded-[12px] border border-dy-line bg-dy-card p-3.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="m-0 min-w-0 text-[0.9375rem] font-bold [overflow-wrap:anywhere]">{s.title}</h3>
        <ScopePill project={s.project} />
        <span className="text-[0.78125rem] text-dy-muted">
          {`${String(s.occurrences)} kez görüldü · son ${agoText(s.lastSeenAt, props.now)}`}
        </span>
      </div>
      <pre className="m-0 max-h-36 overflow-auto rounded-[9px] bg-dy-sunk px-3 py-2 font-dy-mono text-[0.78125rem] whitespace-pre-wrap [overflow-wrap:anywhere]">
        {s.prompt}
      </pre>
      {s.parameters.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[0.8125rem] text-dy-muted">
          {s.parameters.map((p) => {
            const ex = (p.examples ?? [])
              .filter((x) => x !== '')
              .slice(0, 3)
              .map((x) => (x.length > 40 ? `${x.slice(0, 39)}…` : x));
            return (
              <li key={p.name} className="[overflow-wrap:anywhere]">
                <span className="font-dy-mono text-dy-ink">{`{{${p.name}}}`}</span> {PARAM_TYPE_TR[p.type]}
                {ex.length > 0 ? ` — örn. ${ex.join(', ')}` : ''}
              </li>
            );
          })}
        </ul>
      ) : null}
      <details className="text-[0.8125rem] text-dy-muted">
        <summary className="cursor-pointer select-none">{`${String(s.members.length)} kayıttan çıkarıldı`}</summary>
        <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">
          {s.members.map((m) => (
            <li key={`${m.kind}:${m.id}`} className="[overflow-wrap:anywhere]">
              {m.kind === 'job' ? (
                <Link className="text-dy-teal-ink hover:underline" to={`/jobs/${encodeURIComponent(m.id)}`}>
                  {m.title || m.id.slice(0, 8)}
                </Link>
              ) : (
                <span>{`Sohbet taslağı: ${m.title}`}</span>
              )}
            </li>
          ))}
        </ul>
      </details>
      {error === null ? null : (
        <p role="alert" className="m-0 text-[0.8125rem] text-dy-red-ink">
          {sayError(error)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <DyButton
          variant="primary"
          icon="plus"
          onClick={() => {
            void navigate('/jobs/templates/new', { state: { suggestion: s } satisfies SuggestionPrefill });
          }}
        >
          Şablon oluştur
        </DyButton>
        <DyButton
          busy={busy === 'dismiss'}
          disabled={busy !== null}
          onClick={() => void feedback('dismissed')}
        >
          Gizle
        </DyButton>
        <DyButton
          variant="ghost"
          busy={busy === 'not'}
          disabled={busy !== null}
          onClick={() => void feedback('not_similar')}
        >
          Benzer değil
        </DyButton>
        <DyButton
          variant="ghost"
          icon="brain"
          title="Kendi başına hiçbir şey başlatmaz: bu şablonu bir ajanın iyileştirmesi için formu doldurur"
          onClick={() => {
            void navigate('/jobs/new', { state: refineState(s) });
          }}
        >
          Ajanla iyileştir…
        </DyButton>
      </div>
    </article>
  );
}

function SegToggle<T extends string>(props: {
  readonly label: string;
  readonly value: T;
  readonly items: readonly (readonly [T, string])[];
  readonly onChange: (v: T) => void;
}): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[0.8125rem] font-bold" aria-hidden="true">
        {props.label}
      </span>
      <div
        role="group"
        aria-label={props.label}
        className="inline-flex w-fit gap-0.5 rounded-[10px] border border-dy-line bg-dy-sunk p-[3px]"
      >
        {props.items.map(([v, l]) => (
          <button
            key={v}
            type="button"
            aria-pressed={props.value === v}
            onClick={() => {
              props.onChange(v);
            }}
            className={cx(
              'inline-flex min-h-[2.125rem] items-center rounded-[7px] px-3 text-[0.84375rem] font-medium whitespace-nowrap transition-colors duration-150',
              props.value === v
                ? 'bg-dy-card text-dy-ink shadow-dy-seg'
                : 'text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink',
            )}
          >
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

export function TemplatesList(): ReactNode {
  const now = useNow();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState<Shown>('active');
  const [sort, setSort] = useState<Sort>('updated');
  const [items, setItems] = useState<Template[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  // p18-multi-project W4: the library of one project (its own, global and shared templates; hidden ones on request).
  const projects = useReadableProjects();
  const [here, setHere] = useState('');
  const [scope, setScope] = useState<LibraryScope>('any');
  const [showHidden, setShowHidden] = useState(false);

  // The search is sent a moment after typing stops (the classic page reads on every change).
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(q.trim());
    }, 250);
    return () => {
      clearTimeout(t);
    };
  }, [q]);

  const load = useCallback(() => {
    setError(null);
    let live = true;
    listTemplates({
      state: shown,
      ...(query === '' ? {} : { q: query }),
      ...(here === '' ? {} : { project: here, hidden: showHidden ? 'include' : 'exclude' }),
    }).then(
      (r) => {
        if (live) setItems(r);
      },
      (err: unknown) => {
        if (!live) return;
        setError(toApiError(err));
        setItems([]);
      },
    );
    return () => {
      live = false;
    };
  }, [query, shown, here, showHidden]);
  const loadSuggestions = useCallback(() => {
    listSuggestions().then(setSuggestions, () => {
      setSuggestions([]);
    });
  }, []);
  useEffect(load, [load]);
  useEffect(loadSuggestions, [loadSuggestions]);

  const sorted = useMemo(
    () =>
      [...(items ?? [])]
        .filter((t) => here === '' || scope === 'any' || t.scope === scope)
        .sort((a, b) =>
          sort === 'title' ? a.title.localeCompare(b.title, 'tr') : b.updatedAt.localeCompare(a.updatedAt),
        ),
    [items, sort, here, scope],
  );
  const { pageItems, pagination } = useClientPage(sorted, { label: 'Şablon sayfaları' });
  useResetPageOn(`${shown}\u0000${query}\u0000${sort}\u0000${here}\u0000${scope}\u0000${String(showHidden)}`);

  return (
    <ScreenFrame
      title="Şablonlar"
      back={{ to: '/jobs', label: 'İşler' }}
      purpose="Parametreli, tekrar kullanılan işler: bir URL ya da sayı gir, çalıştır. Asistan da kullanır (“şablonu çalıştır”)."
      testId="dy-templates"
      actions={
        <DyButtonLink to="/jobs/templates/new" variant="primary" icon="plus">
          Yeni şablon
        </DyButtonLink>
      }
    >
      <div className="grid gap-4">
        <Panel
          title="Şablonlar"
          count={items === null ? undefined : String(items.length)}
          countLabel={items === null ? undefined : `${String(items.length)} şablon`}
          flush
          testId="dy-templates-list"
        >
          <div
            role="search"
            aria-label="Şablonları süz"
            className="flex flex-wrap items-end gap-3 border-b border-dy-line px-4 pt-1 pb-3"
          >
            <DySearch
              label="Ara"
              value={q}
              placeholder="Başlık, açıklama, etiket"
              onChange={setQ}
              className="w-full sm:w-64"
            />
            <SegToggle<Shown>
              label="Göster"
              value={shown}
              items={[
                ['active', 'Etkin'],
                ['archived', 'Arşivlenmiş'],
              ]}
              onChange={setShown}
            />
            <SegToggle<Sort>
              label="Sırala"
              value={sort}
              items={[
                ['updated', 'Son güncellenen'],
                ['title', 'Ada göre'],
              ]}
              onChange={setSort}
            />
            <LibraryFilter
              projects={projects}
              here={here}
              onHere={(v) => {
                setHere(v);
                setScope('any');
              }}
              scope={scope}
              onScope={setScope}
              showHidden={showHidden}
              onShowHidden={setShowHidden}
            />
          </div>
          <div className="px-4 pt-3 empty:hidden">
            <ErrorLine error={error} what="Şablonlar" onRetry={load} />
          </div>
          {items === null ? (
            <SkeletonRows label="Şablonlar yükleniyor" />
          ) : pageItems.length === 0 ? (
            <EmptyLine
              testId="templates-empty"
              action={
                shown === 'active' && query === '' ? (
                  <DyButtonLink to="/jobs/templates/new" icon="plus">
                    Yeni şablon
                  </DyButtonLink>
                ) : undefined
              }
            >
              {query !== ''
                ? `“${query}” ile eşleşen şablon yok.`
                : shown === 'archived'
                  ? 'Arşivlenmiş şablon yok.'
                  : 'Henüz şablon yok. Bir işi sayfasından (menü → Şablon olarak kaydet), sohbetteki taslak kartından kaydet ya da burada {{yer tutucularla}} yaz.'}
            </EmptyLine>
          ) : (
            <Rows label="Şablonlar" testId="dy-template-rows">
              {pageItems.map((t) => {
                const params = t.current.parameters.map((p) => p.name);
                return (
                  <Row
                    key={t.id}
                    testId="dy-template-row"
                    lead={<DyIcon name="file" className="size-[18px]" />}
                    title={
                      <Link
                        to={`/jobs/templates/${encodeURIComponent(t.id)}${here === '' ? '' : `?project=${encodeURIComponent(here)}`}`}
                        className="text-dy-ink no-underline hover:underline"
                      >
                        {t.title}
                      </Link>
                    }
                    meta={
                      <>
                        {t.description === '' ? null : (
                          <span className="line-clamp-1 w-full [overflow-wrap:anywhere]">
                            {t.description}
                          </span>
                        )}
                        <span data-testid="dy-template-usage">{statsText(t.stats)}</span>
                        {params.length > 0 ? (
                          <span className="font-dy-mono text-[0.75rem]">
                            {params.map((n) => `{{${n}}}`).join(' ')}
                          </span>
                        ) : null}
                      </>
                    }
                    trail={
                      <>
                        <ScopePill project={t.project} />
                        <LibraryPills t={t} />
                        {t.state === 'archived' ? (
                          <Pill tone="amber" icon="tray">
                            Arşivde
                          </Pill>
                        ) : null}
                        <span className="font-dy-mono text-[0.78125rem] text-dy-muted tabular-nums">
                          {`v${String(t.version)}`}
                        </span>
                        <span className="text-[0.78125rem] whitespace-nowrap text-dy-muted">
                          {agoText(t.updatedAt, now)}
                        </span>
                      </>
                    }
                  />
                );
              })}
            </Rows>
          )}
          {items !== null ? <Pager {...pagination} className="border-t border-dy-line" /> : null}
        </Panel>
        {/* p12-diyalog-default (visual tour): suggestions after the list — they arrive later and only sometimes, and above
            the list they pushed it down. */}
        {suggestions !== null && suggestions.length > 0 ? (
          <Panel
            title="Son işlerinden öneriler"
            count={String(suggestions.length)}
            countLabel={`${String(suggestions.length)} öneri`}
            sub="Bu istemler birkaç kez tekrarlandı. Metinler bu sunucuda karşılaştırıldı — model yok, hiçbir şey dışarı gönderilmedi."
            testId="dy-suggestions"
          >
            <div className="grid gap-3 lg:grid-cols-2">
              {suggestions.map((s) => (
                <SuggestionCard key={`${s.project}:${s.id}`} s={s} now={now} onDone={loadSuggestions} />
              ))}
            </div>
          </Panel>
        ) : null}
      </div>
    </ScreenFrame>
  );
}
