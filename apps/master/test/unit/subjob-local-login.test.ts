import { describe, expect, it } from 'vitest';
import type { LeaseSigner } from '../../src/orchestration/lease-signer.js';
import { assignPayload } from '../../src/orchestration/messages.js';
import { familySql, localLoginFacts, SLOT_LEASE_JSON, slotCounts } from '../../src/queue/facts.js';
import { waitCategory } from '../../src/queue/service.js';

/** p9-subjob-local-login-deadlock: master-side pieces without a database. */
describe('sub-jobs beside their parent on a subscription login (master facts)', () => {
  const ll = {
    runtimes: ['claude-code', 'codex'],
    exclusiveProfiles: ['host-restricted'],
    stores: { 'claude-code': 'claude', codex: 'codex' },
  };

  it('localLogin.stores is kept (validated: known runtimes, short ids)', () => {
    expect(localLoginFacts(['profile-slots-v1'], ll)).toEqual(ll);
    expect(
      localLoginFacts(['profile-slots-v1'], { ...ll, stores: { 'claude-code': '../etc' } }),
    ).toBeUndefined();
    expect(localLoginFacts(['profile-slots-v1'], { ...ll, stores: { gpt: 'x' } })).toBeUndefined();
  });

  it('slot leases carry their job and family (SQL) and reach placement', () => {
    expect(SLOT_LEASE_JSON).toContain("'jobId', j.id::text");
    expect(SLOT_LEASE_JSON).toContain(`'family', ${familySql('j')}`);
    expect(familySql('x').replace(/\s+/g, ' ')).toBe(
      'COALESCE((SELECT fs.root_job_id::text FROM job_subtasks fs WHERE fs.child_job_id = x.id), ' +
        // p11-fixes-a: integration / resolution / fix / verify jobs belong to the coordinator's family.
        '(SELECT fi.root_job_id::text FROM integration_jobs fij JOIN integrations fi ON fi.id = fij.integration_id ' +
        'WHERE fij.job_id = x.id), x.id::text)',
    );
    const leases = [
      { jobId: 'p', family: 'p', profile: 'host-restricted', runtime: 'claude-code', ownCredential: false },
    ];
    expect(slotCounts(leases, ll).slotLeases).toEqual(leases);
  });

  it('the new wait reason is a subscription-login wait', () => {
    expect(waitCategory('subscription_login_busy')).toBe('subscription_login');
    expect(waitCategory('subscription_login_exclusive')).toBe('subscription_login');
  });

  it('ASSIGN_JOB carries execution.family when known', () => {
    const signer = { sign: () => 'token' } as unknown as LeaseSigner;
    const lease = {
      id: '1',
      jobId: 'j',
      attemptId: 'a',
      workerId: 'w',
      epoch: 1,
      acquiredAt: new Date(0),
      expiresAt: new Date(60_000),
      releasedAt: null,
      releaseReason: null,
    };
    const spec = { runtime: 'codex' } as unknown as Parameters<typeof assignPayload>[1]['spec'];
    const root = '00000000-0000-4000-8000-0000000000aa';
    expect(
      assignPayload(signer, { lease, project: 'genel', spec, family: root }, new Date(0)).execution,
    ).toEqual({ hostExecutionOptIn: false, family: { rootJobId: root } });
    expect(
      assignPayload(signer, { lease, project: 'genel', spec }, new Date(0)).execution,
    ).not.toHaveProperty('family');
  });
});
