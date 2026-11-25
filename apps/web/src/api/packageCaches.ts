import { apiRequest, nullableStr, obj, type RequestOptions, str } from './client';

/** p6-warm-caches (ADR-0029): whether a project's trusted host-profile jobs share the machines' package caches. */
export interface PackageCacheSetting {
  readonly project: string;
  readonly enabled: boolean;
  readonly updatedBy: string | null;
  readonly updatedAt: string | null;
}

type Opts = Omit<RequestOptions, 'body'>;

export function parsePackageCacheSetting(v: unknown): PackageCacheSetting {
  const o = obj(v);
  return {
    project: str(o, 'project'),
    enabled: o.enabled === true,
    updatedBy: nullableStr(o, 'updatedBy'),
    updatedAt: nullableStr(o, 'updatedAt'),
  };
}

const path = (project: string): string => `/projects/${encodeURIComponent(project)}/package-caches`;

export function getPackageCacheSetting(project: string, opts: Opts = {}): Promise<PackageCacheSetting> {
  return apiRequest('GET', path(project), parsePackageCacheSetting, opts);
}

/** Admin + step-up (the caller wraps it in the step-up dialog). */
export function putPackageCacheSetting(
  project: string,
  enabled: boolean,
  opts: Opts = {},
): Promise<PackageCacheSetting> {
  return apiRequest('PUT', path(project), parsePackageCacheSetting, { ...opts, body: { enabled } });
}
