import { describe, expect, it } from 'vitest';
import { minimalEnv } from '../src/runtimes/session-kit/platform.js';

describe('p15-git-central: allowlisted runtimes keep the job-local git / gh configuration', () => {
  it('passes GIT_CONFIG_* / GH_CONFIG_DIR / prompts off, never a token the job env did not choose', () => {
    const env = minimalEnv({
      PATH: '/usr/bin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/ws/sandboxes/j/a/runtime/git/config',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GH_CONFIG_DIR: '/ws/sandboxes/j/a/runtime/gh',
      GH_PROMPT_DISABLED: '1',
      GIT_AUTHOR_EMAIL: 'bot@example.com',
      GH_TOKEN: 'ghp_not_for_the_agent',
      REMYRAL_GIT_TOKEN: 'ghs_not_for_the_agent',
    });
    expect(env).toMatchObject({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/ws/sandboxes/j/a/runtime/git/config',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GH_CONFIG_DIR: '/ws/sandboxes/j/a/runtime/gh',
      GH_PROMPT_DISABLED: '1',
      GIT_AUTHOR_EMAIL: 'bot@example.com',
    });
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.REMYRAL_GIT_TOKEN).toBeUndefined();
  });
});
