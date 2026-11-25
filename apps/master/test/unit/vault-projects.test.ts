import { describe, expect, it } from 'vitest';
import type { AuditEventInput } from '../../src/audit/audit.js';
import type { Subject } from '../../src/authz/model.js';
import { ChatAdmin, type ChatAdminDeps } from '../../src/chat/admin-actions.js';
import { ChatCredentials, type ChatCredentialsDeps } from '../../src/chat/credentials.js';
import type { VaultService } from '../../src/vault/service.js';
import { CREDENTIAL_NOT_ALLOWED_FOR_PROJECT, credentialAllowsProject } from '../../src/vault/projects.js';

/**
 * p22-vault-projects: the pure allowlist rule and the assistant's credential lookups — a project-scoped conversation
 * lists, resolves and uses only the vault credentials its projects may use. Save, slot binding, run-time build and
 * dispatch are covered by the integration test (vault-projects.test.ts).
 */
const admin = {
  userId: '11111111-1111-4111-8111-111111111111',
  role: 'admin',
  memberships: new Map(),
} as unknown as Subject;

interface Row {
  id: string;
  name: string;
  kind: string;
  allowed_hosts: string[] | null;
  projects: string[] | null;
}
const ROWS: Row[] = [
  { id: 'open', name: 'Open', kind: 'http-auth', allowed_hosts: ['api.example.test'], projects: null },
  { id: 'alpha', name: 'Alpha', kind: 'http-auth', allowed_hosts: ['api.example.test'], projects: ['alpha'] },
];

function chatCredentials(audit: AuditEventInput[]): ChatCredentials {
  const db = {
    query: (sql: string, params: unknown[]) => {
      if (sql.includes('vault_credential_workers')) return Promise.resolve({ rows: [], rowCount: 0 });
      const ref = params[0];
      const rows = ROWS.filter((r) => r.id === ref || r.name === ref);
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  };
  return new ChatCredentials({
    db: db as unknown as ChatCredentialsDeps['db'],
    store: {} as ChatCredentialsDeps['store'],
    audit: {
      record: (e: AuditEventInput) => {
        audit.push(e);
        return Promise.resolve({ id: 'a', hash: Buffer.alloc(0) });
      },
    },
    clock: () => new Date('2026-11-02T12:00:00Z'),
    jobs: () => ({ create: () => Promise.resolve('job-1') }),
    egress: () => null,
  });
}

describe('credentialAllowsProject', () => {
  it('null / absent = every project; a list = only those', () => {
    expect(credentialAllowsProject(null, 'beta')).toBe(true);
    expect(credentialAllowsProject(undefined, 'beta')).toBe(true);
    expect(credentialAllowsProject(['alpha'], 'alpha')).toBe(true);
    expect(credentialAllowsProject(['alpha'], 'beta')).toBe(false);
  });
});

describe('chat credential tokens in a project-scoped conversation', () => {
  it('a credential a working project may not use is not resolved (no id, a refusal block)', async () => {
    const creds = chatCredentials([]);
    const scoped = await creds.tokens(admin, 'use {{credential:alpha}} and {{credential:open}}', ['beta']);
    expect(scoped.chips).toEqual([
      { name: 'alpha', id: null, kind: null, allowedHosts: null, machines: 0 },
      { name: 'open', id: 'open', kind: 'http-auth', allowedHosts: ['api.example.test'], machines: 0 },
    ]);
    expect(JSON.stringify(scoped.blocks[0])).toContain(CREDENTIAL_NOT_ALLOWED_FOR_PROJECT);
    expect(scoped.blocks[1]).toMatchObject({ id: 'open', projects: 'all' });
    // Its own project (or no working projects) resolves it, with the allowlist in the block.
    const own = await creds.tokens(admin, '{{credential:alpha}}', ['alpha']);
    expect(own.chips[0]?.id).toBe('alpha');
    expect(own.blocks[0]).toMatchObject({ id: 'alpha', projects: ['alpha'] });
    expect((await creds.tokens(admin, '{{credential:alpha}}')).chips[0]?.id).toBe('alpha');
  });

  it('run_http_request refuses a credential the project may not use (audited) and allows it in its project', async () => {
    const audit: AuditEventInput[] = [];
    const creds = chatCredentials(audit);
    const refused = await creds.planHttp(admin, {
      project: 'beta',
      url: 'https://api.example.test/v1/items',
      credential: 'alpha',
    });
    expect(refused).toMatchObject({ ok: false, code: 'forbidden' });
    expect(JSON.stringify(refused)).toContain(CREDENTIAL_NOT_ALLOWED_FOR_PROJECT);
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'chat.http_request',
        outcome: 'denied',
        metadata: { project: 'beta', vaultId: 'alpha', denial: CREDENTIAL_NOT_ALLOWED_FOR_PROJECT },
      }),
    ]);
  });
});

describe('list_vault_credentials in a project-scoped conversation', () => {
  const none = () => null;
  const view = (id: string, projects: string[] | null) => ({
    id,
    name: id,
    kind: 'http-auth',
    env: 'REMYRAL_HTTP_AUTH',
    description: null,
    version: 1,
    state: 'active',
    createdAt: '2026-11-01T00:00:00.000Z',
    createdBy: null,
    updatedAt: '2026-11-01T00:00:00.000Z',
    revokedAt: null,
    lastUsedAt: null,
    allowedHosts: ['api.example.test'],
    projects,
    workers: [],
  });
  const chatAdmin = new ChatAdmin({
    db: {} as ChatAdminDeps['db'],
    clock: () => new Date('2026-11-02T12:00:00Z'),
    directory: none,
    fleet: none,
    rotation: none,
    releases: none,
    backups: none,
    vault: () =>
      ({
        list: () =>
          Promise.resolve([view('open', null), view('alpha', ['alpha']), view('both', ['alpha', 'beta'])]),
      }) as unknown as VaultService,
    notifications: none,
    integrations: none,
    github: none,
    quotas: none,
    schedules: none,
    previews: none,
    gitCentral: none,
  });
  const ids = (r: unknown) =>
    (r as { data: { credentials: { id: string; projects: unknown }[] } }).data.credentials.map((c) => c.id);

  it('without working projects every credential is listed with its projects', async () => {
    const r = await chatAdmin.read(admin, 'list_vault_credentials', {});
    expect(ids(r)).toEqual(['open', 'alpha', 'both']);
    expect((r as { data: { credentials: { projects: unknown }[] } }).data.credentials[0]?.projects).toBe(
      'all',
    );
  });

  it('with working projects only credentials every one of them may use', async () => {
    expect(ids(await chatAdmin.read(admin, 'list_vault_credentials', {}, { projects: ['beta'] }))).toEqual([
      'open',
      'both',
    ]);
    expect(
      ids(await chatAdmin.read(admin, 'list_vault_credentials', {}, { projects: ['alpha', 'beta'] })),
    ).toEqual(['open', 'both']);
  });
});
