import type { Messages } from '@remyral/i18n';
import type { ReactNode } from 'react';
import { show } from '../../../../screens/deploy/diffText';
import { cx } from '../../../../components/ui';
import { useT } from '../../../../i18n/I18nProvider';
import { KeyValue } from '../../../KeyValue';
import { DyDetails, DyNotice } from '../../forms';
import { bytesText, decisionLabel } from './deploy-text';

/**
 * p12-diyalog wave 2 (W3) — Projeler → Deploy: the review of an ops action before it is requested, in the Diyalog
 * language. The diff is what the master computed (`POST /deploy/actions/preview`, never the caller); the shapes are
 * the classic `DeployDiff` ones (publish chain, Pages project / domain, DNS record, Coolify resources, Pages files).
 * Every value is rendered as text. p14-i18n-screens-c: the words come from `projectTabs.diff`.
 */

type Json = Record<string, unknown>;
type DiffWords = Messages['projectTabs']['diff'];

function rec(v: unknown): Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};
}

const mono = 'font-dy-mono text-[0.8125rem] [overflow-wrap:anywhere]';

function DnsRecord(props: { readonly diff: Json }): ReactNode {
  const t = useT().projectTabs.diff;
  const ttl = (v: unknown): string => (v === 1 ? t.ttlAuto : show(v));
  const d = props.diff;
  const before = d.before === null || d.before === undefined ? null : rec(d.before);
  const after = d.after === null || d.after === undefined ? null : rec(d.after);
  const rows: [string, string, string][] = [
    [t.content, before === null ? '—' : show(before.content), after === null ? '—' : show(after.content)],
    ['TTL', before === null ? '—' : ttl(before.ttl), after === null ? '—' : ttl(after.ttl)], // i18n-ignore: DNS field name
    ['Proxy', before === null ? '—' : show(before.proxied), after === null ? '—' : show(after.proxied)], // i18n-ignore: Cloudflare field name
  ];
  return (
    <div className="flex flex-col gap-2" data-testid="deploy-diff-dns">
      <p className="m-0">
        <b>{show(d.action)}</b> {show(d.type)} <span className={mono}>{show(d.name)}</span>
        <span className="text-dy-muted">{t.zone({ zone: show(d.zone) })}</span>
      </p>
      <table className="w-full border-collapse text-left text-[0.8125rem]">
        <caption className="sr-only">{t.dnsCaption}</caption>
        <thead>
          <tr className="text-dy-muted">
            <th scope="col" className="py-1 pr-3 font-medium">
              {t.field}
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              {t.now}
            </th>
            <th scope="col" className="py-1 font-medium">
              {t.after}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, b, a]) => (
            <tr key={label} className="border-t border-dy-line align-top">
              <th scope="row" className="py-1 pr-3 font-normal text-dy-muted">
                {label}
              </th>
              <td className={cx('py-1 pr-3', mono)}>{b}</td>
              <td className={cx('py-1', mono, a !== b && 'font-bold text-dy-ink')}>
                {a}
                {a !== b ? <span className="sr-only">{t.changing}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DomainDns(props: { readonly dns: Json }): ReactNode {
  const t = useT().projectTabs.diff;
  const dns = props.dns;
  const r = rec(dns.record);
  const line = `${show(r.type)} ${show(r.name)} → ${show(r.content)}`;
  switch (dns.action) {
    case 'create':
    case 'update':
      return (
        <div className="flex flex-col gap-1">
          <p className="m-0 text-[0.8125rem] text-dy-muted">{t.masterWrites}</p>
          <DnsRecord diff={dns} />
        </div>
      );
    case 'manual':
      return (
        <p className="m-0" data-testid="pages-domain-manual">
          {t.manual}
          <span className={mono}>{line}</span>
        </p>
      );
    case 'skipped':
      return (
        <p className="m-0 text-[0.8125rem] text-dy-muted">
          {t.skippedA}
          <span className={mono}>{line}</span>
          {t.skippedB}
        </p>
      );
    case 'unchanged':
      return <p className="m-0 text-[0.8125rem] text-dy-muted">{t.unchanged}</p>;
    default:
      return null;
  }
}

function PagesProject(props: { readonly diff: Json }): ReactNode {
  const t = useT().projectTabs.diff;
  const d = props.diff;
  if (d.action === 'add domain') {
    return (
      <div className="flex flex-col gap-2" data-testid="deploy-diff-pages-domain">
        <p className="m-0">
          <b>{d.attach === 'attach' ? t.attach : t.attached}</b>{' '}
          <span className={mono}>{show(d.domain)}</span>
          {t.toPages}
          <span className={mono}>{show(d.project)}</span>
          <span className="text-dy-muted"> ({show(d.subdomain)})</span>
          {typeof d.status === 'string' ? (
            <span className="text-dy-muted">{t.status({ status: d.status })}</span>
          ) : null}
        </p>
        <DomainDns dns={rec(d.dns)} />
      </div>
    );
  }
  const existing = d.existing === undefined ? null : rec(d.existing);
  const target = d.deployTarget === null || d.deployTarget === undefined ? null : rec(d.deployTarget);
  const added = d.pagesProjects === null || d.pagesProjects === undefined ? null : rec(d.pagesProjects);
  return (
    <div className="flex flex-col gap-2" data-testid="deploy-diff-pages-project">
      <p className="m-0">
        <b>{d.action === 'adopt project' ? t.adopt : t.create}</b>{' '}
        <span className={mono}>{show(d.project)}</span>
      </p>
      <KeyValue
        rows={[
          { k: t.branch, v: show(d.productionBranch), mono: true },
          { k: t.address, v: show(d.subdomain), mono: true },
          ...(d.directUpload === true ? [{ k: t.type, v: t.directUpload }] : []),
          ...(existing !== null && Array.isArray(existing.domains) && existing.domains.length > 0
            ? [{ k: t.domains, v: existing.domains.map(show).join(', '), mono: true }]
            : []),
        ]}
      />
      {target !== null ? (
        <p className="m-0">
          {t.target}
          <span className={mono}>{show(target.from)}</span> →{' '}
          <span className={cx(mono, 'font-bold')}>{show(target.to)}</span>
        </p>
      ) : null}
      {added !== null ? (
        <p className="m-0" data-testid="deploy-diff-pages-added">
          {t.addedA}
          {added.targetUnchanged === null || added.targetUnchanged === undefined ? (
            t.notSet
          ) : (
            <>
              <span className={mono}>{show(added.targetUnchanged)}</span>
              {t.keeps}
            </>
          )}
          .
        </p>
      ) : null}
      {typeof d.note === 'string' ? <p className="m-0 text-[0.8125rem] text-dy-muted">{d.note}</p> : null}
    </div>
  );
}

function stepDecision(t: DiffWords, v: unknown): string {
  const d = rec(v);
  switch (d.decision) {
    case 'auto':
    case 'approval':
    case 'approval_step_up':
      return t.step[d.decision];
    case 'refused':
      return t.refused({ reason: typeof d.reason === 'string' ? d.reason : '' });
    default:
      return show(d.decision);
  }
}

/** The publish chain's lines in order (create → deploy → domain → CNAME), in the user's language (classic `publishChain`). */
export function chainLines(
  t: DiffWords,
  diff: Json,
): { readonly key: string; readonly text: string; readonly note: string }[] {
  const steps = Array.isArray(diff.steps) ? diff.steps.map(rec) : [];
  const out: { key: string; text: string; note: string }[] = [];
  for (const st of steps) {
    const done = st.done === true ? t.alreadyDone : '';
    if (st.step === 'create') {
      out.push({
        key: 'create',
        text: t.chainCreate({ project: show(st.project), subdomain: show(st.subdomain), done }),
        note: stepDecision(t, st.decision),
      });
    } else if (st.step === 'deploy') {
      out.push({
        key: 'deploy',
        text: t.chainDeploy({
          env: show(st.env ?? diff.env),
          files: show(st.fileCount ?? diff.fileCount),
          size: bytesText(st.bytes ?? diff.bytes),
          project: show(st.project ?? diff.project),
          done,
        }),
        note: stepDecision(t, st.decision),
      });
    } else if (st.step === 'domain') {
      const dns = rec(st.dns);
      const domain = show(st.domain);
      out.push({
        key: 'domain',
        text:
          st.attach === 'already attached'
            ? t.chainDomainAttached({ domain, done })
            : t.chainDomain({ domain, done }),
        note: stepDecision(t, st.decision),
      });
      const target = show(rec(dns.after).content ?? rec(dns.record).content ?? st.subdomain);
      if (dns.action === 'create' || dns.action === 'update') {
        out.push({
          key: 'dns',
          text: t.chainCname({
            domain,
            target,
            zone: show(dns.zone),
            what:
              dns.action === 'create' ? t.newRecord : t.previous({ content: show(rec(dns.before).content) }),
          }),
          note: t.partOfDomain,
        });
      } else if (dns.action === 'manual') {
        out.push({ key: 'dns', text: t.chainManual({ domain, target }), note: t.byHand });
      } else if (dns.action === 'skipped') {
        out.push({ key: 'dns', text: t.chainSkipped({ target }), note: t.skipped });
      } else if (dns.action === 'unchanged') {
        out.push({ key: 'dns', text: t.chainUnchanged({ domain, target }), note: t.nothingToDo });
      }
    }
  }
  return out;
}

function sourceText(t: DiffWords, source: unknown): string | undefined {
  if (source === 'upload') return t.source.upload;
  if (source === 'site-bundle') return t.source.siteBundle;
  if (source === 'output-files') return t.source.outputFiles;
  return undefined;
}

function Publish(props: { readonly diff: Json }): ReactNode {
  const t = useT().projectTabs.diff;
  const d = props.diff;
  const chain = chainLines(t, d);
  const links = rec(d.links);
  const serves = [links.domain, links.pagesDev].filter((u): u is string => typeof u === 'string');
  const source = sourceText(t, d.source);
  return (
    <div className="flex flex-col gap-2" data-testid="deploy-diff-publish">
      <p className="m-0">
        <b>{t.publish}</b>
        {t.toPages}
        <span className={mono}>{show(d.project)}</span> · {show(d.env)}
        {source === undefined ? '' : ` · ${source}`}
      </p>
      <ol className="m-0 flex list-decimal flex-col gap-1 pl-5" data-testid="publish-chain">
        {chain.map((c) => (
          <li key={c.key}>
            <span className="[overflow-wrap:anywhere]">{c.text}</span>{' '}
            <span className="text-[0.8125rem] text-dy-muted">· {c.note}</span>
          </li>
        ))}
      </ol>
      <p className="m-0 text-[0.8125rem] text-dy-muted">{t.oneApproval}</p>
      {serves.length > 0 ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted [overflow-wrap:anywhere]">
          {t.serves({ list: serves.join(', ') })}
        </p>
      ) : null}
    </div>
  );
}

function Resources(props: { readonly diff: Json }): ReactNode {
  const t = useT().projectTabs.diff;
  const d = props.diff;
  const resources = Array.isArray(d.resources) ? d.resources.map(rec) : [];
  return (
    <div className="flex flex-col gap-2" data-testid="deploy-diff-coolify">
      <p className="m-0">
        <b>{show(d.action)}</b> · {show(d.env)}
        {d.force === true ? t.force : ''}
        {typeof d.ref === 'string' && d.ref !== '' ? t.ref({ ref: d.ref }) : ''}
      </p>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[0.8125rem]">
        {resources.map((r) => (
          <li key={show(r.uuid)} className="[overflow-wrap:anywhere]">
            <b>{show(r.name)}</b> <span className={cx(mono, 'text-dy-muted')}>{show(r.uuid)}</span>
            {typeof r.fqdn === 'string' && r.fqdn !== '' ? (
              <span className="text-dy-muted"> · {r.fqdn}</span>
            ) : null}
            {r.currentCommit !== undefined ? (
              <span className="text-dy-muted">{t.nowCommit({ commit: show(r.currentCommit) })}</span>
            ) : null}
            {r.to !== undefined ? <span> → {show(r.to)}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PagesFiles(props: { readonly diff: Json }): ReactNode {
  const t = useT().projectTabs.diff;
  const d = props.diff;
  const files = Array.isArray(d.files) ? d.files.map(rec) : [];
  const upload = d.upload === undefined ? null : rec(d.upload);
  const source = sourceText(t, d.source);
  return (
    <div className="flex flex-col gap-2" data-testid="deploy-diff-pages">
      <p className="m-0">
        <b>{show(d.action)}</b>
        {t.project}
        <span className={mono}>{show(d.project)}</span>
        {d.branch !== undefined ? t.branchOf({ branch: show(d.branch) }) : ''}
        {d.env !== undefined ? ` · ${show(d.env)}` : ''}
        {d.toDeployment !== undefined ? t.toDeployment({ id: show(d.toDeployment) }) : ''}
        {source === undefined ? '' : ` · ${source}`}
      </p>
      {d.source === 'upload' ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="deploy-diff-upload">
          {upload !== null && typeof upload.label === 'string' ? `${upload.label} · ` : ''}
          {t.files({ n: show(d.fileCount), size: bytesText(d.bytes) })}
          {upload !== null && upload.uploadedBy !== undefined
            ? t.uploadedBy({ who: show(upload.uploadedBy) })
            : ''}
        </p>
      ) : null}
      {files.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0 font-dy-mono text-[0.8125rem]">
          {files.map((f) => (
            <li key={show(f.path)} className="[overflow-wrap:anywhere]">
              {show(f.path)} <span className="text-dy-muted">({bytesText(f.bytes)})</span>
            </li>
          ))}
        </ul>
      ) : null}
      {Array.isArray(d.domains) ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted">
          {t.servesDomains({ list: d.domains.map(show).join(', ') })}
        </p>
      ) : null}
    </div>
  );
}

const PAGES_PROJECT_ACTIONS: ReadonlySet<unknown> = new Set([
  'create project', // i18n-ignore: API action names
  'adopt project', // i18n-ignore: API action names
  'add domain', // i18n-ignore: API action names
]);

/** Picks the view from the diff's shape (as the classic one). */
export function DyDeployDiff(props: { readonly diff: Json }): ReactNode {
  const t = useT().projectTabs.diff;
  const d = props.diff;
  if (d.action === 'publish') return <Publish diff={d} />;
  if (PAGES_PROJECT_ACTIONS.has(d.action)) return <PagesProject diff={d} />;
  if ('before' in d || 'after' in d) return <DnsRecord diff={d} />;
  if (Array.isArray(d.resources)) return <Resources diff={d} />;
  if ('project' in d && ('files' in d || 'toDeployment' in d)) return <PagesFiles diff={d} />;
  return (
    <DyDetails summary={t.raw}>
      <pre className="m-0 font-dy-mono text-[0.78125rem] whitespace-pre-wrap [overflow-wrap:anywhere]">
        {JSON.stringify(d, null, 2)}
      </pre>
    </DyDetails>
  );
}

/** The review box: the diff and the policy outcome (refused in red with its reason). */
export function ReviewBox(props: {
  readonly diff: Json;
  readonly policy: { readonly decision: string; readonly reason: string };
  readonly testId: string;
  readonly children?: ReactNode;
}): ReactNode {
  const t = useT().projectTabs.deployText;
  const refused = props.policy.decision === 'refused';
  return (
    <div
      className="flex flex-col gap-3 rounded-[12px] border border-dy-line bg-dy-sunk/50 p-3.5 text-[0.875rem]"
      data-testid={props.testId}
    >
      <DyDeployDiff diff={props.diff} />
      <DyNotice tone={refused ? 'red' : props.policy.decision === 'auto' ? 'teal' : 'amber'}>
        {decisionLabel(t, props.policy.decision, props.policy.reason)}
      </DyNotice>
      {props.children}
    </div>
  );
}

/** A preview response → its diff and policy (classic `reviewOf`). */
export function reviewOf(v: Json): { diff: Json; policy: { decision: string; reason: string } } {
  const policy = rec(v.policy);
  return {
    diff: rec(v.diff),
    policy: {
      decision: typeof policy.decision === 'string' ? policy.decision : '',
      reason: typeof policy.reason === 'string' ? policy.reason : '',
    },
  };
}
