import type { ReactNode } from 'react';
import type { PackageCaches } from '../../../../api/fleet';
import { machinePath } from '../../../../screens/fleet/machineLinks';
import { formatBytes } from '../../../../screens/fleet/cacheBytes';
import { DyButtonLink, Meter, Panel, Row, Rows } from '../../parts';
import type { Formatter, Messages } from '@remyral/i18n';
import { useFormat, useT } from '../../../../i18n/I18nProvider';
import { DATE_TIME_NUMERIC } from '../../../common/time';

/**
 * p12-diyalog wave 2 (W3) — Makine → Genel bakış → Paket önbellekleri (p6-warm-caches, ADR-0029) in the Diyalog
 * language. Read-only, like the classic `PackageCachesCard`: on / off and why, use against the limit as a meter, the
 * projects holding a cache (per package manager, in use, last use), the last eviction and the scan time; admins get
 * the way to the Configuration tab where the limit lives.
 */

/** Package manager product names (not translated). */
const MANAGER: Readonly<Record<string, string>> = {
  npm: 'npm',
  pnpm: 'pnpm',
  yarn: 'Yarn', // i18n-ignore
  'yarn-berry': 'Yarn Berry', // i18n-ignore
  pip: 'pip',
  uv: 'uv',
  cargo: 'Cargo', // i18n-ignore
  go: 'Go', // i18n-ignore
};

export function cacheSummaryText(
  t: Messages['machineAdmin']['caches'],
  fmt: Formatter,
  c: PackageCaches,
): string {
  if (!c.enabled) return c.disabledReason === 'local_config' ? t.offLocal : t.offZero;
  const pct = c.maxBytes > 0 ? Math.min(100, Math.round((c.usedBytes / c.maxBytes) * 100)) : 0;
  return t.summary({
    max: formatBytes(c.maxBytes),
    used: formatBytes(c.usedBytes),
    pct: fmt.percent(pct / 100),
    projects: c.projects.length,
  });
}

export function CachesPanel(props: {
  readonly workerId: string;
  readonly caches: PackageCaches | null;
  readonly isAdmin: boolean;
}): ReactNode {
  const fmt = useFormat();
  const all = useT().machineAdmin;
  const t = all.caches;
  const c = props.caches;
  const pct = c !== null && c.enabled && c.maxBytes > 0 ? (c.usedBytes / c.maxBytes) * 100 : null;
  return (
    <Panel
      title={t.title}
      sub={t.sub}
      aside={
        props.isAdmin && c !== null ? (
          <DyButtonLink to={machinePath(props.workerId, 'configuration')}>{t.changeLimit}</DyButtonLink>
        ) : undefined
      }
      flush
      testId="package-caches"
    >
      {c === null ? (
        <p className="m-0 px-4 pb-4 text-[0.875rem] text-dy-muted">{t.notReported}</p>
      ) : (
        <>
          <div className="flex flex-col gap-2 px-4 pb-3">
            <p className="m-0 text-[0.875rem] font-bold" data-testid="package-caches-summary">
              {cacheSummaryText(t, fmt, c)}
            </p>
            {pct !== null ? (
              <Meter
                label={t.meter}
                showLabel={false}
                value={pct}
                text={fmt.percent(Math.round(pct) / 100)}
                tone={pct >= 90 ? 'amber' : 'teal'}
              />
            ) : null}
          </div>
          {c.projects.length > 0 ? (
            <Rows label={t.projects} testId="package-caches-projects">
              {c.projects.map((p) => (
                <Row
                  key={p.projectId}
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-dy-mono">{p.projectId}</span>
                      {p.inUse ? (
                        <span className="text-[0.75rem] font-bold text-dy-teal-ink">{t.inUse}</span>
                      ) : null}
                    </span>
                  }
                  meta={
                    <>
                      {p.managers.length > 0 ? (
                        <span>
                          {p.managers
                            .map((m) => `${MANAGER[m.manager] ?? m.manager} ${formatBytes(m.bytes)}`)
                            .join(', ')}
                        </span>
                      ) : null}
                      <span>{t.lastUsed({ at: fmt.dateWith(p.lastUsedAt, DATE_TIME_NUMERIC) })}</span>
                    </>
                  }
                  trail={
                    <span className="font-dy-mono text-[0.8125rem] text-dy-muted tabular-nums">
                      {formatBytes(p.bytes)}
                    </span>
                  }
                />
              ))}
            </Rows>
          ) : null}
          <div className="flex flex-col gap-1 border-t border-dy-line px-4 py-3 text-[0.8125rem] text-dy-muted">
            {c.truncated ? <p className="m-0">{t.truncated}</p> : null}
            <p className="m-0">
              {c.lastEviction === null
                ? t.noEviction
                : t.eviction({
                    at: fmt.dateWith(c.lastEviction.at, DATE_TIME_NUMERIC),
                    projects: c.lastEviction.projects,
                    bytes: formatBytes(c.lastEviction.bytes),
                  })}
              {c.scannedAt === null ? '' : t.scanned({ at: fmt.dateWith(c.scannedAt, DATE_TIME_NUMERIC) })}
            </p>
            {props.isAdmin ? <p className="m-0">{t.projectPolicy}</p> : null}
          </div>
        </>
      )}
    </Panel>
  );
}
