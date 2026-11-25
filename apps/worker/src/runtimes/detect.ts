import { Capability, type RuntimeKind } from '@remyral/protocol';
import { locateBinary } from '../probe/locate.js';
import type { PinStatus, Problem, RuntimeReport } from '../probe/report.js';
import { readVersion } from '../probe/tools.js';
import { extractVersion } from '../probe/version.js';
import type { System } from '../system/types.js';
import { CAPABILITY_MATRIX, platformNotes, statusFor } from './matrix.js';
import { RUNTIME_PINS } from './pins.js';

/** How to start a runtime's executable. */
export interface Launch {
  file: string;
  prefixArgs: string[];
}

export interface DetectedRuntime {
  runtime: RuntimeKind;
  installed: boolean;
  binaryPath: string | null;
  version: string | null;
  launch: Launch | null;
  notes: string[];
}

async function detectCli(sys: System, runtime: RuntimeKind): Promise<DetectedRuntime> {
  const pin = RUNTIME_PINS[runtime];
  const notes: string[] = [];
  const path = await locateBinary(sys, pin.binary);
  if (!path) return { runtime, installed: false, binaryPath: null, version: null, launch: null, notes };
  // Version flag per docs/compat/<runtime>.md: `--version` for all four CLIs.
  const v = await readVersion(sys, path, ['--version']);
  if (v.timedOut) notes.push('`--version` timed out');
  else if (v.exitCode !== 0) notes.push(`\`--version\` exited with ${String(v.exitCode)}`);
  if (runtime === 'pi') {
    const real = (await sys.realpath(path)) ?? path;
    if (real.includes('@mariozechner')) {
      notes.push(
        '`pi` resolves to the deprecated @mariozechner/pi-coding-agent; the pin is @earendil-works/pi-coding-agent',
      );
    }
  }
  return {
    runtime,
    installed: true,
    binaryPath: path,
    version: v.version ? (extractVersion(v.version) ?? v.version) : null,
    launch: { file: path, prefixArgs: [] },
    notes,
  };
}

export function detectRuntime(sys: System, runtime: RuntimeKind): Promise<DetectedRuntime> {
  return detectCli(sys, runtime);
}

export function pinStatusOf(
  detected: Pick<DetectedRuntime, 'installed' | 'version' | 'runtime'>,
  pinned: string = RUNTIME_PINS[detected.runtime].version,
): PinStatus {
  if (!detected.installed) return 'not-installed';
  if (!detected.version) return 'unknown';
  return detected.version === pinned ? 'match' : 'mismatch';
}

/**
 * Turns a detection into the report entry. ADR-0008: nothing here is contract-tested,
 * so an installed runtime reports `unverified` for every capability; a runtime that is
 * not installed reports `unsupported` (absent on this host). A pin mismatch is noted on
 * every capability.
 */
export function buildRuntimeReport(
  sys: System,
  detected: DetectedRuntime,
  /** p3-runtime-policy: the master policy's pin for this runtime; default the compiled-in table. */
  policyPin?: string,
): { report: RuntimeReport; problems: Problem[] } {
  const compiled = RUNTIME_PINS[detected.runtime];
  const pin =
    policyPin === undefined
      ? compiled
      : {
          ...compiled,
          version: policyPin,
          install: `version ${policyPin} pinned by the runtime policy (owner installs it; docs/design/p3-runtime-policy.md §7)`,
        };
  const pinStatus = pinStatusOf(detected, pin.version);
  const problems: Problem[] = [];
  const notes = [...detected.notes];

  if (detected.installed) notes.push(...platformNotes(detected.runtime, sys.platform, sys.arch));
  if (policyPin !== undefined) notes.push(`pin ${policyPin} from the master runtime policy`);

  const capabilities: RuntimeReport['capabilities']['capabilities'] = {};
  for (const capability of Capability.options) {
    const cell = CAPABILITY_MATRIX[detected.runtime][capability];
    if (!detected.installed) {
      capabilities[capability] = { status: 'unsupported', note: 'runtime not installed on this host' };
      continue;
    }
    const parts = [`compat ${cell.level}: ${cell.note}`, 'not contract-tested on this worker'];
    if (pinStatus === 'mismatch')
      parts.unshift(`pinMismatch: ${detected.version ?? '?'} != pin ${pin.version}`);
    if (pinStatus === 'unknown') parts.unshift('version unreadable; pin cannot be confirmed');
    capabilities[capability] = { status: statusFor(cell.level), note: parts.join('; ') };
  }

  if (pinStatus === 'mismatch') {
    notes.push(`pinMismatch: found ${detected.version ?? '?'}, pinned ${pin.version} (${pin.install})`);
    problems.push({
      code: 'runtime.pin_mismatch',
      severity: 'warning',
      message: `${detected.runtime} ${detected.version ?? '?'} differs from pin ${pin.version}; all capabilities unverified (ADR-0012). Install: ${pin.install}`,
    });
  } else if (pinStatus === 'unknown') {
    problems.push({
      code: 'runtime.version_unreadable',
      severity: 'warning',
      message: `${detected.runtime} found at ${detected.binaryPath ?? '?'} but \`${pin.versionCommand}\` gave no version.`,
    });
  } else if (pinStatus === 'not-installed') {
    problems.push({
      code: 'runtime.not_installed',
      severity: 'info',
      message: `${detected.runtime} not found (pin ${pin.version}: ${pin.install}).`,
    });
  }

  return {
    report: {
      runtime: detected.runtime,
      capabilities: {
        runtime: detected.runtime,
        version: detected.installed ? (detected.version ?? 'unknown') : 'not-installed',
        installed: detected.installed,
        // Never derived from credential files or env values (task rule; ADR-0006).
        authenticated: 'unknown',
        capabilities,
      },
      binaryPath: detected.binaryPath,
      pin: pin.version,
      pinStatus,
      notes: notes.map((n) => n.slice(0, 512)),
    },
    problems,
  };
}
