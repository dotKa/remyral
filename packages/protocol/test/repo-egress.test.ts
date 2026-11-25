import { describe, expect, it } from 'vitest';
import {
  AssignedRepoEgress,
  AssignJob,
  effectiveRepoEgress,
  MAX_REPO_EGRESS_HOSTS,
  MAX_REPO_EGRESS_WIRE_HOSTS,
  PACKAGE_REGISTRY_PRESETS,
  REPO_EGRESS_FEATURE,
  REPO_EGRESS_PRESETS,
  RepoEgressPreset,
  repoEgressHosts,
  WorkerFeature,
} from '../src/index.js';
import { masterMessages } from './fixtures.js';

/** p14-repo-egress: the wire field (additive), the feature flag, the presets and the effective policy. */
describe('repository project egress (p14-repo-egress)', () => {
  it('ASSIGN_JOB execution.repoEgress is optional, strict and host-checked', () => {
    expect(WorkerFeature.safeParse(REPO_EGRESS_FEATURE).success).toBe(true);
    const assign = structuredClone(masterMessages.ASSIGN_JOB) as {
      payload: { execution?: Record<string, unknown> };
    };
    assign.payload.execution = { hostExecutionOptIn: false };
    expect(AssignJob.safeParse(assign).success).toBe(true);
    assign.payload.execution.repoEgress = {
      mode: 'allowlist',
      hosts: ['registry.npmjs.org', 'git.example.org:2222'],
    };
    expect(AssignJob.safeParse(assign).success).toBe(true);
    for (const bad of [
      { mode: 'open', hosts: [] },
      { mode: 'allowlist', hosts: ['10.0.0.1'] },
      { mode: 'allowlist', hosts: ['Registry.npmjs.org'] },
      { mode: 'allowlist', hosts: ['localhost'] },
      { mode: 'web', hosts: [], extra: true },
    ]) {
      expect(AssignedRepoEgress.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('presets: every host is a valid egress host; the recommended group is the package registries', () => {
    for (const p of RepoEgressPreset.options) {
      const hosts = REPO_EGRESS_PRESETS[p];
      expect(hosts.length).toBeGreaterThan(0);
      expect(AssignedRepoEgress.safeParse({ mode: 'allowlist', hosts }).success, p).toBe(true);
    }
    expect(PACKAGE_REGISTRY_PRESETS).toEqual(['npm', 'pypi', 'crates', 'go', 'maven']);
    // Every preset plus the maximum of custom hosts still fits the wire bound.
    const all = repoEgressHosts(
      RepoEgressPreset.options,
      Array.from({ length: MAX_REPO_EGRESS_HOSTS }, (_, i) => `h${String(i)}.example.com`),
    );
    expect(all.length).toBeLessThanOrEqual(MAX_REPO_EGRESS_WIRE_HOSTS);
  });

  it('effective policy: none carries nothing, an empty allowlist is none, web keeps listed host:port entries', () => {
    expect(effectiveRepoEgress('none', ['npm'], ['a.example.com'])).toEqual({ mode: 'none', hosts: [] });
    expect(effectiveRepoEgress('allowlist', [], [])).toEqual({ mode: 'none', hosts: [] });
    expect(effectiveRepoEgress('allowlist', ['go'], ['a.example.com'])).toEqual({
      mode: 'allowlist',
      hosts: ['a.example.com', 'proxy.golang.org', 'sum.golang.org'],
    });
    expect(effectiveRepoEgress('web', [], ['git.example.org:2222'])).toEqual({
      mode: 'web',
      hosts: ['git.example.org:2222'],
    });
  });
});
