import { describe, expect, it } from 'vitest';
import {
  AssignedGitAuth,
  CredentialRequest,
  fixesFor,
  GitReadinessReport,
  gitVersionSupported,
  knownHostsProblem,
  OpsOperation,
  sshPrivateKeyProblem,
  WorkerFeature,
} from '../src/index.js';

const ED25519 = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';

describe('p15-git-central protocol', () => {
  it('git versions: GIT_CONFIG_GLOBAL needs 2.32+', () => {
    expect(gitVersionSupported('2.32.0')).toBe(true);
    expect(gitVersionSupported('2.47.1.windows.2')).toBe(true);
    expect(gitVersionSupported('git version 2.39.5 (Apple Git-154)')).toBe(true);
    expect(gitVersionSupported('2.31.9')).toBe(false);
    expect(gitVersionSupported('1.99')).toBe(false);
    expect(gitVersionSupported('3.0')).toBe(true);
    expect(gitVersionSupported('garbage')).toBe(false);
  });

  it('known_hosts: plain / bracketed / hashed hosts, no markers, wildcards or junk', () => {
    expect(knownHostsProblem(`git.example.com ssh-ed25519 ${ED25519}`)).toBeNull();
    expect(knownHostsProblem(`[git.example.com]:2222,10.0.0.5 ssh-ed25519 ${ED25519} comment`)).toBeNull();
    expect(
      knownHostsProblem(`|1|c2FsdHNhbHRzYWx0c2FsdHM=|aGFzaGhhc2hoYXNoaGFzaGg= ssh-ed25519 ${ED25519}`),
    ).toBeNull();
    expect(knownHostsProblem('')).toBe('empty');
    expect(knownHostsProblem(`@cert-authority *.example.com ssh-ed25519 ${ED25519}`)).toBe('bad_line');
    expect(knownHostsProblem(`*.example.com ssh-ed25519 ${ED25519}`)).toBe('bad_line');
    expect(knownHostsProblem(`!bad.example.com ssh-ed25519 ${ED25519}`)).toBe('bad_line');
    expect(knownHostsProblem('git.example.com ssh-dss AAAA')).toBe('bad_line');
    expect(knownHostsProblem(Array(17).fill(`h ssh-ed25519 ${ED25519}`).join('\n'))).toBe('too_many_lines');
  });

  it('ASSIGN_JOB gitAuth: an ssh key needs pinned known_hosts; never a value field', () => {
    expect(AssignedGitAuth.safeParse({ kind: 'ssh-key', credentialId: 'deploy-key' }).success).toBe(false);
    const ok = AssignedGitAuth.parse({
      kind: 'ssh-key',
      credentialId: 'deploy-key',
      knownHosts: `git.example.com ssh-ed25519 ${ED25519}`,
      token: 'smuggled',
    });
    expect(ok).not.toHaveProperty('token');
    expect(
      AssignedGitAuth.safeParse({ kind: 'https-token', credentialId: 'x', username: 'a b' }).success,
    ).toBe(false);
  });

  it('feature, op, credential purpose and readiness are additive', () => {
    expect(WorkerFeature.options).toContain('git-central-v1');
    expect(OpsOperation.parse({ kind: 'git.fix', fixes: ['erase_github_credentials'] })).toEqual({
      kind: 'git.fix',
      fixes: ['erase_github_credentials'],
    });
    expect(OpsOperation.safeParse({ kind: 'git.fix', fixes: ['rm -rf'] }).success).toBe(false);
    expect(OpsOperation.safeParse({ kind: 'git.fix', fixes: [] }).success).toBe(false);
    const base = {
      protocolVersion: '1.0',
      type: 'CREDENTIAL_REQUEST',
      messageId: '6f1c1d8e-56a7-4c43-9a43-1d8f4a3f2b11',
      seq: 0,
      ts: '2026-10-22T10:00:00.000Z',
      correlationId: 'c',
      workerId: 'wrk_abcdefghijklmnopqrstuvwxyz',
      jobId: 'job-1',
      payload: {
        attemptId: '6f1c1d8e-56a7-4c43-9a43-1d8f4a3f2b12',
        epoch: 1,
        requestId: '6f1c1d8e-56a7-4c43-9a43-1d8f4a3f2b13',
        kind: 'git',
      },
    };
    expect(CredentialRequest.safeParse(base).success).toBe(true);
    expect(
      CredentialRequest.safeParse({ ...base, payload: { ...base.payload, purpose: 'push', retry: true } })
        .success,
    ).toBe(true);
    const report = GitReadinessReport.parse({
      checkedAt: '2026-10-22T10:00:00.000Z',
      git: { present: true, version: '2.47.1', source: 'system' },
      problems: [
        { code: 'os_store_github', severity: 'warning', fix: 'erase_github_credentials', count: 1 },
        { code: 'global_insteadof', severity: 'warning', fix: 'remove_github_insteadof', count: 1 },
        { code: 'credential_store_file', severity: 'warning', fix: 'erase_github_credentials' },
        { code: 'global_identity', severity: 'info' },
      ],
      jobsIsolated: true,
    });
    expect(fixesFor(report)).toEqual(['erase_github_credentials', 'remove_github_insteadof']);
  });

  it('deploy keys must be unencrypted private keys', () => {
    expect(
      sshPrivateKeyProblem('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n'),
    ).toBeNull();
    expect(sshPrivateKeyProblem('ssh-ed25519 AAAA public')).toBe('not_a_private_key');
    expect(
      sshPrivateKeyProblem(
        '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nAAAA\n-----END RSA PRIVATE KEY-----',
      ),
    ).toBe('encrypted');
  });
});
