import { useEffect, useState } from 'react';
import { type CoolifyConnectionChoice, listProjectCoolifyConnections } from '../../api/coolifyConnections';
import { type Monitor, type MonitorType } from '../../api/uptime';

/**
 * p8-uptime: the New / Edit monitor form. One type at a time (http(s), tcp, Cloudflare Pages, Coolify app), inline
 * hints for the rules the master enforces (ports 80/443/8080/8443, interval ≥ 30 s — provider checks ≥ 60 s —,
 * keyword only with GET); the master validates everything again and its message is shown verbatim.
 */

interface FormState {
  project: string;
  name: string;
  type: MonitorType;
  url: string;
  method: 'GET' | 'HEAD';
  statusMin: string;
  statusMax: string;
  keyword: string;
  keywordMode: 'present' | 'absent';
  maxLatencyMs: string;
  maxRedirects: string;
  tlsWarnDays: string;
  host: string;
  port: string;
  pagesProject: string;
  env: 'production' | 'preview';
  coolifyUuid: string;
  /** p13-multi-coolify: the Coolify connection ('' = the master picks the project's target / default one). */
  coolifyConnection: string;
  intervalSec: string;
  timeoutMs: string;
  retries: string;
  paused: boolean;
}

function s(v: unknown, d = ''): string {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : d;
}

function initial(project: string, m: Monitor | null): FormState {
  const c = m?.config ?? {};
  const es = (typeof c.expectStatus === 'object' && c.expectStatus !== null ? c.expectStatus : {}) as Record<
    string,
    unknown
  >;
  const kw = (typeof c.keyword === 'object' && c.keyword !== null ? c.keyword : {}) as Record<
    string,
    unknown
  >;
  return {
    project: m?.project ?? project,
    name: m?.name ?? '',
    type: m?.type ?? 'http',
    url: s(c.url),
    method: c.method === 'HEAD' ? 'HEAD' : 'GET',
    statusMin: s(es.min, '200'),
    statusMax: s(es.max, '399'),
    keyword: s(kw.text),
    keywordMode: kw.mode === 'absent' ? 'absent' : 'present',
    maxLatencyMs: s(c.maxLatencyMs),
    maxRedirects: s(c.maxRedirects, '3'),
    tlsWarnDays: s(c.tlsWarnDays, '14'),
    host: s(c.host),
    port: s(c.port),
    pagesProject: s(c.project),
    env: c.env === 'preview' ? 'preview' : 'production',
    coolifyUuid: s(c.uuid),
    coolifyConnection: s(c.connection),
    intervalSec: String(m?.intervalSec ?? 60),
    timeoutMs: String(m?.timeoutMs ?? 10_000),
    retries: String(m?.retries ?? 1),
    paused: m?.paused ?? false,
  };
}

function configOf(f: FormState): Record<string, unknown> {
  switch (f.type) {
    case 'http':
      return {
        url: f.url.trim(),
        method: f.method,
        expectStatus: { min: Number(f.statusMin), max: Number(f.statusMax) },
        keyword: f.keyword.trim() === '' ? null : { text: f.keyword, mode: f.keywordMode },
        maxLatencyMs: f.maxLatencyMs.trim() === '' ? null : Number(f.maxLatencyMs),
        maxRedirects: Number(f.maxRedirects),
        tlsWarnDays: Number(f.tlsWarnDays),
      };
    case 'tcp':
      return { host: f.host.trim(), port: Number(f.port) };
    case 'pages':
      return { project: f.pagesProject.trim(), env: f.env };
    case 'coolify':
      return {
        uuid: f.coolifyUuid.trim(),
        ...(f.coolifyConnection === '' ? {} : { connection: f.coolifyConnection }),
      };
  }
}

/**
 * p13-multi-coolify: the Coolify connections a project may use, loaded while `enabled` (a coolify monitor with a
 * project chosen). Errors leave the list empty (the master still resolves the connection).
 */
export function useProjectCoolifyConnections(project: string, enabled: boolean): CoolifyConnectionChoice[] {
  const [list, setList] = useState<CoolifyConnectionChoice[]>([]);
  useEffect(() => {
    if (!enabled || project === '') {
      setList([]);
      return;
    }
    let cancelled = false;
    listProjectCoolifyConnections(project).then(
      (l) => {
        if (!cancelled) setList(l);
      },
      () => {
        if (!cancelled) setList([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [project, enabled]);
  return list;
}

/** Options of the connection select: automatic first, then the project's connections (and a stored unknown one). */
export function coolifyConnectionOptions(
  list: readonly CoolifyConnectionChoice[],
  value: string,
  autoLabel: string,
  unknownSuffix: string,
): (readonly [string, string])[] {
  return [
    ['', autoLabel] as const,
    ...(value !== '' && !list.some((c) => c.id === value)
      ? [[value, `${value} ${unknownSuffix}`] as const]
      : []),
    ...list.map((c) => [c.id, `${c.label}${c.host === '' ? '' : ` (${c.host})`}`] as const),
  ];
}

/** p12-diyalog-w2: the Diyalog monitor form reuses the classic state, defaults and payload (same rules). */
export { configOf as monitorConfigOf, initial as monitorFormInitial };
export type { FormState as MonitorFormState };
