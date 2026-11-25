import { useErrorText } from '../../../i18n/errors';
import type { ReactNode } from 'react';
import type { ApiError } from '../../../api/client';
import type { PlacementPreview } from '../../../api/composer';
import { DyIcon } from '../../icons';
import { Note, Reason, Tag } from './fields';
import { VERDICT_TR } from './words';

/**
 * p12-diyalog-w1: "Nerede çalışır?" — the placement preview of the draft (the classic debounced
 * POST /jobs/placement-preview, newest draft wins): verdict in a word and a sentence, project issues and quota holds
 * with their fix, the ranked candidate machines and why every other machine is out.
 */
export function PlacementPanel(props: {
  readonly preview: PlacementPreview | null;
  readonly loading: boolean;
  readonly error: ApiError | null;
}): ReactNode {
  const sayError = useErrorText();
  const { preview, loading, error } = props;
  const names = new Map((preview?.workers ?? []).map((w) => [w.id, w.name]));
  const name = (id: string): string => names.get(id) ?? id;
  const p = preview?.placement ?? null;
  const v =
    p === null ? null : (VERDICT_TR[p.verdict] ?? { tone: 'amber' as const, label: p.verdict, text: '' });
  return (
    <section
      aria-labelledby="dy-where-heading"
      data-testid="placement-panel"
      className="grid gap-3 rounded-[14px] border border-dy-line bg-dy-card p-4 shadow-dy"
    >
      <div className="flex items-center justify-between gap-2">
        <h2
          id="dy-where-heading"
          className="m-0 flex items-center gap-2 text-[1rem] font-bold tracking-[-0.01em]"
        >
          <DyIcon name="cpu" className="size-4 text-dy-muted" />
          Nerede çalışır?
        </h2>
        {loading ? (
          <span role="status" className="dy-breathe text-[0.78125rem] text-dy-muted">
            kontrol ediliyor…
          </span>
        ) : null}
      </div>
      {error === null ? null : <Note tone="danger">Yerleşim okunamadı: {sayError(error)}</Note>}
      {preview === null ? (
        <p className="m-0 text-[0.84375rem] text-dy-muted">
          Hangi makinelerin çalıştırabileceğini görmek için bir proje seç.
        </p>
      ) : (
        <>
          {preview.issues.map((i) => (
            <div key={i.code} data-testid="placement-issue">
              <Reason
                reason={`${i.code}: ${i.message}`}
                tone="danger"
                context={{ runtime: p?.runtime ?? null }}
              />
            </div>
          ))}
          {p === null || v === null ? (
            <p className="m-0 text-[0.84375rem] text-dy-muted">Yerleşimi görmek için bir runtime seç.</p>
          ) : (
            <div className="grid gap-2.5" aria-live="polite">
              <div className="grid gap-1">
                <span>
                  <Tag tone={v.tone}>{v.label}</Tag>
                </span>
                <span
                  className="text-[0.84375rem] text-dy-muted"
                  data-testid="placement-verdict"
                  data-verdict={p.verdict}
                >
                  {v.text}
                </span>
              </div>
              {p.holds.map((h) => (
                <Reason key={h.code} reason={`${h.code}: ${h.message}`} context={{ runtime: p.runtime }} />
              ))}
              {p.candidates.length > 0 ? (
                <ol className="m-0 grid list-none gap-1 p-0" aria-label="Aday makineler">
                  {p.candidates.map((c, i) => (
                    <li
                      key={c.workerId}
                      data-testid="placement-candidate"
                      className="flex items-center justify-between gap-2 rounded-[9px] bg-dy-green-soft px-2.5 py-1.5 text-[0.8125rem]"
                    >
                      <span className="min-w-0 truncate font-bold text-dy-ink">
                        {i === 0 ? 'İlk tercih: ' : ''}
                        <span translate="no">{name(c.workerId)}</span>
                      </span>
                      <span className="shrink-0 font-dy-mono text-[0.75rem] text-dy-muted tabular-nums">
                        puan {c.score.toFixed(2)}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : null}
              {p.explanation !== null && p.candidates.length > 0 ? (
                <p className="m-0 text-[0.78125rem] text-dy-muted" data-testid="placement-explanation">
                  {p.explanation.charAt(0).toUpperCase()}
                  {p.explanation.slice(1)}.
                </p>
              ) : null}
              {p.rejected.length > 0 ? (
                <details className="group" open={p.candidates.length === 0}>
                  <summary className="cursor-pointer text-[0.8125rem] font-medium text-dy-teal-ink">
                    {`Diğer ${String(p.rejected.length)} makine neden değil?`}
                  </summary>
                  <ul className="m-0 mt-2 grid list-none gap-1.5 p-0">
                    {p.rejected.map((r) => (
                      <li
                        key={r.workerId}
                        className="rounded-[9px] border border-dy-line px-2.5 py-1.5 text-[0.8125rem]"
                        data-testid="placement-rejected"
                      >
                        <span className="font-bold" translate="no">
                          {name(r.workerId)}
                        </span>
                        <ul className="m-0 mt-1 grid list-none gap-1.5 p-0">
                          {r.reasons.map((x) => (
                            <li key={x.code}>
                              <Reason
                                compact
                                reason={`${x.code}: ${x.message}`}
                                context={{
                                  workerId: r.workerId,
                                  workerName: name(r.workerId),
                                  runtime: p.runtime,
                                }}
                              />
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          )}
        </>
      )}
    </section>
  );
}
