import { apiRequest, nullableStr, obj, type RequestOptions, ShapeError, str, strArray } from './client';

/**
 * p14-workflow-engine 14.3 (ADR-0055 K1, docs/design/p14-workflow-engine.md §8.4): a project's HTTP egress policy for
 * workflow HTTP request and e-mail nodes. `open` (default) = any public address; `allowlist` = only the listed hosts.
 * LAN / private / loopback / link-local / metadata addresses are refused in every mode (by the master at save and run,
 * and by the worker for every resolved address and redirect). Changing it needs a project admin and a fresh TOTP.
 */

export type EgressMode = 'open' | 'allowlist';

export interface WorkflowEgress {
  readonly project: string;
  readonly mode: EgressMode;
  readonly hosts: readonly string[];
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

/** At most this many hosts (master: `workflow_egress.hosts`). */
export const MAX_EGRESS_HOSTS = 64;

type Opts = Pick<RequestOptions, 'signal'>;

export function parseWorkflowEgress(body: unknown): WorkflowEgress {
  const b = obj(body);
  const mode = str(b, 'mode');
  if (mode !== 'open' && mode !== 'allowlist') throw new ShapeError('unexpected egress mode');
  return {
    project: str(b, 'project'),
    mode,
    hosts: strArray(b, 'hosts'),
    updatedAt: nullableStr(b, 'updatedAt'),
    updatedBy: nullableStr(b, 'updatedBy'),
  };
}

export function getWorkflowEgress(project: string, opts: Opts = {}): Promise<WorkflowEgress> {
  return apiRequest(
    'GET',
    `/projects/${encodeURIComponent(project)}/workflow-egress`,
    parseWorkflowEgress,
    opts,
  );
}

export function setWorkflowEgress(
  project: string,
  body: { readonly mode: EgressMode; readonly hosts: readonly string[] },
  opts: Opts = {},
): Promise<WorkflowEgress> {
  return apiRequest('PUT', `/projects/${encodeURIComponent(project)}/workflow-egress`, parseWorkflowEgress, {
    ...opts,
    body: { mode: body.mode, hosts: [...body.hosts] },
  });
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const INTERNAL_SUFFIX = /\.(local|internal|lan|home|intranet|corp|localdomain|home\.arpa|localhost)$/;

export type HostProblem = 'empty' | 'format' | 'ip' | 'internal' | 'port' | 'duplicate' | 'tooMany';

/**
 * Client-side check of one allowlist entry (`host` or `host:port`), mirroring the master: a lower-case DNS name with
 * a dot, no IP literal (decimal / hex forms included), no internal name, a port 1–65535. Null = fine.
 */
export function egressHostProblem(raw: string, existing: readonly string[] = []): HostProblem | null {
  const v = raw.trim();
  if (v === '') return 'empty';
  if (v !== v.toLowerCase()) return 'format';
  if (v.startsWith('[') || (v.match(/:/g)?.length ?? 0) > 1) return 'ip';
  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(v);
  if (m?.[1] === undefined) return 'format';
  const host = m[1];
  if (m[2] !== undefined) {
    const port = Number(m[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 'port';
  }
  if (/^[0-9.]+$/.test(host) || /^0x[0-9a-f]+$/.test(host) || /(^|\.)0x[0-9a-f]*(\.|$)/.test(host))
    return 'ip';
  if (host === 'localhost' || host === 'metadata' || host === 'instance-data' || INTERNAL_SUFFIX.test(host))
    return 'internal';
  if (host.length > 253 || !host.includes('.') || !host.split('.').every((l) => LABEL.test(l)))
    return 'format';
  if (existing.includes(v)) return 'duplicate';
  if (existing.length >= MAX_EGRESS_HOSTS) return 'tooMany';
  return null;
}
