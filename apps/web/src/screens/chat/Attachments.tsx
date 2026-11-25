import { type ReactNode, useRef, useState } from 'react';
import { attachmentUrl, UUID_RE } from '../../api/chat';
import { DyLightbox, type LightboxImage } from '../../diyalog/screens/outputs/Lightbox';
import { Spinner } from '../../components/ui';
import { useSharedT } from '../../i18n/scope';
import { formatBytes } from './attachment-files';
import type { PendingAttachment } from './useAttachments';
import type { useSiteZips } from './useSiteZips';
import { MessageSiteZips, ZipChips } from './ZipAttachments';

/**
 * Chat attachments in the conversation (p8-chat-attachments-mentions): the composer's tray of pending files and the
 * thumbnails / file chips of sent messages. Everything in `meta` came over the API and is type-checked here; names
 * render as text, image sources are built from validated ids only.
 */

export interface MetaAttachment {
  readonly id: string;
  readonly kind: 'image' | 'pdf' | 'text';
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
}

/** `meta.attachments` of a user message (anything malformed is skipped). */
export function metaAttachments(meta: Record<string, unknown> | null): MetaAttachment[] {
  const raw = meta?.attachments;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((a): MetaAttachment[] => {
    if (a === null || typeof a !== 'object') return [];
    const o = a as Record<string, unknown>;
    if (typeof o.id !== 'string' || !UUID_RE.test(o.id)) return [];
    if (o.kind !== 'image' && o.kind !== 'pdf' && o.kind !== 'text') return [];
    return [
      {
        id: o.id,
        kind: o.kind,
        name: typeof o.name === 'string' ? o.name.slice(0, 120) : 'file',
        mediaType: typeof o.mediaType === 'string' ? o.mediaType : '',
        sizeBytes: typeof o.sizeBytes === 'number' && Number.isFinite(o.sizeBytes) ? o.sizeBytes : 0,
      },
    ];
  });
}

function FileIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

/** The composer's pending files: thumbnail / name, size, state, remove. */
export function AttachmentTray(props: {
  readonly items: readonly PendingAttachment[];
  readonly errors: readonly string[];
  readonly hint: string | null;
  readonly onRemove: (key: string) => void;
  /** p15-chat-zip: the .zip chips (absent: none). */
  readonly zips?: ReturnType<typeof useSiteZips>;
}): ReactNode {
  // p14-i18n-shell: the Diyalog composer renders this tray too (English in the classic console).
  const t = useSharedT().shared.chat;
  const zips = props.zips;
  const hasZips = zips !== undefined && (zips.items.length > 0 || zips.overflow > 0);
  if (props.items.length === 0 && props.errors.length === 0 && !hasZips) return null;
  return (
    <div className="mx-auto mb-1.5 flex w-full max-w-3xl flex-col gap-1.5" data-testid="attachment-tray">
      {zips === undefined ? null : (
        <ZipChips
          items={zips.items}
          projects={zips.projects}
          projectsFailed={zips.projectsFailed}
          overflow={zips.overflow}
          onRemove={zips.remove}
          onProject={zips.setProject}
          onMode={zips.setMode}
          onSendAnyway={zips.sendAnyway}
          onLeaveOut={zips.leaveOut}
        />
      )}
      {props.items.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label={t.attachedFiles}>
          {props.items.map((i) => (
            <li
              key={i.key}
              data-state={i.state}
              className={`relative flex max-w-[14rem] items-center gap-2 rounded-md border bg-surface p-1.5 pr-8 text-meta ${
                i.state === 'failed' ? 'border-danger/50' : 'border-line'
              }`}
            >
              {i.kind === 'image' && i.previewUrl !== null ? (
                <img src={i.previewUrl} alt="" className="size-10 shrink-0 rounded object-cover" />
              ) : (
                <span className="inline-flex size-10 shrink-0 items-center justify-center rounded bg-surface-2 text-muted">
                  <FileIcon />
                </span>
              )}
              <span className="min-w-0">
                <span className="block truncate text-fg" title={i.name}>
                  {i.name}
                </span>
                <span className="block text-xs text-muted">
                  {i.state === 'preparing' || i.state === 'uploading' ? (
                    <span className="inline-flex items-center gap-1">
                      <Spinner /> {i.state === 'preparing' ? t.preparing : t.uploading}
                    </span>
                  ) : i.state === 'failed' ? (
                    <span className="text-danger" role="alert">
                      {i.error ?? t.uploadFailed}
                    </span>
                  ) : (
                    formatBytes(i.size)
                  )}
                </span>
              </span>
              <button
                type="button"
                onClick={() => {
                  props.onRemove(i.key);
                }}
                aria-label={t.remove({ name: i.name })}
                className="absolute top-1 right-1 inline-flex size-6 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-fg"
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {props.errors.length > 0 ? (
        <ul className="text-meta text-danger" role="alert" data-testid="attachment-errors">
          {props.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      {props.items.some((i) => i.kind === 'image') ? (
        <p className="text-xs text-muted">
          {t.screenshotHint}
          {props.hint === null ? '' : ` ${props.hint}`}
        </p>
      ) : null}
    </div>
  );
}

/** Thumbnails (images) and file chips (PDF / text) of a sent message; an image opens full size in a dialog. */
export function MessageAttachments(props: { readonly meta: Record<string, unknown> | null }): ReactNode {
  const t = useSharedT().shared.chat;
  const list = metaAttachments(props.meta);
  const [open, setOpen] = useState<number | null>(null);
  const thumbs = useRef(new Map<string, HTMLButtonElement>());
  // p15-chat-zip: a message's site uploads and "not a site" .zip notes.
  if (list.length === 0) return <MessageSiteZips meta={props.meta} />;
  const images = list.flatMap((a): { readonly id: string; readonly image: LightboxImage }[] => {
    const url = a.kind === 'image' ? attachmentUrl(a.id) : null;
    return url === null
      ? []
      : [{ id: a.id, image: { src: url, name: a.name, download: url, sizeBytes: a.sizeBytes } }];
  });
  return (
    <>
      <MessageSiteZips meta={props.meta} />
      <ul className="flex max-w-[85%] flex-wrap justify-end gap-2" aria-label={t.attachments}>
        {list.map((a) => {
          const url = attachmentUrl(a.id);
          if (url === null) return null;
          return (
            <li key={a.id}>
              {a.kind === 'image' ? (
                <button
                  ref={(el) => {
                    if (el === null) thumbs.current.delete(a.id);
                    else thumbs.current.set(a.id, el);
                  }}
                  type="button"
                  onClick={() => {
                    setOpen(images.findIndex((x) => x.id === a.id));
                  }}
                  aria-label={t.open({ name: a.name })}
                  title={a.name}
                  className="block overflow-hidden rounded-md border border-line bg-surface-2 hover:border-line-strong focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <img
                    src={url}
                    alt={a.name}
                    loading="lazy"
                    className="h-24 w-32 object-cover"
                    data-testid="attachment-thumb"
                  />
                </button>
              ) : (
                <a
                  href={url}
                  download={a.name}
                  className="inline-flex max-w-[16rem] items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-meta hover:bg-surface-2"
                  data-testid="attachment-file"
                >
                  <FileIcon />
                  <span className="truncate">{a.name}</span>
                  <span className="shrink-0 text-xs text-muted">{formatBytes(a.sizeBytes)}</span>
                </a>
              )}
            </li>
          );
        })}
      </ul>
      {/* p17-chat-drawer: the panel's one image lightbox (was a DyDialog since p16-chat-complete): ←/→ across the
          message's images, download, Esc; focus goes back to the thumbnail of the image last shown. */}
      <DyLightbox
        images={images.map((x) => x.image)}
        index={open}
        onIndex={setOpen}
        wrap={false}
        returnFocus={(i) => {
          const id = images[i]?.id;
          return id === undefined ? null : (thumbs.current.get(id) ?? null);
        }}
        onClose={() => {
          setOpen(null);
        }}
      />
    </>
  );
}
