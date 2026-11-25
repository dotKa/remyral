import { apiRequest, obj, type RequestOptions, ShapeError, str, strArray } from './client';

/**
 * p19-project-env: vault credentials of kind "generic" a project gives its jobs as environment variables (the
 * credential's own variable name). Ids and names only — values never leave the machines.
 */
export interface ProjectEnvCredential {
  readonly credentialId: string;
  readonly name: string;
  readonly env: string;
  /** Machines holding its current version: the project's jobs run only there. */
  readonly machines: readonly string[];
}

export interface ProjectEnvSetting {
  readonly project: string;
  readonly credentials: readonly ProjectEnvCredential[];
  readonly available: readonly { readonly id: string; readonly name: string; readonly env: string }[];
}

type Opts = Omit<RequestOptions, 'body'>;

function list(o: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const v = o[key];
  if (!Array.isArray(v)) throw new ShapeError(`expected array at ${key}`);
  return v.map((x) => obj(x));
}

export function parseProjectEnvSetting(v: unknown): ProjectEnvSetting {
  const o = obj(v);
  return {
    project: str(o, 'project'),
    credentials: list(o, 'credentials').map((c) => ({
      credentialId: str(c, 'credentialId'),
      name: str(c, 'name'),
      env: str(c, 'env'),
      machines: strArray(c, 'machines'),
    })),
    available: list(o, 'available').map((a) => ({
      id: str(a, 'id'),
      name: str(a, 'name'),
      env: str(a, 'env'),
    })),
  };
}

const path = (project: string): string => `/projects/${encodeURIComponent(project)}/env-credentials`;

export function getProjectEnv(project: string, opts: Opts = {}): Promise<ProjectEnvSetting> {
  return apiRequest('GET', path(project), parseProjectEnvSetting, opts);
}

/** Replaces the set. Admin + step-up (the caller wraps it in the step-up dialog). */
export function putProjectEnv(
  project: string,
  credentialIds: readonly string[],
  opts: Opts = {},
): Promise<ProjectEnvSetting> {
  return apiRequest('PUT', path(project), parseProjectEnvSetting, {
    ...opts,
    body: { credentialIds: [...credentialIds] },
  });
}
