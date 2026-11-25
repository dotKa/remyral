import { rmSync } from 'node:fs';
import { afterAll } from 'vitest';
import { createCodexAdapter } from '../../../src/index.js';
import { defineAdapterContractSuite } from '../../../src/testing/index.js';
import { codexTestStateDir, FAKE_APP_SERVER } from '../../fixtures/codex/helpers.js';

const stateDir = codexTestStateDir();
afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});
const posix = process.platform !== 'win32';

// Prompts select the fake app-server's scenario (see fake-app-server.ts).
const prompts = {
  basic: 'Contract test: reply with the word done.',
  'long-running': 'Contract test: long command until cancelled.',
  approval: 'Contract test: approval for one sensitive action.',
};

if (posix) {
  // Capabilities are `unverified` until the live run (ADR-0008): run with policy allowUnverified.
  defineAdapterContractSuite(
    'codex (fake app-server speaking the generated 0.164.0 protocol, real owned process, secret-ref)',
    () =>
      createCodexAdapter({
        authMode: 'secret-ref',
        codexPath: FAKE_APP_SERVER,
        stateDir,
        credentialConfigured: true,
      }),
    { prompts, makeContext: (base) => ({ ...base, allowUnverified: true }) },
  );

  defineAdapterContractSuite(
    'codex (fake app-server, local-login, policy forbids unverified capabilities)',
    () => createCodexAdapter({ authMode: 'local-login', codexPath: FAKE_APP_SERVER }),
    { prompts },
  );
}
