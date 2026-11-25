import type { Shape } from '../shape.js';
import type tr from '../tr/runtimeUpdates.js';

/**
 * p16-runtime-updates: runtime versions above the release pin (unverified) — matrix and Machine → Runtimes badges,
 * per-machine buttons, the bulk option, the 409 skip list, Verification candidates, Settings → Security → Fleet and
 * the chat's runtime update card.
 */
export default {
  badge: 'Unverified version (pin: {pin})',
  badgeHint:
    'This version is newer than the one the machine software release pins; its capabilities count as unverified, jobs still run. Going back to the pin is one step.',
  offer: 'Can be installed as unverified: {version}',
  install: 'Install as unverified ({version})',
  installWhy: '{machine}: install {runtime} {version} as unverified',
  installQuestion:
    '{runtime} {version} is outside the pin ({pin}). It is installed from the official npm package with a sha512 integrity check; its capabilities stay unverified. Install it?',
  rollback: 'Back to the pin ({version})',
  rollbackWhy: '{machine}: return {runtime} to the pin {version}',
  rollbackQuestion: 'Return {runtime} to the pin {version}?',
  started: 'Started — progress in Tools and versions → Fleet actions.',
  summary: {
    installable: '{n} installable',
    releaseRequired: '{n} need a machine software release',
    unverifiedActive: '{n} unverified versions running',
  },
  bulk: {
    unverified: 'Install the newer version outside the pin as unverified',
    unverifiedHint:
      'The source has a version newer than the pin ({version}). It is installed from the official npm package at that exact version with a sha512 integrity check; its capabilities stay unverified, jobs run, going back to the pin is one step.',
    unverifiedOff:
      'The source has a version newer than the pin ({version}), but the security policy does not allow versions outside the pins (Settings → Security → Fleet).',
    latest: 'Newest at the source ({version})',
  },
  skipped: {
    title: 'None of the machines can take this action now',
    some: 'Some machines did not take this action',
    line: '{machine}: {reason}',
  },
  candidates: {
    title: 'Verification candidates',
    sub: 'Runtime versions newer than the pin are checked automatically on a canary machine (daily and when the source changes).',
    honest:
      'Verified candidate: the automatable checks (integrity, version, help / local authentication, adapter probe) passed on one canary machine. A model prompt and the contract suite are not automated. The version stays unverified until a machine software release pins it.',
    empty: 'No candidates yet: the versions at the source are not newer than the pins, or not resolved yet.',
    count: '{n} candidates',
    pin: 'pin {pin}',
    machine: '{machine} · {platform}',
    when: 'last run {when}',
    verifyNow: 'Verify now',
    verifyWhy: 'Verify {runtime} {version} on a canary machine',
    verifyStarted: 'Verification started ({machine}).',
    lock: 'Lockfile (package-lock.json)',
    reason: 'Reason: {reason}',
    states: {
      none: 'not run',
      running: 'checking',
      passed: 'verified candidate',
      failed: 'did not pass',
    },
    runStates: {
      running: 'running',
      passed: 'passed',
      failed: 'failed',
      error: 'could not finish',
    },
    checks: {
      integrity: 'Integrity (sha512)',
      version: 'Version command',
      bundled_version: 'Bundled Claude Code version',
      help: 'Help command',
      server_auth: 'Local server authentication',
      adapter_probe: 'Adapter probe',
      headless_prompt: 'Model prompt',
      contract_suite: 'Contract suite',
    },
    checkStates: {
      passed: 'passed',
      failed: 'failed',
      skipped: 'not automated',
    },
  },
  policy: {
    title: 'Runtime updates',
    hint: 'Runtime versions are pinned in every machine software release. This setting lets a newer version from the source be installed without waiting.',
    switch: 'Unverified runtime updates',
    switchHint:
      'On: a version newer than the pin can be installed labelled “unverified”, jobs run on it and new versions are checked automatically on a canary machine. Off: only pinned versions are installed. Default: on.',
  },
  card: {
    kind: 'Runtime update',
    label: 'Runtime update',
    runtime: 'Runtime',
    version: 'Version',
    machines: 'Machines',
    rollout: 'Rollout',
    canaryFirst: 'canary first',
    allAtOnce: 'all at once',
    rollback: 'Back to the pin {pin}',
    unverified:
      'Unverified version (pin: {pin}) — its capabilities stay unverified, jobs run, going back to the pin is one step.',
    target: '{machine}: {from} → {to}',
    skippedLine: '{machine} will not take it: {reason}',
  },
} satisfies Shape<typeof tr>;
