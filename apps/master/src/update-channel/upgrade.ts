import { randomUUID } from 'node:crypto';
import {
  CatalogTool,
  effectiveRuntimeCatalog,
  RUNTIME_PINS,
  RuntimeKind,
  type RuntimePolicyDocument,
  RuntimeVersion,
  ToolPlatform,
  toolAssetUrl,
  toolVersionValid,
  type VersionCatalog,
} from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import type { Pool } from '../db/pool.js';
import type { RuntimeReleases } from '../fleet-tools/releases.js';
import type { FleetToolsService, OwnerToolSource } from '../fleet-tools/service.js';
import { HttpError } from '../http/errors.js';
import {
  DEFAULT_POLICY,
  type RuntimePolicyService,
  runtimePolicyTemplate,
} from '../runtime-policy/service.js';
import type { ActorContext } from '../workers/fleet.js';

/**
 * p17-update-channel (ADR-0065 §10): the owner upgrades one runtime or tool to an exact
 * upstream version — also newer than the catalog — without a worker release:
 *
 * 1. the master resolves the exact version and its integrity from the fixed official source (npm `dist.integrity` of
 *    the release's own package; GitHub release assets with their published SHA-256 digest) — never `latest` or a
 *    range, never a version whose integrity the source does not publish (Python's NuGet package publishes SHA-512 only,
 *    the Playwright CDN publishes none, Node's signed SHASUMS need gpg, which the master image does not carry: refused
 *    `no_official_checksum`; those come through the version catalog, where the vendor hashes them);
 * 2. a canary-first fleet action installs it (runtimes: the p16 unverified install path plus `runtime.verify` on a
 *    canary; tools: the published asset, re-checked by the worker against the fixed template and the checksum);
 * 3. on the owner's confirmation the rest of the fleet follows and every runtime policy gets a new version for that
 *    runtime — `hold` at that version (`follow` when it is the catalog's verified pin), change note
 *    "owner upgrade, canary passed / failed", audited — so machines under a policy accept it without `allowUnpinned`;
 * 4. rollback restores each policy's previous version and installs the previous version again.
 */

const GITHUB: Readonly<Partial<Record<CatalogTool, { repo: string; tag: (v: string) => string }>>> = {
  git: {
    repo: 'git-for-windows/git',
    tag: (v) => {
      const p = v.split('.');
      return `v${p.slice(0, 3).join('.')}.windows.${p[3] ?? '1'}`;
    },
  },
  uv: { repo: 'astral-sh/uv', tag: (v) => v },
  cloudflared: { repo: 'cloudflare/cloudflared', tag: (v) => v },
  ffmpeg: { repo: 'GyanD/codexffmpeg', tag: (v) => v },
};

export interface OwnerUpgradeView {
  readonly id: string;
  readonly kind: 'runtime' | 'tool';
  readonly item: string;
  readonly version: string;
  readonly fromVersion: string | null;
  readonly state: string;
  readonly canaryResult: string | null;
  readonly actionId: string | null;
  readonly policies: Readonly<Record<string, { before: number | null; after: number }>>;
  readonly createdAt: string;
}

interface Row {
  id: string;
  kind: 'runtime' | 'tool';
  item: string;
  version: string;
  from_version: string | null;
  state: string;
  canary_result: string | null;
  action_id: string | null;
  policies: Record<string, { before: number | null; after: number }>;
  created_at: Date;
}

const view = (r: Row): OwnerUpgradeView => ({
  id: r.id,
  kind: r.kind,
  item: r.item,
  version: r.version,
  fromVersion: r.from_version,
  state: r.state,
  canaryResult: r.canary_result,
  actionId: r.action_id,
  policies: r.policies,
  createdAt: r.created_at.toISOString(),
});

export interface OwnerUpgradeDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  readonly fleet: () => FleetToolsService | null;
  readonly policies: () => RuntimePolicyService | null;
  readonly releases: () => RuntimeReleases | null;
  /** The version feed's bounded JSON reader (VERSION_FEED_HOSTS, https, no redirects); null: feeds off. */
  readonly getJson: (() => ((url: string) => Promise<unknown>) | null) | null;
  readonly catalog: () => VersionCatalog | null;
}

function refuse(code: string, message: string, params: Record<string, string> = {}): HttpError {
  return new HttpError(409, code, message, {}, {}, params);
}

export class OwnerUpgradeService {
  constructor(private readonly d: OwnerUpgradeDeps) {}

  /** A tool's published assets for `version` (GitHub release digests); refused when the source publishes none. */
  async resolveTool(tool: CatalogTool, version: string): Promise<OwnerToolSource> {
    if (!toolVersionValid(tool, version, undefined))
      throw new HttpError(400, 'version_invalid', 'Not an exact version of this tool.', {}, {}, { version });
    const gh = GITHUB[tool];
    if (gh === undefined) {
      throw refuse(
        'no_official_checksum',
        `${tool} publishes no checksum the master can verify for a single version; it comes through the version catalog.`,
        { item: tool },
      );
    }
    const getJson = this.d.getJson?.() ?? null;
    if (getJson === null)
      throw refuse('feed_disabled', 'This master reads no upstream source (FLEET_TOOLS_FEED=off).');
    let rel: unknown;
    try {
      rel = await getJson(
        `https://api.github.com/repos/${gh.repo}/releases/tags/${encodeURIComponent(gh.tag(version))}`,
      );
    } catch {
      throw new HttpError(
        502,
        'tool_release_unreadable',
        `The ${tool} ${version} release could not be read.`,
        {},
        {},
        {
          item: tool,
          version,
        },
      );
    }
    const list = (rel as { assets?: unknown }).assets;
    const assets: Partial<Record<ToolPlatform, { url: string; sha256: string; size: number }>> = {};
    for (const p of ToolPlatform.options) {
      const url = toolAssetUrl(tool, p, version);
      if (url === null || !Array.isArray(list)) continue;
      const a = (list as { browser_download_url?: unknown; digest?: unknown; size?: unknown }[]).find(
        (x) => x.browser_download_url === url,
      );
      const digest =
        typeof a?.digest === 'string' ? /^sha256:([0-9a-f]{64})$/.exec(a.digest)?.[1] : undefined;
      if (a === undefined || digest === undefined || typeof a.size !== 'number' || a.size < 1) continue;
      assets[p] = { url, sha256: digest, size: a.size };
    }
    if (Object.keys(assets).length === 0) {
      throw refuse(
        'no_official_checksum',
        `The ${tool} ${version} release publishes no checksum for its assets; refused.`,
        { item: tool, version },
      );
    }
    return { assets };
  }

  async list(): Promise<OwnerUpgradeView[]> {
    const { rows } = await this.d.pool.query<Row>(
      'SELECT * FROM owner_upgrades ORDER BY created_at DESC LIMIT 20',
    );
    return rows.map(view);
  }

  async #row(id: string): Promise<Row> {
    const { rows } = await this.d.pool.query<Row>('SELECT * FROM owner_upgrades WHERE id = $1', [id]);
    const r = rows[0];
    if (r === undefined) throw new HttpError(404, 'not_found', 'Not found.');
    return r;
  }

  #fleet(): FleetToolsService {
    const f = this.d.fleet();
    if (f === null)
      throw new HttpError(
        503,
        'unavailable',
        'The fleet tools service is not available.',
        {},
        {},
        { reason: 'fleet' },
      );
    return f;
  }

  /** Resolves the source and starts the canary-first install. */
  async start(
    input: { kind: 'runtime' | 'tool'; item: string; version: string },
    actor: ActorContext,
  ): Promise<OwnerUpgradeView> {
    const fleet = this.#fleet();
    const fleetView = await fleet.view();
    const id = randomUUID();
    let source: Record<string, unknown>;
    let actionId: string;
    let fromVersion: string | null;
    if (input.kind === 'runtime') {
      const runtime = RuntimeKind.safeParse(input.item);
      if (!runtime.success)
        throw new HttpError(400, 'item_invalid', 'Not a runtime.', {}, {}, { item: input.item });
      if (!RuntimeVersion.safeParse(input.version).success)
        throw new HttpError(
          400,
          'version_invalid',
          'Not an exact version.',
          {},
          {},
          { version: input.version },
        );
      const releases = this.d.releases();
      if (releases === null)
        throw refuse('feed_disabled', 'This master reads no package registry (FLEET_TOOLS_FEED=off).');
      // The exact version document and its registry integrity (never `latest`, never a range).
      const c = await releases.resolve(runtime.data, input.version);
      source = { package: c.package, packageVersion: c.packageVersion, integrity: c.integrity };
      fromVersion =
        fleetView.catalog.find((x) => x.id === input.item)?.pinned ?? RUNTIME_PINS[runtime.data].version;
      const action = await fleet.create(
        {
          kind: 'runtime.install',
          item: runtime.data,
          version: input.version,
          unverified: true,
          ownerUpgrade: true,
          workers: 'all',
          rollout: 'canary-first',
        },
        false,
        actor,
      );
      actionId = action.id;
      // The automatable verification on a canary (verified / unverified label); best effort.
      await fleet.verifyRuntimeNow(runtime.data, input.version, actor).catch((err: unknown) => {
        this.d.log.warn({ err, runtime: runtime.data }, 'owner upgrade: runtime verification not started');
      });
    } else {
      const tool = CatalogTool.safeParse(input.item);
      if (!tool.success || tool.data === 'node' || tool.data === 'browser' || tool.data === 'python') {
        throw refuse(
          'no_official_checksum',
          `${input.item} cannot be upgraded on demand: its source publishes no usable checksum; use the version catalog.`,
          { item: input.item },
        );
      }
      const src = await this.resolveTool(tool.data, input.version);
      source = { assets: src.assets };
      fromVersion = fleetView.catalog.find((x) => x.id === input.item)?.pinned ?? null;
      const action = await fleet.create(
        {
          kind: 'tool.install',
          item: tool.data,
          version: input.version,
          ownerUpgrade: true,
          toolSource: src,
          workers: 'all',
          rollout: 'canary-first',
        },
        false,
        actor,
      );
      actionId = action.id;
    }
    const now = this.d.clock();
    await this.d.pool.query(
      `INSERT INTO owner_upgrades (id, kind, item, version, from_version, source, action_id, state, created_by,
                                   created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'canary', $8, $9, $9)`,
      [
        id,
        input.kind,
        input.item,
        input.version,
        fromVersion,
        JSON.stringify(source),
        actionId,
        actor.userId,
        now,
      ],
    );
    await this.d.audit.record({
      actor: { type: 'user', id: actor.userId },
      ip: actor.ip,
      userAgent: actor.userAgent,
      action: 'owner_upgrade.start',
      outcome: 'success',
      target: `${input.kind}:${input.item}`,
      metadata: { id, version: input.version, fromVersion, actionId },
    });
    return view(await this.#row(id));
  }

  async #username(userId: string): Promise<string> {
    const { rows } = await this.d.pool.query<{ username: string }>(
      'SELECT username FROM users WHERE id = $1',
      [userId],
    );
    return rows[0]?.username ?? userId.slice(0, 64);
  }

  async #canaryResult(r: Row): Promise<'passed' | 'failed' | 'none'> {
    if (r.kind === 'runtime') {
      const { rows } = await this.d.pool.query<{ verify_state: string }>(
        'SELECT verify_state FROM runtime_candidates WHERE runtime = $1 AND version = $2',
        [r.item, r.version],
      );
      const s = rows[0]?.verify_state;
      return s === 'passed' ? 'passed' : s === 'failed' ? 'failed' : 'none';
    }
    if (r.action_id === null) return 'none';
    const { rows } = await this.d.pool.query<{ state: string }>(
      'SELECT state FROM fleet_tool_action_targets WHERE action_id = $1 AND phase = 1',
      [r.action_id],
    );
    if (rows.some((x) => x.state === 'failed')) return 'failed';
    return rows.some((x) => x.state === 'succeeded') ? 'passed' : 'none';
  }

  /**
   * The owner confirms after the canary: the rest of the fleet follows (refused while the canary runs or after it
   * failed — the fleet action's own rule), and for a runtime every policy gets a new version holding (or following)
   * the upgraded version.
   */
  async confirm(id: string, actor: ActorContext): Promise<OwnerUpgradeView> {
    const r = await this.#row(id);
    if (r.state !== 'canary') throw refuse('upgrade_not_open', 'This upgrade is not waiting for that step.');
    if (r.action_id !== null) {
      const held = await this.d.pool.query(
        "SELECT 1 FROM fleet_tool_action_targets WHERE action_id = $1 AND state = 'held'",
        [r.action_id],
      );
      if ((held.rowCount ?? 0) > 0) await this.#fleet().continue(r.action_id, actor);
    }
    const result = await this.#canaryResult(r);
    const policies: Record<string, { before: number | null; after: number }> = {};
    if (r.kind === 'runtime') {
      const svc = this.d.policies();
      if (svc === null)
        throw new HttpError(
          503,
          'unavailable',
          'Runtime policies are not available.',
          {},
          {},
          { reason: 'runtime_policies' },
        );
      const runtime = RuntimeKind.parse(r.item);
      const catalogPin = effectiveRuntimeCatalog(this.d.catalog(), runtime, RUNTIME_PINS[runtime].version)
        .pinned?.version;
      const follow = r.version === catalogPin;
      const by = await this.#username(actor.userId);
      const at = this.d.clock().toISOString();
      const note = `owner upgrade, canary ${result === 'passed' ? 'passed' : result === 'failed' ? 'failed' : 'not verified'}`;
      const list = await svc.list();
      const targets =
        list.length === 0 ? [{ name: DEFAULT_POLICY, active: null, activeVersion: null }] : list;
      for (const p of targets) {
        const base: RuntimePolicyDocument = p.active?.document ?? runtimePolicyTemplate();
        const rule = base.runtimes[runtime] ?? runtimePolicyTemplate().runtimes[runtime];
        if (rule === undefined) continue;
        const document: RuntimePolicyDocument = {
          ...base,
          runtimes: {
            ...base.runtimes,
            [runtime]: follow
              ? { ...rule, version: r.version, pin: 'follow' as const }
              : { ...rule, version: r.version, pin: 'hold' as const, hold: { by, at, note } },
          },
        };
        const versions = list.length === 0 ? [] : await svc.versions(p.name);
        const latest = versions.reduce((m, v) => Math.max(m, v.version), 0);
        const saved = await svc.put(
          p.name,
          { document, stage: 'all', expectedVersion: latest, changeNote: `${note} (${r.item} ${r.version})` },
          actor,
        );
        policies[p.name] = { before: p.activeVersion, after: saved.activeVersion ?? latest + 1 };
      }
    }
    await this.d.pool.query(
      `UPDATE owner_upgrades SET state = 'done', canary_result = $2, policies = $3, updated_at = $4 WHERE id = $1`,
      [id, result, JSON.stringify(policies), this.d.clock()],
    );
    await this.d.audit.record({
      actor: { type: 'user', id: actor.userId },
      ip: actor.ip,
      userAgent: actor.userAgent,
      action: 'owner_upgrade.confirm',
      outcome: 'success',
      target: `${r.kind}:${r.item}`,
      metadata: { id, version: r.version, canary: result, policies },
    });
    return view(await this.#row(id));
  }

  /** One click back: each policy's previous version, and the previous version installed again. */
  async rollback(id: string, actor: ActorContext): Promise<OwnerUpgradeView> {
    const r = await this.#row(id);
    if (r.state !== 'done' && r.state !== 'canary')
      throw refuse('upgrade_not_open', 'This upgrade is not waiting for that step.');
    const svc = this.d.policies();
    for (const [name, p] of Object.entries(r.policies)) {
      if (svc === null || p.before === null) continue;
      await svc
        .rollback(
          name,
          { toVersion: p.before, reason: `owner upgrade ${r.item} ${r.version} rolled back` },
          actor,
        )
        .catch((err: unknown) => {
          if (!(err instanceof HttpError && err.code === 'already_active')) throw err;
        });
    }
    if (r.action_id !== null && r.state === 'canary')
      await this.#fleet()
        .cancel(r.action_id, actor)
        .catch(() => undefined);
    let rollbackAction: string | null = null;
    if (r.from_version !== null) {
      const a = await this.#fleet()
        .create(
          {
            kind: r.kind === 'runtime' ? 'runtime.install' : 'tool.install',
            item: r.item,
            version: r.from_version,
            workers: 'all',
            rollout: 'all',
          },
          false,
          actor,
        )
        .catch((err: unknown) => {
          // Nothing to do anywhere (no machine took the upgrade): the policy rollback is enough.
          if (err instanceof HttpError && err.code === 'nothing_to_do') return null;
          throw err;
        });
      rollbackAction = a?.id ?? null;
    }
    await this.d.pool.query(
      `UPDATE owner_upgrades SET state = 'rolled_back', rollback_action_id = $2, updated_at = $3 WHERE id = $1`,
      [id, rollbackAction, this.d.clock()],
    );
    await this.d.audit.record({
      actor: { type: 'user', id: actor.userId },
      ip: actor.ip,
      userAgent: actor.userAgent,
      action: 'owner_upgrade.rollback',
      outcome: 'success',
      target: `${r.kind}:${r.item}`,
      metadata: { id, version: r.version, to: r.from_version, policies: r.policies },
    });
    return view(await this.#row(id));
  }
}
