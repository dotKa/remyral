import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * Typed wrappers for the master's project and user management routes (apps/master/src/authz/routes.ts,
 * docs/design/p5-rbac.md §5). Writes need a fresh step-up: callers run them through `useStepUp().run`.
 */

export const ROLES = ['owner', 'admin', 'operator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
export const PROJECT_ROLES = ['operator', 'viewer'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/** p5-research-workspace: a project either has a git repository or is a repository-less work area. */
export const PROJECT_KINDS = ['repository', 'workspace'] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];
export const EGRESS_MODES = ['none', 'allowlist', 'web'] as const;
export type EgressMode = (typeof EGRESS_MODES)[number];

export interface Project {
  readonly id: string;
  readonly name: string;
  /** `repository` when an older master omits it. */
  readonly kind: ProjectKind;
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly members: number;
  readonly myRole: Role;
}

export interface Member {
  readonly userId: string;
  readonly username: string;
  readonly accountRole: Role;
  readonly role: ProjectRole;
  readonly effectiveRole: Role;
  readonly disabled: boolean;
  readonly grantedAt: string;
  readonly grantedBy: string | null;
}

export interface UserAccount {
  readonly id: string;
  readonly username: string;
  readonly role: Role;
  readonly totpEnrolled: boolean;
  readonly disabled: boolean;
  readonly lockedUntil: string | null;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
  readonly memberships: readonly { readonly project: string; readonly role: ProjectRole }[];
}

export interface CreatedUser {
  readonly id: string;
  readonly username: string;
  readonly role: Role;
  /** Shown once; never stored by the console. */
  readonly temporaryPassword: string;
}

type Opts = Omit<RequestOptions, 'body'>;

function oneOf<const A extends readonly string[]>(
  o: Record<string, unknown>,
  key: string,
  allowed: A,
): A[number] {
  const v = str(o, key);
  const found = allowed.find((a) => a === v);
  if (found === undefined) throw new ShapeError(`unexpected ${key}`);
  return found;
}

function bool(o: Record<string, unknown>, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new ShapeError(`expected boolean at ${key}`);
  return v;
}

function items<T>(v: unknown, item: (x: unknown) => T): T[] {
  const list = obj(v).items;
  if (!Array.isArray(list)) throw new ShapeError('expected items');
  return list.map(item);
}

function parseProject(v: unknown): Project {
  const o = obj(v);
  const by = o.createdBy === null ? null : obj(o.createdBy);
  return {
    id: str(o, 'id'),
    name: str(o, 'name'),
    kind: o.kind === 'workspace' ? 'workspace' : 'repository',
    createdAt: str(o, 'createdAt'),
    createdBy: by ? str(by, 'username') : null,
    members: int(o, 'members'),
    myRole: oneOf(o, 'myRole', ROLES),
  };
}

function parseMember(v: unknown): Member {
  const o = obj(v);
  return {
    userId: str(o, 'userId'),
    username: str(o, 'username'),
    accountRole: oneOf(o, 'accountRole', ROLES),
    role: oneOf(o, 'role', PROJECT_ROLES),
    effectiveRole: oneOf(o, 'effectiveRole', ROLES),
    disabled: bool(o, 'disabled'),
    grantedAt: str(o, 'grantedAt'),
    grantedBy: nullableStr(o, 'grantedBy'),
  };
}

export function parseUser(v: unknown): UserAccount {
  const o = obj(v);
  const memberships = o.memberships;
  if (!Array.isArray(memberships)) throw new ShapeError('expected memberships');
  return {
    id: str(o, 'id'),
    username: str(o, 'username'),
    role: oneOf(o, 'role', ROLES),
    totpEnrolled: bool(o, 'totpEnrolled'),
    disabled: bool(o, 'disabled'),
    lockedUntil: nullableStr(o, 'lockedUntil'),
    lastLoginAt: nullableStr(o, 'lastLoginAt'),
    createdAt: str(o, 'createdAt'),
    memberships: memberships.map((m) => {
      const mo = obj(m);
      return { project: str(mo, 'project'), role: oneOf(mo, 'role', PROJECT_ROLES) };
    }),
  };
}

const enc = encodeURIComponent;

export function listProjects(opts: Opts = {}): Promise<Project[]> {
  return apiRequest('GET', '/projects', (v) => items(v, parseProject), opts);
}

export interface NewProjectOptions {
  readonly kind?: ProjectKind;
  /** Workspaces only. */
  readonly egress?: EgressMode;
  /** Workspaces with egress `allowlist` only. */
  readonly allowHosts?: readonly string[];
  /** p10-semantic-defaults-chat: project knowledge (search capture, memory suggestions); omitted = platform default. */
  readonly searchCapture?: boolean;
  readonly memorySuggestions?: boolean;
}

export function createProject(
  id: string,
  name: string,
  options: NewProjectOptions = {},
  opts: Opts = {},
): Promise<void> {
  const body =
    options.kind === 'workspace'
      ? {
          id,
          name,
          kind: 'workspace',
          egress: options.egress ?? 'none',
          ...(options.egress === 'allowlist' ? { allowHosts: options.allowHosts ?? [] } : {}),
        }
      : { id, name };
  // p10-semantic-defaults-chat: project knowledge (omitted = the platform default).
  const knowledge = {
    ...(options.searchCapture === undefined ? {} : { searchCapture: options.searchCapture }),
    ...(options.memorySuggestions === undefined ? {} : { memorySuggestions: options.memorySuggestions }),
  };
  return apiRequest('POST', '/projects', () => undefined, { ...opts, body: { ...body, ...knowledge } });
}

export function listMembers(project: string, opts: Opts = {}): Promise<Member[]> {
  return apiRequest('GET', `/projects/${enc(project)}/members`, (v) => items(v, parseMember), opts);
}

export function setMember(
  project: string,
  userId: string,
  role: ProjectRole,
  opts: Opts = {},
): Promise<Member[]> {
  return apiRequest('PUT', `/projects/${enc(project)}/members`, (v) => items(v, parseMember), {
    ...opts,
    body: { userId, role },
  });
}

export function removeMember(project: string, userId: string, opts: Opts = {}): Promise<Member[]> {
  return apiRequest(
    'DELETE',
    `/projects/${enc(project)}/members?userId=${enc(userId)}`,
    (v) => items(v, parseMember),
    opts,
  );
}

export function listUsers(opts: Opts = {}): Promise<UserAccount[]> {
  return apiRequest('GET', '/users', (v) => items(v, parseUser), opts);
}

export function createUser(username: string, role: Role, opts: Opts = {}): Promise<CreatedUser> {
  return apiRequest(
    'POST',
    '/users',
    (v) => {
      const o = obj(v);
      return {
        id: str(o, 'id'),
        username: str(o, 'username'),
        role: oneOf(o, 'role', ROLES),
        temporaryPassword: str(o, 'temporaryPassword'),
      };
    },
    { ...opts, body: { username, role } },
  );
}

export function setUserRole(id: string, role: Role, opts: Opts = {}): Promise<UserAccount> {
  return apiRequest('PUT', `/users/${enc(id)}/role`, parseUser, { ...opts, body: { role } });
}

export function setUserDisabled(id: string, disabled: boolean, opts: Opts = {}): Promise<UserAccount> {
  return apiRequest('POST', `/users/${enc(id)}/${disabled ? 'disable' : 'enable'}`, parseUser, opts);
}
