import { apiRequest, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * p13-multi-coolify (ADR-0050; apps/master/src/ops/routes.ts): several Coolify connections held by the master. Tokens
 * are write-only: no response carries one, the browser only sends a token the admin types in.
 */

type Opts = Omit<RequestOptions, 'body'>;
type Json = Record<string, unknown>;

export interface CoolifyConnection {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly host: string;
  readonly team: string | null;
  readonly denyResources: readonly string[];
  readonly openUrl: string | null;
  readonly useServerSso: boolean;
  readonly isDefault: boolean;
  readonly allProjects: boolean;
  readonly projects: readonly string[];
  /** p15-coolify-create: Remyral may create applications and change their variables / domains here. */
  readonly manageApps: boolean;
  readonly usedBy: readonly { readonly project: string; readonly envs: readonly string[] }[];
  readonly keyFingerprint: string;
  readonly usable: boolean;
  readonly controlPlane: boolean;
  readonly lastTest: Json | null;
  readonly lastTestAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What a project may use (Project → Deploy target editor, uptime monitor form). */
export interface CoolifyConnectionChoice {
  readonly id: string;
  readonly label: string;
  readonly host: string;
  readonly isDefault: boolean;
}

export interface CoolifyConnectionInput {
  readonly label: string;
  readonly url: string;
  readonly team?: string | null;
  readonly denyResources?: readonly string[];
  readonly openUrl?: string | null;
  readonly useServerSso?: boolean;
  readonly isDefault?: boolean;
  readonly allProjects?: boolean;
  readonly projects?: readonly string[];
  readonly manageApps?: boolean;
  readonly token: string;
}

const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const nstr = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function parseConnection(v: unknown): CoolifyConnection {
  const o = obj(v);
  if (typeof o.id !== 'string') throw new ShapeError('connection id');
  return {
    id: o.id,
    label: str(o, 'label'),
    url: str(o, 'url'),
    host: typeof o.host === 'string' ? o.host : '',
    team: nstr(o.team),
    denyResources: strs(o.denyResources),
    openUrl: nstr(o.openUrl),
    useServerSso: o.useServerSso === true,
    isDefault: o.isDefault === true,
    allProjects: o.allProjects === true,
    projects: strs(o.projects),
    manageApps: o.manageApps === true,
    usedBy: (Array.isArray(o.usedBy) ? o.usedBy : []).map((u) => {
      const x = obj(u);
      return { project: typeof x.project === 'string' ? x.project : '', envs: strs(x.envs) };
    }),
    keyFingerprint: typeof o.keyFingerprint === 'string' ? o.keyFingerprint : '',
    usable: o.usable === true,
    controlPlane: o.controlPlane === true,
    lastTest: o.lastTest === null || o.lastTest === undefined ? null : obj(o.lastTest),
    lastTestAt: nstr(o.lastTestAt),
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : '',
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : '',
  };
}

function parseChoice(v: unknown): CoolifyConnectionChoice {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    label: str(o, 'label'),
    host: typeof o.host === 'string' ? o.host : '',
    isDefault: o.isDefault === true,
  };
}

const items =
  <T>(parse: (v: unknown) => T) =>
  (v: unknown): T[] => {
    const list = obj(v).items;
    return Array.isArray(list) ? list.map(parse) : [];
  };

export function listCoolifyConnections(opts: Opts = {}): Promise<CoolifyConnection[]> {
  return apiRequest('GET', '/integrations/coolify/connections', items(parseConnection), opts);
}

export function createCoolifyConnection(
  body: CoolifyConnectionInput,
  opts: Opts = {},
): Promise<CoolifyConnection> {
  return apiRequest('POST', '/integrations/coolify/connections', parseConnection, { ...opts, body });
}

/** A partial change; `token` only when replacing it. `isDefault: true` makes it the default. */
export function updateCoolifyConnection(
  id: string,
  body: Partial<CoolifyConnectionInput>,
  opts: Opts = {},
): Promise<CoolifyConnection> {
  return apiRequest('PUT', `/integrations/coolify/connections/${encodeURIComponent(id)}`, parseConnection, {
    ...opts,
    body,
  });
}

export function removeCoolifyConnection(id: string, opts: Opts = {}): Promise<void> {
  return apiRequest(
    'DELETE',
    `/integrations/coolify/connections/${encodeURIComponent(id)}`,
    () => undefined,
    opts,
  );
}

export function testCoolifyConnection(id: string, opts: Opts = {}): Promise<Json> {
  return apiRequest(
    'POST',
    `/integrations/coolify/connections/${encodeURIComponent(id)}/test`,
    (v) => obj(v),
    opts,
  );
}

export function listProjectCoolifyConnections(
  project: string,
  opts: Opts = {},
): Promise<CoolifyConnectionChoice[]> {
  return apiRequest(
    'GET',
    `/projects/${encodeURIComponent(project)}/coolify-connections`,
    items(parseChoice),
    opts,
  );
}
