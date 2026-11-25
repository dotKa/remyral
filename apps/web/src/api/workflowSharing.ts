import { apiRequest, int, obj, ShapeError, str } from './client';

/**
 * p18-multi-project W1 + W2 (apps/master/src/workflows/sharing-routes.ts, docs/design/p18-multi-project.md §5):
 * shared workflows. The owner project offers a workflow ("Paylaş") and sees where it is used; a target project's
 * admin attaches an offered workflow, follows or pins its versions, accepts a waiting version, binds its credential
 * slots and sets the attachment's overrides ("Bu projedeki ayarlar").
 */

type Opts = { readonly signal?: AbortSignal };

const optStr = (o: Record<string, unknown>, k: string): string | null =>
  typeof o[k] === 'string' ? o[k] : null;
const optInt = (o: Record<string, unknown>, k: string): number | null =>
  typeof o[k] === 'number' && Number.isInteger(o[k]) ? o[k] : null;
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/** The settings a target project gives its attachment (all optional; validated by the master). */
export interface AttachmentOverrides {
  readonly inputs?: Readonly<Record<string, string>>;
  readonly repository?: { readonly url: string; readonly baseRef: string };
  readonly approvers?: Readonly<Record<string, 'operator' | 'admin' | 'owner'>>;
  readonly onFailure?: { readonly workflow: string };
  readonly retentionDays?: number;
  readonly triggers?: Readonly<
    Record<
      string,
      {
        readonly cron?: string;
        readonly timeZone?: string;
        readonly repository?: string;
        readonly events?: readonly string[];
        readonly branches?: readonly string[];
      }
    >
  >;
  readonly concurrency?: { readonly max: number };
}

export interface CredentialSlot {
  readonly slot: string;
  readonly kind: string;
  readonly hosts: readonly string[];
  readonly nodes: readonly string[];
  readonly credentialId: string | null;
}

export interface Attachment {
  readonly id: string;
  readonly project: string;
  readonly ownerProject: string;
  readonly name: string;
  readonly state: 'enabled' | 'disabled' | 'detached';
  readonly follow: 'auto' | 'pin';
  readonly version: number;
  readonly definitionId: string | null;
  readonly latestVersion: number;
  readonly pendingVersion: number | null;
  readonly pendingReason: string | null;
  readonly ownerArchived: boolean;
  readonly offered: boolean;
  readonly overrides: AttachmentOverrides;
  readonly slots: readonly CredentialSlot[];
  readonly updatedAt: string;
  readonly lastRun: { readonly id: string; readonly state: string; readonly createdAt: string } | null;
}

export interface AttachReport {
  readonly kind: string;
  readonly repository: 'override' | 'registered' | 'missing' | 'not_needed';
  readonly egress: readonly { readonly path: string; readonly code: string }[];
  readonly credentialUnbound: readonly string[];
  readonly privileged: readonly { readonly node: string; readonly type: string; readonly action: string }[];
  readonly issues: readonly { readonly path: string; readonly code: string }[];
}

const issues = (v: unknown): { path: string; code: string }[] =>
  Array.isArray(v)
    ? v.flatMap((i) => {
        if (typeof i !== 'object' || i === null) return [];
        const r = i as Record<string, unknown>;
        return typeof r.path === 'string' && typeof r.code === 'string'
          ? [{ path: r.path, code: r.code }]
          : [];
      })
    : [];

export function parseAttachment(v: unknown): Attachment {
  const o = obj(v);
  const last = typeof o.lastRun === 'object' && o.lastRun !== null ? obj(o.lastRun) : null;
  const state = str(o, 'state');
  return {
    id: str(o, 'id'),
    project: str(o, 'project'),
    ownerProject: str(o, 'ownerProject'),
    name: str(o, 'name'),
    state: state === 'enabled' || state === 'detached' ? state : 'disabled',
    follow: o.follow === 'pin' ? 'pin' : 'auto',
    version: int(o, 'version'),
    definitionId: optStr(o, 'definitionId'),
    latestVersion: optInt(o, 'latestVersion') ?? int(o, 'version'),
    pendingVersion: optInt(o, 'pendingVersion'),
    pendingReason: optStr(o, 'pendingReason'),
    ownerArchived: o.ownerArchived === true,
    offered: o.offered !== false,
    overrides: typeof o.overrides === 'object' && o.overrides !== null ? o.overrides : {},
    slots: (Array.isArray(o.slots) ? o.slots : []).map((x) => {
      const s = obj(x);
      return {
        slot: str(s, 'slot'),
        kind: str(s, 'kind'),
        hosts: strs(s.hosts),
        nodes: strs(s.nodes),
        credentialId: optStr(s, 'credentialId'),
      };
    }),
    updatedAt: optStr(o, 'updatedAt') ?? '',
    lastRun:
      last === null
        ? null
        : { id: str(last, 'id'), state: str(last, 'state'), createdAt: str(last, 'createdAt') },
  };
}

function parseReport(v: unknown): AttachReport {
  const o = obj(v);
  const repo = o.repository;
  return {
    kind: optStr(o, 'kind') ?? 'repository',
    repository: repo === 'override' || repo === 'registered' || repo === 'missing' ? repo : 'not_needed',
    egress: issues(o.egress),
    credentialUnbound: strs(o.credentialUnbound),
    privileged: (Array.isArray(o.privileged) ? o.privileged : []).map((x) => {
      const p = obj(x);
      return { node: str(p, 'node'), type: str(p, 'type'), action: str(p, 'action') };
    }),
    issues: issues(o.issues),
  };
}

export interface AttachmentWithReport {
  readonly attachment: Attachment;
  readonly report: AttachReport;
}
const parseWithReport = (v: unknown): AttachmentWithReport => {
  const o = obj(v);
  return { attachment: parseAttachment(o.attachment), report: parseReport(o.report) };
};

// ------------------------------------------------------------------------------------------------ owner side

export interface Sharing {
  readonly ownerProject: string;
  readonly name: string;
  /** `*` = every project. */
  readonly projects: readonly string[];
}
const parseSharing = (v: unknown): Sharing => {
  const o = obj(v);
  return { ownerProject: str(o, 'ownerProject'), name: str(o, 'name'), projects: strs(o.projects) };
};

export function getSharing(id: string, opts: Opts = {}): Promise<Sharing> {
  return apiRequest('GET', `/workflows/${encodeURIComponent(id)}/sharing`, parseSharing, opts);
}

/** "Paylaş": offer to listed projects or every project (`['*']`); `[]` withdraws. Admin, step-up. */
export function setSharing(id: string, projects: readonly string[]): Promise<Sharing> {
  return apiRequest('PUT', `/workflows/${encodeURIComponent(id)}/sharing`, parseSharing, {
    body: { projects },
  });
}

export interface WhereUsed {
  readonly attachments: readonly Attachment[];
  /** Attaching projects the caller cannot read. */
  readonly hidden: number;
  readonly offeredTo: readonly string[];
}

/** "Nerede kullanılıyor": the projects that attached a workflow. */
export function whereUsed(id: string, opts: Opts = {}): Promise<WhereUsed> {
  return apiRequest(
    'GET',
    `/workflows/${encodeURIComponent(id)}/attachments`,
    (v) => {
      const o = obj(v);
      if (!Array.isArray(o.attachments)) throw new ShapeError('expected attachments');
      return {
        attachments: o.attachments.map(parseAttachment),
        hidden: typeof o.hidden === 'number' ? o.hidden : 0,
        offeredTo: strs(o.offeredTo),
      };
    },
    opts,
  );
}

// ------------------------------------------------------------------------------------------------ target side

export interface Offer {
  readonly workflowId: string;
  readonly ownerProject: string;
  readonly name: string;
  readonly description: string | null;
  readonly latestVersion: number;
  readonly nodes: number;
  readonly attached: boolean;
  readonly nameTaken: boolean;
}

/** Workflows other projects offer to `project` (its admins attach them). */
export function listOffers(project: string, opts: Opts = {}): Promise<Offer[]> {
  return apiRequest(
    'GET',
    `/workflows/offers?project=${encodeURIComponent(project)}`,
    (v) => {
      const o = obj(v);
      if (!Array.isArray(o.offers)) throw new ShapeError('expected offers');
      return o.offers.map((x) => {
        const f = obj(x);
        return {
          workflowId: str(f, 'workflowId'),
          ownerProject: str(f, 'ownerProject'),
          name: str(f, 'name'),
          description: optStr(f, 'description'),
          latestVersion: int(f, 'latestVersion'),
          nodes: typeof f.nodes === 'number' ? f.nodes : 0,
          attached: f.attached === true,
          nameTaken: f.nameTaken === true,
        };
      });
    },
    opts,
  );
}

export function attachWorkflow(
  project: string,
  body: {
    readonly ownerProject: string;
    readonly name: string;
    readonly follow?: 'auto' | 'pin';
    readonly overrides?: AttachmentOverrides;
  },
): Promise<AttachmentWithReport> {
  return apiRequest(
    'POST',
    `/projects/${encodeURIComponent(project)}/workflow-attachments`,
    parseWithReport,
    { body },
  );
}

export function listAttachments(project: string, opts: Opts = {}): Promise<Attachment[]> {
  return apiRequest(
    'GET',
    `/projects/${encodeURIComponent(project)}/workflow-attachments`,
    (v) => {
      const o = obj(v);
      if (!Array.isArray(o.attachments)) throw new ShapeError('expected attachments');
      return o.attachments.map(parseAttachment);
    },
    opts,
  );
}

export function getAttachment(id: string, opts: Opts = {}): Promise<AttachmentWithReport> {
  return apiRequest('GET', `/workflow-attachments/${encodeURIComponent(id)}`, parseWithReport, opts);
}

export function updateAttachment(
  id: string,
  patch: {
    readonly state?: 'enabled' | 'disabled';
    readonly follow?: 'auto' | 'pin';
    readonly overrides?: AttachmentOverrides;
  },
): Promise<AttachmentWithReport> {
  return apiRequest('PATCH', `/workflow-attachments/${encodeURIComponent(id)}`, parseWithReport, {
    body: patch,
  });
}

export function detachAttachment(id: string): Promise<void> {
  return apiRequest('DELETE', `/workflow-attachments/${encodeURIComponent(id)}`, () => undefined);
}

/** "Güncellemeyi kabul et": run `version` here (privileged nodes: admin with a fresh step-up). */
export function acceptAttachmentVersion(id: string, version: number): Promise<AttachmentWithReport> {
  return apiRequest('POST', `/workflow-attachments/${encodeURIComponent(id)}/accept`, parseWithReport, {
    body: { version },
  });
}

/** Bind a credential slot to one of the vault's credentials (admin, always-fresh step-up). */
export function bindAttachmentSlot(
  id: string,
  slot: string,
  credentialId: string,
): Promise<AttachmentWithReport> {
  return apiRequest(
    'PUT',
    `/workflow-attachments/${encodeURIComponent(id)}/credentials/${encodeURIComponent(slot)}`,
    parseWithReport,
    { body: { credentialId } },
  );
}

export function unbindAttachmentSlot(id: string, slot: string): Promise<AttachmentWithReport> {
  return apiRequest(
    'DELETE',
    `/workflow-attachments/${encodeURIComponent(id)}/credentials/${encodeURIComponent(slot)}`,
    parseWithReport,
  );
}
