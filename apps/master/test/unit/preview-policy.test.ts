import type { ModelProfile, RuntimePolicyDocument } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { policyBlocks } from '../../src/composer/preview.js';

const rule = (modelProfiles: ModelProfile[]) => ({
  version: '1.54.0',
  authModes: ['secret-ref' as const],
  allowUnpinned: false,
  allowUnverified: true,
  modelProfiles,
  defaultProfile: modelProfiles.length > 0 ? (modelProfiles[0]?.name ?? null) : null,
});

describe('composer preview: runtime policy model profiles (same rule as the worker gate)', () => {
  it('a catalog model on a runtime whose policy rule defines no profiles is not a policy refusal', () => {
    const doc: RuntimePolicyDocument = { runtimes: { pi: rule([]) }, projectProfiles: {} };
    expect(policyBlocks(doc, 'pi', 'cluster-test', 'claude-opus-aws')).toEqual([]);
  });

  it('a model that names no policy profile is refused when the rule defines profiles', () => {
    const doc: RuntimePolicyDocument = {
      runtimes: {
        pi: rule([{ name: 'sonnet', provider: 'anthropic', model: 'claude-sonnet-5', params: {} }]),
      },
      projectProfiles: {},
    };
    expect(policyBlocks(doc, 'pi', 'p', 'other').map((r) => r.code)).toEqual(['model_profile_not_allowed']);
    expect(policyBlocks(doc, 'pi', 'p', 'sonnet')).toEqual([]);
  });

  it('a runtime the policy does not list is refused', () => {
    const doc: RuntimePolicyDocument = { runtimes: {}, projectProfiles: {} };
    expect(policyBlocks(doc, 'pi', 'p', undefined).map((r) => r.code)).toEqual([
      'runtime_not_allowed_by_policy',
    ]);
  });
});
