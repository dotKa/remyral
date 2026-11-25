import { RuntimeKind } from '@remyral/protocol';

/**
 * Context model (docs/design/p6-context-model.md): namespaced documents with immutable versions,
 * provenance and role-based permissions. Pure: no I/O.
 */

export type { RuntimeKind } from '@remyral/protocol';
export const RUNTIME_KINDS: readonly RuntimeKind[] = RuntimeKind.options;

export const CONTEXT_KINDS = ['instructions', 'memory', 'reference'] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];

/** Human console roles, weakest first (mirrors apps/master auth roles). */
export const ROLES = ['viewer', 'operator', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export function roleRank(role: Role): number {
  return ROLES.indexOf(role);
}

export function roleAtLeast(role: Role, min: Role): boolean {
  return roleRank(role) >= roleRank(min);
}

export function maxRole(a: Role, b: Role): Role {
  return roleRank(a) >= roleRank(b) ? a : b;
}

/** Project identifier, same format as jobs.project / project_policies.project. */
export const PROJECT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SKILL_ID = /^[A-Za-z0-9_.-]{1,128}$/;

export type Namespace =
  | { readonly type: 'global' }
  | { readonly type: 'project'; readonly project: string }
  | { readonly type: 'skill'; readonly skill: string }
  /** p5-machine-admin (ADR-0021): the memory of one worker machine, written only by the machine-admin service. */
  | { readonly type: 'machine'; readonly worker: string }
  /**
   * p11-memory-layers (ADR-0043): one person's own working rules. Read and written only by that person; injected only
   * into the jobs that person creates (never another user's jobs, never a worker-created job).
   */
  | { readonly type: 'user'; readonly user: string };

const WORKER_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** User ids are UUIDs (users.id). */
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Parses `global`, `project:<id>`, `skill:<id>`, `machine:<workerId>` or `user:<userId>`; null when malformed. */
export function parseNamespace(value: string): Namespace | null {
  if (value === 'global') return { type: 'global' };
  if (value.startsWith('project:')) {
    const project = value.slice('project:'.length);
    return PROJECT_ID.test(project) ? { type: 'project', project } : null;
  }
  if (value.startsWith('skill:')) {
    const skill = value.slice('skill:'.length);
    return SKILL_ID.test(skill) ? { type: 'skill', skill } : null;
  }
  if (value.startsWith('machine:')) {
    const worker = value.slice('machine:'.length);
    return WORKER_ID.test(worker) ? { type: 'machine', worker } : null;
  }
  if (value.startsWith('user:')) {
    const user = value.slice('user:'.length);
    return USER_ID.test(user) ? { type: 'user', user } : null;
  }
  return null;
}

export function formatNamespace(ns: Namespace): string {
  switch (ns.type) {
    case 'global':
      return 'global';
    case 'project':
      return `project:${ns.project}`;
    case 'skill':
      return `skill:${ns.skill}`;
    case 'machine':
      return `machine:${ns.worker}`;
    case 'user':
      return `user:${ns.user}`;
  }
}

/** p11-memory-layers: the namespace of one person's own rules. */
export function userNamespace(userId: string): string {
  return `user:${userId.toLowerCase()}`;
}

export function machineNamespace(workerId: string): string {
  return `machine:${workerId}`;
}

export function projectNamespace(project: string): string {
  return `project:${project}`;
}

/** Who authored a version. Agents are identified by job + attempt (+ the worker that ran it). */
export type Provenance =
  | { readonly type: 'user'; readonly userId: string }
  | { readonly type: 'import'; readonly userId: string; readonly source: string }
  | {
      readonly type: 'agent';
      readonly jobId: string;
      readonly attemptId: string;
      readonly workerId: string | null;
    }
  | { readonly type: 'platform' };

/** Which projects may read a document at retrieval: project documents only their own project. */
export type ProjectScope = 'own' | 'all' | 'listed';

export interface ContextVersion {
  readonly docId: string;
  readonly version: number;
  readonly title: string;
  readonly content: string;
  /** `sha256:<hex>` of the UTF-8 content. */
  readonly contentHash: string;
  readonly sortOrder: number;
  /** null: applies to every runtime. */
  readonly runtimes: readonly RuntimeKind[] | null;
  readonly changeNote: string | null;
  readonly provenance: Provenance;
  readonly createdAt: Date;
}

export interface ContextDocument {
  readonly id: string;
  /** Formatted namespace (`global`, `project:<id>`). */
  readonly namespace: string;
  readonly kind: ContextKind;
  readonly readRole: Role;
  readonly writeRole: Role;
  readonly projectScope: ProjectScope;
  /** Explicit project grants (only meaningful for `global` + `listed`). */
  readonly grants: readonly string[];
  readonly currentVersion: number;
  readonly deletedAt: Date | null;
  readonly purgeAfter: Date | null;
}

/** A document together with the version the resolver should use (normally the current one). */
export interface ResolvableDocument {
  readonly doc: ContextDocument;
  readonly version: ContextVersion;
  /**
   * p11-memory-layers: the record type when the document is a typed memory record (`rule` documents are
   * instructions, the others memory). Undefined: an untyped (legacy) document — memory counts as a fact.
   */
  readonly recordType?: 'rule' | 'fact' | 'decision' | 'lesson' | undefined;
  /**
   * p11-memory-layers: relevance to the job prompt (cosine, higher first) used only to choose which memories fit the
   * budget; never part of the bundle hash or the item order.
   */
  readonly relevance?: number | undefined;
}

export const LIMITS = {
  titleChars: 200,
  contentBytes: 256 * 1024,
  changeNoteChars: 1_000,
  importSourceChars: 500,
  sortOrderAbs: 1_000_000,
  grants: 500,
} as const;

/** True when `s` contains C0 control characters or DEL. */
export function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Normalises user text: CRLF/CR → LF, NUL removed. Applied before hashing and storing. */
export function normalizeText(s: string): string {
  return s.replaceAll('\u0000', '').replace(/\r\n?/g, '\n');
}

/**
 * Weakest `writeRole` allowed for a document: global context steers every project and needs an admin;
 * project documents need at least an operator. Viewers never write.
 */
export function writeRoleFloor(ns: Namespace): Role {
  // p11-memory-layers: a person's own rules — the namespace itself is the permission (only its owner sees it).
  return ns.type === 'project' || ns.type === 'user' ? 'operator' : 'admin';
}

export interface WriteViolation {
  readonly field: string;
  readonly code: string;
}

export interface DocumentSettings {
  readonly namespace: string;
  readonly kind: ContextKind;
  readonly readRole: Role;
  readonly writeRole: Role;
  readonly projectScope: ProjectScope;
  readonly grants: readonly string[];
}

/**
 * Validates namespace/kind/access settings for a new or re-configured document.
 *
 * p6-skills: `skill:<id>` documents exist only as the SKILL.md of a **signed** skill version, written by the
 * skills service after the signature verified (`opts.signedSkill`). Every other write path gets
 * `skill_requires_signed_bundle`. A skill document is `instructions`, admin-written, project scope `own`
 * (which projects receive a skill is decided by skill assignments, never by context grants).
 */
export function checkDocumentSettings(
  s: DocumentSettings,
  opts: { readonly signedSkill?: boolean; readonly machineMemory?: boolean } = {},
): WriteViolation[] {
  const out: WriteViolation[] = [];
  const ns = parseNamespace(s.namespace);
  if (ns === null) return [{ field: 'namespace', code: 'invalid_format' }];
  // p5-machine-admin: machine memory is written only by the machine-admin service (jobs, the Fleet editor).
  if (ns.type === 'machine') {
    if (opts.machineMemory !== true) return [{ field: 'namespace', code: 'machine_memory_is_managed' }];
    if (s.kind !== 'memory') out.push({ field: 'kind', code: 'machine_memory_is_memory' });
    if (s.projectScope !== 'own') out.push({ field: 'projectScope', code: 'machine_memory_is_own' });
    if (s.grants.length > 0) out.push({ field: 'projects', code: 'machine_memory_has_no_grants' });
  }
  if (ns.type === 'skill') {
    if (opts.signedSkill !== true) return [{ field: 'namespace', code: 'skill_requires_signed_bundle' }];
    if (s.kind !== 'instructions') out.push({ field: 'kind', code: 'skills_are_instructions' });
    if (s.projectScope !== 'own') out.push({ field: 'projectScope', code: 'skills_are_own' });
    if (s.grants.length > 0) out.push({ field: 'projects', code: 'skills_have_no_grants' });
  }
  if (!CONTEXT_KINDS.includes(s.kind)) out.push({ field: 'kind', code: 'invalid' });
  if (!ROLES.includes(s.readRole)) out.push({ field: 'readRole', code: 'invalid' });
  if (!ROLES.includes(s.writeRole)) out.push({ field: 'writeRole', code: 'invalid' });
  if (out.length > 0) return out;
  if (!roleAtLeast(s.writeRole, writeRoleFloor(ns))) out.push({ field: 'writeRole', code: 'below_floor' });
  if (roleRank(s.readRole) > roleRank(s.writeRole)) {
    out.push({ field: 'readRole', code: 'above_write_role' });
  }
  if (ns.type === 'user') {
    if (s.kind !== 'instructions') out.push({ field: 'kind', code: 'user_docs_are_rules' });
    if (s.projectScope !== 'own') out.push({ field: 'projectScope', code: 'user_docs_are_own' });
    if (s.grants.length > 0) out.push({ field: 'projects', code: 'user_docs_have_no_grants' });
  }
  if (ns.type === 'project') {
    if (s.projectScope !== 'own') out.push({ field: 'projectScope', code: 'project_docs_are_own' });
    if (s.grants.length > 0) out.push({ field: 'projects', code: 'project_docs_have_no_grants' });
  } else if (ns.type === 'global') {
    if (s.projectScope === 'own') out.push({ field: 'projectScope', code: 'invalid_for_global' });
    if (s.projectScope === 'all' && s.grants.length > 0) {
      out.push({ field: 'projects', code: 'grants_need_listed_scope' });
    }
    if (s.grants.length > LIMITS.grants) out.push({ field: 'projects', code: 'too_many' });
    for (const g of s.grants) {
      if (!PROJECT_ID.test(g)) {
        out.push({ field: 'projects', code: 'invalid_format' });
        break;
      }
    }
  }
  return out;
}

export interface VersionInput {
  readonly title: string;
  readonly content: string;
  readonly changeNote: string | null;
  readonly sortOrder: number;
  readonly runtimes: readonly string[] | null;
}

/** Validates (already normalised) version fields. */
export function checkVersionInput(v: VersionInput): WriteViolation[] {
  const out: WriteViolation[] = [];
  const title = v.title.trim();
  if (title.length === 0) out.push({ field: 'title', code: 'required' });
  if (title.length > LIMITS.titleChars) out.push({ field: 'title', code: 'too_long' });
  if (hasControlChars(v.title)) out.push({ field: 'title', code: 'control_characters' });
  if (v.content.trim().length === 0) out.push({ field: 'content', code: 'required' });
  if (Buffer.byteLength(v.content, 'utf8') > LIMITS.contentBytes) {
    out.push({ field: 'content', code: 'too_large' });
  }
  if (v.changeNote !== null && v.changeNote.length > LIMITS.changeNoteChars) {
    out.push({ field: 'changeNote', code: 'too_long' });
  }
  if (!Number.isInteger(v.sortOrder) || Math.abs(v.sortOrder) > LIMITS.sortOrderAbs) {
    out.push({ field: 'sortOrder', code: 'invalid' });
  }
  if (v.runtimes !== null) {
    if (v.runtimes.length === 0) out.push({ field: 'runtimes', code: 'empty' });
    for (const r of v.runtimes) {
      if (!(RUNTIME_KINDS as readonly string[]).includes(r)) {
        out.push({ field: 'runtimes', code: 'unknown_runtime' });
        break;
      }
    }
    if (new Set(v.runtimes).size !== v.runtimes.length) out.push({ field: 'runtimes', code: 'duplicate' });
  }
  return out;
}

/**
 * Provenance rules (ADR-0010, T-INJ-5): an agent may only record `memory` in its own job's project
 * namespace; it can never author instructions, references or global context.
 */
export function checkProvenance(
  provenance: Provenance,
  kind: ContextKind,
  namespace: string,
  jobProject?: string,
): WriteViolation[] {
  if (provenance.type === 'platform') return [{ field: 'provenance', code: 'platform_is_builtin' }];
  if (provenance.type !== 'agent') return [];
  const out: WriteViolation[] = [];
  if (kind !== 'memory') out.push({ field: 'kind', code: 'agents_write_memory_only' });
  const ns = parseNamespace(namespace);
  if (ns?.type !== 'project' || jobProject === undefined || ns.project !== jobProject) {
    out.push({ field: 'namespace', code: 'agents_write_own_project_only' });
  }
  return out;
}

/**
 * Retrieval permission: may an agent working on `project` see this document? Deleted documents never;
 * project documents only their own project; global documents when scoped to all projects or granted;
 * p11-memory-layers: a `user:<id>` document only in a job created by that user (`user`).
 */
export function projectCanRead(doc: ContextDocument, project: string, user?: string | null): boolean {
  if (doc.deletedAt !== null) return false;
  const ns = parseNamespace(doc.namespace);
  if (ns === null) return false;
  switch (ns.type) {
    case 'project':
      return ns.project === project;
    case 'global':
      return doc.projectScope === 'all' || (doc.projectScope === 'listed' && doc.grants.includes(project));
    case 'skill':
      // p6-skills: skills never enter the context bundle; they are delivered as signed bundles to the
      // projects they are assigned to (apps/master/src/skills), verified again by the worker.
      return false;
    case 'machine':
      // p5-machine-admin: machine memory goes only to machine-admin jobs of that machine (ASSIGN_JOB.machineAdmin).
      return false;
    case 'user':
      return user !== undefined && user !== null && ns.user === user.toLowerCase();
  }
}

/** Console read permission (role only; deletion is handled by the caller). */
export function userCanRead(doc: Pick<ContextDocument, 'readRole'>, role: Role): boolean {
  return roleAtLeast(role, doc.readRole);
}

export function userCanWrite(doc: Pick<ContextDocument, 'writeRole'>, role: Role): boolean {
  return role !== 'viewer' && roleAtLeast(role, doc.writeRole);
}
