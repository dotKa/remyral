import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox } from '../../src/auth/secret-box.js';
import { AutomationService, type AutomationServiceDeps } from '../../src/automations/service.js';
import { gitHubEventTarget } from '../../src/gitflow/github-events.js';

/** p22-github-webhook (docs/design/p22-github-webhook.md): what a delivery marks, and the delivery path. */
const SHA = 'a'.repeat(40);

describe('p22-github-webhook: gitHubEventTarget', () => {
  it('push: the branch; tags and malformed refs change nothing', () => {
    expect(gitHubEventTarget('push', { ref: 'refs/heads/main', after: SHA })).toEqual({
      branches: ['main'],
      pullRequests: [],
      shas: [],
    });
    expect(gitHubEventTarget('push', { ref: 'refs/tags/v1' })).toBeNull();
    expect(gitHubEventTarget('push', { ref: 'refs/heads/bad name' })).toBeNull();
    expect(gitHubEventTarget('push', {})).toBeNull();
  });

  it('pull_request: number, head branch and head sha', () => {
    expect(
      gitHubEventTarget('pull_request', {
        action: 'synchronize',
        number: 12,
        pull_request: { head: { ref: 'rac/x/a1', sha: SHA.toUpperCase() } },
      }),
    ).toEqual({ branches: ['rac/x/a1'], pullRequests: [12], shas: [SHA] });
    expect(gitHubEventTarget('pull_request', { number: -1, pull_request: {} })).toBeNull();
  });

  it('CI events: the head sha; other events change nothing', () => {
    expect(gitHubEventTarget('check_suite', { check_suite: { head_sha: SHA } })?.shas).toEqual([SHA]);
    expect(gitHubEventTarget('check_run', { check_run: { head_sha: SHA } })?.shas).toEqual([SHA]);
    expect(gitHubEventTarget('status', { sha: SHA })?.shas).toEqual([SHA]);
    expect(gitHubEventTarget('check_suite', { check_suite: { head_sha: 'nope' } })).toBeNull();
    expect(gitHubEventTarget('issues', { issue: { number: 3 } })).toBeNull();
    expect(gitHubEventTarget('release', null)).toBeNull();
  });
});

describe('p22-github-webhook: delivery → git flow', () => {
  const SECRET = 'whsec-fixture-0001';
  const make = (gitEvents: AutomationServiceDeps['githubGitEvents']) => {
    const warnings: string[] = [];
    const svc = new AutomationService({
      pool: { query: () => Promise.resolve({ rows: [], rowCount: 0 }) },
      box: new SecretBox(Buffer.alloc(32, 7)),
      clock: () => new Date('2026-11-02T10:00:00Z'),
      log: { warn: (_o: unknown, m: string) => warnings.push(m), info: () => undefined },
      githubWebhookSecret: () => Promise.resolve(SECRET),
      githubGitEvents: gitEvents,
    } as unknown as AutomationServiceDeps);
    return { svc, warnings };
  };
  const deliver = (svc: AutomationService, body: object, secret = SECRET) => {
    const raw = Buffer.from(JSON.stringify(body));
    return svc.receiveGitHub(
      {
        event: 'push',
        delivery: '00000000-0000-4000-8000-000000000001',
        signature: `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
        contentType: 'application/json',
      },
      raw,
    );
  };

  it('a verified delivery reaches the git flow even when no automation matches', async () => {
    const seen: unknown[] = [];
    const { svc } = make((repo, event, payload) => {
      seen.push([repo, event, payload]);
      return Promise.resolve(1);
    });
    const body = { ref: 'refs/heads/main', repository: { full_name: 'Acme/App' } };
    const out = await deliver(svc, body);
    expect(out.status).toBe(200);
    expect(seen).toEqual([['acme/app', 'push', body]]);
  });

  it('a wrong signature reaches nothing; a git flow error does not fail the delivery', async () => {
    let calls = 0;
    const { svc, warnings } = make(() => {
      calls++;
      return Promise.reject(new Error('db down'));
    });
    const body = { ref: 'refs/heads/main', repository: { full_name: 'acme/app' } };
    expect((await deliver(svc, body, 'wrong')).status).toBe(401);
    expect(calls).toBe(0);
    expect((await deliver(svc, body)).status).toBe(200);
    expect(calls).toBe(1);
    expect(warnings).toContain('github webhook: git flow re-check not marked');
  });
});
