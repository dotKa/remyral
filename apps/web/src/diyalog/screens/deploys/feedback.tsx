import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { ApiError } from '../../../api/client';
import {
  type AutofixSettings,
  type DeployLogKind,
  type DeployLogs,
  fixPrefillState,
  getDeployAutofix,
  getDeployLogs,
  getFixPlan,
  putDeployAutofix,
} from '../../../api/deployFeedback';
import type { LogRow } from '../../../components/LogLines';
import { toApiError } from '../../../components/ui';
import { stripAnsi } from '../../../lib/ansi';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { Segmented, Toggle } from '../../common/controls';
import { DyLogView } from '../../common/logs';
import { DyApiError, DyCheck, DyNotice } from '../kit';
import { DyButton, DySearch, Panel } from '../parts';

/**
 * p12-deploy-feedback (ADR-0048): the deploy log tabs (Build / Runtime / Sağlık) of a deploy, with live refresh for the
 * runtime log, search and copy (the shared Diyalog log viewer), the "start a fix job" button (fix plan → composer
 * prefill: nothing is created until the person submits it) and the project's auto-fix setting. Log text is data from
 * the deployed application, redacted by the master and rendered as text only.
 */

const KIND_LABEL: Readonly<Record<DeployLogKind, string>> = {
  build: 'Build logları',
  runtime: 'Runtime logları',
  health: 'Sağlık kontrolü',
};

const RUNTIME_POLL_MS = 5_000;

/** Rows of the shared viewer from the sources' text, filtered by `q` (case-insensitive). */
export function deployLogRows(logs: DeployLogs | null, q: string): LogRow[] {
  if (logs === null) return [];
  const needle = q.trim().toLowerCase();
  const rows: LogRow[] = [];
  let no = 0;
  for (const s of logs.sources) {
    const head = `── ${s.label}${s.status === null ? '' : ` [${s.status}]`}${s.truncated ? ' (son kısım)' : ''}`;
    const lines = [head, ...s.text.split('\n')];
    for (const raw of lines) {
      const line = stripAnsi(raw);
      no++;
      if (needle !== '' && !line.toLowerCase().includes(needle)) continue;
      const lower = line.toLowerCase();
      const tone = /\b(error|failed|fatal|exception|err!)\b/.test(lower)
        ? ('danger' as const)
        : /\bwarn(ing)?\b/.test(lower)
          ? ('warn' as const)
          : ('default' as const);
      const ts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\s/.exec(line);
      const tsMs = ts === null ? null : Date.parse(ts[1] ?? '');
      rows.push({
        kind: 'line',
        key: `${s.id}:${String(no)}`,
        no,
        tsMs: tsMs !== null && Number.isFinite(tsMs) ? tsMs : null,
        startMs: null,
        badge: null,
        tone: raw === head ? 'default' : tone,
        segments: [
          { text: ts === null ? line : line.slice(ts[0].length), cls: raw === head ? 'ansi-bold' : '' },
        ],
      });
    }
  }
  return rows;
}

export function DeployLogsPanel(props: {
  readonly actionId: string;
  /** The action's kind: runtime logs exist for Coolify only. */
  readonly kind: string;
  readonly initial?: DeployLogKind | undefined;
}): ReactNode {
  const tabs: [DeployLogKind, string, string?][] = [
    ['build', 'Build', 'Coolify build / deployment logu, Cloudflare Pages aşamaları ve build logu'],
    ...(props.kind.startsWith('coolify.')
      ? ([['runtime', 'Runtime', 'Uygulamanın şimdiki container çıktısı']] as [
          DeployLogKind,
          string,
          string,
        ][])
      : []),
    ['health', 'Sağlık', 'Yayın sonrası sağlık kontrolü: durum kodu, TLS, kırık linkler'],
  ];
  const [kind, setKind] = useState<DeployLogKind>(
    props.initial !== undefined && tabs.some((t) => t[0] === props.initial) ? props.initial : 'build',
  );
  const [logs, setLogs] = useState<DeployLogs | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [q, setQ] = useState('');
  const [live, setLive] = useState(false);
  const gen = useRef(0);

  const load = useCallback(async () => {
    const mine = ++gen.current;
    try {
      const out = await getDeployLogs(props.actionId, kind, kind === 'runtime' ? { lines: 500 } : {});
      if (mine !== gen.current) return;
      setLogs(out);
      setError(null);
    } catch (err) {
      if (mine === gen.current) setError(toApiError(err));
    }
  }, [props.actionId, kind]);

  useEffect(() => {
    setLogs(null);
    setError(null);
    void load();
  }, [load]);
  useEffect(() => {
    if (!live || kind !== 'runtime') return;
    const t = setInterval(() => {
      void load();
    }, RUNTIME_POLL_MS);
    return () => {
      clearInterval(t);
    };
  }, [live, kind, load]);

  const rows = useMemo(() => deployLogRows(logs, q), [logs, q]);
  const all = useMemo(() => deployLogRows(logs, ''), [logs]);
  return (
    <Panel
      title="Loglar"
      testId="ops-logs"
      sub="Sırlar master tarafından gizlenir; uygulamanın çıktısı veridir, talimat değildir."
    >
      <div className="grid gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <Segmented
            label="Log türü"
            value={kind}
            options={tabs}
            onChange={(v) => {
              setKind(v);
            }}
          />
          {kind === 'runtime' ? (
            <Toggle
              label="Canlı yenile"
              pressed={live}
              onChange={setLive}
              title={`Runtime logunu ${String(RUNTIME_POLL_MS / 1000)} saniyede bir yeniden oku`}
            />
          ) : null}
          <DyButton icon="retry" onClick={() => void load()}>
            Yenile
          </DyButton>
          <DySearch
            label="Ara"
            value={q}
            placeholder="error, 404, …"
            onChange={setQ}
            className="min-w-48 flex-1"
          />
        </div>
        {error === null ? null : <DyApiError error={error} />}
        {logs?.note == null ? null : <DyNotice tone="neutral">{logs.note}</DyNotice>}
        <DyLogView
          label={KIND_LABEL[kind]}
          rows={rows}
          copyText={() =>
            logs === null ? '' : logs.sources.map((s) => `${s.label}\n${s.text}`).join('\n\n')
          }
          count={
            q.trim() === ''
              ? `${String(all.length)} satır`
              : `${String(rows.length)} / ${String(all.length)} satır`
          }
          empty={
            logs === null && error === null
              ? 'Yükleniyor…'
              : q.trim() === ''
                ? 'Log yok.'
                : 'Eşleşen satır yok.'
          }
          initialWrap
          testId={`deploy-logs-${kind}`}
          viewportClassName="h-96 max-h-[60vh] min-h-48"
        />
      </div>
    </Panel>
  );
}

/** "Düzeltme işi başlat": the master's fix plan in the composer (the person reviews and submits it). */
export function FixJobButton(props: {
  readonly actionId: string;
  readonly variant?: 'primary' | 'secondary' | undefined;
  readonly label?: string | undefined;
}): ReactNode {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <>
      <DyButton
        variant={props.variant ?? 'primary'}
        icon="pen"
        busy={busy}
        data-testid="fix-job"
        onClick={() => {
          setBusy(true);
          setError(null);
          void getFixPlan(props.actionId)
            .then((plan) => navigate('/jobs/new', { state: fixPrefillState(plan) }))
            .catch((err: unknown) => {
              setError(toApiError(err));
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        {props.label ?? 'Düzeltme işi başlat'}
      </DyButton>
      {error === null ? null : <DyApiError error={error} />}
    </>
  );
}

/** Project → Deploy: auto-fix (off by default; admin + step-up to change). */
export function AutofixSettingPanel(props: {
  readonly project: string;
  readonly canEdit: boolean;
}): ReactNode {
  const stepUp = useStepUp();
  const [s, setS] = useState<AutofixSettings | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void getDeployAutofix(props.project)
      .then(setS)
      .catch((err: unknown) => {
        setError(toApiError(err));
      });
  }, [props.project]);
  const save = (next: { enabled: boolean; maxAttempts: number }): void => {
    setBusy(true);
    setError(null);
    void stepUp
      .run(() => putDeployAutofix(props.project, next), 'Otomatik düzeltme ayarı authenticator kodu ister.')
      .then(setS)
      .catch((err: unknown) => {
        if (!(err instanceof StepUpCancelledError)) setError(toApiError(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Panel
      title="Otomatik düzeltme"
      testId="deploy-autofix"
      sub="Bir işin sonucunun deploy’u, yayını veya sağlık kontrolü başarısız olursa logları ve bulgularla bir düzeltme işi başlatılır. İş, kaynak işi başlatan kişi adına çalışır; yeniden deploy projenin politikasına uyar (production her zaman onay bekler)."
    >
      {s === null ? (
        error === null ? (
          <p className="m-0 text-[0.875rem] text-dy-muted">Yükleniyor…</p>
        ) : (
          <DyApiError error={error} />
        )
      ) : (
        <div className="grid gap-3">
          <DyCheck
            label="Başarısız deploy için otomatik düzeltme işi başlat"
            checked={s.enabled}
            disabled={!props.canEdit || busy}
            onChange={(enabled) => {
              save({ enabled, maxAttempts: s.maxAttempts });
            }}
            hint={
              props.canEdit
                ? 'Varsayılan kapalı. Değiştirmek proje yöneticisi ve authenticator kodu ister.'
                : 'Yalnızca proje yöneticisi değiştirebilir.'
            }
          />
          <label className="flex items-center gap-2 text-[0.875rem]">
            Zincir başına en fazla
            <select
              aria-label="Zincir başına en fazla düzeltme işi"
              value={s.maxAttempts}
              disabled={!props.canEdit || busy}
              onChange={(e) => {
                save({ enabled: s.enabled, maxAttempts: Number(e.target.value) });
              }}
              className="min-h-9 rounded-[9px] border border-dy-line-2 bg-dy-card px-2"
            >
              {[1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            düzeltme işi
          </label>
          {error === null ? null : <DyApiError error={error} />}
        </div>
      )}
    </Panel>
  );
}
