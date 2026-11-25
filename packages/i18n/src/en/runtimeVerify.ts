import type { Shape } from '../shape.js';
import type tr from '../tr/runtimeVerify.js';

/**
 * p17-runtime-verify: proving runtime capabilities from the panel — “Verify” on the Machine → Runtimes row, live
 * progress, results per capability and history; proven versions per platform and the number of runtimes that depend
 * on “Allow unverified” in Tools and versions / Runtime policy; “Mark as verified” in the version catalog.
 */
export default {
  title: 'Proof',
  state: {
    verified: 'Proven',
    partial: 'Partly proven',
    unverified: 'Not proven',
    not_applicable: 'No proof information',
  },
  provenBy: 'Proven ({machine}, {when})',
  partialBy: 'Partly proven ({machine}, {when}): {caps} did not pass',
  notProven: 'Not proven: {reason}',
  noRun: 'no verification has run for this version and platform yet',
  failedCaps: '{caps} did not pass',
  fleetWide:
    'The proof counts for every machine with the same runtime version and platform; another version or adapter needs a new verification.',
  olderWorker:
    'This machine’s version cannot verify runtimes; update the machine first (Settings → Machine versions).',
  verify: 'Verify',
  verifyAgain: 'Verify again',
  verifyWhy: '{machine}: verify the capabilities of {runtime}',
  confirmTitle: 'Verify {runtime} {version} on this machine?',
  confirmBody:
    'The real runtime runs a short scenario set: a small task that writes a file (with an approval), resuming the same session and a long command that is cancelled. The sign-in or key the machine uses for jobs is used; it runs confined like a job, in a repository that is deleted afterwards.',
  confirmCost:
    'Expected: about {tokens} tokens and {minutes} minutes (limit: {maxTokens} tokens, {maxMinutes} minutes).',
  authSubscription: 'The subscription login is used: tokens count against the subscription’s quota.',
  authKey: 'The API key is used: tokens are billed to the provider account.',
  authNone:
    'No job sign-in is configured for this runtime; the verification will most likely end with a sign-in error.',
  start: 'Start verification',
  cancel: 'Cancel',
  stop: 'Stop verification',
  running: 'Verifying…',
  steps: {
    task: 'task session',
    resume: 'resume',
    long: 'long command and cancel',
  },
  capability: {
    streaming: 'Streaming',
    interactive_prompt: 'Messages while running',
    approval: 'Approval',
    cancel: 'Cancel',
    safe_cancel: 'Safe cancel',
    resume: 'Resume',
    cost_reporting: 'Cost reporting',
    artifacts: 'Artifacts',
  },
  outcome: {
    passed: 'passed',
    failed: 'failed',
    skipped: 'skipped',
  },
  effective: {
    supported: 'supported',
    degraded: 'limited',
    unverified: 'not proven',
    unsupported: 'unsupported',
    unknown: 'unknown',
  },
  stoppedBy: {
    time_budget: 'time limit reached',
    token_budget: 'token limit reached',
    cancelled: 'stopped',
    error: 'error',
  },
  usage: '{tokens} tokens · {seconds} s',
  refused: 'The machine did not start the verification: {reason}',
  evidenceRefused: 'The proof the machine sent was refused (signature not valid); the result does not count.',
  results: 'Result per capability',
  history: 'History',
  historyLine: '{when} · {version} · {passed} passed, {failed} failed',
  historyExpired: 'no longer valid (other version or adapter)',
  platforms: {
    title: 'Proven runtime versions',
    sub: 'Per platform, which runtime version was proven from the panel. Another runtime version or adapter needs a new verification.',
    empty: 'No proof yet. Start with Machine → Runtimes → Verify.',
    verified: '{caps} proven',
    failed: '{caps} did not pass',
    expired: 'the adapter changed; verify again',
    by: '{machine}, {when}',
  },
  policy: {
    title: 'Dependence on unproven capabilities',
    none: 'No runtime uses job capabilities without proof; “Allow unverified” in the policies can be turned off.',
    count:
      '{n} of {total} runtimes still use job capabilities (streaming, cancel, approval) without proof; they run only because the policy has “Allow unverified”.',
    path: 'The way out: Machine → Runtimes → Verify for each; once all are proven, untick “Allow unverified” in the policy.',
    item: '{machine}: {runtime} {version} ({platform}) — {caps}',
    updateFirst: 'update the machine first',
    open: 'Open machine',
  },
  catalog: {
    proven: 'Proven ({machine}, {when})',
    failed: 'Verification did not pass ({when})',
    partial: 'Partly proven ({when})',
    marked: 'Verified on this installation ({when})',
    mark: 'Mark as verified',
    markWhy: 'mark {runtime} {version} as verified on this installation',
    markQuestion:
      '{runtime} {version} passed its verification on the canary machine. Mark it as verified on this installation? The signed catalog does not change: making the version verified for everyone is the vendor’s catalog routine.',
    vendorNote:
      'The mark is for this installation only; the capability effect comes from the proof. A version becomes verified for everyone in the vendor’s weekly catalog routine (promote and sign).',
    verifyFirst: 'First run Machine → Runtimes → Verify on the canary machine',
  },
} satisfies Shape<typeof tr>;
