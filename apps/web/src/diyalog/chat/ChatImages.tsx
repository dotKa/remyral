import { type ReactNode, useRef, useState } from 'react';
import { Link } from 'react-router';
import { cx } from '../../components/ui';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { DyIcon } from '../icons';
import { DyLightbox, type LightboxImage } from '../screens/outputs/Lightbox';
import { type ChatImage, chatImageJobLink, chatImageUrl } from './images';

/**
 * p20-chat-images (docs/design/p20-chat-images.md §2): the images one assistant turn showed (show_image), under its
 * answer. Thumbnails keep their aspect ratio inside a bounded box (`object-contain` — a screenshot is never cropped or
 * stretched), two columns on phones, three from `sm`; the caption under them; a click / Enter opens the panel's one
 * lightbox (←/→ across the turn's images, download, Esc, swipe; focus back on the thumbnail). A load that fails (file
 * removed, the keeping machine offline, no access for this reader) shows a plain placeholder with a link to the job.
 */
export function ChatImages(props: { readonly images: readonly ChatImage[] }): ReactNode {
  const t = useT().chat.images;
  const f = useFormat();
  const [open, setOpen] = useState<number | null>(null);
  const [failed, setFailed] = useState<ReadonlySet<number>>(new Set());
  const thumbs = useRef(new Map<number, HTMLButtonElement>());
  const { images } = props;
  if (images.length === 0) return null;
  const captions = [...new Set(images.flatMap((x) => (x.caption === null ? [] : [x.caption])))];
  // The lightbox walks the images that loaded (a broken one has nothing to show).
  const shown = images.flatMap((img, i) => (failed.has(i) ? [] : [i]));
  const gallery: LightboxImage[] = shown.map((i) => {
    const img = images[i] as ChatImage;
    return {
      src: chatImageUrl(img, true),
      name: img.name,
      download: chatImageUrl(img, false),
      sizeBytes: img.sizeBytes,
      meta: img.caption,
    };
  });
  return (
    <figure className="m-0 mt-2 flex max-w-[40rem] min-w-0 flex-col gap-1.5" data-testid="chat-images">
      <ul
        aria-label={t.label({ n: images.length })}
        className={cx(
          'm-0 grid list-none gap-2 p-0',
          images.length === 1 ? 'grid-cols-1' : 'grid-cols-2 sm:grid-cols-3',
        )}
      >
        {images.map((img, i) => (
          <li key={`${img.jobId}:${img.source === 'output' ? img.artifactId : img.path}`} className="min-w-0">
            {failed.has(i) ? (
              <div
                className="flex min-h-24 flex-col items-start justify-center gap-1 rounded-[10px] border border-dashed border-dy-line-2 bg-dy-sunk px-3 py-2 text-[0.78125rem] text-dy-muted"
                role="status"
                data-testid="chat-image-failed"
              >
                <span className="font-bold text-dy-ink">{t.failed}</span>
                <span className="[overflow-wrap:anywhere]">{img.name}</span>
                <Link to={chatImageJobLink(img)} className="text-dy-teal-ink underline">
                  {t.openJob}
                </Link>
              </div>
            ) : (
              <button
                ref={(el) => {
                  if (el === null) thumbs.current.delete(i);
                  else thumbs.current.set(i, el);
                }}
                type="button"
                onClick={() => {
                  setOpen(shown.indexOf(i));
                }}
                aria-label={t.open({ name: img.name })}
                title={img.name}
                className={cx(
                  'group relative grid w-full place-items-center overflow-hidden rounded-[10px] border border-dy-line bg-dy-sunk p-0 outline-none focus-visible:ring-2 focus-visible:ring-dy-teal',
                  images.length === 1 ? 'max-h-[min(60vh,28rem)] min-h-24' : 'aspect-[4/3] min-h-24',
                )}
                data-testid="chat-image"
              >
                <img
                  src={chatImageUrl(img, true)}
                  alt={img.caption ?? img.name}
                  loading="lazy"
                  decoding="async"
                  onError={() => {
                    setFailed((s) => new Set(s).add(i));
                  }}
                  className={cx(
                    'block object-contain',
                    images.length === 1
                      ? 'h-auto max-h-[min(60vh,28rem)] w-auto max-w-full'
                      : 'h-full w-full',
                  )}
                />
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute right-1.5 bottom-1.5 grid size-8 place-items-center rounded-full bg-dy-lightbox-ctl text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
                >
                  <DyIcon name="search" className="size-4" />
                </span>
              </button>
            )}
          </li>
        ))}
      </ul>
      <figcaption
        className="flex flex-wrap gap-x-3 text-[0.75rem] text-dy-muted"
        data-testid="chat-images-caption"
      >
        {captions.length === 0 ? null : (
          <span className="text-dy-ink [overflow-wrap:anywhere]">{captions.join(' · ')}</span>
        )}
        <span className="tabular-nums">
          {images.length === 1
            ? `${images[0]?.name ?? ''} · ${f.bytes(images[0]?.sizeBytes ?? 0)}`
            : t.count({ n: images.length })}
        </span>
        {images[0]?.source === 'workfile' ? <span>{t.kept}</span> : null}
      </figcaption>
      <DyLightbox
        images={gallery}
        index={open}
        onIndex={setOpen}
        wrap={false}
        returnFocus={(at) => {
          const i = shown[at];
          return i === undefined ? null : (thumbs.current.get(i) ?? null);
        }}
        onClose={() => {
          setOpen(null);
        }}
      />
    </figure>
  );
}
