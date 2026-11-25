import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import type { MentionType } from '../../api/chat';
import { ApiError } from '../../api/client';
import { getJob } from '../../api/jobs';
import { getWorker } from '../../api/workers';
import { mentionHref, metaMentions } from '../../screens/chat/MentionPicker';
import { segmentMentions, unplacedMentions } from '../../screens/chat/mentionText';
import { DyIcon, type IconName } from '../icons';
import { segmentSecretTokens } from '@remyral/protocol/chat-secrets';
import { metaCredentials, TokenChip } from '../vault/CredentialChip';
import { jobState } from '../screens/projects/states';
import { StateBadge } from '../StateBadge';
import { timeAgoTr } from '../topbar';
import { type Locale, type Messages, messagesFor } from '@remyral/i18n';
import { useLocale, useT } from '../../i18n/I18nProvider';

/**
 * p12-mention-badges (docs/design/p8-chat-attachments-mentions.md §3.1): the mentions of a sent message as badges —
 * inline where the message's text carries the ref's `@label`, else in a row under it. A badge is built only from the
 * message's own refs (`meta.mentions`: type, id, the label resolved at send time); the label is React text, never
 * markup. It links to the target (the target page checks access again) and, on hover (after a short delay) or focus,
 * shows a small card: the type, the full label and — for jobs and machines, read once per ref as the viewer — the
 * state, project and last change. A ref whose id is not a valid target, or whose read answers 403 / 404, turns into a
 * muted, struck-through badge: "erişim yok ya da bulunamadı" (the same words for both — nothing leaks).
 */

/**
 * The type names in Turkish — kept for the Sohbet composer's chips (ops/Composer.tsx, moved with its own screen);
 * new code reads `t.chat.mention.types`.
 */
export const MENTION_TYPE_TR: Readonly<Record<MentionType, string>> = messagesFor('tr').chat.mention.types;

const TYPE_ICON: Readonly<Record<MentionType, IconName>> = {
  project: 'branch',
  thread: 'msg',
  output: 'tray',
  job: 'jobs',
  worker: 'cpu',
  folder: 'folder',
  credential: 'key',
  code: 'code',
};

const HOVER_DELAY_MS = 350;

export interface BadgeMention {
  readonly type: MentionType;
  readonly id: string;
  readonly project: string | null;
  readonly label: string;
}

// ---------------------------------------------------------------- facts (read once per ref, shared by every badge)

/** One line of a hover card, as data (labels and relative times are said when the card renders, in its language). */
type Fact =
  | { readonly kind: 'jobState'; readonly state: string }
  | { readonly kind: 'workerState'; readonly state: string }
  | { readonly kind: 'project' | 'system'; readonly value: string }
  | { readonly kind: 'updated' | 'lastSeen'; readonly at: string };

type Facts =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly facts: readonly Fact[] }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error' };

const cache = new Map<string, Facts>();
const listeners = new Set<() => void>();
const keyOf = (m: { type: string; id: string }): string => `${m.type}:${m.id}`;

function setFacts(key: string, f: Facts): void {
  cache.set(key, f);
  for (const l of listeners) l();
}

/** Tests: start every case with an empty cache. */
export function resetMentionFacts(): void {
  cache.clear();
  for (const l of listeners) l();
}

/** What a read of the target says (jobs and machines; the other types show the ref's own data). */
async function readFacts(m: BadgeMention): Promise<readonly Fact[]> {
  if (m.type === 'job') {
    const d = await getJob(m.id);
    return [
      { kind: 'jobState', state: d.job.state },
      { kind: 'project', value: d.job.project },
      { kind: 'updated', at: d.job.stateChangedAt },
    ];
  }
  if (m.type === 'worker') {
    const w = await getWorker(m.id);
    return [
      { kind: 'workerState', state: w.state },
      ...(w.os === null
        ? []
        : [{ kind: 'system', value: [w.os, w.arch].filter(Boolean).join(' · ') } as const]),
      ...(w.lastSeenAt === null ? [] : [{ kind: 'lastSeen', at: w.lastSeenAt } as const]),
    ];
  }
  const project = m.type === 'project' ? m.id : m.project;
  return project === null || project === '' ? [] : [{ kind: 'project', value: project }];
}

function load(m: BadgeMention): void {
  const key = keyOf(m);
  if (cache.has(key)) return;
  setFacts(key, { kind: 'loading' });
  readFacts(m).then(
    (facts) => {
      setFacts(key, { kind: 'ready', facts });
    },
    (err: unknown) => {
      const missing = err instanceof ApiError && (err.status === 403 || err.status === 404);
      setFacts(key, missing ? { kind: 'missing' } : { kind: 'error' });
    },
  );
}

function useFacts(key: string): Facts | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => cache.get(key),
  );
}

// ---------------------------------------------------------------- one badge

/** The type's icon in its badge colour (the composer's chips use it too). */
export function MentionIcon(props: { readonly type: MentionType }): ReactNode {
  return (
    <span className="inline-flex" data-mention={props.type}>
      <DyIcon name={TYPE_ICON[props.type]} className="dy-mention-icon" />
    </span>
  );
}

function BadgeBody(props: { readonly m: BadgeMention }): ReactNode {
  return (
    <>
      <DyIcon name={TYPE_ICON[props.m.type]} className="dy-mention-icon" />
      <span className="dy-mention-label">{`@${props.m.label}`}</span>
    </>
  );
}

/** A fact's label and value in the reader's language. */
function factLine(
  f: Fact,
  t: Messages,
  locale: Locale,
): { readonly label: string; readonly value: ReactNode } {
  const m = t.chat.mention;
  switch (f.kind) {
    case 'jobState': {
      const s = jobState(f.state);
      return { label: m.facts.state, value: <StateBadge state={s.state} label={s.label} /> };
    }
    case 'workerState': {
      const names: Readonly<Record<string, string>> = m.workerStates;
      return { label: m.facts.state, value: names[f.state] ?? f.state };
    }
    case 'project':
      return { label: m.facts.project, value: f.value };
    case 'system':
      return { label: m.facts.system, value: f.value };
    case 'updated':
      return { label: m.facts.updated, value: timeAgoTr(f.at, Date.now(), locale) };
    case 'lastSeen':
      return { label: m.facts.lastSeen, value: timeAgoTr(f.at, Date.now(), locale) };
  }
}

function FactsCard(props: {
  readonly id: string;
  readonly m: BadgeMention;
  readonly facts: Facts | undefined;
  readonly place: { readonly style: CSSProperties; readonly host: Element };
}): ReactNode {
  const { m, facts } = props;
  const t = useT();
  const { locale } = useLocale();
  const tm = t.chat.mention;
  // In a portal (fixed): thread items skip off-screen paint (`content-visibility`), which would clip it in place.
  return createPortal(
    <span
      id={props.id}
      style={props.place.style}
      role="tooltip"
      data-testid="mention-card"
      className="dy-mention-card pointer-events-none fixed z-50 grid w-max max-w-[min(18rem,calc(100vw-2rem))] gap-1 rounded-xl border border-dy-line-2 bg-dy-card px-3 py-2 text-left font-dy text-[0.8125rem] font-normal whitespace-normal text-dy-ink shadow-dy-pop"
    >
      <span className="flex items-center gap-1.5 text-[0.75rem] text-dy-muted">
        <DyIcon name={TYPE_ICON[m.type]} className="size-3.5" />
        {tm.types[m.type]}
      </span>
      <span className="font-bold [overflow-wrap:anywhere]">{m.label}</span>
      {facts?.kind === 'loading' ? <span className="text-dy-muted">{tm.reading}</span> : null}
      {facts?.kind === 'missing' ? <span className="text-dy-muted">{tm.missingCard}</span> : null}
      {facts?.kind === 'error' ? <span className="text-dy-muted">{tm.readError}</span> : null}
      {facts?.kind === 'ready' && facts.facts.length > 0 ? (
        <span className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
          {facts.facts.map((fact) => {
            const line = factLine(fact, t, locale);
            return (
              <span key={fact.kind} className="contents">
                <span className="text-dy-muted">{line.label}</span>
                <span className="min-w-0 truncate">{line.value}</span>
              </span>
            );
          })}
        </span>
      ) : null}
    </span>,
    props.place.host,
  );
}

export function MentionBadge(props: { readonly m: BadgeMention }): ReactNode {
  const { m } = props;
  const href = mentionHref(m);
  const key = keyOf(m);
  const facts = useFacts(key);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ style: CSSProperties; host: Element } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const cardId = useId();
  const tm = useT().chat.mention;
  const typeName = tm.types[m.type];
  const missingText = tm.missing;
  const missing = href === null || facts?.kind === 'missing';

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const show = useCallback(() => {
    cancel();
    if (href !== null) load(m);
    setOpen(true);
  }, [cancel, href, m]);
  const hide = useCallback(() => {
    cancel();
    setOpen(false);
  }, [cancel]);
  useEffect(() => cancel, [cancel]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') hide();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [open, hide]);
  // Place the card under the badge (above it near the bottom, right-aligned near the right edge), in the Diyalog
  // scope so it keeps the palette; scrolling or resizing closes it.
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    const el = wrapRef.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const style: CSSProperties = {
      ...(r.left + 288 > vw - 16 ? { right: Math.max(8, vw - r.right) } : { left: Math.max(8, r.left) }),
      ...(r.bottom + 170 > vh ? { bottom: vh - r.top + 6 } : { top: r.bottom + 6 }),
    };
    setPlace({ style, host: el.closest('[data-ui="diyalog"]') ?? document.body });
    const close = (): void => {
      setOpen(false);
    };
    window.addEventListener('scroll', close, { capture: true, passive: true });
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, { capture: true });
      window.removeEventListener('resize', close);
    };
  }, [open]);

  if (href === null)
    return (
      <span
        className="dy-mention"
        data-mention={m.type}
        data-missing=""
        data-testid="mention-badge"
        title={`${typeName}: ${m.label} — ${missingText}`}
        aria-label={`${typeName}: ${m.label} (${missingText})`}
        role="img"
      >
        <BadgeBody m={m} />
      </span>
    );

  return (
    <span
      ref={wrapRef}
      className="inline-flex max-w-full align-baseline"
      onPointerEnter={(e) => {
        if (e.pointerType !== 'mouse') return;
        cancel();
        timer.current = setTimeout(show, HOVER_DELAY_MS);
      }}
      onPointerLeave={hide}
    >
      <Link
        to={href}
        className="dy-mention"
        data-mention={m.type}
        data-missing={missing ? '' : undefined}
        data-testid="mention-badge"
        aria-label={`${typeName}: ${m.label}${missing ? ` (${missingText})` : ''}`}
        aria-describedby={open ? cardId : undefined}
        onFocus={show}
        onBlur={hide}
      >
        <BadgeBody m={m} />
      </Link>
      {open && place !== null ? <FactsCard id={cardId} m={m} facts={facts} place={place} /> : null}
    </span>
  );
}

// ---------------------------------------------------------------- a message's text with its badges

/**
 * A user message's text with its mentions as inline badges (whitespace kept); refs whose `@label` is not in the text
 * follow in a row. Text that only looks like `@x` stays text.
 */
export function MentionText(props: {
  readonly text: string;
  readonly meta: Record<string, unknown> | null;
}): ReactNode {
  const refs = metaMentions(props.meta);
  const rest = unplacedMentions(props.text, refs);
  const tm = useT().chat.mention;
  // p15-chat-vault: credential / secret tokens first (chips), then the mentions inside the plain runs.
  const creds = metaCredentials(props.meta);
  const parts = segmentSecretTokens(props.text);
  return (
    <>
      {props.text.trim() === '' ? null : (
        <span className="whitespace-pre-wrap" data-testid="mention-text">
          {parts.map((p, j) =>
            p.kind !== 'text' ? (
              <TokenChip key={`c${String(j)}`} seg={p} credentials={creds} />
            ) : (
              segmentMentions(p.text, refs).map((s, i) =>
                s.kind === 'text' ? (
                  <span key={`t${String(j)}-${String(i)}`}>{s.text}</span>
                ) : (
                  <MentionBadge key={`m${String(j)}-${String(i)}`} m={s.mention} />
                ),
              )
            ),
          )}
        </span>
      )}
      {rest.length === 0 ? null : (
        <ul className="m-0 mt-1.5 flex list-none flex-wrap gap-1.5 p-0" aria-label={tm.unplaced}>
          {rest.map((m) => (
            <li key={keyOf(m)} className="max-w-full">
              <MentionBadge m={m} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
