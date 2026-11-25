import { describe, expect, it } from 'vitest';
import type { PolicyDocument, PolicyRule } from '../src/api/runtimePolicy';
import { documentOf, draftOf } from '../src/screens/runtimePolicyDraft';

const rule = (version: string, extra: Partial<PolicyRule> = {}): PolicyRule => ({
  version,
  authModes: ['secret-ref'],
  allowUnpinned: false,
  allowUnverified: true,
  modelProfiles: [],
  defaultProfile: null,
  ...extra,
});

describe('runtime policy draft', () => {
  it('a stored version saved under an older release takes the current release pin, keeping its own settings', () => {
    const stored: PolicyDocument = {
      runtimes: { codex: rule('0.162.1', { authModes: ['local-login'] }) },
      projectProfiles: {},
    };
    const template: PolicyDocument = {
      runtimes: { codex: rule('0.164.0'), pi: rule('1.4.0') },
      projectProfiles: {},
    };
    const draft = draftOf('default', stored, template, 6);
    const doc = documentOf(draft);
    expect(doc.runtimes.codex?.version).toBe('0.164.0');
    expect(doc.runtimes.codex?.authModes).toEqual(['local-login']);
    // A runtime the stored version did not allow stays off.
    expect(doc.runtimes.pi).toBeUndefined();
  });
});
