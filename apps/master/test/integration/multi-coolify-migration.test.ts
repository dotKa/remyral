import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { SecretBox } from '../../src/auth/secret-box.js';
import { DEFAULT_MIGRATIONS_DIR, migrate } from '../../src/db/migrate.js';
import { OpsIntegrations } from '../../src/ops/integrations.js';
import { createGuardedFetch } from '../../src/ops/http.js';
import { createTestDatabase, describeIntegration, type TestDatabase } from '../helpers/env.js';
import { FakeCoolify } from '../helpers/fake-ops.js';

/**
 * p13-multi-coolify: migration 0097 turns the p6 single Coolify integration into the default connection — the token
 * is moved as it is (decrypts with its old AAD, no re-entry) and targets, actions, pending deploys on success and
 * uptime monitors are stamped with the connection id.
 */
describeIntegration('migration 0097 Coolify connections', () => {
  let db: TestDatabase;
  let dir = '';
  const coolify = new FakeCoolify();
  const box = new SecretBox(Buffer.alloc(32, 7));
  const sub = new SecretBox(box.deriveKey('ops-integrations'));

  beforeAll(async () => {
    await coolify.start();
    db = await createTestDatabase({ migrated: false });
    dir = await mkdtemp(join(tmpdir(), 'mig-0096-'));
    for (const f of await readdir(DEFAULT_MIGRATIONS_DIR)) {
      if (f.endsWith('.sql') && f < '0097') await cp(join(DEFAULT_MIGRATIONS_DIR, f), join(dir, f));
    }
    await migrate(db.pool, { dir });
  });
  afterAll(async () => {
    await db.drop();
    await rm(dir, { recursive: true, force: true });
    await coolify.stop();
  });

  it('moves the token and stamps every Coolify reference with the default connection', async () => {
    const q = db.pool;
    await q.query(`INSERT INTO projects (id, name, created_at) VALUES ('shop', 'shop', now())`);
    await q.query(
      `INSERT INTO ops_integrations (provider, config, secret, key_fingerprint, created_at, updated_at)
       VALUES ('coolify', $1, $2, '0123456789abcdef', now(), now())`,
      [
        { url: coolify.base, team: null, denyResources: ['extradeny1'] },
        sub.encrypt(Buffer.from(coolify.token, 'utf8'), 'ops-integration:coolify'),
      ],
    );
    await q.query(
      `INSERT INTO project_deploy_targets (project, config, version, updated_at) VALUES ('shop', $1, 3, now())`,
      [{ coolify: { preview: { uuids: ['shopprev01'], tags: [] }, production: null } }],
    );
    const actionId = randomUUID();
    await q.query(
      `INSERT INTO ops_actions (id, project, kind, env, params, params_hash, target, diff, policy_decision, policy_reason,
                                state, requested_by_type, requested_by_id, via, idempotency_key, created_at, updated_at)
       VALUES ($1, 'shop', 'coolify.deploy', 'preview', '{"env":"preview"}', repeat('0', 64),
               '{"provider":"coolify","resources":[{"uuid":"shopprev01"}]}', '{}', 'auto', 'r', 'deploying', 'user',
               'u1', 'api', 'idem-0001', now(), now())`,
      [actionId],
    );
    const monitorId = randomUUID();
    await q.query(
      `INSERT INTO uptime_monitors (id, project, name, type, config, interval_sec, timeout_ms, retries, paused, status,
                                    next_check_at, created_by_type, created_at, updated_at)
       VALUES ($1, 'shop', 'm', 'coolify', '{"uuid":"shopprev01"}', 300, 5000, 1, false, 'pending', now(), 'system',
               now(), now())`,
      [monitorId],
    );

    await migrate(q);

    const conns = await q.query<{
      id: string;
      label: string;
      is_default: boolean;
      all_projects: boolean;
      config: unknown;
    }>('SELECT id::text AS id, label, is_default, all_projects, config FROM coolify_connections');
    expect(conns.rows).toHaveLength(1);
    const c = conns.rows[0];
    expect(c).toMatchObject({ label: 'Sunucu Coolify (varsayılan)', is_default: true, all_projects: true });
    expect(c?.config).toMatchObject({ url: coolify.base, denyResources: ['extradeny1'], useServerSso: true });
    const id = c?.id ?? '';
    expect((await q.query("SELECT 1 FROM ops_integrations WHERE provider = 'coolify'")).rowCount).toBe(0);
    const t = await q.query<{ config: { coolify: { preview: { connection: string } } }; version: number }>(
      "SELECT config, version FROM project_deploy_targets WHERE project = 'shop'",
    );
    expect(t.rows[0]?.config.coolify.preview.connection).toBe(id);
    expect(t.rows[0]?.version).toBe(3);
    const a = await q.query<{ target: { connection: unknown } }>(
      'SELECT target FROM ops_actions WHERE id = $1',
      [actionId],
    );
    expect(a.rows[0]?.target.connection).toEqual({ id, label: 'Sunucu Coolify (varsayılan)' });
    const m = await q.query<{ config: { connection: string } }>(
      'SELECT config FROM uptime_monitors WHERE id = $1',
      [monitorId],
    );
    expect(m.rows[0]?.config.connection).toBe(id);

    // The moved token works without re-entry.
    const integrations = new OpsIntegrations({
      pool: q,
      audit: new AuditLog(q),
      box,
      clock: () => new Date(),
      fetch: createGuardedFetch({ internalOrigins: [coolify.base] }),
      internalOrigins: new Set([coolify.base]),
      cloudflareApi: 'https://api.cloudflare.example/client/v4',
      controlPlaneResources: [],
      protectedHosts: [],
    });
    const h = await integrations.coolifyConnections.forAction('shop', null);
    expect(h.id).toBe(id);
    expect(await h.client.version()).toContain('v4');
    expect(coolify.requests.at(-1)?.auth).toBe(`Bearer ${coolify.token}`);
    const legacy = await integrations.status();
    expect(legacy.coolify).toMatchObject({
      provider: 'coolify',
      usable: true,
      keyFingerprint: '0123456789abcdef',
    });
  });
});
