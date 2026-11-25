import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeCodeAdapter } from '../../../src/index.js';
import { defineAdapterContractSuite, type ContractScenario } from '../../../src/testing/index.js';
import {
  approvalTurn,
  basicTurn,
  FAKE_CLI,
  FakeClaudeSdk,
  longTurn,
  type FakeTurnScript,
} from '../../fixtures/claude-code/fake-sdk.js';

const scripts: Record<ContractScenario, FakeTurnScript> = {
  basic: basicTurn,
  'long-running': longTurn,
  approval: approvalTurn,
};

const stateDir = mkdtempSync(join(tmpdir(), 'remyral-claude-contract-'));
const sdkInfo = () => ({ sdkVersion: '0.3.310', claudeCodeVersion: '2.1.310', packageDir: stateDir });

const posix = process.platform !== 'win32';

// The capabilities are `unverified` until the live run (ADR-0008), so the
// contract kit runs with policy allowUnverified — exactly how a worker would
// have to run this adapter today.
if (posix) {
  defineAdapterContractSuite(
    'claude-code (fake SDK typed by sdk.d.ts 0.3.310, real owned CLI process, secret-ref)',
    (scenario) =>
      createClaudeCodeAdapter({
        authMode: 'secret-ref',
        binaryPath: FAKE_CLI,
        sdkInfo,
        sdk: new FakeClaudeSdk({ script: scripts[scenario] }),
        stateDir,
        credentialConfigured: true,
      }),
    { makeContext: (base) => ({ ...base, allowUnverified: true }) },
  );

  defineAdapterContractSuite(
    'claude-code (fake SDK, local-login, policy forbids unverified capabilities)',
    (scenario) =>
      createClaudeCodeAdapter({
        authMode: 'local-login',
        binaryPath: FAKE_CLI,
        sdkInfo,
        sdk: new FakeClaudeSdk({ script: scripts[scenario] }),
      }),
    // local-login must not receive provider credentials; the canary is a neutral name.
  );
}
