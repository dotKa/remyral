import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { listOpenPullRequests, type OpenPullRequest } from '../../api/code';
import { useErrorText } from '../../i18n/errors';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { DyNotice } from '../common/notices';
import { DyIcon } from '../icons';
import { SkeletonRows } from '../screens/parts';

/**
 * p18-leftovers (docs/design/p19-ide.md "Leftovers"): the open pull / merge requests of the project repository in the
 * Kod tab — folded by default; each opens the compare view of its base and head (`/projects/:id/code/compare`) and links
 * to the provider. Titles, branches and authors are provider text, rendered as text only.
 */
export function PullRequests(props: { readonly project: string }): ReactNode {
  const t = useT().code.pulls;
  const f = useFormat();
  const sayError = useErrorText();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'ok'; supported: boolean; items: OpenPullRequest[] }
    | { kind: 'error'; error: unknown }
  >({ kind: 'idle' });
  useEffect(() => {
    if (!open || state.kind !== 'idle') return;
    setState({ kind: 'loading' });
    listOpenPullRequests(props.project).then(
      (out) => {
        setState({ kind: 'ok', supported: out.supported, items: out.items });
      },
      (error: unknown) => {
        setState({ kind: 'error', error });
      },
    );
  }, [open, state.kind, props.project]);
  const count = state.kind === 'ok' ? state.items.length : null;
  return (
    <section className="rounded-[12px] border border-dy-line bg-dy-card" data-testid="code-pulls">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[0.8125rem] font-bold"
        data-testid="code-pulls-toggle"
      >
        <DyIcon name="merge" className="size-4" />
        {count === null ? t.title : t.titleCount({ n: count })}
        <span className="ml-auto text-dy-muted">{open ? t.hide : t.show}</span>
      </button>
      {!open ? null : (
        <div className="border-t border-dy-line px-3 py-2">
          {state.kind === 'loading' || state.kind === 'idle' ? (
            <SkeletonRows label={t.loading} rows={2} />
          ) : state.kind === 'error' ? (
            <DyNotice tone="red">{`${t.failed} ${sayError(state.error)}`}</DyNotice>
          ) : !state.supported ? (
            <p className="m-0 text-[0.8125rem] text-dy-muted">{t.unsupported}</p>
          ) : state.items.length === 0 ? (
            <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="code-pulls-empty">
              {t.none}
            </p>
          ) : (
            <ul className="m-0 grid list-none gap-1 p-0">
              {state.items.map((pr) => (
                <li
                  key={pr.number}
                  className="grid gap-0.5 rounded-[9px] px-2 py-1.5 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk"
                  data-testid="code-pull"
                >
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[0.875rem]">
                    <span className="font-dy-mono text-dy-muted">{`#${String(pr.number)}`}</span>
                    <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{pr.title}</span>
                    {pr.draft ? <span className="text-[0.75rem] text-dy-muted">{t.draft}</span> : null}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.75rem] text-dy-muted">
                    <span className="font-dy-mono [overflow-wrap:anywhere]">
                      {`${pr.baseBranch} ← ${pr.headBranch}${pr.sameRepository ? '' : ` (${t.fork})`}`}
                    </span>
                    {pr.author === null ? null : <span>{pr.author}</span>}
                    {pr.updatedAt === null ? null : <span>{f.relative(pr.updatedAt)}</span>}
                    {pr.compare === null ? (
                      <span>{t.noCompare}</span>
                    ) : (
                      <Link
                        to={`/projects/${encodeURIComponent(props.project)}/code/compare?base=${encodeURIComponent(pr.compare.base)}&head=${encodeURIComponent(pr.compare.head)}`}
                        className="font-bold text-dy-teal-ink"
                        data-testid="code-pull-compare"
                      >
                        {t.compare}
                      </Link>
                    )}
                    {pr.url === null ? null : (
                      <a
                        href={pr.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="font-bold text-dy-teal-ink"
                      >
                        {t.open}
                      </a>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
