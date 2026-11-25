import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * p17-update-channel (ADR-0065): Settings → Worker releases → Update channel (apps/master/src/update-channel/routes.ts).
 */

export type UpdatePolicy = 'patch_auto' | 'manual' | 'auto';

export interface ChannelRelease {
  readonly version: string;
  readonly bump: string;
  readonly state: string;
  readonly error: string | null;
  readonly publishedAt: string;
  readonly summary: string;
  readonly notes: string;
  readonly imported: boolean;
}

export interface ChannelRollout {
  readonly version: string;
  readonly stage: string;
  readonly trigger: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly reason: string | null;
  readonly canary: readonly { readonly workerId: string; readonly status: string }[];
}

export interface CatalogItemInfo {
  readonly kind: 'runtime' | 'tool';
  readonly item: string;
  readonly version: string;
  readonly verified: boolean;
}

export interface CatalogWorkerInfo {
  readonly workerId: string;
  readonly enabled: boolean;
  readonly keys: number;
  readonly sequence: number;
  readonly lastOutcome: string | null;
  readonly lastReason: string | null;
}

export interface UpdateChannelOverview {
  readonly configured: boolean;
  readonly policy: UpdatePolicy;
  readonly soakMinutes: number;
  readonly feed: {
    readonly source: string | null;
    readonly keyId: string | null;
    readonly checkedAt: string | null;
    readonly error: string | null;
  };
  readonly stableVersion: string | null;
  readonly releases: readonly ChannelRelease[];
  readonly rollout: ChannelRollout | null;
  readonly catalog: {
    readonly enabled: boolean;
    readonly configured: boolean;
    readonly error: string | null;
    readonly sequence: number | null;
    readonly generatedAt: string | null;
    readonly items: readonly CatalogItemInfo[];
    readonly workers: readonly CatalogWorkerInfo[];
  };
}

type Opts = Pick<RequestOptions, 'signal' | 'fetchImpl'>;

const bool = (o: Record<string, unknown>, key: string): boolean => {
  const v = o[key];
  if (typeof v !== 'boolean') throw new ShapeError(`expected boolean at ${key}`);
  return v;
};
const arr = (o: Record<string, unknown>, key: string): Record<string, unknown>[] => {
  const v = o[key];
  if (!Array.isArray(v)) throw new ShapeError(`expected array at ${key}`);
  return v.map(obj);
};
const nullableInt = (o: Record<string, unknown>, key: string): number | null =>
  o[key] === null ? null : int(o, key);
const policyOf = (v: string): UpdatePolicy => {
  if (v === 'patch_auto' || v === 'manual' || v === 'auto') return v;
  throw new ShapeError('expected an update policy');
};

export function parseUpdateChannel(v: unknown): UpdateChannelOverview {
  const o = obj(v);
  const feed = obj(o.feed);
  const cat = obj(o.catalog);
  const rollout = o.rollout === null ? null : obj(o.rollout);
  return {
    configured: bool(o, 'configured'),
    policy: policyOf(str(o, 'policy')),
    soakMinutes: int(o, 'soakMinutes'),
    feed: {
      source: nullableStr(feed, 'source'),
      keyId: nullableStr(feed, 'keyId'),
      checkedAt: nullableStr(feed, 'checkedAt'),
      error: nullableStr(feed, 'error'),
    },
    stableVersion: nullableStr(o, 'stableVersion'),
    releases: arr(o, 'releases').map((r) => ({
      version: str(r, 'version'),
      bump: str(r, 'bump'),
      state: str(r, 'state'),
      error: nullableStr(r, 'error'),
      publishedAt: str(r, 'publishedAt'),
      summary: str(r, 'summary'),
      notes: str(r, 'notes'),
      imported: bool(r, 'imported'),
    })),
    rollout:
      rollout === null
        ? null
        : {
            version: str(rollout, 'version'),
            stage: str(rollout, 'stage'),
            trigger: str(rollout, 'trigger'),
            startedAt: str(rollout, 'startedAt'),
            finishedAt: nullableStr(rollout, 'finishedAt'),
            reason: nullableStr(rollout, 'reason'),
            canary: arr(rollout, 'canary').map((c) => ({
              workerId: str(c, 'workerId'),
              status: str(c, 'status'),
            })),
          },
    catalog: {
      enabled: bool(cat, 'enabled'),
      configured: bool(cat, 'configured'),
      error: nullableStr(cat, 'error'),
      sequence: nullableInt(cat, 'sequence'),
      generatedAt: nullableStr(cat, 'generatedAt'),
      items: arr(cat, 'items').map((i) => {
        const kind = str(i, 'kind');
        if (kind !== 'runtime' && kind !== 'tool') throw new ShapeError('expected runtime | tool');
        return { kind, item: str(i, 'item'), version: str(i, 'version'), verified: bool(i, 'verified') };
      }),
      workers: arr(cat, 'workers').map((w) => ({
        workerId: str(w, 'workerId'),
        enabled: bool(w, 'enabled'),
        keys: int(w, 'keys'),
        sequence: int(w, 'sequence'),
        lastOutcome: nullableStr(w, 'lastOutcome'),
        lastReason: nullableStr(w, 'lastReason'),
      })),
    },
  };
}

export function getUpdateChannel(opts: Opts = {}): Promise<UpdateChannelOverview> {
  return apiRequest('GET', '/update-channel', parseUpdateChannel, opts);
}

export function checkUpdateChannel(opts: Opts = {}): Promise<UpdateChannelOverview> {
  return apiRequest('POST', '/update-channel/check', parseUpdateChannel, opts);
}

export function setUpdatePolicy(
  policy: UpdatePolicy,
  soakMinutes: number,
  opts: Opts = {},
): Promise<UpdateChannelOverview> {
  return apiRequest('PUT', '/update-channel/policy', parseUpdateChannel, {
    ...opts,
    body: { policy, soakMinutes },
  });
}

export function installChannelRelease(version: string, opts: Opts = {}): Promise<UpdateChannelOverview> {
  return apiRequest(
    'POST',
    `/update-channel/releases/${encodeURIComponent(version)}/install`,
    parseUpdateChannel,
    opts,
  );
}

// ------------------------------------------------------------------ owner upgrades (p17-update-channel)

export interface OwnerUpgrade {
  readonly id: string;
  readonly kind: 'runtime' | 'tool';
  readonly item: string;
  readonly version: string;
  readonly fromVersion: string | null;
  readonly state: string;
  readonly canaryResult: string | null;
  readonly actionId: string | null;
  readonly createdAt: string;
}

function upgrade(v: unknown): OwnerUpgrade {
  const o = obj(v);
  const kind = str(o, 'kind');
  if (kind !== 'runtime' && kind !== 'tool') throw new ShapeError('expected runtime | tool');
  return {
    id: str(o, 'id'),
    kind,
    item: str(o, 'item'),
    version: str(o, 'version'),
    fromVersion: nullableStr(o, 'fromVersion'),
    state: str(o, 'state'),
    canaryResult: nullableStr(o, 'canaryResult'),
    actionId: nullableStr(o, 'actionId'),
    createdAt: str(o, 'createdAt'),
  };
}

export function listOwnerUpgrades(opts: Opts = {}): Promise<OwnerUpgrade[]> {
  return apiRequest('GET', '/owner-upgrades', (v) => arr(obj(v), 'upgrades').map(upgrade), opts);
}

export function startOwnerUpgrade(
  input: { kind: 'runtime' | 'tool'; item: string; version: string },
  opts: Opts = {},
): Promise<OwnerUpgrade> {
  return apiRequest('POST', '/owner-upgrades', upgrade, { ...opts, body: input });
}

export function confirmOwnerUpgrade(id: string, opts: Opts = {}): Promise<OwnerUpgrade> {
  return apiRequest('POST', `/owner-upgrades/${encodeURIComponent(id)}/confirm`, upgrade, opts);
}

export function rollbackOwnerUpgrade(id: string, opts: Opts = {}): Promise<OwnerUpgrade> {
  return apiRequest('POST', `/owner-upgrades/${encodeURIComponent(id)}/rollback`, upgrade, opts);
}
