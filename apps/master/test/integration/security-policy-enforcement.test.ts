import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p15-autonomy (ADR-0056, docs/design/p15-autonomy.md): the master enforces the stored security policy — per-event
 * authenticator codes (each preset), the step-up window, autonomy defaults of new projects, the audited change path,
 * RBAC of the settings and the migration default (Dengeli on a fresh install, migration 0221).
 */
const PW = 'amber-falcon-river-31';
const MIN = 60_000;

describeIntegration('security policy enforcement (integration, p15-autonomy)', { timeout: 180_000 }, () => {
  const h = new Harness();
  let owner: Client;
  let ownerSecret = '';
  let ownerId = '';
  let opSecret = '';
  let projects = 0;

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    const r = await owner.req('POST', '/auth/step-up', { code: h.code(ownerSecret) });
    expect(r.statusCode, r.body).toBe(200);
  }
  /** A stale step-up: the last code is older than `minutes` (session kept alive below its idle timeout). */
  async function age(minutes: number): Promise<void> {
    for (let left = minutes; left > 0; left -= 10) {
      h.clock.advance(Math.min(10, left) * MIN);
      expect((await owner.req('GET', '/auth/session')).statusCode).toBe(200);
    }
  }
  const newProject = () => {
    projects += 1;
    return owner.req('POST', '/projects', { id: `sp-${String(projects)}`, name: `SP ${String(projects)}` });
  };
  const roleChange = (id: string) => owner.req('PUT', `/users/${id}/role`, { role: 'viewer' });

  beforeAll(async () => {
    await h.start();
    ownerId = await h.createUser('owner.sp', PW, 'owner');
    ({ secret: ownerSecret } = await enroll(h, 'owner.sp', PW));
    owner = await fullLogin(h, 'owner.sp', PW, ownerSecret);
    await h.createUser('op.sp', PW, 'operator');
    ({ secret: opSecret } = await enroll(h, 'op.sp', PW));
  });
  afterAll(async () => {
    await h.stop();
  });

  it('migrations 0118 / 0126 seed Serbest; 0221 starts a fresh installation on Dengeli', async () => {
    const { rows } = await h.db.pool.query<{ document: unknown; version: number }>(
      'SELECT document, version FROM security_policy_versions ORDER BY version',
    );
    expect(rows[0]?.document).toEqual({ preset: 'serbest' });
    // p15-auto-mode: migration 0126 adds version 2 (auto mode on); oss-sec3: 0221 replaces it with Dengeli (no user
    // existed and nobody had saved the policy). All written by migrations.
    expect(rows[2]?.document).toEqual({ preset: 'dengeli' });
    const via = await h.db.pool.query<{ via: string }>(
      'SELECT via FROM security_policy_versions ORDER BY version',
    );
    expect(via.rows.map((r) => r.via)).toEqual(['migration', 'migration', 'migration']);
  });

  describe('Sıkı (the behaviour before ADR-0056)', () => {
    it('asks for a code for every privileged route once the 10-minute window is over', async () => {
      await h.setSecurityPolicy({ preset: 'siki' });
      await stepUp();
      expect((await newProject()).statusCode).toBe(201);
      await age(11);
      const refused = await newProject();
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ error: 'step_up_required' });
      const s = (await owner.req('GET', '/auth/session')).json<{ session: { stepUpWaived: string[] } }>();
      expect(s.session.stepUpWaived).toEqual([]);
      // New projects stay confined, no auto-approve.
      await stepUp();
      expect((await newProject()).statusCode).toBe(201);
      const p = await h.db.pool.query<{ host_execution: boolean; auto_approve_execution: boolean }>(
        'SELECT host_execution, auto_approve_execution FROM projects WHERE id = $1',
        [`sp-${String(projects)}`],
      );
      expect(p.rows[0]).toEqual({ host_execution: false, auto_approve_execution: false });
    });
  });

  describe('Serbest (default)', () => {
    it('lets non-core events pass without a code and gives new projects full autonomy', async () => {
      await h.setSecurityPolicy({ preset: 'serbest', stepUp: { windowMinutes: 5 } });
      await stepUp();
      await age(6);
      const created = await newProject();
      expect(created.statusCode, created.body).toBe(201);
      const p = await h.db.pool.query<{ host_execution: boolean; auto_approve_execution: boolean }>(
        'SELECT host_execution, auto_approve_execution FROM projects WHERE id = $1',
        [`sp-${String(projects)}`],
      );
      expect(p.rows[0]).toEqual({ host_execution: true, auto_approve_execution: true });
      const s = (await owner.req('GET', '/auth/session')).json<{
        session: { stepUpWaived: string[]; stepUpValidUntil: string | null };
      }>();
      expect(s.session.stepUpWaived).toContain('projects.policy');
      expect(s.session.stepUpWaived).toContain('chat.cards');
      expect(s.session.stepUpWaived).not.toContain('security.policy');
      expect(s.session.stepUpWaived).not.toContain('users.roles');
    });

    it('keeps the safe core: user / role changes and the policy itself ask for a code after the window', async () => {
      await h.setSecurityPolicy({ preset: 'serbest', stepUp: { windowMinutes: 5 } });
      const target = await h.createUser('victim.sp', PW, 'operator');
      await stepUp();
      const s = (await owner.req('GET', '/auth/session')).json<{
        session: { stepUpValidUntil: string; mfaAt: string };
      }>();
      // The window is the policy's 5 minutes (not the server's 10).
      expect(Date.parse(s.session.stepUpValidUntil) - Date.parse(s.session.mfaAt)).toBe(5 * MIN);
      await age(6);
      const role = await roleChange(target);
      expect(role.statusCode).toBe(403);
      expect(role.json()).toMatchObject({ error: 'step_up_required' });
      const policy = await owner.req('PUT', '/security/policy', { events: { 'users.roles': false } });
      expect(policy.statusCode).toBe(403);
      // A non-core route still passes.
      expect((await newProject()).statusCode).toBe(201);
      await stepUp();
      expect((await roleChange(target)).statusCode).toBe(200);
    });
  });

  describe('Dengeli', () => {
    it('protects account security and credentials, not everyday project settings', async () => {
      await h.setSecurityPolicy({ preset: 'dengeli', stepUp: { windowMinutes: 5 } });
      await stepUp();
      await age(6);
      expect((await newProject()).statusCode).toBe(201);
      // Account security (revoke every trusted device) is protected in Dengeli.
      const devices = await owner.req('POST', '/auth/devices/revoke-all', {});
      expect(devices.statusCode).toBe(403);
      expect(devices.json()).toMatchObject({ error: 'step_up_required' });
    });
  });

  describe('the policy API', () => {
    it('is admin-only, audited with the changed paths, and refuses a stale version', async () => {
      await h.setSecurityPolicy({ preset: 'serbest' });
      h.clock.advance(30_000);
      const operator = await fullLogin(h, 'op.sp', PW, opSecret);
      expect((await operator.req('GET', '/security/policy')).statusCode).toBe(403);
      expect((await operator.req('PUT', '/security/policy', { preset: 'siki' })).statusCode).toBe(403);
      await stepUp();
      const view = await owner.req('GET', '/security/policy');
      expect(view.statusCode, view.body).toBe(200);
      const v = view.json<{
        version: number;
        effective: { preset: string; events: Record<string, boolean> };
        catalog: { events: { id: string; category: string; core: boolean }[] };
      }>();
      expect(v.effective.preset).toBe('serbest');
      expect(v.catalog.events.filter((e) => e.core).map((e) => e.id)).toEqual(
        expect.arrayContaining(['security.policy', 'users.roles', 'secrets.reveal', 'account.mfa']),
      );
      const put = await owner.req('PUT', '/security/policy', {
        stepUp: { windowMinutes: 24 * 60 },
        events: { 'deploy.production': true },
        expectedVersion: v.version,
        reason: 'test',
      });
      expect(put.statusCode, put.body).toBe(200);
      const after = put.json<{ version: number; changed: string[]; effective: { customized: boolean } }>();
      expect(after.version).toBe(v.version + 1);
      expect(after.changed).toEqual(['stepUp.windowMinutes', 'events.deploy.production']);
      expect(after.effective.customized).toBe(true);
      const stale = await owner.req('PUT', '/security/policy', {
        preset: 'siki',
        expectedVersion: v.version,
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error: 'version_conflict' });
      const audit = await h.db.pool.query<{ outcome: string; metadata: Record<string, unknown> }>(
        `SELECT outcome, metadata FROM audit_events WHERE action = 'security.policy.update' AND actor_id = $1
          ORDER BY id`,
        [ownerId],
      );
      const ok = audit.rows.find((r) => r.outcome === 'success' && r.metadata.noop !== true);
      expect(ok?.metadata).toMatchObject({
        via: 'console',
        changed: ['stepUp.windowMinutes', 'events.deploy.production'],
        preset: 'serbest',
        reason: 'test',
      });
      expect(audit.rows.some((r) => r.outcome === 'denied')).toBe(true);
      const versions = await h.db.pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM security_policy_versions',
      );
      expect(Number(versions.rows[0]?.n)).toBeGreaterThanOrEqual(2);
    });

    it('applies the autonomy defaults to existing projects (except Machines), audited', async () => {
      await h.setSecurityPolicy({ preset: 'serbest' });
      await h.db.pool.query(
        "INSERT INTO projects (id, name, created_at) VALUES ('sp-legacy', 'Legacy', now()) ON CONFLICT DO NOTHING",
      );
      await stepUp();
      const r = await owner.req('POST', '/security/policy/apply-autonomy', {});
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json<{ updated: string[] }>().updated).toContain('sp-legacy');
      expect(r.json<{ updated: string[] }>().updated).not.toContain('machines');
      const p = await h.db.pool.query<{ host_execution: boolean; auto_approve_execution: boolean }>(
        "SELECT host_execution, auto_approve_execution FROM projects WHERE id = 'sp-legacy'",
      );
      expect(p.rows[0]).toEqual({ host_execution: true, auto_approve_execution: true });
      const audit = await h.db.pool.query(
        "SELECT 1 FROM audit_events WHERE action = 'security.policy.apply_autonomy' AND outcome = 'success'",
      );
      expect(audit.rowCount).toBe(1);
    });
  });
});
