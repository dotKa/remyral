import type { Shape } from '../shape.js';
import type tr from '../tr/verifierJobs.js';

/** p19-verifier-jobs: platform verifier jobs (badge, title, outcome, could-not-run causes, retry). */
export default {
  badge: 'Verification',
  badgeTitle: 'A verification job the platform started; its result is the verified job’s result.',
  title: {
    verify: (p) => `Verify: ${p.title}`,
    health: (p) => `Health check: ${p.title}`,
    'integration-verify': (p) => `Integration verification: ${p.title}`,
  },
  outcome: {
    verified: 'Verified',
    issues: 'Verification found issues',
    unverifiable: 'Could not verify',
    running: 'Verifying',
  },
  checkedJob: 'Verified job',
  openChecked: 'Open the verified job',
  cause: {
    git_auth: 'the repository could not be read (no git credential)',
    git_network: 'the repository could not be reached (network error)',
    timeout: 'the verifier ran out of time',
    runtime_crash: 'the agent runtime crashed',
    login: 'the agent runtime’s login expired',
    disk_low: 'the machine is out of disk space',
    provider_error: 'the model provider returned an error',
    machine_lost: 'the verifier’s machine stopped answering',
    cancelled: 'the verifier job was cancelled',
    not_started: 'the verifier job could not be started',
    no_report: 'the verifier produced no valid report',
    verifier_missing: 'the verifier job no longer exists',
    run_failed: 'the verifier job ended with an error',
  },
  couldNotRun: (p) => `Verification could not run: ${p.cause}`,
  retry: 'Retry verification',
  retrying: 'Starting…',
  retried: 'The verification starts again; a new verifier job opens within a few seconds.',
  retryFailed: (p) => `The verification could not be started again: ${p.error}`,
  resultLine: (p) => `Verification: ${p.outcome}`,
} satisfies Shape<typeof tr>;
