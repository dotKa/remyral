import type { Formatter, Messages } from '@remyral/i18n';
import type { ReactNode } from 'react';
import { cx } from '../../components/ui';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { DyIcon } from '../icons';
import { rec, sizeText, text } from './summary';

/**
 * p12-diyalog-w4: the change an ops draft (deploy / DNS / Pages) would make, as the master computed it when the
 * assistant drafted it — the Diyalog counterpart of the classic `DeployDiff` for chat cards: a DNS record now → after
 * (changed values bold), the Coolify resources a deploy touches, the files of a Pages deploy, a Pages project or a
 * domain (with what DNS does), and a publish bundle's chain. Every value is rendered as text; unknown shapes fall back
 * to the JSON as text.
 */

type Json = Record<string, unknown>;

const show = (v: unknown): string => (v === null || v === undefined ? '—' : text(v));

type DiffWords = Messages['drafts']['diff'];

/** Sizes (a non-number shows as itself). */
const bytes = (n: unknown, f: Formatter): string =>
  typeof n === 'number' && Number.isFinite(n) ? sizeText(n, f) : show(n);

function actionText(v: unknown, w: DiffWords): string {
  if (typeof v !== 'string') return show(v);
  return Object.hasOwn(w.actions, v) ? w.actions[v as keyof DiffWords['actions']] : v;
}

/** " · işin site paketinden" for a known source, else nothing. */
function sourceText(v: unknown, w: DiffWords): string {
  const s =
    v === 'site-bundle'
      ? w.sources.siteBundle
      : v === 'output-files'
        ? w.sources.outputFiles
        : v === 'upload'
          ? w.sources.upload
          : undefined;
  return s === undefined ? '' : ` · ${s}`;
}

const envText = (v: unknown, t: Messages): string => (v === 'production' ? t.drafts.live : show(v));

function Line(props: { readonly children: ReactNode; readonly testId?: string }): ReactNode {
  return (
    <p className="m-0 text-[0.875rem] [overflow-wrap:anywhere]" data-testid={props.testId}>
      {props.children}
    </p>
  );
}

const Mono = (props: { readonly children: ReactNode }): ReactNode => (
  <span className="font-dy-mono text-[0.8125rem]" translate="no">
    {props.children}
  </span>
);

function DnsDiff(props: { readonly diff: Json }): ReactNode {
  const w = useT().drafts.diff;
  const d = props.diff;
  const before = d.before === null || d.before === undefined ? null : rec(d.before);
  const after = d.after === null || d.after === undefined ? null : rec(d.after);
  const ttl = (v: unknown): string => (v === 1 ? w.ttlAuto : show(v));
  const rows: readonly (readonly [string, string, string])[] = [
    [w.content, before === null ? '—' : show(before.content), after === null ? '—' : show(after.content)],
    ['TTL', before === null ? '—' : ttl(before.ttl), after === null ? '—' : ttl(after.ttl)],
    [w.proxy, before === null ? '—' : show(before.proxied), after === null ? '—' : show(after.proxied)],
  ];
  return (
    <div className="grid gap-2" data-testid="deploy-diff-dns">
      <Line>
        <b>{actionText(d.action, w)}</b> {show(d.type)} <Mono>{show(d.name)}</Mono>
        <span className="text-dy-muted">{` · ${w.inZone({ zone: show(d.zone) })}`}</span>
      </Line>
      <table className="w-full border-collapse text-left text-[0.8125rem]">
        <caption className="sr-only">{w.caption}</caption>
        <thead>
          <tr className="text-dy-muted">
            <th scope="col" className="py-1 pr-3 font-medium">
              {w.field}
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              {w.now}
            </th>
            <th scope="col" className="py-1 font-medium">
              {w.after}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, b, a]) => (
            <tr key={label} className="border-t border-dy-line align-top">
              <th scope="row" className="py-1 pr-3 font-normal text-dy-muted">
                {label}
              </th>
              <td className="py-1 pr-3 font-dy-mono [overflow-wrap:anywhere]">{b}</td>
              <td
                className={cx(
                  'py-1 font-dy-mono [overflow-wrap:anywhere]',
                  a !== b && 'font-bold text-dy-ink',
                )}
              >
                {a}
                {a !== b ? <span className="sr-only">{` (${w.changing})`}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResourcesDiff(props: { readonly diff: Json }): ReactNode {
  const t = useT();
  const w = t.drafts.diff;
  const d = props.diff;
  const resources = Array.isArray(d.resources) ? d.resources.map(rec) : [];
  return (
    <div className="grid gap-2" data-testid="deploy-diff-coolify">
      <Line>
        <b>{actionText(d.action, w)}</b> · {envText(d.env, t)}
        {d.force === true ? ` · ${w.forceRebuild}` : ''}
        {typeof d.ref === 'string' && d.ref !== '' ? (
          <>
            {' · ref '}
            <Mono>{d.ref}</Mono>
          </>
        ) : null}
      </Line>
      {typeof d.connection === 'string' && d.connection !== '' ? (
        <Line>
          <span data-testid="deploy-diff-connection">
            {'Coolify: ' /* i18n-ignore: product name */}
            <b>{d.connection}</b>
          </span>
        </Line>
      ) : null}
      <ul className="m-0 grid list-none gap-1 p-0 text-[0.8125rem]">
        {resources.map((r) => (
          <li key={show(r.uuid)} className="[overflow-wrap:anywhere]">
            <b className="font-bold">{show(r.name)}</b> <Mono>{show(r.uuid)}</Mono>
            {typeof r.fqdn === 'string' && r.fqdn !== '' ? (
              <span className="text-dy-muted">{` · ${r.fqdn}`}</span>
            ) : null}
            {r.currentCommit !== undefined ? (
              <span className="text-dy-muted">{` · ${w.currently({ commit: show(r.currentCommit) })}`}</span>
            ) : null}
            {r.to !== undefined ? <span>{` → ${show(r.to)}`}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PagesDiff(props: { readonly diff: Json }): ReactNode {
  const t = useT();
  const f = useFormat();
  const w = t.drafts.diff;
  const d = props.diff;
  const files = Array.isArray(d.files) ? d.files.map(rec) : [];
  const upload = d.upload === undefined ? null : rec(d.upload);
  return (
    <div className="grid gap-2" data-testid="deploy-diff-pages">
      <Line>
        <b>{actionText(d.action, w)}</b> · {w.project({ project: show(d.project) })}
        {d.branch !== undefined ? ` · ${w.branch({ branch: show(d.branch) })}` : ''}
        {d.env !== undefined ? ` · ${envText(d.env, t)}` : ''}
        {d.toDeployment !== undefined ? ` → ${w.toDeployment({ id: show(d.toDeployment) })}` : ''}
        {sourceText(d.source, w)}
      </Line>
      {d.source === 'upload' ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="deploy-diff-upload">
          {upload !== null && typeof upload.label === 'string' ? `${upload.label} · ` : ''}
          {w.upload({ files: show(d.fileCount), size: bytes(d.bytes, f) })}
          {upload !== null && upload.uploadedBy !== undefined
            ? ` · ${w.uploadedBy({ who: show(upload.uploadedBy) })}`
            : ''}
        </p>
      ) : null}
      {files.length > 0 ? (
        <ul className="m-0 grid list-none gap-0.5 p-0 font-dy-mono text-[0.8125rem]">
          {files.map((x) => (
            <li key={show(x.path)} className="[overflow-wrap:anywhere]">
              {show(x.path)} <span className="text-dy-muted">({bytes(x.bytes, f)})</span>
            </li>
          ))}
        </ul>
      ) : null}
      {Array.isArray(d.domains) ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted">
          {w.serves({ list: d.domains.map(show).join(', ') })}
        </p>
      ) : null}
    </div>
  );
}

function DomainDns(props: { readonly dns: Json }): ReactNode {
  const w = useT().drafts.diff;
  const dns = props.dns;
  const record = rec(dns.record);
  const line = `${show(record.type)} ${show(record.name)} → ${show(record.content)}`;
  switch (dns.action) {
    case 'create':
    case 'update':
      return (
        <div className="grid gap-1">
          <p className="m-0 text-[0.8125rem] text-dy-muted">{w.masterWrites}</p>
          <DnsDiff diff={dns} />
        </div>
      );
    case 'manual':
      return (
        <Line testId="pages-domain-manual">
          {w.manual}
          <Mono>{line}</Mono>
        </Line>
      );
    case 'skipped':
      return (
        <p className="m-0 text-[0.8125rem] text-dy-muted">
          {w.skipped}
          <Mono>{line}</Mono>
          {').'}
        </p>
      );
    case 'unchanged':
      return <p className="m-0 text-[0.8125rem] text-dy-muted">{w.unchanged}</p>;
    default:
      return null;
  }
}

function PagesProjectDiff(props: { readonly diff: Json }): ReactNode {
  const w = useT().drafts.diff;
  const d = props.diff;
  if (d.action === 'add domain') {
    return (
      <div className="grid gap-2" data-testid="deploy-diff-pages-domain">
        <Line>
          <b>{d.attach === 'attach' ? w.attach : w.attached}</b> <Mono>{show(d.domain)}</Mono>
          {` ${w.toPagesProject({ project: show(d.project) })}`}
          <span className="text-dy-muted">{` (${show(d.subdomain)})`}</span>
          {typeof d.status === 'string' ? (
            <span className="text-dy-muted">{` · ${w.status({ status: d.status })}`}</span>
          ) : null}
        </Line>
        <DomainDns dns={rec(d.dns)} />
      </div>
    );
  }
  const existing = d.existing === undefined ? null : rec(d.existing);
  const target = d.deployTarget === null || d.deployTarget === undefined ? null : rec(d.deployTarget);
  const added = d.pagesProjects === null || d.pagesProjects === undefined ? null : rec(d.pagesProjects);
  return (
    <div className="grid gap-2" data-testid="deploy-diff-pages-project">
      <Line>
        <b>{d.action === 'adopt project' ? w.adopt : w.createProject}</b> <Mono>{show(d.project)}</Mono>
        <span className="text-dy-muted">
          {` · ${w.productionBranch({ branch: show(d.productionBranch), subdomain: show(d.subdomain) })}`}
          {d.directUpload === true ? ` · ${w.directUpload}` : ''}
        </span>
      </Line>
      {existing !== null && Array.isArray(existing.domains) && existing.domains.length > 0 ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted">
          {w.domains({ list: existing.domains.map(show).join(', ') })}
        </p>
      ) : null}
      {target !== null ? (
        <Line>
          {w.pagesTarget}
          <Mono>{show(target.from)}</Mono>
          {' → '}
          <b>
            <Mono>{show(target.to)}</Mono>
          </b>
        </Line>
      ) : null}
      {added !== null ? (
        <Line testId="deploy-diff-pages-added">
          {w.added}
          {added.targetUnchanged === null || added.targetUnchanged === undefined ? (
            w.notSet
          ) : (
            <>
              <Mono>{show(added.targetUnchanged)}</Mono> {w.stays}
            </>
          )}
          .
        </Line>
      ) : null}
      {typeof d.note === 'string' ? <p className="m-0 text-[0.8125rem] text-dy-muted">{d.note}</p> : null}
    </div>
  );
}

function stepDecision(v: unknown, w: DiffWords): string {
  const d = rec(v);
  switch (d.decision) {
    case 'auto':
    case 'approval':
    case 'approval_step_up':
      return w.stepDecisions[d.decision];
    case 'refused':
      return w.stepDecisions.refused({ reason: typeof d.reason === 'string' ? d.reason : '' });
    default:
      return show(d.decision);
  }
}

/** p10-publish-bundle: the publish chain in order (create → deploy → domain → CNAME). */
export function publishChainSteps(
  diff: Json,
  t: Messages,
  f: Formatter,
): { readonly key: string; readonly text: string; readonly note: string }[] {
  const w = t.drafts.diff;
  const s = w.steps;
  const steps = Array.isArray(diff.steps) ? diff.steps.map(rec) : [];
  const out: { key: string; text: string; note: string }[] = [];
  for (const st of steps) {
    const done = st.done === true;
    if (st.step === 'create') {
      out.push({
        key: 'create',
        text: s.create({ project: show(st.project), subdomain: show(st.subdomain), done }),
        note: stepDecision(st.decision, w),
      });
    } else if (st.step === 'deploy') {
      out.push({
        key: 'deploy',
        text: s.deploy({
          env: show(st.env ?? diff.env),
          files: show(st.fileCount ?? diff.fileCount),
          size: bytes(st.bytes ?? diff.bytes, f),
          project: show(st.project ?? diff.project),
          done,
        }),
        note: stepDecision(st.decision, w),
      });
    } else if (st.step === 'domain') {
      const dns = rec(st.dns);
      const domain = show(st.domain);
      out.push({
        key: 'domain',
        text: s.domain({ domain, attached: st.attach === 'already attached', done }),
        note: stepDecision(st.decision, w),
      });
      const target = show(rec(dns.after).content ?? rec(dns.record).content ?? st.subdomain);
      if (dns.action === 'create' || dns.action === 'update') {
        out.push({
          key: 'dns',
          text: s.dnsWrite({
            domain,
            target,
            zone: show(dns.zone),
            previous: dns.action === 'create' ? null : show(rec(dns.before).content),
          }),
          note: s.dnsWriteNote,
        });
      } else if (dns.action === 'manual') {
        out.push({ key: 'dns', text: s.dnsManual({ domain, target }), note: s.dnsManualNote });
      } else if (dns.action === 'skipped') {
        out.push({ key: 'dns', text: s.dnsSkipped({ target }), note: s.dnsSkippedNote });
      } else if (dns.action === 'unchanged') {
        out.push({ key: 'dns', text: s.dnsUnchanged({ domain, target }), note: s.dnsUnchangedNote });
      }
    }
  }
  return out;
}

function PublishDiff(props: { readonly diff: Json }): ReactNode {
  const t = useT();
  const w = t.drafts.diff;
  const d = props.diff;
  const chain = publishChainSteps(d, t, useFormat());
  const links = rec(d.links);
  const serves = [links.domain, links.pagesDev].filter((u): u is string => typeof u === 'string');
  return (
    <div className="grid gap-2" data-testid="deploy-diff-publish">
      <Line>
        <b>{w.actions.deploy}</b>
        {' → '}
        <Mono>{show(d.project)}</Mono>
        {` ${w.pagesProject({ env: envText(d.env, t) })}`}
        {sourceText(d.source, w)}
      </Line>
      <ol className="m-0 grid list-none gap-1 p-0" data-testid="publish-chain">
        {chain.map((c, i) => (
          <li key={c.key} className="flex gap-2 text-[0.875rem]">
            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-dy-sunk font-dy-mono text-[0.75rem] text-dy-muted">
              {i + 1}
            </span>
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {c.text} <span className="text-[0.8125rem] text-dy-muted">{`· ${c.note}`}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="m-0 text-[0.8125rem] text-dy-muted">{w.oneApproval}</p>
      {serves.length > 0 ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted [overflow-wrap:anywhere]">
          {w.willServe({ list: serves.join(', ') })}
        </p>
      ) : null}
    </div>
  );
}

const PAGES_PROJECT_ACTIONS: ReadonlySet<unknown> = new Set([
  'create project', // i18n-ignore: API action values
  'adopt project', // i18n-ignore: API action values
  'add domain', // i18n-ignore: API action values
]);

/** Picks the renderer from the diff's shape (the classic DeployDiff's rules). */
export function OpsDiff(props: { readonly diff: Json }): ReactNode {
  const w = useT().drafts.diff;
  const d = props.diff;
  let body: ReactNode;
  if (d.action === 'publish') body = <PublishDiff diff={d} />;
  else if (PAGES_PROJECT_ACTIONS.has(d.action)) body = <PagesProjectDiff diff={d} />;
  else if ('before' in d || 'after' in d) body = <DnsDiff diff={d} />;
  else if (Array.isArray(d.resources)) body = <ResourcesDiff diff={d} />;
  else if ('project' in d && ('files' in d || 'toDeployment' in d)) body = <PagesDiff diff={d} />;
  else
    body = (
      <pre className="m-0 font-dy-mono text-[0.75rem] whitespace-pre-wrap [overflow-wrap:anywhere]">
        {JSON.stringify(d, null, 2)}
      </pre>
    );
  return (
    <section
      aria-label={w.region}
      className="rounded-[10px] border border-dy-line bg-dy-sunk px-3 py-2.5"
      data-testid="ops-draft-diff"
    >
      <p className="m-0 mb-2 flex items-center gap-1.5 text-[0.8125rem] font-bold text-dy-muted">
        <DyIcon name="rocket" className="size-3.5" />
        {w.title}
      </p>
      {body}
    </section>
  );
}
