import { apiRequest, nullableStr, obj, type RequestOptions, ShapeError, str, strArray } from './client';

/**
 * p19-install-scripts (ADR-0068, apps/master/src/mcp/install-script-routes.ts): npm install scripts an admin reviewed
 * and approved for the whole platform. The evaluation is the registry's public metadata of one exact version; the
 * script text and descriptions are the package authors' and are rendered as text.
 */

type Opts = Omit<RequestOptions, 'body'>;

export interface InstallScriptEvaluation {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly scripts: Readonly<Partial<Record<'preinstall' | 'install' | 'postinstall', string>>>;
  readonly gypfile: boolean;
  readonly hasInstallScript: boolean;
  readonly hosts: readonly string[];
  readonly publisher: string | null;
  readonly trustedPublisher: boolean;
  readonly maintainers: readonly string[];
  readonly signatures: number;
  readonly provenance: boolean;
  readonly repository: string | null;
  readonly license: string | null;
  readonly description: string | null;
  readonly publishedAt: string | null;
}

export interface InstallScriptApproval {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly evaluation: InstallScriptEvaluation | null;
  readonly reason: string | null;
  readonly via: 'console' | 'chat';
  readonly approvedBy: string | null;
  readonly approvedAt: string;
  readonly revokedBy: string | null;
  readonly revokedAt: string | null;
}

const bool = (o: Record<string, unknown>, k: string): boolean => o[k] === true;
const num = (o: Record<string, unknown>, k: string): number => (typeof o[k] === 'number' ? o[k] : 0);

export function parseEvaluation(raw: unknown): InstallScriptEvaluation {
  const o = obj(raw);
  const s = obj(o.scripts ?? {});
  const scripts: Partial<Record<'preinstall' | 'install' | 'postinstall', string>> = {};
  for (const k of ['preinstall', 'install', 'postinstall'] as const) {
    if (typeof s[k] === 'string') scripts[k] = s[k];
  }
  return {
    name: str(o, 'name'),
    version: str(o, 'version'),
    integrity: str(o, 'integrity'),
    scripts,
    gypfile: bool(o, 'gypfile'),
    hasInstallScript: bool(o, 'hasInstallScript'),
    hosts: Array.isArray(o.hosts) ? strArray(o, 'hosts') : [],
    publisher: o.publisher === undefined ? null : nullableStr(o, 'publisher'),
    trustedPublisher: bool(o, 'trustedPublisher'),
    maintainers: Array.isArray(o.maintainers) ? strArray(o, 'maintainers') : [],
    signatures: num(o, 'signatures'),
    provenance: bool(o, 'provenance'),
    repository: o.repository === undefined ? null : nullableStr(o, 'repository'),
    license: o.license === undefined ? null : nullableStr(o, 'license'),
    description: o.description === undefined ? null : nullableStr(o, 'description'),
    publishedAt: o.publishedAt === undefined ? null : nullableStr(o, 'publishedAt'),
  };
}

export function parseApproval(raw: unknown): InstallScriptApproval {
  const o = obj(raw);
  const via = str(o, 'via');
  if (via !== 'console' && via !== 'chat') throw new ShapeError('expected via');
  return {
    id: str(o, 'id'),
    name: str(o, 'name'),
    version: str(o, 'version'),
    integrity: str(o, 'integrity'),
    evaluation: o.evaluation === null || o.evaluation === undefined ? null : parseEvaluation(o.evaluation),
    reason: nullableStr(o, 'reason'),
    via,
    approvedBy: nullableStr(o, 'approvedBy'),
    approvedAt: str(o, 'approvedAt'),
    revokedBy: nullableStr(o, 'revokedBy'),
    revokedAt: nullableStr(o, 'revokedAt'),
  };
}

export function listInstallScripts(opts: Opts = {}): Promise<InstallScriptApproval[]> {
  return apiRequest(
    'GET',
    '/mcp/install-scripts',
    (b) => {
      const a = obj(b).approvals;
      if (!Array.isArray(a)) throw new ShapeError('expected approvals');
      return a.map(parseApproval);
    },
    opts,
  );
}

export function evaluateInstallScript(
  input: { readonly name: string; readonly version: string },
  opts: Opts = {},
): Promise<InstallScriptEvaluation> {
  const q = new URLSearchParams({ name: input.name, version: input.version });
  return apiRequest('GET', `/mcp/install-scripts/evaluate?${q.toString()}`, parseEvaluation, opts);
}

/** Step-up: event `extensions.install_scripts` (always fresh). */
export function approveInstallScript(
  input: {
    readonly name: string;
    readonly version: string;
    readonly integrity?: string;
    readonly reason?: string;
  },
  opts: Opts = {},
): Promise<InstallScriptApproval> {
  return apiRequest('POST', '/mcp/install-scripts', (b) => parseApproval(obj(b).approval), {
    ...opts,
    body: input,
  });
}

export function revokeInstallScript(id: string, opts: Opts = {}): Promise<InstallScriptApproval> {
  return apiRequest(
    'DELETE',
    `/mcp/install-scripts/${encodeURIComponent(id)}`,
    (b) => parseApproval(obj(b).approval),
    opts,
  );
}
