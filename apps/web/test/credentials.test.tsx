import { afterEach, describe, expect, it, vi } from 'vitest';
import { credentialValueProblem, envProblem } from '../src/api/vault';
import { entryOf } from '../src/screens/modelForm';

const VALUE = 'sk-ant-api03-test-value-0123456789';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('client-side checks', () => {
  it('refuses Claude subscription tokens, short values and code-loading env vars', () => {
    expect(credentialValueProblem('sk-ant-oat01-abcdefghijklmnop')).toMatch(/subscription/);
    expect(credentialValueProblem('abc')).not.toBeNull();
    expect(credentialValueProblem(VALUE)).toBeNull();
    expect(envProblem('NODE_OPTIONS')).not.toBeNull();
    expect(envProblem('CLAUDE_CODE_OAUTH_TOKEN')).toMatch(/local login/);
    expect(envProblem('OPENROUTER_API_KEY')).toBeNull();
  });
});

describe('Settings → Models', () => {
  it('entryOf parses params and credential references', () => {
    const form = {
      id: 'or',
      displayName: 'OpenRouter',
      description: '',
      runtimes: ['pi'],
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.5',
      credSource: 'vault',
      credName: 'openrouter',
      credEnv: '',
      params: 'temperature=0.2\ncaching=true',
      contextWindow: '',
      maxOutputTokens: '',
      inputPerMTok: '',
      outputPerMTok: '',
      enabled: true,
    } as const;
    const { entry } = entryOf({ ...form, runtimes: ['pi'] });
    expect(entry).toMatchObject({
      credentialRef: { source: 'vault', id: 'openrouter' },
      params: { temperature: 0.2, caching: true },
    });
    expect(entry).not.toHaveProperty('baseUrl');
    expect(entryOf({ ...form, runtimes: ['pi'], credEnv: 'bad env' }).errors.credEnv).toBeDefined();
  });
});
