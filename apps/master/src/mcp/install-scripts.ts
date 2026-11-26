import { randomUUID } from 'node:crypto';
import {
  MAX_INSTALL_SCRIPT_APPROVALS,
  MCP_PACKAGE_HOSTS,
  NPM_PACKAGE_NAME,
  NPM_SHA512_INTEGRITY,
  type NpmScriptApproval,
} from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { McpFetch } from './stdio.js';

/**
 * p19-install-scripts (ADR-0068, docs/design/p19-install-scripts.md): npm install scripts an admin reviewed and approved
 * for the whole platform. Dependencies must be reviewable and approvable: a local MCP server whose
 * dependency needs its install script (frida downloads its native binding) no longer stops for good — the master shows
 * what the script is and where it comes from, an admin approves exactly that version and tarball with an authenticator
 * code, and the machines run that script (and no other) when they install.
 *
 * The master **never runs or downloads** a package: the evaluation reads the registry's JSON for one exact version
 * (`registry.npmjs.org`, no redirects, bounded) — the lifecycle scripts' text, `dist.integrity`, registry signatures,
 * the provenance attestation, the publisher (trusted publishing), maintainers, repository, `gypfile` — and the hosts
 * the scripts' text names. It is stored with the approval (what the reviewer saw). An approval is exact (name, version,
 * integrity): another version or a re-published tarball needs its own. Revoking stops new installs from running it;
 * what is installed stays until it is removed or installed again.
 */

export interface InstallScriptEvaluation {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  /** npm runs these (in this order) — the text as published (bounded). */
  readonly scripts: {
    readonly preinstall?: string;
    readonly install?: string;
    readonly postinstall?: string;
  };
  /** A `binding.gyp` without an own install script: npm runs `node-gyp rebuild` (a native build). */
  readonly gypfile: boolean;
  readonly hasInstallScript: boolean;
  /** Hosts named in the scripts' text (where they may download from; the files the scripts run may name more). */
  readonly hosts: string[];
  readonly publisher: string | null;
  /** Published by a CI through npm trusted publishing (OIDC), not by a person's token. */
  readonly trustedPublisher: boolean;
  readonly maintainers: string[];
  /** Registry signatures of the tarball (npm signs every package it serves). */
  readonly signatures: number;
  /** A SLSA provenance attestation links the tarball to a source commit and a build. */
  readonly provenance: boolean;
  readonly repository: string | null;
  readonly license: string | null;
  readonly description: string | null;
  readonly dependencies: number;
  readonly unpackedSize: number | null;
  readonly publishedAt: string | null;
  readonly evaluatedAt: string;
}

export interface InstallScriptApprovalView {
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

export interface InstallScriptActor {
  readonly userId: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface InstallScriptDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  /** Registry fetch (tests); default the global fetch. */
  readonly fetch?: McpFetch | null;
}

const LOOKUP_TIMEOUT_MS = 15_000;
const MAX_VERSION_BYTES = 1024 * 1024;
const MAX_PACKUMENT_BYTES = 8 * 1024 * 1024;
const EVALUATIONS_PER_MINUTE = 30;
const SCRIPT_TEXT_MAX = 2000;
const EXACT_VERSION = /^[0-9][0-9A-Za-z.+-]{0,63}$/;
const LIFECYCLE = ['preinstall', 'install', 'postinstall'] as const;

const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null;
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Hosts named by `http(s)://` URLs in a text (deduplicated, at most 20). */
export function hostsIn(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/https?:\/\/([A-Za-z0-9.-]{1,253})(?::\d{1,5})?/g)) {
    const h = m[1]?.toLowerCase().replace(/\.$/, '');
    if (h !== undefined && h.includes('.')) out.add(h);
    if (out.size >= 20) break;
  }
  return [...out].sort();
}

/**
 * The evaluation of one version document of the npm registry (`GET /<name>/<version>`), or null when it is not that
 * version or has no sha512 integrity. `publishedAt` comes from the full document's `time` (absent: null).
 */
export function evaluationOf(
  body: unknown,
  input: { readonly name: string; readonly version: string },
  publishedAt: string | null,
  now: Date,
): InstallScriptEvaluation | null {
  const b = obj(body);
  if (b.name !== input.name || b.version !== input.version) return null;
  const dist = obj(b.dist);
  const integrity = typeof dist.integrity === 'string' ? dist.integrity : '';
  if (!NPM_SHA512_INTEGRITY.test(integrity)) return null;
  const rawScripts = obj(b.scripts);
  const scripts: Record<string, string> = {};
  for (const k of LIFECYCLE) {
    const s = text(rawScripts[k], SCRIPT_TEXT_MAX);
    if (s !== null) scripts[k] = s;
  }
  const gypfile = b.gypfile === true;
  const npmUser = obj(b._npmUser);
  const repo = b.repository;
  const repository =
    typeof repo === 'string' ? text(repo, 300) : (text(obj(repo).url, 300)?.replace(/^git\+/, '') ?? null);
  const maintainers = Array.isArray(b.maintainers)
    ? b.maintainers
        .map((m) => text(obj(m).name, 100))
        .filter((m): m is string => m !== null)
        .slice(0, 10)
    : [];
  const attestations = obj(dist.attestations);
  return {
    name: input.name,
    version: input.version,
    integrity,
    scripts,
    gypfile,
    hasInstallScript: Object.keys(scripts).length > 0 || gypfile || b.hasInstallScript === true,
    hosts: hostsIn(Object.values(scripts).join('\n')),
    publisher: text(npmUser.name, 100),
    trustedPublisher: typeof npmUser.trustedPublisher === 'object' && npmUser.trustedPublisher !== null,
    maintainers,
    signatures: Array.isArray(dist.signatures) ? dist.signatures.length : 0,
    provenance: obj(attestations.provenance).predicateType !== undefined,
    repository,
    license: text(b.license, 100),
    description: text(b.description, 300),
    dependencies: Object.keys(obj(b.dependencies)).length,
    unpackedSize: typeof dist.unpackedSize === 'number' ? dist.unpackedSize : null,
    publishedAt,
    evaluatedAt: now.toISOString(),
  };
}

interface Row {
  id: string;
  name: string;
  version: string;
  integrity: string;
  evaluation: InstallScriptEvaluation | Record<string, never>;
  reason: string | null;
  via: 'console' | 'chat';
  approved_by_name: string | null;
  approved_at: Date;
  revoked_by_name: string | null;
  revoked_at: Date | null;
}

const COLS = `a.id, a.name, a.version, a.integrity, a.evaluation, a.reason, a.via, a.approved_at, a.revoked_at,
  ua.username AS approved_by_name, ur.username AS revoked_by_name`;
const FROM = `npm_install_script_approvals a LEFT JOIN users ua ON ua.id = a.approved_by
  LEFT JOIN users ur ON ur.id = a.revoked_by`;

function view(r: Row): InstallScriptApprovalView {
  const e = r.evaluation as Partial<InstallScriptEvaluation>;
  return {
    id: r.id,
    name: r.name,
    version: r.version,
    integrity: r.integrity,
    evaluation: typeof e.name === 'string' ? (e as InstallScriptEvaluation) : null,
    reason: r.reason,
    via: r.via,
    approvedBy: r.approved_by_name,
    approvedAt: r.approved_at.toISOString(),
    revokedBy: r.revoked_by_name,
    revokedAt: r.revoked_at === null ? null : r.revoked_at.toISOString(),
  };
}

export class InstallScriptApprovals {
  readonly #evaluations = new Map<string, number[]>();

  constructor(private readonly d: InstallScriptDeps) {}

  /** Registry metadata and the scripts of one exact npm version (the review; nothing is downloaded or run). */
  async evaluate(
    userId: string,
    input: { readonly name: string; readonly version: string },
  ): Promise<InstallScriptEvaluation> {
    const now = this.d.clock();
    const recent = (this.#evaluations.get(userId) ?? []).filter((t) => now.getTime() - t < 60_000);
    if (recent.length >= EVALUATIONS_PER_MINUTE) {
      throw new HttpError(
        429,
        'rate_limited',
        'Too many package evaluations; try again in a minute.',
        { 'retry-after': '60' },
        {},
        { reason: 'install_scripts' },
      );
    }
    this.#evaluations.set(userId, [...recent, now.getTime()]);
    if (!NPM_PACKAGE_NAME.test(input.name) || input.name.length > 214 || !EXACT_VERSION.test(input.version)) {
      throw new HttpError(
        422,
        'install_script_package_invalid',
        'The npm package name or version is invalid (an exact version is needed).',
      );
    }
    const base = `https://${MCP_PACKAGE_HOSTS.npm[0] ?? 'registry.npmjs.org'}/${input.name.replaceAll('/', '%2f')}`;
    const body = await this.#get(`${base}/${encodeURIComponent(input.version)}`, MAX_VERSION_BYTES, input);
    // The publish time is only in the full document; a too large one (thousands of versions) leaves it unknown.
    let publishedAt: string | null = null;
    try {
      const full = await this.#get(base, MAX_PACKUMENT_BYTES, input);
      const t = obj(obj(full).time)[input.version];
      publishedAt = typeof t === 'string' && !Number.isNaN(Date.parse(t)) ? new Date(t).toISOString() : null;
    } catch {
      // unknown publish time
    }
    const e = evaluationOf(body, input, publishedAt, now);
    if (e === null) {
      throw new HttpError(
        422,
        'install_script_package_invalid',
        'The registry answer has no sha512 integrity for this version.',
        {},
        {},
        { reason: 'registry' },
      );
    }
    return e;
  }

  async #get(
    url: string,
    max: number,
    input: { readonly name: string; readonly version: string },
  ): Promise<unknown> {
    const fetch: McpFetch = this.d.fetch ?? ((u, i) => globalThis.fetch(u, i));
    const signal = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal,
        redirect: 'error',
        headers: { accept: 'application/json' },
        credentials: 'omit',
      });
      if (res.status === 404) {
        throw new HttpError(
          404,
          'install_script_package_not_found',
          `${input.name}@${input.version} is not on npm.`,
          {},
          {},
          { name: input.name, version: input.version },
        );
      }
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
      if (Number(res.headers.get('content-length') ?? '0') > max) throw new Error('too large');
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.byteLength > max) throw new Error('too large');
      return JSON.parse(bytes.toString('utf8')) as unknown;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(
        502,
        'install_script_registry_unavailable',
        'The npm registry did not answer; try again later.',
      );
    }
  }

  /**
   * Approves the install script of exactly `name@version` (the registry's current tarball; `integrity`, when given,
   * must be that tarball's). Idempotent: an active approval of the same tarball is returned as it is.
   */
  async approve(
    actor: InstallScriptActor,
    input: {
      readonly name: string;
      readonly version: string;
      readonly integrity?: string | undefined;
      readonly reason?: string | undefined;
    },
    via: 'console' | 'chat',
  ): Promise<InstallScriptApprovalView> {
    const e = await this.evaluate(actor.userId, input);
    if (input.integrity !== undefined && input.integrity !== e.integrity) {
      throw new HttpError(
        409,
        'install_script_integrity_mismatch',
        `The registry tarball of ${e.name}@${e.version} is not the one named (its integrity differs).`,
        {},
        {},
        { name: e.name, version: e.version },
      );
    }
    if (!e.hasInstallScript) {
      throw new HttpError(
        422,
        'install_script_none',
        `${e.name}@${e.version} has no install script; nothing to approve.`,
        {},
        {},
        { name: e.name, version: e.version },
      );
    }
    const now = this.d.clock();
    const reason = input.reason?.trim().slice(0, 500) ?? null;
    const ins = await this.d.pool.query<{ id: string }>(
      `INSERT INTO npm_install_script_approvals (id, name, version, integrity, evaluation, reason, via, approved_by,
         approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (name, version, integrity) WHERE revoked_at IS NULL DO NOTHING RETURNING id`,
      [
        randomUUID(),
        e.name,
        e.version,
        e.integrity,
        JSON.stringify(e),
        reason === '' ? null : reason,
        via,
        actor.userId,
        now,
      ],
    );
    const created = ins.rows[0]?.id;
    if (created !== undefined) {
      await this.d.audit.record({
        actor: { type: 'user', id: actor.userId },
        action: 'mcp.install_script.approve',
        target: `npm:${e.name}@${e.version}`,
        outcome: 'success',
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        metadata: {
          approvalId: created,
          name: e.name,
          version: e.version,
          integrity: e.integrity,
          scripts: Object.keys(e.scripts),
          gypfile: e.gypfile,
          hosts: e.hosts,
          provenance: e.provenance,
          trustedPublisher: e.trustedPublisher,
          via,
        },
      });
    }
    const { rows } = await this.d.pool.query<Row>(
      `SELECT ${COLS} FROM ${FROM} WHERE a.name = $1 AND a.version = $2 AND a.integrity = $3 AND a.revoked_at IS NULL`,
      [e.name, e.version, e.integrity],
    );
    const r = rows[0];
    if (r === undefined) throw new Error('approval vanished');
    return view(r);
  }

  /** Revokes an active approval (never asks for a code: it only takes a permission away). */
  async revoke(actor: InstallScriptActor, id: string): Promise<InstallScriptApprovalView> {
    const now = this.d.clock();
    const { rows } = await this.d.pool.query<{ name: string; version: string; integrity: string }>(
      `UPDATE npm_install_script_approvals SET revoked_at = $2, revoked_by = $3
        WHERE id = $1 AND revoked_at IS NULL RETURNING name, version, integrity`,
      [id, now, actor.userId],
    );
    const r = rows[0];
    if (r === undefined) {
      throw new HttpError(404, 'install_script_approval_not_found', 'No active approval with this id.');
    }
    await this.d.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'mcp.install_script.revoke',
      target: `npm:${r.name}@${r.version}`,
      outcome: 'success',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: { approvalId: id, name: r.name, version: r.version, integrity: r.integrity },
    });
    const out = await this.d.pool.query<Row>(`SELECT ${COLS} FROM ${FROM} WHERE a.id = $1`, [id]);
    const v = out.rows[0];
    if (v === undefined) throw new Error('approval vanished');
    return view(v);
  }

  /** The active approvals, then the most recently revoked ones (at most 200 in all). */
  async list(): Promise<InstallScriptApprovalView[]> {
    const { rows } = await this.d.pool.query<Row>(
      `SELECT ${COLS} FROM ${FROM}
        ORDER BY (a.revoked_at IS NULL) DESC, coalesce(a.revoked_at, a.approved_at) DESC, a.name, a.version
        LIMIT 200`,
    );
    return rows.map(view);
  }

  /** What an `mcp.install` carries: the active approvals (newest first, at most MAX_INSTALL_SCRIPT_APPROVALS). */
  async active(): Promise<NpmScriptApproval[]> {
    const { rows } = await this.d.pool.query<NpmScriptApproval>(
      `SELECT name, version, integrity FROM npm_install_script_approvals WHERE revoked_at IS NULL
        ORDER BY approved_at DESC LIMIT ${String(MAX_INSTALL_SCRIPT_APPROVALS)}`,
    );
    return rows.map((r) => ({ name: r.name, version: r.version, integrity: r.integrity }));
  }
}

/**
 * p19-install-scripts: runs a confirmed `install_script_approval` card for the confirming user (the draft executor
 * checked `mcp.scripts` and the always-fresh code). Each package is approved as `POST /mcp/install-scripts`
 * would (evaluated again now; the card's integrity must still be the registry's).
 */
export class InstallScriptCardRunner {
  constructor(private readonly approvals: () => InstallScriptApprovals | null) {}

  async run(
    ctx: {
      readonly subject: { readonly userId: string };
      readonly actor: { readonly ip: string; readonly userAgent?: string | null };
    },
    d: { readonly payload: Record<string, unknown> },
  ): Promise<Record<string, unknown>> {
    const svc = this.approvals();
    if (svc === null)
      throw new HttpError(
        503,
        'unavailable',
        'Install script approvals are not available.',
        {},
        {},
        { reason: 'install_scripts' },
      );
    const packages = (Array.isArray(d.payload.packages) ? d.payload.packages : []) as NpmScriptApproval[];
    const reason = typeof d.payload.reason === 'string' ? d.payload.reason : undefined;
    const approved: { id: string; package: string }[] = [];
    for (const p of packages) {
      const v = await svc.approve(
        { userId: ctx.subject.userId, ip: ctx.actor.ip, userAgent: ctx.actor.userAgent ?? null },
        { name: p.name, version: p.version, integrity: p.integrity, reason },
        'chat',
      );
      approved.push({ id: v.id, package: `${v.name}@${v.version}` });
    }
    return {
      op: 'install_script_approval',
      approved,
      link: '/settings/security?tab=scripts',
      next: 'Retry the failed MCP install (its machines now run these scripts).',
    };
  }
}
