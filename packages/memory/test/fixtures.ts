import { contentHash } from '../src/canonical.js';
import type {
  ContextDocument,
  ContextKind,
  ProjectScope,
  Provenance,
  ResolvableDocument,
  RuntimeKind,
} from '../src/model.js';

/** Format-correct fake tokens built at runtime so the source never contains a whole token. */
export const CANARY = {
  anthropic: ['sk', 'ant', 'api03', 'Zq3Xv7Lp9Wm2Rt5Yb8Nc4Kd6Hf1Gj0Sa'].join('-'),
  github: ['ghp', 'Ab3dE5fG7hJ9kLmN2pQrS4tUvW6xYz8C1aB3'].join('_'),
  pemBegin: ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' '),
};

let seq = 0;

export interface DocOptions {
  id?: string;
  namespace?: string;
  kind?: ContextKind;
  content?: string;
  title?: string;
  version?: number;
  sortOrder?: number;
  runtimes?: RuntimeKind[] | null;
  projectScope?: ProjectScope;
  grants?: string[];
  deleted?: boolean;
  provenance?: Provenance;
}

export function doc(o: DocOptions = {}): ResolvableDocument {
  seq += 1;
  const id = o.id ?? `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  const namespace = o.namespace ?? 'project:acme';
  const content = o.content ?? `content of ${id}`;
  const version = o.version ?? 1;
  const d: ContextDocument = {
    id,
    namespace,
    kind: o.kind ?? 'instructions',
    readRole: 'viewer',
    writeRole: namespace === 'global' ? 'admin' : 'operator',
    projectScope: o.projectScope ?? (namespace === 'global' ? 'all' : 'own'),
    grants: o.grants ?? [],
    currentVersion: version,
    deletedAt: o.deleted === true ? new Date('2026-10-13T00:00:00Z') : null,
    purgeAfter: o.deleted === true ? new Date('2026-11-13T00:00:00Z') : null,
  };
  return {
    doc: d,
    version: {
      docId: id,
      version,
      title: o.title ?? `Doc ${id.slice(-4)}`,
      content,
      contentHash: contentHash(content),
      sortOrder: o.sortOrder ?? 0,
      runtimes: o.runtimes ?? null,
      changeNote: null,
      provenance: o.provenance ?? { type: 'user', userId: '00000000-0000-4000-8000-0000000000aa' },
      createdAt: new Date('2026-10-13T00:00:00Z'),
    },
  };
}
