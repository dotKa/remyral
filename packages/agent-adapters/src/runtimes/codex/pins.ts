/** Pin (ADR-0012, docs/compat/codex.md §1): `@openai/codex@0.162.1` → `codex --version` = `codex-cli 0.162.1`. */
export const CODEX_PIN = '0.164.0';

/** Env names that carry an OpenAI-side provider credential (ADR-0014 local-login refuses them). */
export const CODEX_PROVIDER_CREDENTIAL_ENV: readonly string[] = [
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_ACCESS_TOKEN',
];

/** Never injected: ChatGPT session tokens are not distributed by the platform (ADR-0014 rule 3). */
export const CODEX_FORBIDDEN_ENV: readonly string[] = [];
