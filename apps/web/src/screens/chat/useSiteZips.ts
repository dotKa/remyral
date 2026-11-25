import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { listProjects, type Project } from '../../api/directory';
import { findingsOf, type InputFinding } from '../../api/inputUploads';
import { refusalsOf, type SiteRefusal } from '../../api/siteUploads';
import { toApiError } from '../../components/ui';
import { uploadInputBundle, withoutPaths } from '../../lib/inputBundle';
import { UploadCancelledError } from '../../lib/releaseUpload';
import { type SiteUploadProgress, uploadSite } from '../../lib/siteUpload';
import {
  archiveNote,
  type ChatZipPlan,
  defaultMode,
  defaultProject,
  MAX_ZIPS,
  planChatZip,
  uploadProjects,
  zipCan,
  type ZipMode,
} from './chat-zip';

/**
 * p15-chat-zip + p16-zip-job-input: the composer's .zip chips. A dropped / picked .zip is unpacked and planned at once
 * (in the browser), both as a site and as a job's input files:
 *
 *  - a site that can also be input files starts as "both": on send it is uploaded as a site upload AND as an input
 *    bundle, and the message (or the assistant's question) decides whether to publish it or work with it; the chip lets
 *    the person narrow it to one;
 *  - anything else that fits the input rules is an input bundle ("İş girdisi");
 *  - a .zip that is neither travels as a note only.
 *
 * Uploads are chunked, retried and resumed on the next send after a failure. An input bundle whose secret scan found
 * something stops before the message is sent: the chip names file, rule and line, and "Yine de gönder" completes it on
 * the next send (the master audits the override).
 */

export type ZipPhase =
  | 'reading'
  | 'ready'
  | 'refused'
  | 'uploading'
  | 'uploaded'
  | 'failed'
  /** p16-zip-job-input: the input bundle's scan found possible secrets; nothing is sent until the person decides. */
  | 'secrets';

export interface ZipItem {
  readonly key: string;
  readonly name: string;
  readonly phase: ZipPhase;
  readonly plan: ChatZipPlan | null;
  readonly project: string | null;
  /** p16-zip-job-input: what the send uploads (null: neither is possible — a note only). */
  readonly mode: ZipMode | null;
  readonly progress: SiteUploadProgress | null;
  /** A started site upload (resumed by the next send after a failure). */
  readonly resumeId: string | null;
  /** The ready site upload the message names. */
  readonly uploadId: string | null;
  /** p16-zip-job-input: a started / the ready input bundle. */
  readonly inputResumeId: string | null;
  readonly inputUploadId: string | null;
  /** p16-zip-job-input: the scan's findings (file, rule, line) and the person's "send anyway". */
  readonly findings: readonly InputFinding[];
  readonly allowSecrets: boolean;
  readonly error: string | null;
  /** Files the master refused (path, reason, rule, line). */
  readonly refusedByMaster: readonly SiteRefusal[];
}

const REMEMBER = 'remyral.chat.zipProject';

function remembered(): string | null {
  try {
    return localStorage.getItem(REMEMBER);
  } catch {
    return null;
  }
}
function remember(project: string): void {
  try {
    localStorage.setItem(REMEMBER, project);
  } catch {
    /* private mode */
  }
}

export interface ZipDeps {
  readonly listProjects?: () => Promise<Project[]>;
  readonly upload?: typeof uploadSite;
  readonly uploadInput?: typeof uploadInputBundle;
  /** p16-chat-complete: the conversation's own project — a new chip defaults to it (then the remembered one). */
  readonly threadProject?: string | null;
}

let counter = 0;

const wantsSite = (m: ZipMode | null): boolean => m === 'site' || m === 'both';
const wantsInput = (m: ZipMode | null): boolean => m === 'input' || m === 'both';

export function useSiteZips(deps: ZipDeps = {}): {
  readonly items: readonly ZipItem[];
  /** Projects the person may upload into (null: not loaded yet / failed). */
  readonly projects: readonly Project[] | null;
  readonly projectsFailed: boolean;
  readonly busy: boolean;
  /** How many .zip files were refused because the message has too many (shown by the tray). */
  readonly overflow: number;
  readonly add: (files: readonly File[]) => void;
  readonly remove: (key: string) => void;
  readonly setProject: (key: string, project: string) => void;
  /** p16-zip-job-input: site upload / input files / both. */
  readonly setMode: (key: string, mode: ZipMode) => void;
  /** p16-zip-job-input: "Yine de gönder" — the next send completes the bundle despite the findings. */
  readonly sendAnyway: (key: string) => void;
  /** p16-zip-job-input: leave out the files the master refused (e.g. executables) and try again. */
  readonly leaveOut: (key: string) => void;
  /** Uploads everything not uploaded yet; null when one failed or waits for a decision (its chip says why). */
  readonly prepare: () => Promise<{
    siteUploads: string[];
    archives: ReturnType<typeof archiveNote>[];
    inputUploads: string[];
  } | null>;
  readonly sent: () => void;
} {
  const [items, setItems] = useState<ZipItem[]>([]);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectsFailed, setProjectsFailed] = useState(false);
  const [overflow, setOverflow] = useState(0);
  const ref = useRef<ZipItem[]>([]);
  const projectsRef = useRef<Project[] | null>(null);
  const aborts = useRef(new Map<string, AbortController>());
  const loading = useRef<Promise<Project[] | null> | null>(null);
  const load = deps.listProjects ?? listProjects;
  const upload = deps.upload ?? uploadSite;
  const uploadInput = deps.uploadInput ?? uploadInputBundle;
  const threadProjectRef = useRef<string | null>(deps.threadProject ?? null);
  threadProjectRef.current = deps.threadProject ?? null;

  const update = useCallback((fn: (list: ZipItem[]) => ZipItem[]) => {
    ref.current = fn(ref.current);
    setItems(ref.current);
  }, []);
  const patch = useCallback(
    (key: string, p: Partial<ZipItem>) => {
      update((list) => list.map((i) => (i.key === key ? { ...i, ...p } : i)));
    },
    [update],
  );
  const current = (key: string): ZipItem | undefined => ref.current.find((i) => i.key === key);

  useEffect(
    () => () => {
      for (const c of aborts.current.values()) c.abort();
    },
    [],
  );

  const ensureProjects = useCallback((): Promise<Project[] | null> => {
    if (projectsRef.current !== null) return Promise.resolve(projectsRef.current);
    loading.current ??= load()
      .then((all) => {
        const allowed = uploadProjects(all);
        projectsRef.current = allowed;
        setProjects(allowed);
        setProjectsFailed(false);
        return allowed;
      })
      .catch(() => {
        setProjectsFailed(true);
        loading.current = null;
        return null;
      });
    return loading.current;
  }, [load]);

  const add = useCallback(
    (files: readonly File[]) => {
      const room = MAX_ZIPS - ref.current.length;
      const taken = files.slice(0, Math.max(0, room));
      setOverflow(files.length - taken.length);
      if (taken.length === 0) return;
      const fresh = taken.map((file): { key: string; file: File } => {
        counter += 1;
        return { key: `z${String(counter)}`, file };
      });
      update((list) => [
        ...list,
        ...fresh.map(({ key, file }): ZipItem => ({
          key,
          name: file.name,
          phase: 'reading',
          plan: null,
          project: null,
          mode: null,
          progress: null,
          resumeId: null,
          uploadId: null,
          inputResumeId: null,
          inputUploadId: null,
          findings: [],
          allowSecrets: false,
          error: null,
          refusedByMaster: [],
        })),
      ]);
      for (const { key, file } of fresh) {
        void (async () => {
          const [plan, allowed] = await Promise.all([planChatZip(file), ensureProjects()]);
          const mode = defaultMode(plan);
          patch(key, {
            name: plan.name,
            plan,
            mode,
            phase: mode === null ? 'refused' : 'ready',
            project:
              mode === null ? null : defaultProject(allowed ?? [], remembered(), threadProjectRef.current),
          });
        })().catch((err: unknown) => {
          patch(key, { phase: 'refused', error: err instanceof Error ? err.message : 'error' });
        });
      }
    },
    [ensureProjects, patch, update],
  );

  const remove = useCallback(
    (key: string) => {
      aborts.current.get(key)?.abort();
      aborts.current.delete(key);
      update((list) => list.filter((i) => i.key !== key));
      setOverflow(0);
    },
    [update],
  );

  const editable = (i: ZipItem): boolean =>
    i.phase !== 'reading' && i.phase !== 'refused' && i.phase !== 'uploading';

  const setProject = useCallback(
    (key: string, project: string) => {
      remember(project);
      // Another project means other uploads: start over there.
      update((list) =>
        list.map((i): ZipItem =>
          i.key !== key || !editable(i)
            ? i
            : {
                ...i,
                project,
                phase: 'ready',
                resumeId: null,
                uploadId: null,
                inputResumeId: null,
                inputUploadId: null,
                findings: [],
                allowSecrets: false,
                error: null,
                refusedByMaster: [],
              },
        ),
      );
    },
    [update],
  );

  const setMode = useCallback(
    (key: string, mode: ZipMode) => {
      update((list) =>
        list.map((i): ZipItem => {
          if (i.key !== key || !editable(i) || i.plan === null) return i;
          const can = zipCan(i.plan);
          if ((wantsSite(mode) && !can.site) || (wantsInput(mode) && !can.input)) return i;
          // Uploads already done for the chosen kinds stay; the other kind is simply not sent.
          return { ...i, mode, phase: 'ready', error: null, refusedByMaster: [] };
        }),
      );
    },
    [update],
  );

  const sendAnyway = useCallback(
    (key: string) => {
      const i = current(key);
      if (i?.phase !== 'secrets') return;
      patch(key, { allowSecrets: true, phase: 'ready' });
    },
    [patch],
  );

  const leaveOut = useCallback(
    (key: string) => {
      const i = current(key);
      if (i?.plan?.input == null || i.refusedByMaster.length === 0) return;
      const paths = new Set(i.refusedByMaster.map((r) => r.path));
      const input = withoutPaths(i.plan.input, paths);
      patch(key, {
        plan: { ...i.plan, input },
        phase: input.problems.length === 0 ? 'ready' : 'failed',
        inputResumeId: null,
        inputUploadId: null,
        refusedByMaster: [],
        error: null,
      });
    },
    [patch],
  );

  /** One site upload of the chip (null: failed — the chip says why). */
  const uploadSiteOf = useCallback(
    async (item: ZipItem): Promise<string | null> => {
      const plan = item.plan;
      if (plan === null || item.project === null) return null;
      const ctrl = new AbortController();
      aborts.current.set(item.key, ctrl);
      let started = item.resumeId;
      patch(item.key, { phase: 'uploading', progress: null, error: null, refusedByMaster: [] });
      try {
        const done = await upload(item.project, plan.files, {
          label: plan.name,
          signal: ctrl.signal,
          resumeId: item.resumeId,
          onStarted: (id) => {
            started = id;
            patch(item.key, { resumeId: id });
          },
          onProgress: (p) => {
            patch(item.key, { progress: p });
          },
        });
        patch(item.key, { uploadId: done.id, progress: null });
        return done.id;
      } catch (err) {
        if (err instanceof UploadCancelledError) return null;
        const api = toApiError(err);
        // A refused site was discarded by the master; an expired one is gone: the next send starts over.
        const keep = err instanceof ApiError && api.code !== 'site_refused' && api.code !== 'upload_expired';
        patch(item.key, {
          phase: 'failed',
          progress: null,
          error: api.message,
          resumeId: keep ? started : null,
          refusedByMaster: refusalsOf(err),
        });
        return null;
      } finally {
        aborts.current.delete(item.key);
      }
    },
    [patch, upload],
  );

  /** p16-zip-job-input: one input bundle upload of the chip (null: failed or waiting for "send anyway"). */
  const uploadInputOf = useCallback(
    async (item: ZipItem): Promise<string | null> => {
      const plan = item.plan?.input ?? null;
      if (plan === null || item.project === null || item.plan === null) return null;
      const ctrl = new AbortController();
      aborts.current.set(item.key, ctrl);
      let started = item.inputResumeId;
      patch(item.key, { phase: 'uploading', progress: null, error: null, refusedByMaster: [] });
      try {
        const done = await uploadInput(item.project, plan.files, {
          label: item.plan.name,
          signal: ctrl.signal,
          resumeId: item.inputResumeId,
          allowSecrets: item.allowSecrets,
          onStarted: (id) => {
            started = id;
            patch(item.key, { inputResumeId: id });
          },
          onProgress: (p) => {
            patch(item.key, { progress: p });
          },
        });
        patch(item.key, { inputUploadId: done.id, progress: null, findings: done.secretFindings });
        return done.id;
      } catch (err) {
        if (err instanceof UploadCancelledError) return null;
        const findings = findingsOf(err);
        if (findings.length > 0) {
          // The master kept the parts: "send anyway" completes this same upload.
          patch(item.key, {
            phase: 'secrets',
            progress: null,
            findings,
            inputResumeId: started,
            allowSecrets: false,
            error: null,
          });
          return null;
        }
        const api = toApiError(err);
        const keep = err instanceof ApiError && api.code !== 'input_refused' && api.code !== 'upload_expired';
        patch(item.key, {
          phase: 'failed',
          progress: null,
          error: api.message,
          inputResumeId: keep ? started : null,
          refusedByMaster: refusalsOf(err),
        });
        return null;
      } finally {
        aborts.current.delete(item.key);
      }
    },
    [patch, uploadInput],
  );

  const prepare = useCallback(async () => {
    const siteUploads: string[] = [];
    const archives: ReturnType<typeof archiveNote>[] = [];
    const inputUploads: string[] = [];
    for (const snapshot of ref.current) {
      if (snapshot.plan === null) return null;
      if (snapshot.phase === 'refused' || snapshot.mode === null) {
        archives.push(archiveNote(snapshot.plan));
        continue;
      }
      if (snapshot.phase === 'secrets') return null;
      if (snapshot.project === null) {
        patch(snapshot.key, { phase: 'failed', error: null });
        return null;
      }
      if (wantsSite(snapshot.mode)) {
        const id = current(snapshot.key)?.uploadId ?? (await uploadSiteOf(snapshot));
        if (id === null) return null;
        siteUploads.push(id);
      }
      if (wantsInput(snapshot.mode)) {
        const fresh = current(snapshot.key) ?? snapshot;
        const id = fresh.inputUploadId ?? (await uploadInputOf(fresh));
        if (id === null) return null;
        inputUploads.push(id);
      }
      patch(snapshot.key, { phase: 'uploaded' });
    }
    return { siteUploads, archives, inputUploads };
  }, [patch, uploadInputOf, uploadSiteOf]);

  const sent = useCallback(() => {
    update(() => []);
    setOverflow(0);
  }, [update]);

  return {
    items,
    projects,
    projectsFailed,
    busy: items.some((i) => i.phase === 'reading' || i.phase === 'uploading'),
    overflow,
    add,
    remove,
    setProject,
    setMode,
    sendAnyway,
    leaveOut,
    prepare,
    sent,
  };
}
