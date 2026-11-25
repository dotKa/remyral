import { apiRequest, nullableStr, obj, type RequestOptions, ShapeError, str, strArray } from './client';

/**
 * p19-ide W3 (apps/master/src/ide/extension-routes.ts): IDE extensions from Open VSX through the master's allowlist,
 * a project's required / recommended / denied extensions and enforced settings, and the user's own list. Nothing here
 * is a secret: ids, versions, hashes of public packages, setting names.
 */

type Opts = Omit<RequestOptions, 'body'>;
const enc = encodeURIComponent;

export interface IdeExtensionPolicy {
  readonly registryUrl: string;
  readonly verifiedOnly: boolean;
  readonly deny: readonly string[];
  readonly updatedAt: string | null;
}

export interface IdeExtensionTarget {
  readonly target: string;
  readonly sha256: string;
  readonly size: number;
  readonly keyId: string;
  readonly keyPinned: boolean;
}

export interface IdeAllowedExtension {
  readonly id: string;
  readonly version: string;
  readonly pinned: boolean;
  readonly displayName: string;
  readonly description: string;
  readonly publisherVerified: boolean;
  readonly license: string | null;
  readonly engine: string | null;
  readonly dependencies: readonly string[];
  readonly registryUrl: string;
  readonly targets: readonly IdeExtensionTarget[];
  readonly approvedBy: string | null;
  readonly approvedAt: string;
}

export interface IdeSearchHit {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  readonly verified: boolean;
  readonly deprecated: boolean;
  readonly downloadCount: number;
  readonly allowedVersion: string | null;
  readonly denied: boolean;
}

export interface IdeProjectExtensionPolicy {
  readonly required: readonly string[];
  readonly recommended: readonly string[];
  readonly deny: readonly string[];
  readonly enforcedSettings: Readonly<Record<string, unknown>>;
  readonly updatedAt: string | null;
}

export interface IdeUserExtensions {
  readonly available: readonly (IdeAllowedExtension & {
    readonly required: boolean;
    readonly recommended: boolean;
  })[];
  readonly mine: readonly string[];
  readonly required: readonly string[];
  readonly recommended: readonly string[];
  readonly blocked: readonly { readonly id: string; readonly reason: string }[];
  readonly settings: {
    readonly settingsBytes: number | null;
    readonly keybindingsBytes: number | null;
    readonly updatedAt: string | null;
  };
}

const num = (o: Record<string, unknown>, k: string): number => {
  const v = o[k];
  if (typeof v !== 'number') throw new ShapeError(`${k} must be a number`);
  return v;
};
const nnum = (o: Record<string, unknown>, k: string): number | null => {
  const v = o[k];
  return typeof v === 'number' ? v : null;
};
const arr = (o: Record<string, unknown>, k: string): unknown[] => {
  const v = o[k];
  if (!Array.isArray(v)) throw new ShapeError(`${k} must be an array`);
  return v;
};

function parsePolicy(raw: unknown): IdeExtensionPolicy {
  const o = obj(raw);
  return {
    registryUrl: str(o, 'registryUrl'),
    verifiedOnly: o.verifiedOnly === true,
    deny: strArray(o, 'deny'),
    updatedAt: nullableStr(o, 'updatedAt'),
  };
}

export function parseAllowed(raw: unknown): IdeAllowedExtension {
  const o = obj(raw);
  return {
    id: str(o, 'id'),
    version: str(o, 'version'),
    pinned: o.pinned === true,
    displayName: str(o, 'displayName'),
    description: str(o, 'description'),
    publisherVerified: o.publisherVerified === true,
    license: nullableStr(o, 'license'),
    engine: nullableStr(o, 'engine'),
    dependencies: strArray(o, 'dependencies'),
    registryUrl: str(o, 'registryUrl'),
    targets: arr(o, 'targets').map((t) => {
      const x = obj(t);
      return {
        target: str(x, 'target'),
        sha256: str(x, 'sha256'),
        size: num(x, 'size'),
        keyId: str(x, 'keyId'),
        keyPinned: x.keyPinned === true,
      };
    }),
    approvedBy: nullableStr(o, 'approvedBy'),
    approvedAt: str(o, 'approvedAt'),
  };
}

function parseProject(raw: unknown): IdeProjectExtensionPolicy {
  const o = obj(raw);
  return {
    required: strArray(o, 'required'),
    recommended: strArray(o, 'recommended'),
    deny: strArray(o, 'deny'),
    enforcedSettings: obj(o.enforcedSettings),
    updatedAt: nullableStr(o, 'updatedAt'),
  };
}

function parseUser(raw: unknown): IdeUserExtensions {
  const o = obj(raw);
  const s = obj(o.settings);
  return {
    available: arr(o, 'available').map((a) => {
      const x = obj(a);
      return { ...parseAllowed(x), required: x.required === true, recommended: x.recommended === true };
    }),
    mine: strArray(o, 'mine'),
    required: strArray(o, 'required'),
    recommended: strArray(o, 'recommended'),
    blocked: arr(o, 'blocked').map((b) => {
      const x = obj(b);
      return { id: str(x, 'id'), reason: str(x, 'reason') };
    }),
    settings: {
      settingsBytes: nnum(s, 'settingsBytes'),
      keybindingsBytes: nnum(s, 'keybindingsBytes'),
      updatedAt: nullableStr(s, 'updatedAt'),
    },
  };
}

export function getIdeExtensionPolicy(opts: Opts = {}): Promise<IdeExtensionPolicy> {
  return apiRequest('GET', '/ide/extension-policy', parsePolicy, opts);
}

/** Step-up: event `extensions.ide`. */
export function putIdeExtensionPolicy(
  body: {
    readonly registryUrl: string | null;
    readonly verifiedOnly: boolean;
    readonly deny: readonly string[];
  },
  opts: Opts = {},
): Promise<IdeExtensionPolicy> {
  return apiRequest('PUT', '/ide/extension-policy', parsePolicy, { ...opts, body });
}

export function listIdeExtensions(opts: Opts = {}): Promise<IdeAllowedExtension[]> {
  return apiRequest('GET', '/ide/extensions', (b) => arr(obj(b), 'extensions').map(parseAllowed), opts);
}

export function searchIdeExtensions(q: string, opts: Opts = {}): Promise<IdeSearchHit[]> {
  return apiRequest(
    'GET',
    `/ide/extensions/search?q=${enc(q)}`,
    (b) =>
      arr(obj(b), 'results').map((r) => {
        const x = obj(r);
        return {
          id: str(x, 'id'),
          version: str(x, 'version'),
          displayName: str(x, 'displayName'),
          description: str(x, 'description'),
          verified: x.verified === true,
          deprecated: x.deprecated === true,
          downloadCount: num(x, 'downloadCount'),
          allowedVersion: nullableStr(x, 'allowedVersion'),
          denied: x.denied === true,
        };
      }),
    opts,
  );
}

/** Allows an extension: the master downloads, verifies and caches it (step-up: `extensions.ide`). */
export function allowIdeExtension(
  input: { readonly id: string; readonly version?: string },
  opts: Opts = {},
): Promise<IdeAllowedExtension> {
  return apiRequest('POST', '/ide/extensions', (b) => parseAllowed(obj(b).extension), {
    ...opts,
    body: input,
  });
}

export function removeIdeExtension(id: string, opts: Opts = {}): Promise<null> {
  return apiRequest('DELETE', `/ide/extensions/${enc(id)}`, () => null, opts);
}

export function getProjectIdeExtensionPolicy(
  project: string,
  opts: Opts = {},
): Promise<IdeProjectExtensionPolicy> {
  return apiRequest('GET', `/projects/${enc(project)}/ide/extension-policy`, parseProject, opts);
}

/** Step-up: event `extensions.ide`. */
export function putProjectIdeExtensionPolicy(
  project: string,
  body: {
    readonly required: readonly string[];
    readonly recommended: readonly string[];
    readonly deny: readonly string[];
    readonly enforcedSettings: Readonly<Record<string, unknown>>;
  },
  opts: Opts = {},
): Promise<IdeProjectExtensionPolicy> {
  return apiRequest('PUT', `/projects/${enc(project)}/ide/extension-policy`, parseProject, { ...opts, body });
}

export function getMyIdeExtensions(project: string, opts: Opts = {}): Promise<IdeUserExtensions> {
  return apiRequest('GET', `/projects/${enc(project)}/ide/extensions`, parseUser, opts);
}

export function putMyIdeExtensions(extensions: readonly string[], opts: Opts = {}): Promise<string[]> {
  return apiRequest('PUT', '/me/ide/extensions', (b) => strArray(obj(b), 'extensions'), {
    ...opts,
    body: { extensions },
  });
}

export function resetMyIdeSettings(opts: Opts = {}): Promise<null> {
  return apiRequest('DELETE', '/me/ide/settings', () => null, opts);
}
