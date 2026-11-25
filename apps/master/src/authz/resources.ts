import type { FastifyRequest } from 'fastify';
import type { Queryable } from '../db/pool.js';
import type { Resource } from './model.js';

/**
 * Resource resolvers for route declarations (docs/design/p5-rbac.md §3). They run before schema
 * validation, so every input is treated as untrusted: type-checked here, passed to SQL as parameters only.
 * `undefined` = no single resource addressed; `null` = the addressed resource does not exist.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;

function field(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const v = (source as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

export function param(request: FastifyRequest, key: string): string | undefined {
  return field(request.params, key);
}

/** `<prefix>:<param>` audit target from an (unvalidated) route param, clipped. */
export function paramTarget(prefix: string, key = 'id') {
  return (request: FastifyRequest): string => `${prefix}:${(param(request, key) ?? '').slice(0, 64)}`;
}

/** A project named directly by a route param (e.g. `/projects/:id/...`). Malformed ids → not found. */
export function projectParam(key = 'id') {
  return (request: FastifyRequest): Resource | null => {
    const id = param(request, key);
    return id !== undefined && PROJECT.test(id) ? { project: id } : null;
  };
}

/**
 * p22-output-delivery: a project named by a JSON body field (a bulk action of one project). Absent → no single
 * resource (the body schema then refuses the request); malformed → not found.
 */
export function projectBody(key = 'project') {
  return (request: FastifyRequest): Resource | null | undefined => {
    const id = field(request.body, key);
    if (id === undefined) return undefined;
    return PROJECT.test(id) ? { project: id } : null;
  };
}

/** A project named by an optional query parameter (`?project=`); absent → collection. */
export function projectQuery(key = 'project') {
  return (request: FastifyRequest): Resource | null | undefined => {
    const id = field(request.query, key);
    if (id === undefined) return undefined;
    return PROJECT.test(id) ? { project: id } : null;
  };
}

async function projectOf(db: Queryable, sql: string, id: string | undefined): Promise<Resource | null> {
  if (id === undefined || !UUID.test(id)) return null;
  const { rows } = await db.query<{ project: string }>(sql, [id]);
  const project = rows[0]?.project;
  return project === undefined ? null : { project };
}

export function jobResource(db: Queryable, key = 'id') {
  return (request: FastifyRequest): Promise<Resource | null> =>
    projectOf(db, 'SELECT project FROM jobs WHERE id = $1', param(request, key));
}

export function approvalResource(db: Queryable, key = 'id') {
  return (request: FastifyRequest): Promise<Resource | null> =>
    projectOf(
      db,
      'SELECT j.project FROM approval_requests r JOIN jobs j ON j.id = r.job_id WHERE r.id = $1',
      param(request, key),
    );
}

/** Namespace → resource: `project:<id>` is project-bound, `global` and `skill:*` are global resources. */
export function namespaceResource(namespace: string | undefined): Resource | null | undefined {
  if (namespace === undefined) return undefined;
  if (namespace.startsWith('project:')) {
    const project = namespace.slice('project:'.length);
    return PROJECT.test(project) ? { project } : null;
  }
  return { project: null };
}

export function contextDocResource(db: Queryable, key = 'id') {
  return async (request: FastifyRequest): Promise<Resource | null> => {
    const id = param(request, key);
    if (id === undefined || !UUID.test(id)) return null;
    const { rows } = await db.query<{ namespace: string }>(
      'SELECT namespace FROM context_documents WHERE id = $1',
      [id],
    );
    const ns = rows[0]?.namespace;
    return ns === undefined ? null : (namespaceResource(ns) ?? null);
  };
}

/** A string field of the (unvalidated) query string. */
export function queryField(request: FastifyRequest, key: string): string | undefined {
  return field(request.query, key);
}

/** A string field of the (unvalidated) JSON body. */
export function bodyField(request: FastifyRequest, key: string): string | undefined {
  return field(request.body, key);
}

/** The namespace in a JSON body (context creation). */
export function namespaceBody(key = 'namespace') {
  return (request: FastifyRequest): Resource | null | undefined =>
    namespaceResource(field(request.body, key));
}
