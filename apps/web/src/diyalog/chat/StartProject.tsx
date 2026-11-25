import { type ReactNode, useEffect, useId, useState } from 'react';
import { MAX_THREAD_PROJECTS } from '../../api/chatKnowledge';
import { listProjects, type Project } from '../../api/directory';
import { useT } from '../../i18n/I18nProvider';
import { ChatIcon } from './icons';

/**
 * A new conversation can start from a project: the empty new conversation offers a project picker in its centre area;
 * the conversation is linked to it when it is created (the first message, a suggestion or an upload). "Projesiz" keeps
 * today's behaviour; the project can still be changed later in the context strip.
 *
 * p18-multi-project W3: once a project is chosen, "Başka proje ekle" adds more working projects (the first stays the
 * primary; at most {@link MAX_THREAD_PROJECTS}) — the conversation starts with the whole set.
 */
export function StartProject(props: {
  /** The chosen projects, the primary first (empty: "Projesiz"). */
  readonly value: readonly string[];
  readonly onChange: (projects: string[]) => void;
  readonly disabled?: boolean;
}): ReactNode {
  const t = useT().chat.thread.startProject;
  const m = useT().multiProject.start;
  const id = useId();
  const moreId = useId();
  const [projects, setProjects] = useState<readonly Project[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    let live = true;
    listProjects().then(
      (p) => {
        if (live) setProjects(p);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, []);
  if (failed || (projects !== null && projects.length === 0)) return null;
  const primary = props.value[0] ?? null;
  const extras = props.value.slice(1);
  const nameOf = (pid: string): string => projects?.find((p) => p.id === pid)?.name ?? pid;
  const label = (p: Project): string => (p.name === p.id ? p.id : `${p.name} (${p.id})`);
  const free = (projects ?? []).filter((p) => !props.value.includes(p.id));
  return (
    <div className="mt-3 flex flex-col items-center gap-1.5" data-testid="dy-chat-start-project">
      <label htmlFor={id} className="text-[0.8125rem] font-bold text-dy-muted">
        {t.label}
      </label>
      <select
        id={id}
        value={primary ?? ''}
        disabled={props.disabled === true || projects === null}
        onChange={(e) => {
          const v = e.target.value;
          props.onChange(v === '' ? [] : [v, ...extras.filter((x) => x !== v)]);
        }}
        className="min-h-11 min-w-[16rem] max-w-full rounded-[10px] border border-dy-line-2 bg-dy-card px-3 text-[0.9375rem] text-dy-ink sm:min-h-9"
      >
        <option value="">{projects === null ? t.loading : t.none}</option>
        {(projects ?? []).map((p) => (
          <option key={p.id} value={p.id}>
            {label(p)}
          </option>
        ))}
      </select>
      {primary === null ? null : (
        <div
          className="flex max-w-full flex-wrap items-center justify-center gap-1.5"
          data-testid="dy-chat-start-extras"
        >
          {extras.length === 0 ? null : <span className="text-[0.8125rem] text-dy-muted">{m.extras}</span>}
          {extras.map((pid) => (
            <span
              key={pid}
              data-testid="dy-chat-start-extra"
              className="inline-flex min-h-9 items-center gap-1 rounded-full border border-dy-line bg-dy-card py-0.5 pr-0.5 pl-3 text-[0.8125rem] font-bold text-dy-ink"
            >
              {nameOf(pid)}
              <button
                type="button"
                aria-label={m.remove({ name: nameOf(pid) })}
                disabled={props.disabled === true}
                onClick={() => {
                  props.onChange(props.value.filter((x) => x !== pid));
                }}
                className="dy-press grid size-11 place-items-center rounded-full text-dy-muted sm:size-7 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk"
              >
                <ChatIcon name="close" className="size-3" />
              </button>
            </span>
          ))}
          {adding ? (
            <>
              <label htmlFor={moreId} className="sr-only">
                {m.more}
              </label>
              <select
                id={moreId}
                value=""
                data-testid="dy-chat-start-more-select"
                disabled={props.disabled === true}
                onChange={(e) => {
                  if (e.target.value !== '') props.onChange([...props.value, e.target.value]);
                  setAdding(false);
                }}
                className="min-h-11 max-w-full rounded-[10px] border border-dy-line-2 bg-dy-card px-3 text-[0.875rem] text-dy-ink sm:min-h-9"
              >
                <option value="">{m.more}</option>
                {free.map((p) => (
                  <option key={p.id} value={p.id}>
                    {label(p)}
                  </option>
                ))}
              </select>
            </>
          ) : props.value.length < MAX_THREAD_PROJECTS && free.length > 0 ? (
            <button
              type="button"
              data-testid="dy-chat-start-more"
              disabled={props.disabled === true}
              onClick={() => {
                setAdding(true);
              }}
              className="dy-press inline-flex min-h-11 items-center rounded-[8px] px-1.5 text-[0.8125rem] font-bold text-dy-teal-ink sm:min-h-8"
            >
              {m.more}
            </button>
          ) : null}
        </div>
      )}
      <p className="m-0 max-w-[52ch] text-[0.8125rem] text-dy-muted">
        {primary === null ? t.hintNone : extras.length > 0 ? m.hintMany({ n: props.value.length }) : t.hint}
      </p>
    </div>
  );
}
