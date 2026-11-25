import { useErrorText } from '../../i18n/errors';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { cancelWatch, type ChatWatch } from '../../api/chat';
import {
  MAX_THREAD_PROJECTS,
  setThreadKnowledge,
  setThreadProjects,
  type ThreadKnowledge,
  type ThreadProject,
} from '../../api/chatKnowledge';
import { listProjects, type Project } from '../../api/directory';
import { chatSummaryPrompt } from '../../api/memorySuggestions';
import { cx } from '../../components/ui';
import type { PrefillState } from '../../screens/composer/prefill';
import { DyIcon } from '../icons';
import { ChatIcon } from './icons';
import type { Formatter, Messages } from '@remyral/i18n';
import { useFormat, useT } from '../../i18n/I18nProvider';

/**
 * p12-diyalog-parity (§13.3): the conversation's context under its header, in the Diyalog language — the classic
 * KnowledgeBar (p10-semantic-defaults-chat: linked project, "link to X (suggested)", change / none, where it is shared,
 * "share with project knowledge", summarise for project memory → an ordinary job prefilled in the composer) and the
 * classic WatchStrip (p6-chat-notify: what the assistant watches here, until when, Stop). Same calls
 * (`PUT /chat/threads/:id/knowledge`, `GET /projects`, `POST …/memory-summary-prompt`, `POST /chat/watches/:id/cancel`).
 */

export function watchCondition(
  w: Pick<ChatWatch, 'conditions' | 'repeat'> & { readonly check?: ChatWatch['check'] },
  t: Messages,
): string {
  // p15-watches: a check watch says its condition itself (in the watch's language).
  if (w.check !== undefined && w.check !== null) return w.check.summary;
  const names: Readonly<Record<string, string>> = t.chat.context.conditions;
  const parts = w.conditions.map((c) => names[c] ?? c);
  return `${parts.join(', ')}${w.repeat === 'every' ? t.chat.context.everyTime : ''}`;
}

/** Longest watch label in the strip (the full label stays in the tooltip). */
export const WATCH_LABEL_MAX = 48;

/**
 * p15-merge-approvals item 3: a safety cut for watch labels made before the master shortened them ("Job 0a1b2c3d: Bu
 * işin dalı, SampleWebApp uygulamasının Coolify DEPLOY DALI olacak…"): at most {@link WATCH_LABEL_MAX} characters,
 * cut at a word.
 */
export function shortWatchLabel(label: string): string {
  const one = label.replace(/\s+/g, ' ').trim();
  if (one.length <= WATCH_LABEL_MAX) return one;
  const head = one.slice(0, WATCH_LABEL_MAX - 1);
  const space = head.lastIndexOf(' ');
  return `${(space >= WATCH_LABEL_MAX / 2 ? head.slice(0, space) : head).replace(/[\s,.;:·-]+$/u, '')}…`;
}

function untilText(iso: string, f: Formatter): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : f.dateWith(d, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const LINK =
  'dy-press inline-flex min-h-11 items-center rounded-[8px] px-1.5 text-[0.8125rem] font-bold text-dy-teal-ink sm:min-h-8 disabled:opacity-50';

/**
 * p18-multi-project W3: the conversation's working projects as chips — the primary first ("ana"), each with its own
 * "Proje bilgisiyle paylaş" switch (the dot), "make primary" and remove; "+ Proje ekle" picks one more project the user
 * can read (at most {@link MAX_THREAD_PROJECTS}). Every change sends the whole set (`PUT /chat/threads/:id/projects`).
 */
export function ProjectSet(props: {
  readonly threadId: string;
  readonly projects: readonly ThreadProject[];
  readonly onChanged: () => void;
}): ReactNode {
  const sayError = useErrorText();
  const t = useT().multiProject.thread;
  const selectId = useId();
  const [set, setSet] = useState<readonly ThreadProject[]>(props.projects);
  const [adding, setAdding] = useState(false);
  const [all, setAll] = useState<Project[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSet(props.projects);
  }, [props.projects]);
  useEffect(() => {
    if (!adding || all !== null) return;
    let live = true;
    listProjects().then(
      (p) => {
        if (live) setAll(p);
      },
      (err: unknown) => {
        if (live) setError(sayError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [adding, all]);

  async function save(next: readonly { project: string; share: boolean }[]): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setSet(await setThreadProjects(props.threadId, next));
      setAdding(false);
      props.onChanged();
    } catch (err) {
      setError(sayError(err));
    } finally {
      setBusy(false);
    }
  }
  const base = set.map((m) => ({ project: m.project, share: m.share }));
  const full = set.length >= MAX_THREAD_PROJECTS;
  const candidates = (all ?? []).filter((p) => !set.some((m) => m.project === p.id));
  return (
    <div
      role="group"
      aria-label={t.region}
      className="flex min-w-0 flex-wrap items-center gap-1.5"
      data-testid="thread-projects"
    >
      <DyIcon name="folder" className="size-3.5 text-dy-faint" />
      <span className="text-dy-muted">{t.label}</span>
      {set.length === 0 ? <span className="text-dy-muted">{t.none}</span> : null}
      <ul className="m-0 flex min-w-0 list-none flex-wrap gap-1.5 p-0">
        {set.map((m) => (
          <li
            key={m.project}
            data-testid="thread-project"
            data-project={m.project}
            data-primary={m.primary ? 'true' : undefined}
            className={cx(
              'inline-flex min-h-9 max-w-full min-w-0 items-center gap-0.5 rounded-full border bg-dy-card py-0.5 pr-0.5 pl-2 text-[0.8125rem] sm:min-h-8',
              m.primary ? 'border-dy-teal/50' : 'border-dy-line',
              m.role === null && 'opacity-60',
            )}
          >
            <button
              type="button"
              disabled={busy || m.role === null}
              aria-pressed={m.share}
              aria-label={m.share ? t.shareOn({ name: m.name }) : t.shareOff({ name: m.name })}
              title={m.share ? t.shareOn({ name: m.name }) : t.shareOff({ name: m.name })}
              data-testid="thread-project-share"
              onClick={() =>
                void save(base.map((b) => (b.project === m.project ? { ...b, share: !b.share } : b)))
              }
              className="dy-press grid size-11 shrink-0 place-items-center rounded-full disabled:opacity-50 sm:size-6"
            >
              <span
                aria-hidden="true"
                className={cx(
                  'size-2 rounded-full',
                  m.share ? 'bg-dy-green' : 'border border-dy-line-2 bg-transparent',
                )}
              />
            </button>
            <span className="min-w-0 truncate font-bold text-dy-ink" title={m.project}>
              {m.name}
            </span>
            {m.primary ? (
              <span className="ml-1 shrink-0 text-[0.75rem] text-dy-teal-ink" title={t.primaryHint}>
                {t.primary}
              </span>
            ) : (
              <button
                type="button"
                disabled={busy || m.role === null}
                aria-label={t.makePrimary({ name: m.name })}
                title={t.makePrimary({ name: m.name })}
                data-testid="thread-project-primary"
                onClick={() =>
                  void save([
                    ...base.filter((b) => b.project === m.project),
                    ...base.filter((b) => b.project !== m.project),
                  ])
                }
                className="dy-press grid size-11 shrink-0 place-items-center rounded-full text-dy-muted disabled:opacity-50 sm:size-6 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk"
              >
                <ChatIcon name="star" className="size-3.5" />
              </button>
            )}
            {m.role === null ? (
              <span className="ml-1 shrink-0 text-[0.75rem] text-dy-muted">{t.noAccess}</span>
            ) : null}
            <button
              type="button"
              disabled={busy}
              aria-label={t.remove({ name: m.name })}
              title={t.remove({ name: m.name })}
              data-testid="thread-project-remove"
              onClick={() => void save(base.filter((b) => b.project !== m.project))}
              className="dy-press grid size-11 shrink-0 place-items-center rounded-full text-dy-muted disabled:opacity-50 sm:size-6 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
            >
              <ChatIcon name="close" className="size-3" />
            </button>
          </li>
        ))}
      </ul>
      {adding ? (
        <span className="flex items-center gap-2">
          <label htmlFor={selectId} className="sr-only">
            {t.addLabel}
          </label>
          {all === null ? (
            <span className="text-dy-faint" role="status">
              {t.loading}
            </span>
          ) : (
            <select
              id={selectId}
              value=""
              disabled={busy}
              data-testid="thread-project-add-select"
              onChange={(e) => {
                if (e.target.value !== '') void save([...base, { project: e.target.value, share: true }]);
              }}
              className="min-h-11 max-w-[16rem] rounded-[8px] border border-dy-line-2 bg-dy-card px-2 text-[0.875rem] text-dy-ink sm:min-h-8"
            >
              <option value="">{t.choose}</option>
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name === p.id ? p.id : `${p.name} (${p.id})`}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className={cx(LINK, 'font-medium text-dy-muted')}
            onClick={() => {
              setAdding(false);
            }}
          >
            {t.cancel}
          </button>
        </span>
      ) : (
        <button
          type="button"
          disabled={busy || full}
          title={full ? t.max({ max: MAX_THREAD_PROJECTS }) : undefined}
          data-testid="thread-project-add"
          className={LINK}
          onClick={() => {
            setAdding(true);
          }}
        >
          <ChatIcon name="link" className="mr-1 size-3.5" />
          {t.add}
        </button>
      )}
      {error === null ? null : (
        <p role="alert" className="m-0 w-full text-[0.78125rem] text-dy-red-ink">
          {error}
        </p>
      )}
    </div>
  );
}

function Knowledge(props: {
  readonly threadId: string;
  readonly knowledge: ThreadKnowledge;
  readonly onChanged: () => void;
}): ReactNode {
  const sayError = useErrorText();
  const tc = useT().chat;
  const c = tc.context;
  const selectId = useId();
  const navigate = useNavigate();
  const [k, setK] = useState(props.knowledge);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setK(props.knowledge);
  }, [props.knowledge]);
  useEffect(() => {
    if (!editing || projects !== null) return;
    let live = true;
    listProjects().then(
      (p) => {
        if (live) setProjects(p);
      },
      (err: unknown) => {
        if (live) setError(sayError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [editing, projects]);

  async function change(patch: { project?: string | null; share?: boolean }): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setK(await setThreadKnowledge(props.threadId, patch));
      setEditing(false);
      props.onChanged();
    } catch (err) {
      setError(sayError(err));
    } finally {
      setBusy(false);
    }
  }

  async function summarise(project: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { prompt } = await chatSummaryPrompt(props.threadId, project);
      const state: PrefillState = { prefill: { project, spec: { prompt } } };
      void navigate('/jobs/new', { state });
    } catch (err) {
      setError(sayError(err));
    } finally {
      setBusy(false);
    }
  }

  const shared = k.sharedWith;
  const canShare = shared.length > 0 || k.notShared.some((n) => n.reason === 'thread_off');
  // p18-multi-project W3: with a project set the chips replace the single "Proje: X · Değiştir" line and the thread-wide
  // switch (each chip has its own); a conversation without projects keeps the classic line ("Projeye bağla", suggestion).
  const chips = k.projects.length > 0;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem]" data-testid="knowledge-bar">
      {chips ? (
        <ProjectSet threadId={props.threadId} projects={k.projects} onChanged={props.onChanged} />
      ) : editing ? (
        <span className="flex items-center gap-2">
          <label htmlFor={selectId} className="text-dy-muted">
            {c.project}
          </label>
          {projects === null ? (
            <span className="text-dy-faint" role="status">
              {c.projectsLoading}
            </span>
          ) : (
            <select
              id={selectId}
              value={k.project ?? ''}
              disabled={busy}
              onChange={(e) => void change({ project: e.target.value === '' ? null : e.target.value })}
              className="min-h-11 rounded-[8px] border border-dy-line-2 bg-dy-card px-2 text-[0.875rem] text-dy-ink sm:min-h-8"
            >
              <option value="">{c.noProject}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className={cx(LINK, 'font-medium text-dy-muted')}
            onClick={() => {
              setEditing(false);
            }}
          >
            {tc.cancel}
          </button>
        </span>
      ) : (
        <span className="flex flex-wrap items-center gap-1.5">
          <DyIcon name="folder" className="size-3.5 text-dy-faint" />
          <span className="text-dy-muted">
            {c.projectLabel}
            <b className="font-bold text-dy-ink">{k.project ?? c.none}</b>
          </span>
          <button
            type="button"
            className={LINK}
            onClick={() => {
              setEditing(true);
            }}
          >
            {k.project === null ? c.link : c.change}
          </button>
          {k.project === null && k.suggestedProject !== null ? (
            <button
              type="button"
              disabled={busy}
              className={LINK}
              data-testid="knowledge-suggested"
              onClick={() => void change({ project: k.suggestedProject })}
            >
              {c.linkSuggested({ project: k.suggestedProject })}
            </button>
          ) : null}
        </span>
      )}
      {shared.length > 0 ? (
        <span className="inline-flex items-center gap-1.5 text-dy-green" data-testid="knowledge-shared">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-dy-green" />
          {c.sharedWith({ projects: shared.join(', ') })}
        </span>
      ) : k.notShared.length > 0 ? (
        <span className="text-dy-muted" data-testid="knowledge-not-shared">
          {c.notSharedWith({
            projects: k.notShared.map((n) => n.project).join(', '),
            reason: c.notShared[k.notShared[0]?.reason ?? 'thread_off'],
          })}
        </span>
      ) : null}
      {canShare && !chips ? (
        <label className="ml-auto inline-flex min-h-11 cursor-pointer items-center gap-2 sm:min-h-8">
          <input
            type="checkbox"
            role="switch"
            className="size-4 accent-[var(--dy-teal)]"
            checked={k.share}
            disabled={busy}
            onChange={(e) => void change({ share: e.target.checked })}
          />
          {c.share}
        </label>
      ) : null}
      {k.memorySummary.map((p) => (
        <button
          key={p}
          type="button"
          disabled={busy}
          title={c.summariseHint}
          className={LINK}
          data-testid="knowledge-summarise"
          onClick={() => void summarise(p)}
        >
          {c.summarise({ project: p })}
        </button>
      ))}
      {error === null ? null : (
        <p role="alert" className="m-0 w-full text-[0.78125rem] text-dy-red-ink">
          {error}
        </p>
      )}
    </div>
  );
}

function Watches(props: {
  readonly watches: readonly ChatWatch[];
  readonly onChanged: () => void;
}): ReactNode {
  const sayError = useErrorText();
  const fmt = useFormat();
  const t = useT();
  const c = t.chat.context;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Many watches would push the conversation down: past two they fold into one line ("5 izleme ▾").
  const [open, setOpen] = useState(false);
  const active = props.watches.filter((w) => w.state === 'active');
  const folds = active.length > 2;
  const shown = !folds || open;
  if (active.length === 0 && error === null) return null;
  async function stop(w: ChatWatch): Promise<void> {
    setBusy(w.id);
    setError(null);
    try {
      await cancelWatch(w.id);
      props.onChanged();
    } catch (err) {
      setError(sayError(err));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section
      aria-label={c.watchesRegion}
      data-testid="chat-watches"
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5"
    >
      <span className="inline-flex items-center gap-1.5 text-[0.8125rem] text-dy-muted">
        <ChatIcon name="sparkle" className="size-3.5" />
        {c.watching}
      </span>
      {folds ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls="chat-watch-list"
          data-testid="chat-watches-toggle"
          onClick={() => {
            setOpen((v) => !v);
          }}
          title={open ? c.hideWatches : c.showWatches}
          className="dy-press inline-flex min-h-9 items-center gap-1 rounded-full border border-dy-line bg-dy-card px-3 text-[0.8125rem] font-bold text-dy-ink [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk"
        >
          {c.watchingCount({ n: active.length })}
          <span aria-hidden="true" className="text-dy-muted">
            {open ? '▴' : '▾'}
          </span>
        </button>
      ) : null}
      {shown ? (
        <ul
          id="chat-watch-list"
          className={`m-0 flex min-w-0 list-none flex-wrap gap-1.5 p-0${folds ? ' max-h-40 w-full overflow-y-auto' : ''}`}
          aria-label={c.activeWatches}
        >
          {active.map((w) => (
            <li
              key={w.id}
              className="inline-flex min-h-9 max-w-full min-w-0 items-center gap-1 rounded-full border border-dy-line bg-dy-card py-0.5 pr-0.5 pl-3 text-[0.8125rem]"
            >
              <Link
                to={w.link}
                className="min-w-0 truncate font-bold text-dy-ink no-underline"
                title={w.label}
              >
                {shortWatchLabel(w.label)}
              </Link>
              <span className="shrink-0 text-dy-muted">
                {c.watchUntil({ condition: watchCondition(w, t), until: untilText(w.expiresAt, fmt) })}
              </span>
              <button
                type="button"
                disabled={busy === w.id}
                aria-label={c.stopWatch({ label: w.label })}
                onClick={() => void stop(w)}
                className="dy-press grid size-11 shrink-0 place-items-center rounded-full text-dy-muted disabled:opacity-50 sm:size-8 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
              >
                <ChatIcon name="close" className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="m-0 w-full text-[0.78125rem] text-dy-red-ink">
          {error}
        </p>
      )}
    </section>
  );
}

/** Knowledge line + watches, pinned under the conversation header (nothing when neither has anything to say). */
export function ContextStrip(props: {
  readonly threadId: string;
  readonly knowledge: ThreadKnowledge | null;
  readonly watches: readonly ChatWatch[];
  readonly onChanged: () => void;
}): ReactNode {
  const hasWatches = props.watches.some((w) => w.state === 'active');
  if (props.knowledge === null && !hasWatches) return null;
  return (
    <div
      className="flex flex-col gap-1.5 border-b border-dy-line bg-dy-thread/95 px-3 py-1.5 backdrop-blur-[14px] sm:px-6"
      data-testid="dy-knowledge"
    >
      {props.knowledge === null ? null : (
        <Knowledge threadId={props.threadId} knowledge={props.knowledge} onChanged={props.onChanged} />
      )}
      <Watches watches={props.watches} onChanged={props.onChanged} />
    </div>
  );
}
