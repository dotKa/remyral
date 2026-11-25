import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { cx } from '../../../components/ui';
import { bytesText, show } from '../../../screens/deploy/diffText';
import { DyIcon, type IconName } from '../../icons';
import type { Tone } from '../../tone';
import { Pill } from '../parts';

/**
 * p12-diyalog-w2: an ops action's diff (as the master computed it) in the Diyalog language — DNS before → after,
 * the Coolify resources a deploy touches, the files of a Pages deploy, a Pages project / domain, a publish chain —
 * plus the publish progress and the result. Shape detection and the chain wording come from the classic
 * `DeployDiff` (`show`, `bytesText`; the publish chain is its `publishChain` in Turkish); every value is rendered as
 * text.
 */

type Json = Record<string, unknown>;

function rec(v: unknown): Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};
}

const ttl = (v: unknown): string => (v === 1 ? 'otomatik' : show(v));

function Lead(props: { readonly children: ReactNode }): ReactNode {
  return <p className="m-0 text-[0.9375rem] [overflow-wrap:anywhere]">{props.children}</p>;
}

function Muted(props: { readonly children: ReactNode; readonly testId?: string }): ReactNode {
  return (
    <p data-testid={props.testId} className="m-0 text-[0.8125rem] text-dy-muted [overflow-wrap:anywhere]">
      {props.children}
    </p>
  );
}

const Code = (props: { readonly children: ReactNode; readonly strong?: boolean }): ReactNode => (
  <code
    className={cx(
      'font-dy-mono text-[0.84375rem] [overflow-wrap:anywhere]',
      props.strong === true && 'font-bold',
    )}
  >
    {props.children}
  </code>
);

function DnsDiff(props: { readonly diff: Json }): ReactNode {
  const d = props.diff;
  const before = d.before === null || d.before === undefined ? null : rec(d.before);
  const after = d.after === null || d.after === undefined ? null : rec(d.after);
  const rows: [string, string, string][] = [
    ['İçerik', before === null ? '—' : show(before.content), after === null ? '—' : show(after.content)],
    ['TTL', before === null ? '—' : ttl(before.ttl), after === null ? '—' : ttl(after.ttl)],
    ['Proxy', before === null ? '—' : show(before.proxied), after === null ? '—' : show(after.proxied)],
  ];
  return (
    <div className="grid gap-2" data-testid="deploy-diff-dns">
      <Lead>
        <b>{show(d.action)}</b> {show(d.type)} <Code>{show(d.name)}</Code>
        <span className="text-dy-muted"> · bölge {show(d.zone)}</span>
      </Lead>
      <div className="overflow-hidden rounded-[10px] border border-dy-line">
        <table className="w-full table-fixed border-collapse text-left text-[0.84375rem]">
          <caption className="sr-only">DNS kaydı: şimdi ve sonra</caption>
          <thead>
            <tr className="bg-dy-sunk text-dy-muted">
              <th scope="col" className="w-[22%] px-3 py-1.5 font-bold">
                Alan
              </th>
              <th scope="col" className="px-3 py-1.5 font-bold">
                Şimdi
              </th>
              <th scope="col" className="px-3 py-1.5 font-bold">
                Sonra
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, b, a]) => {
              const changed = a !== b;
              return (
                <tr key={label} className="border-t border-dy-line align-top">
                  <th scope="row" className="px-3 py-1.5 font-normal text-dy-muted">
                    {label}
                  </th>
                  <td
                    className={cx(
                      'px-3 py-1.5 font-dy-mono [overflow-wrap:anywhere]',
                      changed && 'text-dy-muted line-through decoration-dy-red/60',
                    )}
                  >
                    {b}
                  </td>
                  <td
                    className={cx(
                      'px-3 py-1.5 font-dy-mono [overflow-wrap:anywhere]',
                      changed && 'bg-dy-green-soft font-bold text-dy-ink',
                    )}
                  >
                    {a}
                    {changed ? <span className="sr-only"> (değişiyor)</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ResourcesDiff(props: { readonly diff: Json }): ReactNode {
  const d = props.diff;
  const resources = Array.isArray(d.resources) ? d.resources.map(rec) : [];
  return (
    <div className="grid gap-2" data-testid="deploy-diff-coolify">
      <Lead>
        <b>{show(d.action)}</b> · {show(d.env)}
        {d.force === true ? ' · zorla yeniden derle' : ''}
        {typeof d.ref === 'string' && d.ref !== '' ? (
          <>
            {' '}
            · ref <Code>{d.ref}</Code>
          </>
        ) : null}
      </Lead>
      {typeof d.connection === 'string' && d.connection !== '' ? (
        <Lead>
          <span data-testid="deploy-diff-connection">
            Coolify: <b>{d.connection}</b>
          </span>
        </Lead>
      ) : null}
      <ul className="m-0 grid list-none overflow-hidden rounded-[10px] border border-dy-line p-0 text-[0.84375rem]">
        {resources.map((r) => (
          <li key={show(r.uuid)} className="grid gap-0.5 border-t border-dy-line px-3 py-2 first:border-t-0">
            <span className="flex flex-wrap items-baseline gap-x-2">
              <b>{show(r.name)}</b>
              <span className="font-dy-mono text-[0.78125rem] text-dy-muted">{show(r.uuid)}</span>
            </span>
            {typeof r.fqdn === 'string' && r.fqdn !== '' ? (
              <span className="text-dy-muted [overflow-wrap:anywhere]">{r.fqdn}</span>
            ) : null}
            {r.currentCommit !== undefined || r.to !== undefined ? (
              <span className="font-dy-mono text-[0.78125rem] [overflow-wrap:anywhere]">
                {r.currentCommit === undefined ? null : (
                  <span className="text-dy-muted">şimdi {show(r.currentCommit)}</span>
                )}
                {r.to === undefined ? null : <span className="font-bold"> → {show(r.to)}</span>}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function sourceText(source: unknown): string {
  if (source === 'site-bundle') return ' · işin site paketinden';
  if (source === 'output-files') return ' · işin çıktı dosyalarından';
  if (source === 'upload') return ' · yüklenen bir siteden';
  return '';
}

function PagesDiff(props: { readonly diff: Json }): ReactNode {
  const d = props.diff;
  const files = Array.isArray(d.files) ? d.files.map(rec) : [];
  const upload = d.upload === undefined ? null : rec(d.upload);
  return (
    <div className="grid gap-2" data-testid="deploy-diff-pages">
      <Lead>
        <b>{show(d.action)}</b> · proje {show(d.project)}
        {d.branch === undefined ? '' : ` · dal ${show(d.branch)}`}
        {d.env === undefined ? '' : ` · ${show(d.env)}`}
        {d.toDeployment === undefined ? '' : ` → deployment ${show(d.toDeployment)}`}
        {sourceText(d.source)}
      </Lead>
      {d.source === 'upload' ? (
        <Muted testId="deploy-diff-upload">
          {upload !== null && typeof upload.label === 'string' ? `${upload.label} · ` : ''}
          {show(d.fileCount)} dosya · {bytesText(d.bytes)}
          {upload !== null && upload.uploadedBy !== undefined ? ` · yükleyen ${show(upload.uploadedBy)}` : ''}
        </Muted>
      ) : null}
      {files.length > 0 ? (
        <ul className="m-0 grid max-h-72 list-none gap-0.5 overflow-auto rounded-[10px] bg-dy-sunk p-2.5 font-dy-mono text-[0.78125rem]">
          {files.map((f) => (
            <li key={show(f.path)} className="flex justify-between gap-3">
              <span className="min-w-0 [overflow-wrap:anywhere]">{show(f.path)}</span>
              <span className="shrink-0 text-dy-muted">{bytesText(f.bytes)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {Array.isArray(d.domains) ? <Muted>Sunar: {d.domains.map(show).join(', ')}</Muted> : null}
    </div>
  );
}

function DomainDnsLine(props: { readonly dns: Json }): ReactNode {
  const dns = props.dns;
  const record = rec(dns.record);
  const line = `${show(record.type)} ${show(record.name)} → ${show(record.content)}`;
  switch (dns.action) {
    case 'create':
    case 'update':
      return (
        <div className="grid gap-1">
          <Muted>DNS (master yazar):</Muted>
          <DnsDiff diff={dns} />
        </div>
      );
    case 'manual':
      return (
        <p className="m-0 text-[0.875rem]" data-testid="pages-domain-manual">
          Bu kaydı alan adının DNS sağlayıcısına elle ekle: <Code>{line}</Code>
        </p>
      );
    case 'skipped':
      return (
        <Muted>
          DNS’e dokunulmuyor (kayıt <Code>{line}</Code> olurdu).
        </Muted>
      );
    case 'unchanged':
      return <Muted>DNS kaydı zaten doğru.</Muted>;
    default:
      return null;
  }
}

function PagesProjectDiff(props: { readonly diff: Json }): ReactNode {
  const d = props.diff;
  if (d.action === 'add domain') {
    return (
      <div className="grid gap-2" data-testid="deploy-diff-pages-domain">
        <Lead>
          <b>{d.attach === 'attach' ? 'Bağla:' : 'Zaten bağlı:'}</b> <Code>{show(d.domain)}</Code> → Pages
          projesi {show(d.project)} <span className="text-dy-muted">({show(d.subdomain)})</span>
          {typeof d.status === 'string' ? <span className="text-dy-muted"> · durum {d.status}</span> : null}
        </Lead>
        <DomainDnsLine dns={rec(d.dns)} />
      </div>
    );
  }
  const existing = d.existing === undefined ? null : rec(d.existing);
  const target = d.deployTarget === null || d.deployTarget === undefined ? null : rec(d.deployTarget);
  const added = d.pagesProjects === null || d.pagesProjects === undefined ? null : rec(d.pagesProjects);
  return (
    <div className="grid gap-2" data-testid="deploy-diff-pages-project">
      <Lead>
        <b>{d.action === 'adopt project' ? 'Var olan Pages projesini kullan' : 'Pages projesi oluştur'}</b>{' '}
        <Code>{show(d.project)}</Code>
        <span className="text-dy-muted">
          {' '}
          · üretim dalı {show(d.productionBranch)} · {show(d.subdomain)}
          {d.directUpload === true ? ' · Direct Upload (depo bağlı değil)' : ''}
        </span>
      </Lead>
      {existing !== null && Array.isArray(existing.domains) && existing.domains.length > 0 ? (
        <Muted>Alan adları: {existing.domains.map(show).join(', ')}</Muted>
      ) : null}
      {target === null ? null : (
        <p className="m-0 text-[0.875rem]">
          Bu projenin Pages hedefi: <Code>{show(target.from)}</Code> → <Code strong>{show(target.to)}</Code>
        </p>
      )}
      {added === null ? null : (
        <p className="m-0 text-[0.875rem]" data-testid="deploy-diff-pages-added">
          Projenin Pages projelerine eklenir; Pages hedefi{' '}
          {added.targetUnchanged === null || added.targetUnchanged === undefined ? (
            'ayarlı değil'
          ) : (
            <>
              <Code>{show(added.targetUnchanged)}</Code> olarak kalır
            </>
          )}
          .
        </p>
      )}
      {typeof d.note === 'string' ? <Muted>{d.note}</Muted> : null}
    </div>
  );
}

/** A step decision as a short phrase (the classic `stepDecision`, in Turkish). */
function stepDecisionTr(v: unknown): string {
  const d = rec(v);
  switch (d.decision) {
    case 'auto':
      return 'hemen çalışır';
    case 'approval':
      return 'onay ister';
    case 'approval_step_up':
      return 'onay + kod ister';
    case 'refused':
      return `reddedildi${typeof d.reason === 'string' && d.reason !== '' ? `: ${d.reason}` : ''}`;
    default:
      return show(d.decision);
  }
}

/** p10-publish-bundle: the chain's lines in order (create → deploy → domain → CNAME); the classic `publishChain`. */
export function publishChainTr(
  diff: Json,
): { readonly key: string; readonly text: string; readonly note: string }[] {
  const steps = Array.isArray(diff.steps) ? diff.steps.map(rec) : [];
  const out: { key: string; text: string; note: string }[] = [];
  for (const st of steps) {
    const done = st.done === true ? ' (zaten yapılmış)' : '';
    if (st.step === 'create') {
      out.push({
        key: 'create',
        text: `Pages projesi ${show(st.project)} oluştur (Direct Upload, ${show(st.subdomain)})${done}`,
        note: stepDecisionTr(st.decision),
      });
    } else if (st.step === 'deploy') {
      out.push({
        key: 'deploy',
        text: `Yayınla (${show(st.env ?? diff.env)}): ${show(st.fileCount ?? diff.fileCount)} dosya · ${bytesText(st.bytes ?? diff.bytes)} → ${show(st.project ?? diff.project)}${done}`,
        note: stepDecisionTr(st.decision),
      });
    } else if (st.step === 'domain') {
      const dns = rec(st.dns);
      out.push({
        key: 'domain',
        text: `${st.attach === 'already attached' ? 'Alan adı zaten bağlı:' : 'Alan adını bağla:'} ${show(st.domain)}${done}`,
        note: stepDecisionTr(st.decision),
      });
      const target = show(rec(dns.after).content ?? rec(dns.record).content ?? st.subdomain);
      if (dns.action === 'create' || dns.action === 'update') {
        out.push({
          key: 'dns',
          text: `CNAME ${show(st.domain)} → ${target}, bölge ${show(dns.zone)} (${dns.action === 'create' ? 'yeni kayıt' : `önceden ${show(rec(dns.before).content)}`})`,
          note: 'alan adı adımının parçası',
        });
      } else if (dns.action === 'manual') {
        out.push({
          key: 'dns',
          text: `CNAME ${show(st.domain)} → ${target} kaydını alan adının DNS sağlayıcısına ekle (hesap dışında)`,
          note: 'elle',
        });
      } else if (dns.action === 'skipped') {
        out.push({ key: 'dns', text: `DNS’e dokunulmuyor (CNAME → ${target} olurdu)`, note: 'atlandı' });
      } else if (dns.action === 'unchanged') {
        out.push({
          key: 'dns',
          text: `CNAME ${show(st.domain)} zaten ${target} adresini gösteriyor`,
          note: 'yapılacak bir şey yok',
        });
      }
    }
  }
  return out;
}

function PublishDiff(props: { readonly diff: Json }): ReactNode {
  const d = props.diff;
  const chain = publishChainTr(d);
  const links = rec(d.links);
  const serves = [links.domain, links.pagesDev].filter((u): u is string => typeof u === 'string');
  return (
    <div className="grid gap-2" data-testid="deploy-diff-publish">
      <Lead>
        <b>Yayınla</b> → Pages projesi <Code>{show(d.project)}</Code> · {show(d.env)}
        {sourceText(d.source)}
      </Lead>
      <ol className="m-0 grid list-none gap-0 p-0 text-[0.875rem]" data-testid="publish-chain">
        {chain.map((c, i) => (
          <li
            key={c.key}
            className="grid grid-cols-[24px_minmax(0,1fr)] gap-2 border-t border-dy-line py-1.5 first:border-t-0"
          >
            <span className="grid size-6 place-items-center rounded-full bg-dy-sunk font-dy-mono text-[0.75rem] text-dy-muted">
              {i + 1}
            </span>
            <span className="min-w-0">
              <span className="[overflow-wrap:anywhere]">{c.text}</span>{' '}
              <span className="text-[0.78125rem] text-dy-muted">· {c.note}</span>
            </span>
          </li>
        ))}
      </ol>
      <Muted>
        Tek onay her adımı kapsar; her adım çalışırken yeniden denetlenir ve zincir ilk hatada durur.
      </Muted>
      {serves.length > 0 ? <Muted>Sunacağı adresler: {serves.join(', ')}</Muted> : null}
    </div>
  );
}

const PAGES_PROJECT_ACTIONS: ReadonlySet<unknown> = new Set([
  'create project',
  'adopt project',
  'add domain',
]);

/** Picks the renderer from the diff's shape (the classic `DeployDiff` order). */
export function DyDeployDiff(props: { readonly diff: Json }): ReactNode {
  const d = props.diff;
  if (d.action === 'publish') return <PublishDiff diff={d} />;
  if (PAGES_PROJECT_ACTIONS.has(d.action)) return <PagesProjectDiff diff={d} />;
  if ('before' in d || 'after' in d) return <DnsDiff diff={d} />;
  if (Array.isArray(d.resources)) return <ResourcesDiff diff={d} />;
  if ('project' in d && ('files' in d || 'toDeployment' in d)) return <PagesDiff diff={d} />;
  if (Object.keys(d).length === 0) return <Muted>Master bu eylem için bir fark hesaplamadı.</Muted>;
  return (
    <pre className="m-0 overflow-auto rounded-[10px] bg-dy-sunk p-3 font-dy-mono text-[0.78125rem] whitespace-pre-wrap">
      {JSON.stringify(d, null, 2)}
    </pre>
  );
}

const STEP_STATE: Readonly<Record<string, { label: string; tone: Tone; icon: IconName }>> = {
  pending: { label: 'sırada', tone: 'neutral', icon: 'clock' },
  running: { label: 'çalışıyor', tone: 'teal', icon: 'retry' },
  waiting: { label: 'bekliyor', tone: 'amber', icon: 'shield' },
  done: { label: 'bitti', tone: 'green', icon: 'checkc' },
  failed: { label: 'başarısız', tone: 'red', icon: 'xc' },
  skipped: { label: 'atlandı', tone: 'neutral', icon: 'chev' },
};

const STEP_TEXT: Readonly<Record<string, string>> = {
  create: 'Pages projesi oluştur',
  deploy: 'Yayınla',
  domain: 'Alan adı + CNAME bağla',
};

/** p10-publish-bundle: the progress of a publish bundle (each step links to its own ops action). */
export function DyPublishSteps(props: { readonly result: Json }): ReactNode {
  const steps = Array.isArray(props.result.steps) ? props.result.steps.map(rec) : [];
  if (steps.length === 0) return null;
  return (
    <ol className="m-0 grid list-none gap-0 p-0 text-[0.875rem]" data-testid="publish-steps">
      {steps.map((st, i) => {
        const id =
          typeof st.actionId === 'string' && /^[0-9a-f-]{36}$/i.test(st.actionId) ? st.actionId : null;
        const s = STEP_STATE[show(st.state)] ?? {
          label: show(st.state),
          tone: 'neutral' as const,
          icon: 'clock' as const,
        };
        return (
          <li
            key={`${show(st.step)}-${String(i)}`}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-dy-line py-1.5 first:border-t-0"
          >
            <b>{STEP_TEXT[show(st.step)] ?? show(st.step)}</b>
            <Pill tone={s.tone} icon={s.icon}>
              {s.label}
            </Pill>
            {id === null ? null : (
              <Link to={`/deploys/${id}`} className="text-[0.8125rem] font-medium text-dy-teal-ink">
                aç
              </Link>
            )}
            {typeof st.error === 'string' ? (
              <span className="w-full text-[0.8125rem] text-dy-red-ink [overflow-wrap:anywhere]">
                {st.error}
              </span>
            ) : null}
            {typeof st.note === 'string' ? (
              <span className="w-full text-[0.8125rem] text-dy-muted [overflow-wrap:anywhere]">
                {st.note}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** The result fields the master stored (deployments, record ids, status, stage) and its https links. */
export function DyResult(props: { readonly result: Json }): ReactNode {
  const r = props.result;
  const deployments = Array.isArray(r.deployments)
    ? r.deployments.map((d) => show((d as Json).deploymentUuid))
    : [];
  const links: unknown[] = Array.isArray(r.links) ? (r.links as unknown[]) : [];
  const urls = [r.url, ...links].filter((u): u is string => typeof u === 'string' && /^https:\/\//.test(u));
  const rows: [string, string][] = [];
  if (deployments.length > 0) rows.push(['Deployment’lar', deployments.join(', ')]);
  if (typeof r.deploymentId === 'string') rows.push(['Deployment', r.deploymentId]);
  if (typeof r.recordId === 'string') rows.push(['DNS kaydı', r.recordId]);
  if (typeof r.previousDeploymentId === 'string') rows.push(['Önceki deployment', r.previousDeploymentId]);
  if (Array.isArray(r.statuses))
    rows.push([
      'Durum',
      r.statuses
        .map((s) => {
          const o = s as Json;
          return `${show(o.deploymentUuid)}: ${show(o.status)}`;
        })
        .join(', '),
    ]);
  if (typeof r.stageStatus === 'string') rows.push(['Aşama', `${show(r.stage)} ${r.stageStatus}`]);
  if (typeof r.retryAfterSec === 'number')
    rows.push(['Yeniden deneme', `${String(r.retryAfterSec)} sn sonra`]);
  return (
    <div className="grid gap-2" data-testid="ops-result">
      {rows.length === 0 ? null : (
        <dl className="m-0 grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] text-[0.84375rem]">
          {rows.map(([k, v], i) => (
            <div key={k} className="contents">
              <dt className={cx('py-1.5 pr-4 text-dy-muted', i > 0 && 'border-t border-dy-line')}>{k}</dt>
              <dd
                className={cx(
                  'm-0 py-1.5 font-dy-mono [overflow-wrap:anywhere]',
                  i > 0 && 'border-t border-dy-line',
                )}
              >
                {v}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {[...new Set(urls)].map((u) => (
        <a
          key={u}
          href={u}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1.5 text-[0.875rem] font-medium text-dy-teal-ink [overflow-wrap:anywhere]"
        >
          <DyIcon name="globe" className="size-3.5 shrink-0" />
          {u}
        </a>
      ))}
    </div>
  );
}
