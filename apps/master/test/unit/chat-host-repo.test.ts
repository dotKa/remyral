import type { GitHostConnectionView } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import type { Subject } from '../../src/authz/model.js';
import { ChatGitHubRepo } from '../../src/chat/github-repo-actions.js';
import { ChatHostRepo } from '../../src/chat/host-repo-actions.js';
import type { ConfirmContext } from '../../src/chat/drafts.js';
import type { DraftRecord } from '../../src/chat/store.js';
import type { ProjectGitConfigStore } from '../../src/gitflow/config-store.js';
import type { GitHostService } from '../../src/gitflow/git-hosts.js';

/**
 * p16-git-providers: create_repository on GitLab / Bitbucket — the connection is chosen by the master (one of a kind,
 * or the named one), tokens that cannot create repositories are refused before a card, the role is checked at plan
 * and at confirm, and the confirmed card opens the repository and links the project with the connection.
 */

function conn(over: Partial<GitHostConnectionView>): GitHostConnectionView {
  return {
    id: '6f1f6c1e-1111-4222-8333-944444444444',
    kind: 'gitlab',
    label: 'GitLab',
    baseUrl: 'https://git.example.com',
    webHost: 'git.example.com',
    tokenKind: 'group',
    scope: 'acme',
    tokenFingerprint: 'abcdefabcdef',
    pushTokenFingerprint: null,
    separatePushToken: false,
    expiresAt: null,
    pushExpiresAt: null,
    rotatable: true,
    tokenUpdatedAt: '2026-10-23T00:00:00.000Z',
    lastTest: null,
    usable: true,
    projects: [],
    version: 1,
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
    ...over,
  };
}

const owner: Subject = { userId: 'u1', role: 'owner', memberships: new Map() };
const operator: Subject = { userId: 'u2', role: 'operator', memberships: new Map([['acme', 'operator']]) };

function setup(connections: GitHostConnectionView[], existing: string | null = null) {
  const created: unknown[] = [];
  const puts: unknown[] = [];
  const hosts = {
    list: () => Promise.resolve(connections),
    createRepository: (_a: unknown, id: string, input: Record<string, unknown>) => {
      created.push({ id, ...input });
      return Promise.resolve({
        fullPath: `acme/${String(input.name)}`,
        cloneUrl: `https://git.example.com/acme/${String(input.name)}.git`,
        webUrl: `https://git.example.com/acme/${String(input.name)}`,
        defaultBranch: 'main',
        private: true,
        archived: false,
        created: true,
      });
    },
  } as unknown as GitHostService;
  const configs = {
    get: () => Promise.resolve(existing === null ? null : { repositoryUrl: existing, version: 3 }),
    put: (project: string, input: unknown) => {
      puts.push({ project, input });
      return Promise.resolve({});
    },
  } as unknown as ProjectGitConfigStore;
  const hosted = new ChatHostRepo({ hosts: () => hosts, configs: () => configs });
  const chat = new ChatGitHubRepo({ repos: () => null, hosted: () => hosted });
  return { chat, created, puts };
}

const ctx = (subject: Subject): ConfirmContext =>
  ({
    subject,
    human: { userId: subject.userId },
    actor: { userId: subject.userId, ip: '127.0.0.1', userAgent: null },
  }) as unknown as ConfirmContext;

describe('create_repository on GitLab / Bitbucket (p16-git-providers)', () => {
  it('plans a card with the only connection; the confirmed card creates and links', async () => {
    const { chat, created, puts } = setup([conn({})]);
    const plan = await chat.plan(owner, { provider: 'gitlab', name: 'site', project: 'acme' });
    expect(plan).toMatchObject({ ok: true, title: 'New private GitLab repository acme/site' });
    if (!plan.ok) throw new Error('plan failed');
    expect(plan.payload).toMatchObject({
      op: 'create_hosted_repository',
      provider: 'gitlab',
      connection: 'GitLab',
    });
    const out = await chat.run(ctx(owner), { payload: plan.payload } as unknown as DraftRecord);
    expect(out).toMatchObject({
      op: 'create_hosted_repository',
      created: true,
      linked: true,
      fullName: 'acme/site',
    });
    expect(created).toEqual([expect.objectContaining({ name: 'site', private: true, namespace: 'acme' })]);
    expect(puts).toMatchObject([
      {
        project: 'acme',
        input: {
          provider: 'gitlab',
          repositoryUrl: 'https://git.example.com/acme/site.git',
          hostConnectionId: '6f1f6c1e-1111-4222-8333-944444444444',
          expectedVersion: 0,
        },
      },
    ]);
  });

  it('refuses: no connection, several, a token kind that cannot create, a non-admin, an existing link', async () => {
    expect(await setup([]).chat.plan(owner, { provider: 'bitbucket', name: 'x' })).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    const two = setup([
      conn({ label: 'A' }),
      conn({ id: '6f1f6c1e-2222-4222-8333-944444444444', label: 'B' }),
    ]);
    expect(await two.chat.plan(owner, { provider: 'gitlab', name: 'x' })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(await two.chat.plan(owner, { provider: 'gitlab', name: 'x', connection: 'b' })).toMatchObject({
      ok: true,
    });
    const projectToken = setup([conn({ tokenKind: 'project', scope: 'acme/app' })]);
    const refused = await projectToken.chat.plan(owner, { provider: 'gitlab', name: 'x' });
    expect(refused).toMatchObject({ ok: false, code: 'invalid' });
    expect(refused.ok ? '' : refused.message).toContain('group');
    const repoToken = setup([conn({ kind: 'bitbucket', tokenKind: 'repository', scope: 'acme/app' })]);
    expect(await repoToken.chat.plan(owner, { provider: 'bitbucket', name: 'x' })).toMatchObject({
      ok: false,
    });
    expect(await setup([conn({})]).chat.plan(operator, { provider: 'gitlab', name: 'x' })).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    const linked = setup([conn({})], 'https://github.com/acme/app.git');
    expect(await linked.chat.plan(owner, { provider: 'gitlab', name: 'x', project: 'acme' })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(
      await linked.chat.plan(owner, { provider: 'gitlab', name: 'x', project: 'acme', replaceLink: true }),
    ).toMatchObject({ ok: true });
    // The confirming user's role is re-checked.
    const { chat } = setup([conn({})]);
    const plan = await chat.plan(owner, { provider: 'gitlab', name: 'site' });
    if (!plan.ok) throw new Error('plan failed');
    await expect(
      chat.run(ctx(operator), { payload: plan.payload } as unknown as DraftRecord),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
