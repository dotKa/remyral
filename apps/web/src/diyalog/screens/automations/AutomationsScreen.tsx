import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { type Automation, listAutomations } from '../../../api/automations';
import type { ApiError } from '../../../api/client';
import { toApiError } from '../../../components/ui';
import { useClientPage, withoutPage } from '../../../lib/pager';
import { DySortBar, sortRows, useSortParam } from '../../common/sort';
import { DyIcon } from '../../icons';
import { DyPager, Fact } from '../kit';
import { ScreenFrame } from '../ScreenFrame';
import {
  agoText,
  DyButtonLink,
  DySelect,
  EmptyLine,
  ErrorLine,
  Panel,
  Row,
  Rows,
  SkeletonRows,
} from '../parts';
import { automationWord, percentText, TRIGGER_ICON, TRIGGER_TR, untilText } from './labels';
import { AutomationPill, RunPill, WaitingPill } from './shared';
import { GroupPill } from './GroupParts';
import { BindingPill } from './WorkflowBinding';
import { useT } from '../../../i18n/I18nProvider';
import { scheduleSummary } from '../../../lib/schedule';

/**
 * p12-diyalog-w2: Otomasyonlar (/automations) — every automation of the projects the viewer can see: what starts it,
 * the last run and how it went, the next run, the success rate, a run waiting for a person. Same request and
 * `?project=` filter as the classic page; client-side pages (`?page=&pageSize=`).
 */
const AUTOMATION_SORT_KEYS = ['name', 'rate'] as const;
const AUTOMATION_SORT_LABEL = { name: 'Ad', rate: 'Başarı' } as const;
const AUTOMATION_COMPARE = {
  name: (a: Automation, b: Automation): number => a.name.localeCompare(b.name),
  rate: (a: Automation, b: Automation): number => (a.successRate ?? -1) - (b.successRate ?? -1),
} as const;

export function AutomationsScreen(): ReactNode {
  const [params, setParams] = useSearchParams();
  const project = params.get('project') ?? '';
  const [items, setItems] = useState<Automation[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(() => {
    let live = true;
    listAutomations().then(
      (x) => {
        if (!live) return;
        setItems(x);
        setError(null);
      },
      (err: unknown) => {
        if (live) setError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, []);
  useEffect(load, [load]);

  const projects = useMemo(() => [...new Set((items ?? []).map((a) => a.project))].sort(), [items]);
  // The classic table's sortable columns (name, success rate), kept in the URL.
  const [sort, setSort] = useSortParam(AUTOMATION_SORT_KEYS);
  const rows = useMemo(
    () =>
      sortRows(
        (items ?? []).filter((a) => project === '' || a.project === project),
        sort,
        AUTOMATION_COMPARE,
      ),
    [items, project, sort],
  );
  const { pageItems, pagination } = useClientPage(rows, { label: 'Otomasyon sayfaları' });
  const active = rows.filter((a) => a.state === 'active').length;
  const waiting = rows.filter((a) => a.waiting !== null).length;
  const stopped = rows.filter((a) => a.state === 'failed').length;

  return (
    <ScreenFrame
      title="Otomasyonlar"
      purpose="Bir takvimde, GitHub olaylarında, imzalı bir webhook çağrısında ya da başka bir otomasyondan sonra başlayan işler — ve çalıştırmalarının nasıl geçtiği."
      testId="dy-automations"
      actions={
        <DyButtonLink to="/automations/new" variant="primary" icon="plus">
          Yeni otomasyon
        </DyButtonLink>
      }
      facts={
        items === null ? null : (
          <>
            <Fact label="Açık">{active}</Fact>
            {waiting > 0 ? (
              <Fact label="Onay bekleyen" tone="amber">
                {waiting}
              </Fact>
            ) : null}
            {stopped > 0 ? (
              <Fact label="Durdurulan" tone="red">
                {stopped}
              </Fact>
            ) : null}
          </>
        )
      }
    >
      <ErrorLine error={error} what="Otomasyonlar" onRetry={load} />
      {projects.length > 1 ? (
        <div className="mb-4 max-w-[320px]">
          <DySelect
            label="Proje"
            value={project}
            options={[['', 'Tüm projeler'], ...projects.map((p) => [p, p] as const)]}
            onChange={(value) => {
              setParams(
                (prev) => {
                  const next = withoutPage(prev);
                  if (value === '') next.delete('project');
                  else next.set('project', value);
                  return next;
                },
                { replace: true },
              );
            }}
          />
        </div>
      ) : null}
      <Panel
        title="Otomasyonlar"
        count={items === null ? undefined : String(rows.length)}
        countLabel={`${String(rows.length)} otomasyon`}
        flush
      >
        {items === null && error === null ? <SkeletonRows label="Otomasyonlar yükleniyor" /> : null}
        {items !== null && rows.length === 0 ? (
          <EmptyLine
            testId="automations-empty"
            action={
              <DyButtonLink to="/automations/new" icon="plus">
                Yeni otomasyon
              </DyButtonLink>
            }
          >
            Henüz otomasyon yok. Her gece bir iş, her pull request’te bir inceleme, başka bir sistem çağırınca
            ya da başka bir otomasyon bitince bir iş çalıştırabilirsin. Sohbet’te asistandan da kurmasını
            isteyebilirsin.
          </EmptyLine>
        ) : null}
        {items !== null && rows.length > 0 ? (
          <>
            <DySortBar
              keys={AUTOMATION_SORT_KEYS}
              labels={AUTOMATION_SORT_LABEL}
              sort={sort}
              onSort={setSort}
              defaultNote="Sunucu sırası"
              sortedNote="Tüm otomasyonlar sıralı"
              className="border-b border-dy-line"
              testId="automation-sort"
            />
            <Rows label="Otomasyonlar" testId="automations-list">
              {pageItems.map((a) => (
                <AutomationRow key={a.id} a={a} />
              ))}
            </Rows>
          </>
        ) : null}
        {items !== null ? <DyPager {...pagination} /> : null}
      </Panel>
    </ScreenFrame>
  );
}

function AutomationRow(props: { readonly a: Automation }): ReactNode {
  const { a } = props;
  const w = automationWord(a.state);
  // p16-workflow-quality: "her saat başı · Europe/Istanbul".
  const schedule = scheduleSummary(a, useT().workflowQuality.schedule);
  return (
    <Row
      testId="automation-row"
      tone={w.tone === 'neutral' ? undefined : w.tone}
      lead={
        <span title={TRIGGER_TR[a.trigger.kind] ?? a.trigger.kind}>
          <DyIcon name={TRIGGER_ICON[a.trigger.kind] ?? 'clock'} className="size-[18px]" />
        </span>
      }
      title={
        <span className="flex flex-wrap items-center gap-2">
          <Link
            to={`/automations/${encodeURIComponent(a.id)}`}
            className="text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
          >
            {a.name}
          </Link>
          <AutomationPill state={a.state} />
          <BindingPill automation={a} />
          <GroupPill automation={a} />
          {a.waiting !== null ? <WaitingPill waiting={a.waiting} /> : null}
        </span>
      }
      meta={
        <>
          <span data-testid="automation-trigger">{schedule}</span>
          <span>{a.project}</span>
          <span>{a.nextRunAt === null ? 'Sıradaki yok' : `Sıradaki ${untilText(a.nextRunAt)}`}</span>
        </>
      }
      trail={
        <span className="flex flex-wrap items-center gap-3 sm:justify-end">
          {a.lastRun === null ? (
            <span className="text-[0.8125rem] text-dy-muted" data-testid="automation-last">
              Hiç çalışmadı
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5" data-testid="automation-last">
              <RunPill state={a.lastRun.state} />
              <span className="text-[0.8125rem] text-dy-muted">{agoText(a.lastRun.at)}</span>
            </span>
          )}
          <span className="min-w-[4.5rem] text-right" title="Son 20 biten çalıştırmanın başarı oranı">
            <span className="block text-[0.75rem] text-dy-muted">Başarı</span>
            <span className="font-dy-mono text-[0.84375rem] tabular-nums" data-testid="automation-rate">
              {percentText(a.successRate)}
            </span>
          </span>
        </span>
      }
    />
  );
}
