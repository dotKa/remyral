import { type ReactNode, type SubmitEvent, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ApiError } from '../../../api/client';
import {
  addItemNote,
  deleteItemNote,
  deleteNoteCard,
  editItemNote,
  fileUrl,
  getNoteCard,
  type ItemNote,
  listItemNotes,
  listOutputs,
  type NoteCard,
  type OutputItem,
  updateOutputItem,
} from '../../../api/outputs';
import { type Monitor, monitorFromOutput, pct, providerRow } from '../../../api/uptime';
import { toApiError } from '../../../components/ui';
import { parseTagText } from '../../../screens/outputs/format';
import { useSubmit } from '../../../screens/useSubmit';
import { DyIcon } from '../../icons';
import { KeyValue, type KeyValueRow } from '../../KeyValue';
import { DyApiError, DyConfirm, DyInput, DyNotice, DyTextarea } from '../kit';
import { createShare, downloadUrl, listShares, revokeShare, type ShareLink } from '../../../api/storage';
import { DyCopyButton } from '../../common/actions';
import { useGuardedOp } from '../settings/integrations-ops';
import { DyButton, Pill, SkeletonRows } from '../parts';
import { ItemFolders } from './Folders';
import { NoteForm } from './NoteForm';
import { DyFileViewer, DySiteBundle } from './Preview';
import { WorkfilesPanel } from '../../workfiles/WorkfilesPanel';
import { outputImages } from '../../chat/JobResultCard';
import {
  canEdit,
  DyMarkdown,
  HealthBadge,
  HealthThumb,
  siteWhere,
  upState,
  UpWord,
  type Viewer,
  When,
} from './shared';
import { useFormat, useT } from '../../../i18n/I18nProvider';

/**
 * p12-diyalog-w2: the item drawer of Çıktılar (a side sheet; full screen on phones) — preview, site (open, where,
 * protection, deploy, health, uptime + "Bunu izle"), file facts (type, size, redacted, kept until, SHA-256), title /
 * tags / pin, the notes thread, a note card, the folders the item is in and the source job. Same calls and rules as
 * the classic `OutputDetail`; every text from an output is React text.
 */

const LINK =
  'font-medium text-dy-teal-ink underline-offset-2 [@media(hover:hover)_and_(pointer:fine)]:hover:underline';

const ACTION =
  'dy-press inline-flex min-h-10 items-center justify-center gap-1.5 rounded-[9px] border px-3.5 text-[0.875rem] font-bold no-underline sm:min-h-9';

function Section(props: {
  readonly title: string;
  readonly children: ReactNode;
  readonly testId?: string;
}): ReactNode {
  return (
    <section aria-label={props.title} className="flex flex-col gap-2.5" data-testid={props.testId}>
      <h3 className="m-0 text-[0.9375rem] font-bold">{props.title}</h3>
      {props.children}
    </section>
  );
}

export function OutputDetail(props: {
  readonly item: OutputItem;
  readonly viewer: Viewer;
  readonly onChanged: (item: OutputItem | null) => void;
}): ReactNode {
  const t = useT().outputs;
  const { item, viewer } = props;
  const writable = viewer.writable.has(item.project);
  return (
    <div className="flex flex-col gap-6" data-testid="output-detail">
      <div className="flex flex-wrap items-center gap-2 text-[0.8125rem] text-dy-muted">
        <Pill tone="neutral">{t.types[item.type]}</Pill>
        <span translate="no">{item.project}</span>
        <span aria-hidden="true">·</span>
        <When iso={item.createdAt} />
        {item.pinned ? (
          <Pill tone="teal" icon="flag">
            {t.pinned}
          </Pill>
        ) : null}
        {item.jobId !== null ? (
          <Link
            to={`/jobs/${encodeURIComponent(item.jobId)}`}
            className={`ml-auto ${LINK}`}
            data-testid="source-job"
          >
            {t.detail.sourceJob}
          </Link>
        ) : null}
      </div>
      {item.type === 'note' ? (
        <NoteCardDetail item={item} viewer={viewer} onChanged={props.onChanged} />
      ) : (
        <>
          {item.site !== null ? <SiteSection item={item} /> : null}
          {item.site !== null && item.health !== null ? (
            <Section title={t.detail.health} testId="site-health-section">
              <HealthBadge item={item} />
              <HealthThumb item={item} large />
            </Section>
          ) : null}
          {item.site !== null ? (
            <UptimeSection
              item={item}
              writable={writable}
              onMonitored={() => {
                props.onChanged(item);
              }}
            />
          ) : null}
          {item.file !== null ? <FileSection item={item} viewer={viewer} /> : null}
          {/* p15-workspace-retention: the job's kept working directory, when there is one. */}
          {item.jobId !== null ? (
            <WorkfilesPanel jobId={item.jobId} hideWhenNone canManage={writable} />
          ) : null}
          {writable ? <MetaEditor item={item} onChanged={props.onChanged} /> : <ReadOnlyTags item={item} />}
          <NotesThread
            item={item}
            viewer={viewer}
            onCount={(n) => {
              props.onChanged({ ...item, noteCount: n });
            }}
          />
        </>
      )}
      <ItemFolders project={item.project} itemKey={item.key} projectWritable={writable} />
    </div>
  );
}

function SiteSection(props: { readonly item: OutputItem }): ReactNode {
  const t = useT().outputs;
  const ts = t.detail.site;
  const s = props.item.site;
  if (s === null) return null;
  const rows: KeyValueRow[] = [];
  if (s.url !== null) rows.push({ k: ts.address, v: s.url, mono: true });
  rows.push({ k: ts.where, v: siteWhere(s, t) });
  if (s.provider === 'tunnel') {
    rows.push({
      k: ts.protection,
      v:
        s.protection === 'none' ? (
          <span className="font-bold text-dy-amber-ink" data-testid="output-public-link">
            {ts.public}
          </span>
        ) : s.protection === 'access' ? (
          ts.access
        ) : s.protection === 'service-token' ? (
          ts.serviceToken
        ) : (
          '—'
        ),
    });
    if (s.expiresAt !== null) rows.push({ k: ts.closes, v: <When iso={s.expiresAt} /> });
  }
  rows.push({ k: ts.deployed, v: <When iso={s.deployedAt} /> });
  rows.push({
    k: ts.deploy,
    v: (
      <Link to={`/deploys/${encodeURIComponent(s.opsActionId)}`} className={LINK}>
        {s.provider === 'tunnel' ? ts.openOps : ts.openDeploy}
      </Link>
    ),
  });
  return (
    <Section title={t.types.site}>
      {s.url !== null ? (
        <a
          href={s.url}
          target="_blank"
          rel="noopener noreferrer"
          className={`${ACTION} self-start border-dy-ink bg-dy-ink text-dy-card`}
          data-testid="open-site"
        >
          <DyIcon name="globe" className="size-4" />
          {t.openSite}
        </a>
      ) : (
        <DyNotice tone="neutral">{ts.noUrl}</DyNotice>
      )}
      <KeyValue rows={rows} />
      {s.provider === 'pages' && props.item.jobId !== null ? (
        <details className="rounded-[12px] border border-dy-line p-3">
          <summary className="cursor-pointer text-[0.875rem] font-bold">{ts.files}</summary>
          <div className="mt-3">
            <DySiteBundle jobId={props.item.jobId} />
          </div>
        </details>
      ) : null}
    </Section>
  );
}

function UptimeSection(props: {
  readonly item: OutputItem;
  readonly writable: boolean;
  readonly onMonitored: () => void;
}): ReactNode {
  const t = useT().outputs;
  const tu = t.detail.uptime;
  const { item } = props;
  const submit = useSubmit();
  const [created, setCreated] = useState<readonly Monitor[] | null>(null);
  const monitors = item.uptime?.monitors ?? [];
  return (
    <Section title={tu.title} testId="site-uptime-section">
      {monitors.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[0.875rem]">
          {monitors.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-2">
              <UpWord state={upState(m)} />
              <Link to={`/uptime/${encodeURIComponent(m.id)}`} className={LINK}>
                {providerRow(m.type, m.detail, m.status) ?? m.name}
              </Link>
              <span className="font-dy-mono text-[0.78125rem] text-dy-muted">{`${pct(m.uptime24h)} · ${t.last24h}`}</span>
            </li>
          ))}
        </ul>
      ) : created === null ? (
        <p className="m-0 text-[0.875rem] text-dy-muted">{tu.none}</p>
      ) : null}
      {created !== null ? (
        <DyNotice tone="green" live>
          <span data-testid="monitor-this-done">
            {created.length === 0 ? tu.already : tu.now({ names: created.map((m) => m.name).join(', ') })}{' '}
            {created[0] !== undefined ? (
              <Link to={`/uptime/${encodeURIComponent(created[0].id)}`} className="font-bold text-current">
                {tu.open}
              </Link>
            ) : null}
          </span>
        </DyNotice>
      ) : null}
      {props.writable && monitors.length === 0 && created === null ? (
        <DyButton
          icon="gauge"
          className="self-start"
          busy={submit.busy}
          disabled={submit.blocked}
          onClick={() => {
            void submit.run(async () => {
              const r = await monitorFromOutput(item.project, item.key);
              setCreated(r.created);
              props.onMonitored();
            });
          }}
        >
          {tu.watch}
        </DyButton>
      ) : null}
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
    </Section>
  );
}

/**
 * p17-object-storage: time-limited share links of a stored output (owners / admins; a fresh code under the security
 * policy). The link is shown once, right after it was created; the list never carries a token.
 */
function ShareLinks(props: { readonly item: OutputItem; readonly artifactId: string }): ReactNode {
  const t = useT().outputs.detail.file.share;
  const fmt = useFormat();
  const jobId = props.item.jobId ?? '';
  const [links, setLinks] = useState<readonly ShareLink[] | null>(null);
  const [days, setDays] = useState('1');
  const [created, setCreated] = useState<string | null>(null);
  const act = useSubmit();
  const guarded = useGuardedOp();
  useEffect(() => {
    if (jobId === '') return;
    const ctl = new AbortController();
    listShares(jobId, props.artifactId, { signal: ctl.signal }).then(setLinks, () => {
      setLinks([]);
    });
    return () => {
      ctl.abort();
    };
  }, [jobId, props.artifactId]);
  if (jobId === '') return null;
  const now = Date.now();
  const active = (links ?? []).filter((l) => l.revokedAt === null && Date.parse(l.expiresAt) > now);
  return (
    <div className="flex flex-col gap-2" data-testid="share-links">
      <p className="m-0 font-bold">{t.title}</p>
      <p className="m-0 text-[0.8125rem] text-dy-muted">{t.sub}</p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(async () => {
            const out = await guarded(
              () => createShare(jobId, props.artifactId, Number(days) || 1),
              t.stepUp,
            );
            if (out === null) return;
            setCreated(out.url);
            setLinks([out.link, ...(links ?? [])]);
          });
        }}
      >
        <DyInput
          label={t.days}
          inputMode="numeric"
          value={days}
          onChange={(e) => {
            setDays(e.target.value.replace(/[^0-9]/g, '').slice(0, 2));
          }}
        />
        <DyButton type="submit" busy={act.busy} icon="send">
          {t.create}
        </DyButton>
      </form>
      {created !== null ? (
        <DyNotice tone="green" live>
          <span className="flex flex-col gap-1">
            <span>{t.created}</span>
            <span className="font-dy-mono break-all" data-testid="share-url">
              {created}
            </span>
            <span>
              <DyCopyButton text={created} label={t.copy} />
            </span>
          </span>
        </DyNotice>
      ) : null}
      <DyApiError error={act.error} retryLeft={act.retryLeft} />
      {links === null ? (
        <SkeletonRows label={t.loading} rows={1} />
      ) : active.length === 0 ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted">{t.none}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {active.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-2 text-[0.8125rem]">
              <span>
                {t.row({ by: l.createdBy ?? '—', uses: String(l.useCount) })} · {t.expires}{' '}
                {fmt.dateTime(l.expiresAt)}
              </span>
              <DyConfirm
                label={t.revoke}
                question={t.revokeQuestion}
                onConfirm={() => {
                  void act.run(async () => {
                    const r = await revokeShare(jobId, props.artifactId, l.id);
                    setLinks(active.map((x) => (x.id === r.id ? r : x)));
                  });
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FileSection(props: { readonly item: OutputItem; readonly viewer: Viewer }): ReactNode {
  const t = useT().outputs.detail.file;
  const fmt = useFormat();
  const { item } = props;
  const f = item.file;
  // p15-workspace-retention: the job's images, so the lightbox goes next / previous across them.
  const [siblings, setSiblings] = useState<readonly OutputItem[] | null>(null);
  const isImage = f?.preview === 'image';
  useEffect(() => {
    if (!isImage || item.jobId === null) return;
    const ctl = new AbortController();
    listOutputs({ job: item.jobId, limit: 50 }, { signal: ctl.signal }).then(
      (r) => {
        setSiblings(r.items);
      },
      () => undefined,
    );
    return () => {
      ctl.abort();
    };
  }, [isImage, item.jobId]);
  const images = outputImages(siblings ?? [item]);
  const at = images.findIndex((x) => x.key === item.key);
  if (f === null) return null;
  const rows: KeyValueRow[] = [
    { k: t.file, v: item.name, mono: true },
    {
      k: t.type,
      v: `${f.mediaType}${f.sizeBytes !== null ? ` · ${fmt.bytes(f.sizeBytes)}` : ''}${
        f.kind === 'summary' ? ` · ${t.summary}` : f.kind === 'run' ? ` · ${t.run}` : ''
      }`,
    },
  ];
  if (f.redacted) rows.push({ k: t.cleaned, v: t.cleanedText });
  rows.push({
    k: t.kept,
    v:
      f.removed !== null ? (
        t.removed
      ) : f.expiresAt !== null ? (
        <When iso={f.expiresAt} />
      ) : item.pinned ? (
        t.pinnedKept
      ) : (
        t.noLimit
      ),
  });
  if (f.sha256 !== null)
    rows.push({ k: 'SHA-256', v: <span className="break-all">{f.sha256}</span>, mono: true });
  // p17-object-storage: where the bytes are.
  if (f.location !== null) rows.push({ k: t.location, v: t.locations[f.location] });
  return (
    <Section title={t.title}>
      {f.download !== null ? (
        <span className="flex flex-wrap gap-2 self-start">
          {/* A navigation (never a fetch into memory): a presigned link of the object storage, or the file itself. */}
          <a
            href={f.source === 'workspace' ? downloadUrl(f.download) : fileUrl(f.download, false)}
            download
            className={`${ACTION} border-dy-line-2 bg-dy-card text-dy-ink`}
            data-testid="download-file"
          >
            <DyIcon name="tray" className="size-4" />
            {t.download}
          </a>
          {f.location === 's3' ? (
            <a
              href={downloadUrl(f.download, true)}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
              className={`${ACTION} border-dy-line-2 bg-dy-card text-dy-ink`}
              data-testid="open-in-s3"
            >
              <DyIcon name="globe" className="size-4" />
              {t.openInS3}
            </a>
          ) : null}
        </span>
      ) : null}
      <DyFileViewer
        file={f}
        jobId={item.jobId}
        name={item.name}
        {...(at < 0 ? {} : { gallery: { images: images.map((x) => x.image), index: at } })}
      />
      <KeyValue rows={rows} />
      {props.viewer.admin && f.download !== null && f.source === 'workspace' ? (
        <ShareLinks item={item} artifactId={f.artifactId} />
      ) : null}
    </Section>
  );
}

function ReadOnlyTags(props: { readonly item: OutputItem }): ReactNode {
  const t = useT().outputs;
  if (props.item.tags.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label={t.tags}>
      {props.item.tags.map((tag) => (
        <li key={tag} className="rounded-full bg-dy-sunk px-2.5 py-0.5 text-[0.78125rem]">
          {tag}
        </li>
      ))}
    </ul>
  );
}

function MetaEditor(props: {
  readonly item: OutputItem;
  readonly onChanged: (i: OutputItem) => void;
}): ReactNode {
  const t = useT().outputs;
  const tm = t.detail.meta;
  const { item } = props;
  const [title, setTitle] = useState(item.title ?? '');
  const [tags, setTags] = useState(item.tags.join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    setTitle(item.title ?? '');
    setTags(item.tags.join(', '));
  }, [item.key, item.title, item.tags]);

  async function save(patch: {
    title?: string | null;
    tags?: readonly string[];
    pinned?: boolean;
  }): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      props.onChanged(await updateOutputItem({ project: item.project, key: item.key, ...patch }));
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-[12px] border border-dy-line bg-dy-sunk/50 p-3.5"
      aria-label={tm.label}
      onSubmit={(e: SubmitEvent<HTMLFormElement>) => {
        e.preventDefault();
        void save({ title: title.trim() === '' ? null : title.trim(), tags: parseTagText(tags) });
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 text-[0.9375rem] font-bold">{tm.heading}</h3>
        <DyButton
          variant={item.pinned ? 'primary' : 'secondary'}
          icon="flag"
          aria-pressed={item.pinned}
          busy={busy}
          onClick={() => void save({ pinned: !item.pinned })}
          data-testid="pin-toggle"
        >
          {item.pinned ? t.pinnedState : t.pin}
        </DyButton>
      </div>
      {item.type === 'file' ? <p className="m-0 text-[0.78125rem] text-dy-muted">{tm.pinnedFiles}</p> : null}
      <DyInput
        label={tm.title}
        value={title}
        maxLength={200}
        placeholder={item.name}
        onChange={(e) => {
          setTitle(e.target.value);
        }}
      />
      <DyInput
        label={t.tags}
        hint={tm.tagsHint}
        value={tags}
        onChange={(e) => {
          setTags(e.target.value);
        }}
      />
      <DyApiError error={error} />
      <DyButton type="submit" busy={busy} className="self-start">
        {t.save}
      </DyButton>
    </form>
  );
}

function NotesThread(props: {
  readonly item: OutputItem;
  readonly viewer: Viewer;
  readonly onCount: (count: number) => void;
}): ReactNode {
  const t = useT().outputs;
  const tn = t.detail.notes;
  const { item, viewer } = props;
  const [notes, setNotes] = useState<ItemNote[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const writable = viewer.writable.has(item.project);

  useEffect(() => {
    let live = true;
    setNotes(null);
    listItemNotes(item.project, item.key).then(
      (n) => {
        if (live) setNotes(n);
      },
      (err: unknown) => {
        if (live) setError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [item.project, item.key]);

  async function run(fn: () => Promise<number>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      props.onCount(await fn());
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title={tn.title}>
      {notes === null && error === null ? <SkeletonRows label={tn.loading} rows={1} /> : null}
      {notes !== null && notes.length === 0 ? (
        <p className="m-0 text-[0.875rem] text-dy-muted">{tn.none}</p>
      ) : null}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {(notes ?? []).map((n) => (
          <li
            key={n.id}
            className="rounded-[12px] border border-dy-line bg-dy-card p-3"
            data-testid="item-note"
          >
            <div className="mb-1.5 flex flex-wrap items-center gap-x-2 text-[0.78125rem] text-dy-muted">
              <span className="font-bold text-dy-ink">{n.author.username ?? t.deletedUser}</span>
              <When iso={n.createdAt} />
              {n.updatedAt !== n.createdAt ? <span>{tn.edited}</span> : null}
            </div>
            {editing?.id === n.id ? (
              <div className="flex flex-col gap-2">
                <DyTextarea
                  label={<span className="sr-only">{tn.editLabel}</span>}
                  rows={4}
                  maxLength={20_000}
                  value={editing.body}
                  onChange={(e) => {
                    setEditing({ id: n.id, body: e.target.value });
                  }}
                />
                <div className="flex gap-2">
                  <DyButton
                    variant="primary"
                    busy={busy}
                    onClick={() =>
                      void run(async () => {
                        const saved = await editItemNote(n.id, editing.body);
                        setNotes((list) => (list ?? []).map((x) => (x.id === n.id ? saved : x)));
                        setEditing(null);
                        return notes?.length ?? 0;
                      })
                    }
                  >
                    {t.save}
                  </DyButton>
                  <DyButton
                    variant="ghost"
                    onClick={() => {
                      setEditing(null);
                    }}
                  >
                    {t.cancel}
                  </DyButton>
                </div>
              </div>
            ) : (
              <DyMarkdown source={n.body} className="text-[0.875rem]" />
            )}
            {writable && canEdit(viewer, n.author.id) && editing?.id !== n.id ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <DyButton
                  variant="ghost"
                  icon="pen"
                  onClick={() => {
                    setEditing({ id: n.id, body: n.body });
                  }}
                >
                  {t.edit}
                </DyButton>
                <DyConfirm
                  label={t.delete}
                  icon="trash"
                  question={tn.deleteQuestion}
                  busy={busy}
                  onConfirm={() =>
                    void run(async () => {
                      await deleteItemNote(n.id);
                      setNotes((list) => (list ?? []).filter((x) => x.id !== n.id));
                      return Math.max(0, (notes?.length ?? 1) - 1);
                    })
                  }
                />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <DyApiError error={error} />
      {writable ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e: SubmitEvent<HTMLFormElement>) => {
            e.preventDefault();
            if (draft.trim() === '') return;
            void run(async () => {
              const n = await addItemNote(item.project, item.key, draft);
              setNotes((list) => [...(list ?? []), n]);
              setDraft('');
              return (notes?.length ?? 0) + 1;
            });
          }}
        >
          <DyTextarea
            label={tn.add}
            rows={3}
            maxLength={20_000}
            value={draft}
            placeholder={tn.placeholder}
            onChange={(e) => {
              setDraft(e.target.value);
            }}
          />
          <DyButton type="submit" busy={busy} disabled={draft.trim() === ''} className="self-start">
            {tn.submit}
          </DyButton>
        </form>
      ) : null}
    </Section>
  );
}

function NoteCardDetail(props: {
  readonly item: OutputItem;
  readonly viewer: Viewer;
  readonly onChanged: (item: OutputItem | null) => void;
}): ReactNode {
  const t = useT().outputs;
  const tc = t.detail.card;
  const { item, viewer } = props;
  const id = item.note?.id ?? '';
  const [card, setCard] = useState<NoteCard | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    getNoteCard(id).then(
      (c) => {
        if (live) setCard(c);
      },
      (err: unknown) => {
        if (live) setError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [id]);
  if (card === null)
    return error !== null ? <DyApiError error={error} /> : <SkeletonRows label={tc.loading} rows={2} />;
  const mine = viewer.writable.has(card.project) && canEdit(viewer, card.author.id);
  if (editing) {
    return (
      <NoteForm
        project={card.project}
        initial={card}
        onCancel={() => {
          setEditing(false);
        }}
        onSaved={(c) => {
          setCard(c);
          setEditing(false);
          props.onChanged({ ...item, name: c.title, tags: c.tags, pinned: c.pinned });
        }}
      />
    );
  }
  return (
    <div className="flex flex-col gap-3" data-testid="note-card">
      <DyMarkdown source={card.body} />
      {card.links.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label={tc.links}>
          {card.links.map((l) => (
            <li key={l}>
              <a href={l} target="_blank" rel="noopener noreferrer" className={`break-all ${LINK}`}>
                {l}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      <ReadOnlyTags item={{ ...item, tags: card.tags }} />
      <p className="m-0 text-[0.78125rem] text-dy-muted">
        {card.author.username ?? t.deletedUser} · {tc.updated} <When iso={card.updatedAt} />
      </p>
      <DyApiError error={error} />
      {mine ? (
        <div className="flex flex-wrap gap-2">
          <DyButton
            icon="pen"
            onClick={() => {
              setEditing(true);
            }}
          >
            {t.edit}
          </DyButton>
          <DyConfirm
            label={tc.delete}
            icon="trash"
            busy={busy}
            onConfirm={() => {
              setBusy(true);
              deleteNoteCard(card.id).then(
                () => {
                  props.onChanged(null);
                },
                (err: unknown) => {
                  setBusy(false);
                  setError(toApiError(err));
                },
              );
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
