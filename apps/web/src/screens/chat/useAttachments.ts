import { useCallback, useEffect, useRef, useState } from 'react';
import { type ChatInput, deleteAttachment, uploadAttachment } from '../../api/chat';
import { toApiError } from '../../components/ui';
import { checkFile, type FileKind, kindOf, MAX_MESSAGE_BYTES, prepareFile } from './attachment-files';
import { type archiveNote, isZipFile } from './chat-zip';
import { type ZipDeps, useSiteZips } from './useSiteZips';

/** One file in the composer's tray (p8-chat-attachments-mentions). */
export interface PendingAttachment {
  readonly key: string;
  readonly name: string;
  readonly kind: FileKind;
  readonly size: number;
  readonly previewUrl: string | null;
  readonly state: 'preparing' | 'uploading' | 'ready' | 'failed';
  /** The master's attachment id once uploaded. */
  readonly id: string | null;
  readonly error: string | null;
}

/** What the composer may attach given the engine (`ChatStatus.input`; null = older master: nothing). */
export function inputAllows(input: ChatInput | null | undefined): {
  readonly any: boolean;
  readonly images: boolean;
  readonly pdf: boolean;
  readonly reason: string | null;
} {
  if (input === null || input === undefined) {
    return { any: false, images: false, pdf: false, reason: 'Attachments need a newer master.' };
  }
  const images = input.images !== 'unsupported';
  return {
    any: true,
    images,
    pdf: input.pdf,
    reason: images ? null : (input.reason ?? 'The assistant engine cannot read images.'),
  };
}

let counter = 0;

/**
 * The composer's pending attachments: checks a file against the limits, prepares it (downsizes photos), uploads it
 * to the thread (`ensureThread` creates the conversation first when there is none yet) and removes unsent uploads.
 */
export function useAttachments(opts: {
  readonly ensureThread: (() => Promise<string>) | undefined;
  readonly input: ChatInput | null | undefined;
  /** p15-chat-zip: injectable I/O of the .zip chips (tests). */
  readonly zipDeps?: ZipDeps;
  /** p16-chat-complete: the conversation's own project (the .zip chip's default). */
  readonly threadProject?: string | null;
}): {
  readonly items: readonly PendingAttachment[];
  readonly errors: readonly string[];
  readonly busy: boolean;
  readonly readyIds: readonly string[];
  readonly add: (files: readonly File[]) => void;
  readonly remove: (key: string) => void;
  /** After a successful send: the uploads now belong to the message (nothing is deleted). */
  readonly sent: () => void;
  readonly dismissErrors: () => void;
  /** p15-chat-zip: the .zip chips (sites uploaded on send, other archives as a note). */
  readonly zips: ReturnType<typeof useSiteZips>;
} {
  const zips = useSiteZips({ ...opts.zipDeps, threadProject: opts.threadProject ?? null });
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  // The ref is the source of truth (async uploads read it); `items` mirrors it for rendering.
  const itemsRef = useRef<PendingAttachment[]>([]);
  const update = useCallback((fn: (list: PendingAttachment[]) => PendingAttachment[]) => {
    itemsRef.current = fn(itemsRef.current);
    setItems(itemsRef.current);
  }, []);
  const { ensureThread, input } = opts;

  // Object URLs of the previews are released when the component goes away.
  useEffect(
    () => () => {
      for (const i of itemsRef.current)
        if (i.previewUrl?.startsWith('blob:') === true) URL.revokeObjectURL(i.previewUrl);
    },
    [],
  );

  const patch = useCallback(
    (key: string, p: Partial<PendingAttachment>) => {
      update((list) => list.map((i) => (i.key === key ? { ...i, ...p } : i)));
    },
    [update],
  );

  const addZips = zips.add;
  const add = useCallback(
    (all: readonly File[]) => {
      const allow = inputAllows(input);
      // p15-chat-zip: a .zip is unpacked in the browser (a site is uploaded on send), not attached as a file.
      const archives = all.filter(isZipFile);
      if (archives.length > 0 && allow.any) addZips(archives);
      const files = allow.any ? all.filter((f) => !isZipFile(f)) : all;
      if (files.length === 0) {
        setErrors([]);
        return;
      }
      const problems: string[] = [];
      const list = itemsRef.current.filter((i) => i.state !== 'failed');
      let count = list.length;
      const bytes = list.reduce((n, i) => n + i.size, 0);
      const accepted: { key: string; file: File }[] = [];
      for (const file of files) {
        if (!allow.any || ensureThread === undefined) {
          problems.push(allow.reason ?? 'Attachments are not available here.');
          break;
        }
        const why = checkFile(file, { count, bytes }, allow);
        if (why !== null) {
          problems.push(why);
          continue;
        }
        counter += 1;
        accepted.push({ key: `a${String(counter)}`, file });
        count += 1;
      }
      setErrors(problems);
      if (accepted.length === 0 || ensureThread === undefined) return;
      update((cur) => [
        ...cur,
        ...accepted.map(({ key, file }): PendingAttachment => ({
          key,
          name: file.name || 'image',
          kind: kindOf(file) ?? 'text',
          size: file.size,
          previewUrl: null,
          state: 'preparing',
          id: null,
          error: null,
        })),
      ]);
      for (const { key, file } of accepted) {
        void (async () => {
          try {
            const prepared = await prepareFile(file);
            const total = itemsRef.current
              .filter((i) => i.key !== key && i.state !== 'failed')
              .reduce((n, i) => n + i.size, 0);
            if (total + prepared.size > MAX_MESSAGE_BYTES) {
              throw new Error('These files are too large together for one message (12 MB).');
            }
            patch(key, {
              name: prepared.name,
              kind: prepared.kind,
              size: prepared.size,
              previewUrl: prepared.previewUrl,
              state: 'uploading',
            });
            const threadId = await ensureThread();
            const a = await uploadAttachment(threadId, prepared.name, prepared.base64);
            if (!itemsRef.current.some((i) => i.key === key)) {
              // Removed while uploading: the upload is not wanted any more.
              void deleteAttachment(a.id).catch(() => undefined);
              return;
            }
            patch(key, { state: 'ready', id: a.id, name: a.name, size: a.sizeBytes });
          } catch (err) {
            const message =
              err instanceof Error && !('status' in err) ? err.message : toApiError(err).message;
            patch(key, { state: 'failed', error: message });
          }
        })();
      }
    },
    [addZips, ensureThread, input, patch, update],
  );

  const remove = useCallback(
    (key: string) => {
      const item = itemsRef.current.find((i) => i.key === key);
      if (item === undefined) return;
      if (item.previewUrl?.startsWith('blob:') === true) URL.revokeObjectURL(item.previewUrl);
      if (item.id !== null) void deleteAttachment(item.id).catch(() => undefined);
      update((list) => list.filter((i) => i.key !== key));
    },
    [update],
  );

  const zipsSent = zips.sent;
  const sent = useCallback(() => {
    for (const i of itemsRef.current)
      if (i.previewUrl?.startsWith('blob:') === true) URL.revokeObjectURL(i.previewUrl);
    update(() => []);
    setErrors([]);
    zipsSent();
  }, [update, zipsSent]);

  const dismissErrors = useCallback(() => {
    setErrors([]);
  }, []);

  return {
    items,
    errors,
    busy: zips.busy || items.some((i) => i.state === 'preparing' || i.state === 'uploading'),
    readyIds: items.flatMap((i) => (i.state === 'ready' && i.id !== null ? [i.id] : [])),
    add,
    remove,
    sent,
    dismissErrors,
    zips,
  };
}

/**
 * p15-chat-zip: what the composer adds to a message for its .zip chips — uploads the sites first (progress on the
 * chips). Null: an upload failed or a chip still needs a project (the chip says why; sending again resumes).
 */
export async function zipExtras(zips: ReturnType<typeof useSiteZips>): Promise<{
  siteUploads?: string[];
  archives?: ReturnType<typeof archiveNote>[];
  inputUploads?: string[];
} | null> {
  const out = await zips.prepare();
  if (out === null) return null;
  return {
    ...(out.siteUploads.length === 0 ? {} : { siteUploads: out.siteUploads }),
    ...(out.archives.length === 0 ? {} : { archives: out.archives }),
    // p16-zip-job-input: input bundles for a job.
    ...(out.inputUploads.length === 0 ? {} : { inputUploads: out.inputUploads }),
  };
}
