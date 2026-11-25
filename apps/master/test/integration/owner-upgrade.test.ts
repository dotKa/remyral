import { RUNTIME_PINS, runtimePolicyHash, type RuntimePolicyDocument } from '@remyral/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

const PW = 'quartz-meadow-lantern-7';
const wid = (n: string) => `wrk_${n}${'a'.repeat(26)}`.slice(0, 30);
const codexPin = RUNTIME_PINS.codex.version;
const UP = codexPin.replace(/\d+$/, (n) => String(Number(n) + 6));
const integ = `sha512-${'a'.repeat(86)}==`;

/**
 * p17-update-channel (ADR-0065 §10): runtime policy pin modes (follow / hold) and the owner's upgrade of a
 * runtime / tool to an exact upstream version — canary first, then the fleet plus a new policy version, one-click
 * rollback; sources without official checksums refused.
 */
describeIntegration(
  'p17-update-channel: pin modes and owner upgrades (integration)',
  { timeout: 60_000 },
  () => {
    const h = new Harness();
    let owner: Client;
    let secret: string;
    let admin: Client;
    let adminSecret: string;
    const upstream = new Map<string, unknown>();

    const stepUp = async (c: Client, s: string) => {
      h.clock.advance(30_000);
      expect((await c.req('POST', '/auth/step-up', { code: h.code(s) })).statusCode).toBe(200);
    };
    async function worker(id: string, canary: boolean) {
      const now = h.clock.now();
      const report = {
        runtimes: [
          {
            runtime: 'codex',
            method: 'npm',
            supported: true,
            pinned: codexPin,
            available: [codexPin],
            installed: [{ version: codexPin, installedAt: now.toISOString(), integrity: 'ok' }],
            active: codexPin,
            unverifiedSupported: true,
          },
        ],
        logins: [],
        serviceRestart: false,
        logs: false,
      };
      const inventory = {
        detectedAt: now.toISOString(),
        ttlSec: 3600,
        tools: [{ name: 'cloudflared', found: true, version: '2026.10.3', source: 'managed' }],
        recipes: [
          { tool: 'cloudflared', version: '2026.10.3', elevated: false, supported: true, installed: true },
        ],
      };
      await h.db.pool.query(
        `INSERT INTO workers (id, display_name, state, facts, worker_version, features, remote_ops, tool_inventory,
                            tool_inventory_at, last_seen_at, approved_at, created_at, updated_at)
       VALUES ($1, $1, 'online', '{"os":"linux","arch":"x64"}'::jsonb, '1.2.0', $2, $3, $4, $5, $5, $5, $5, $5)`,
        [
          id,
          JSON.stringify(['remote-ops-v1', 'tools-v1', 'runtime-unverified-v1', 'version-catalog-v1']),
          JSON.stringify(report),
          JSON.stringify(inventory),
          now,
        ],
      );
      await h.db.pool
        .query(
          `INSERT INTO worker_runtimes (worker_id, runtime, version, os, arch, installed, present, pinned_version,
                                    capabilities, last_reported_at)
       VALUES ($1, 'codex', $2, 'linux', 'x64', true, true, $2, '{}'::jsonb, $3)`,
          [id, codexPin, now],
        )
        .catch(() => undefined);
      if (canary)
        await h.db.pool.query('INSERT INTO worker_runtime_policies (worker_id, canary) VALUES ($1, true)', [
          id,
        ]);
    }
    const doc = (codex: Record<string, unknown>, pi: Record<string, unknown>) => ({
      runtimes: {
        codex: {
          authModes: ['local-login'],
          allowUnpinned: false,
          modelProfiles: [],
          defaultProfile: null,
          ...codex,
        },
        pi: {
          authModes: ['local-login'],
          allowUnpinned: false,
          modelProfiles: [],
          defaultProfile: null,
          ...pi,
        },
      },
      projectProfiles: {},
    });
    const active = async () => {
      const r = await owner.req('GET', '/runtime-policies/default');
      expect(r.statusCode).toBe(200);
      return r.json<{
        activeVersion: number;
        active: {
          document: {
            runtimes: Record<string, { version: string; pin?: string; hold?: { by: string; note?: string } }>;
          };
        };
      }>();
    };

    beforeAll(async () => {
      await h.start({
        fleetTools: {
          fetch: (url) => {
            const body = upstream.get(url);
            if (body === undefined) return Promise.resolve(new Response('{}', { status: 404 }));
            return Promise.resolve(
              new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
            );
          },
        },
      });
      await h.createUser('owner1', PW);
      ({ secret } = await enroll(h, 'owner1', PW));
      owner = await fullLogin(h, 'owner1', PW, secret);
      await h.createUser('admin1', PW, 'admin');
      ({ secret: adminSecret } = await enroll(h, 'admin1', PW));
      admin = await fullLogin(h, 'admin1', PW, adminSecret);
      await worker(wid('canary'), true);
      await worker(wid('other'), false);
    });
    afterAll(async () => {
      await h.stop();
    });

    it('migrates stored rules: a former release pin follows, any other version is held (by system, with a note)', async () => {
      await stepUp(owner, secret);
      const put = await owner.req('PUT', '/runtime-policies/default', {
        document: doc({ version: '0.162.1' }, { version: '1.2.3' }),
        stage: 'all',
        expectedVersion: 0,
      });
      expect(put.statusCode).toBe(200);
      expect(await h.app.runtimePolicies.migratePinModes()).toEqual(['default']);
      const p = await active();
      expect(p.active.document.runtimes.codex).toMatchObject({ version: '0.162.1', pin: 'follow' });
      expect(p.active.document.runtimes.pi).toMatchObject({
        version: '1.2.3',
        pin: 'hold',
        hold: { by: 'system' },
      });
      expect(await h.app.runtimePolicies.migratePinModes()).toEqual([]); // idempotent
    });

    it('an owner hold records who held it', async () => {
      const before = await active();
      await stepUp(owner, secret);
      const r = await owner.req('PUT', '/runtime-policies/default', {
        document: doc({ version: codexPin, pin: 'follow' }, { version: '1.2.3', pin: 'hold' }),
        stage: 'all',
        expectedVersion: before.activeVersion,
      });
      expect(r.statusCode).toBe(200);
      expect((await active()).active.document.runtimes.pi?.hold?.by).toBe('owner1');
    });

    it('a worker without the pin modes gets the legacy document and its hash (it would refuse the stored one)', async () => {
      const id = 'wrk_legacypinmodesaaaaaaaaaaaa';
      const now = new Date();
      await h.db.pool.query(
        `INSERT INTO workers (id, display_name, state, facts, worker_version, features, last_seen_at, approved_at,
                              created_at, updated_at)
         VALUES ($1, $1, 'online', '{"os":"win32","arch":"x64"}'::jsonb, '1.1.5', $2, $3, $3, $3, $3)`,
        [id, JSON.stringify(['remote-ops-v1', 'runtime-unverified-v1']), now],
      );
      await h.app.runtimePolicies.deliver(id, { force: true });
      const row = await h.db.pool.query<{
        payload: { policy: { runtimePolicy?: { documentHash: string; document: RuntimePolicyDocument } } };
      }>(
        `SELECT payload FROM worker_outbox WHERE worker_id = $1 AND type = 'UPDATE_POLICY' ORDER BY seq DESC LIMIT 1`,
        [id],
      );
      const delivered = row.rows[0]?.payload.policy.runtimePolicy;
      expect(delivered).toBeDefined();
      for (const rule of Object.values(delivered?.document.runtimes ?? {})) {
        expect(rule).not.toHaveProperty('pin');
        expect(rule).not.toHaveProperty('hold');
      }
      if (delivered === undefined) return;
      expect(delivered.documentHash).toBe(runtimePolicyHash(delivered.document));
      expect(delivered.document.runtimes.pi?.version).toBe('1.2.3'); // the held version stays
      expect((await active()).active.document.runtimes.pi?.pin).toBe('hold'); // the stored document keeps its modes
      await h.db.pool.query('DELETE FROM worker_outbox WHERE worker_id = $1', [id]);
      await h.db.pool.query('DELETE FROM worker_runtime_policies WHERE worker_id = $1', [id]);
      await h.db.pool.query('DELETE FROM workers WHERE id = $1', [id]);
    });

    it('refuses a tool whose source publishes no checksum, and admins may not upgrade', async () => {
      await stepUp(owner, secret);
      let r = await owner.req('POST', '/owner-upgrades', { kind: 'tool', item: 'browser', version: '1250' });
      expect(r.json()).toMatchObject({ error: 'no_official_checksum' });
      r = await owner.req('POST', '/owner-upgrades', { kind: 'tool', item: 'python', version: '3.13.18' });
      expect(r.json()).toMatchObject({ error: 'no_official_checksum' });
      // A GitHub release whose assets carry no digest.
      upstream.set('https://api.github.com/repos/cloudflare/cloudflared/releases/tags/2026.11.1', {
        assets: [
          {
            browser_download_url:
              'https://github.com/cloudflare/cloudflared/releases/download/2026.11.1/cloudflared-linux-amd64',
            size: 10,
          },
        ],
      });
      r = await owner.req('POST', '/owner-upgrades', {
        kind: 'tool',
        item: 'cloudflared',
        version: '2026.11.1',
      });
      expect(r.json()).toMatchObject({ error: 'no_official_checksum' });
      await stepUp(admin, adminSecret);
      r = await admin.req('POST', '/owner-upgrades', { kind: 'runtime', item: 'codex', version: UP });
      expect(r.statusCode).toBe(403);
    });

    it('a runtime upgrade: canary first, then the fleet and a held policy version; rollback restores it', async () => {
      upstream.set(`https://registry.npmjs.org/@openai%2Fcodex/${UP}`, {
        name: '@openai/codex',
        version: UP,
        dist: { integrity: integ },
      });
      const before = await active();
      await stepUp(owner, secret);
      const r = await owner.req('POST', '/owner-upgrades', { kind: 'runtime', item: 'codex', version: UP });
      expect(r.statusCode).toBe(200);
      const up = r.json<{ id: string; actionId: string; state: string; fromVersion: string }>();
      expect(up).toMatchObject({ state: 'canary', fromVersion: codexPin });
      const targets = await h.db.pool.query<{ worker_id: string; phase: number; state: string }>(
        'SELECT worker_id, phase, state FROM fleet_tool_action_targets WHERE action_id = $1 ORDER BY phase',
        [up.actionId],
      );
      expect(targets.rows.map((t) => [t.worker_id, t.phase, t.state])).toEqual([
        [wid('canary'), 1, 'queued'],
        [wid('other'), 2, 'held'],
      ]);
      // The canary machine installed it.
      await h.db.pool.query(
        "UPDATE fleet_tool_action_targets SET state = 'succeeded' WHERE action_id = $1 AND phase = 1",
        [up.actionId],
      );
      await stepUp(owner, secret);
      const c = await owner.req('POST', `/owner-upgrades/${up.id}/confirm`);
      expect(c.statusCode).toBe(200);
      expect(c.json()).toMatchObject({ state: 'done', canaryResult: 'none' });
      const after = await active();
      expect(after.activeVersion).toBe(before.activeVersion + 1);
      expect(after.active.document.runtimes.codex).toMatchObject({
        version: UP,
        pin: 'hold',
        hold: { by: 'owner1', note: 'owner upgrade, canary not verified' },
      });
      const note = await h.db.pool.query<{ change_note: string }>(
        'SELECT change_note FROM runtime_policy_versions WHERE policy = $1 AND version = $2',
        ['default', after.activeVersion],
      );
      expect(note.rows[0]?.change_note).toContain('owner upgrade');
      const other = await h.db.pool.query<{ state: string }>(
        'SELECT state FROM fleet_tool_action_targets WHERE action_id = $1 AND phase = 2',
        [up.actionId],
      );
      expect(other.rows[0]?.state).not.toBe('held');
      // The policy-applied machine is told to run exactly this version (no allowUnpinned needed).
      const wp = await owner.req('GET', `/workers/${wid('other')}/runtime-policy`);
      expect(
        wp.json<{ runtimes: { runtime: string; pinned: string; pinMode: string }[] }>().runtimes,
      ).toContainEqual(expect.objectContaining({ runtime: 'codex', pinned: UP, pinMode: 'hold' }));

      await stepUp(owner, secret);
      const rb = await owner.req('POST', `/owner-upgrades/${up.id}/rollback`);
      expect(rb.statusCode).toBe(200);
      expect(rb.json()).toMatchObject({ state: 'rolled_back' });
      expect((await active()).activeVersion).toBe(before.activeVersion);
      const audit = await h.db.pool.query(
        "SELECT action FROM audit_events WHERE action LIKE 'owner_upgrade.%' ORDER BY id",
      );
      expect(audit.rows.map((x: { action: string }) => x.action)).toEqual([
        'owner_upgrade.start',
        'owner_upgrade.confirm',
        'owner_upgrade.rollback',
      ]);
    });

    it('a tool upgrade carries the published asset to the machines (canary first)', async () => {
      const url =
        'https://github.com/cloudflare/cloudflared/releases/download/2026.11.0/cloudflared-linux-amd64';
      upstream.set('https://api.github.com/repos/cloudflare/cloudflared/releases/tags/2026.11.0', {
        assets: [{ browser_download_url: url, size: 1234, digest: `sha256:${'c'.repeat(64)}` }],
      });
      await stepUp(owner, secret);
      const r = await owner.req('POST', '/owner-upgrades', {
        kind: 'tool',
        item: 'cloudflared',
        version: '2026.11.0',
      });
      expect(r.statusCode).toBe(200);
      const up = r.json<{ actionId: string }>();
      const a = await h.db.pool.query<{ recipe: { ownerTool: { assets: Record<string, unknown> } } }>(
        'SELECT recipe FROM fleet_tool_actions WHERE id = $1',
        [up.actionId],
      );
      expect(a.rows[0]?.recipe.ownerTool.assets['linux-x64']).toEqual({
        url,
        sha256: 'c'.repeat(64),
        size: 1234,
      });
    });
  },
);
