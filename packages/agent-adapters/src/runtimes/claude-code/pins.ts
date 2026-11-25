/**
 * Pins (ADR-0012, docs/compat/claude-code.md §1). The SDK pin *is* the CLI pin:
 * `@anthropic-ai/claude-agent-sdk@0.3.296` ships `claudeCodeVersion: 2.1.296`
 * and resolves that platform binary. The capability key uses the CLI version
 * (what `claude --version` and the worker probe report).
 */
export const CLAUDE_AGENT_SDK_PIN = '0.3.310';
export const CLAUDE_CODE_CLI_PIN = '2.1.310';

/** Env names that carry an Anthropic-side provider credential (ADR-0014 local-login refuses them). */
export const CLAUDE_PROVIDER_CREDENTIAL_ENV: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'ANTHROPIC_FOUNDRY_API_KEY',
];

/** Never injected in any mode: subscription OAuth token distribution is excluded (ADR-0014 rule 3). */
export const CLAUDE_FORBIDDEN_ENV: readonly string[] = ['CLAUDE_CODE_OAUTH_TOKEN'];
