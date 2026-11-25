import { useSyncExternalStore } from 'react';

/**
 * p19-ide W1 (docs/design/p19-ide.md §6): `code` chat references — lines of a file picked in the code viewer or a
 * diff ("Sohbete ekle"). Small and eager: the composer (home bundle) shows the pending ones as chips and sends them as
 * mentions; the code viewer itself is a lazy chunk.
 *
 * The id is the master's (apps/master/src/code/reference.ts): `repo:<sha>:<a>-<b>:<path>`,
 * `workfiles:<job>:<a>-<b>:<path>` or (p19-ide W2, "Sohbete ekle" in Tam IDE) `ide:<workspace>:<a>-<b>:<path>`. The
 * browser never sends the lines: the master re-reads them as the sender.
 *
 * Pending references live in this tab's sessionStorage until they are sent or removed (several can be collected
 * before sending), so a reload or a hop to Sohbet keeps them.
 */
export interface CodeRef {
  readonly project: string;
  readonly source: 'repo' | 'workfiles' | 'ide';
  /** Commit sha (repo), job id (workfiles) or IDE workspace id (ide). */
  readonly ref: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const ID = /^(repo|workfiles|ide):([0-9a-f-]{36,40}):(\d{1,7})-(\d{1,7}):(.+)$/s;
const MAX_PENDING = 8;
const KEY = 'remyral.codeRefs';

export function codeRefId(r: CodeRef): string {
  return `${r.source}:${r.ref}:${String(r.startLine)}-${String(r.endLine)}:${r.path}`;
}

function goodPath(p: string): boolean {
  return (
    p.length > 0 &&
    p.length <= 1024 &&
    !p.startsWith('/') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/** A reference from a mention id + project, or null when malformed. */
export function parseCodeRef(id: string, project: string | null | undefined): CodeRef | null {
  if (project === null || project === undefined || !PROJECT.test(project) || id.length > 320) return null;
  const m = ID.exec(id);
  if (m === null) return null;
  const source = m[1] as CodeRef['source'];
  const ref = m[2] ?? '';
  if (source === 'repo' ? !SHA.test(ref) : !UUID.test(ref)) return null;
  const startLine = Number(m[3]);
  const endLine = Number(m[4]);
  const path = m[5] ?? '';
  if (startLine < 1 || endLine < startLine || !goodPath(path)) return null;
  return { project, source, ref, path, startLine, endLine };
}

/** `src/app.ts:40-58 · a1b2c3d` (the master gives the same label to the sent chip). */
export function codeRefLabel(r: CodeRef): string {
  const name = r.path.length > 60 ? `…/${r.path.split('/').pop() ?? r.path}` : r.path;
  const lines =
    r.startLine === r.endLine ? String(r.startLine) : `${String(r.startLine)}-${String(r.endLine)}`;
  return `${name}:${lines}${r.source === 'repo' ? ` · ${r.ref.slice(0, 7)}` : r.source === 'ide' ? ' · IDE' : ''}`;
}

/** The viewer at a file and line range: `/projects/:id/code?ref=…&path=…&L=40-58` (`job=` for working files). */
export function codeHref(r: {
  readonly project: string;
  readonly source?: 'repo' | 'workfiles' | undefined;
  readonly ref?: string | undefined;
  readonly path?: string | undefined;
  readonly startLine?: number | undefined;
  readonly endLine?: number | undefined;
}): string {
  const q = new URLSearchParams();
  if (r.ref !== undefined && r.ref !== '') q.set(r.source === 'workfiles' ? 'job' : 'ref', r.ref);
  if (r.path !== undefined && r.path !== '') q.set('path', r.path);
  if (r.startLine !== undefined) {
    const end = r.endLine ?? r.startLine;
    q.set('L', end === r.startLine ? String(r.startLine) : `${String(r.startLine)}-${String(end)}`);
  }
  const qs = q.toString();
  return `/projects/${encodeURIComponent(r.project)}/code${qs === '' ? '' : `?${qs}`}`;
}

/** The viewer link of a sent `code` mention, or null when its id is malformed (or an IDE file: no viewer for it). */
export function codeMentionHref(id: string, project: string | null | undefined): string | null {
  const r = parseCodeRef(id, project);
  return r === null || r.source === 'ide' ? null : codeHref({ ...r, source: r.source });
}

/**
 * p19-ide W4: the "Aç" card the assistant's open_code / open_diff leave on their tool line (`meta.codeCard`). Only these
 * checked fields are read; the link is built here, never taken from the model or the master.
 */
export type AssistantCodeCard =
  | {
      readonly kind: 'code';
      readonly project: string;
      readonly path: string;
      readonly sha: string;
      readonly refLabel: string;
      readonly startLine?: number;
      readonly endLine?: number;
      readonly note?: string;
    }
  | {
      readonly kind: 'diff';
      readonly project: string;
      readonly job?: string;
      readonly base?: string;
      readonly head?: string;
      readonly pr?: number;
      readonly title?: string;
      readonly path?: string;
      readonly files?: number;
      readonly note?: string;
    };

const REF = /^[A-Za-z0-9._/@+-]{1,255}$/;
const line = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1_000_000 ? v : undefined;
const text = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;

/** A tool message's `meta.codeCard`, or null when it is missing or malformed. */
export function parseAssistantCodeCard(v: unknown): AssistantCodeCard | null {
  if (v === null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const project = typeof o.project === 'string' && PROJECT.test(o.project) ? o.project : null;
  if (project === null) return null;
  const note = text(o.note, 200);
  if (o.kind === 'code') {
    if (typeof o.path !== 'string' || !goodPath(o.path)) return null;
    if (typeof o.sha !== 'string' || !SHA.test(o.sha)) return null;
    const startLine = line(o.startLine);
    const endLine = startLine === undefined ? undefined : line(o.endLine);
    return {
      kind: 'code',
      project,
      path: o.path,
      sha: o.sha,
      refLabel: text(o.refLabel, 255) ?? o.sha.slice(0, 7),
      ...(startLine === undefined ? {} : { startLine }),
      ...(endLine === undefined || endLine < (startLine ?? 1) ? {} : { endLine }),
      ...(note === undefined ? {} : { note }),
    };
  }
  if (o.kind !== 'diff') return null;
  const path = typeof o.path === 'string' && goodPath(o.path) ? o.path : undefined;
  const title = text(o.title, 200);
  const files =
    typeof o.files === 'number' && Number.isInteger(o.files) && o.files >= 0 ? o.files : undefined;
  const rest = {
    ...(path === undefined ? {} : { path }),
    ...(title === undefined ? {} : { title }),
    ...(files === undefined ? {} : { files }),
    ...(note === undefined ? {} : { note }),
  };
  if (typeof o.job === 'string' && UUID.test(o.job)) return { kind: 'diff', project, job: o.job, ...rest };
  if (typeof o.base !== 'string' || typeof o.head !== 'string' || !REF.test(o.base) || !REF.test(o.head))
    return null;
  const pr = line(o.pr);
  return { kind: 'diff', project, base: o.base, head: o.head, ...(pr === undefined ? {} : { pr }), ...rest };
}

/** Where a card's "Aç" goes: the viewer at the file and lines, the job's reviewer or a compare (at its file). */
export function assistantCodeCardHref(c: AssistantCodeCard): string {
  if (c.kind === 'code')
    return codeHref({
      project: c.project,
      source: 'repo',
      ref: c.sha,
      path: c.path,
      ...(c.startLine === undefined ? {} : { startLine: c.startLine, endLine: c.endLine ?? c.startLine }),
    });
  const p = encodeURIComponent(c.project);
  if (c.job !== undefined) {
    const q = c.path === undefined ? '' : `?${new URLSearchParams({ path: c.path }).toString()}`;
    return `/projects/${p}/code/jobs/${c.job}${q}`;
  }
  const q = new URLSearchParams({ base: c.base ?? '', head: c.head ?? '' });
  if (c.path !== undefined) q.set('path', c.path);
  return `/projects/${p}/code/compare?${q.toString()}`;
}

/** `L=40-58` / `L=40` → the range, or null. */
export function parseLineRange(v: string | null): { start: number; end: number } | null {
  if (v === null) return null;
  const m = /^(\d{1,7})(?:-(\d{1,7}))?$/.exec(v);
  if (m === null) return null;
  const start = Number(m[1]);
  const end = m[2] === undefined ? start : Number(m[2]);
  return start >= 1 && end >= start ? { start, end } : null;
}

// ---------------------------------------------------------------------------------------------- pending store

let pending: readonly CodeRef[] = read();
const listeners = new Set<() => void>();

function read(): readonly CodeRef[] {
  try {
    const raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(KEY);
    if (raw === null) return [];
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list.flatMap((x): CodeRef[] => {
      if (x === null || typeof x !== 'object') return [];
      const o = x as Record<string, unknown>;
      const r =
        typeof o.id === 'string'
          ? parseCodeRef(o.id, typeof o.project === 'string' ? o.project : null)
          : null;
      return r === null ? [] : [r];
    });
  } catch {
    return [];
  }
}

function write(next: readonly CodeRef[]): void {
  pending = next;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(next.map((r) => ({ id: codeRefId(r), project: r.project }))));
  } catch {
    // Private mode / storage off: the list stays in memory for this page.
  }
  for (const l of [...listeners]) l();
}

/** Adds a reference for the next message; false when it is already there or the list is full (8, like mentions). */
export function addPendingCodeRef(r: CodeRef): boolean {
  if (pending.some((p) => codeRefId(p) === codeRefId(r) && p.project === r.project)) return false;
  if (pending.length >= MAX_PENDING) return false;
  write([...pending, r]);
  return true;
}

export function removePendingCodeRef(r: CodeRef): void {
  write(pending.filter((p) => !(codeRefId(p) === codeRefId(r) && p.project === r.project)));
}

export function clearPendingCodeRefs(): void {
  write([]);
}

export function pendingCodeRefs(): readonly CodeRef[] {
  return pending;
}

/** Tests: start with an empty list (and reread the storage). */
export function resetPendingCodeRefs(): void {
  pending = read();
  for (const l of [...listeners]) l();
}

export function usePendingCodeRefs(): readonly CodeRef[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => pending,
    () => pending,
  );
}
