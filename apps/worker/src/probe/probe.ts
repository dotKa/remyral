import { RuntimeKind } from '@remyral/protocol';
import { buildRuntimeReport, detectRuntime } from '../runtimes/detect.js';
import { runSelfTest } from '../runtimes/selftest.js';
import type { System } from '../system/types.js';
import { probeHost } from './host.js';
import { PROBE_SCHEMA_VERSION, ProbeReport, type Problem, type RuntimeReport } from './report.js';
import { probeSandboxProfiles } from './sandbox.js';
import { probeTools } from './tools.js';
import { WORKER_VERSION } from '../version.js';

export { WORKER_VERSION };

export interface ProbeOptions {
  selfTest: boolean;
  runtime: RuntimeKind | null;
  /** p3-runtime-policy: pins from the applied master policy (override the compiled-in table). */
  pins?: Partial<Record<RuntimeKind, string>> | undefined;
}

/**
 * Runs the whole probe. Each section is isolated: a section that throws becomes a
 * `probe.section_failed` error instead of aborting the report. The result is validated
 * against {@link ProbeReport} before it is returned.
 */
export async function runProbe(sys: System, options: ProbeOptions): Promise<ProbeReport> {
  const started = sys.monotonicMs();
  const probedAt = sys.now().toISOString();
  const problems: Problem[] = [];
  const sectionFailed = (section: string, error: unknown) => {
    problems.push({
      code: 'probe.section_failed',
      severity: 'error',
      message: `${section} probe crashed: ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        512,
      ),
    });
  };

  const hostPart = await probeHost(sys);
  problems.push(...hostPart.problems);

  let tools: Awaited<ReturnType<typeof probeTools>>['tools'] = [];
  try {
    const t = await probeTools(sys);
    tools = t.tools;
    problems.push(...t.problems);
  } catch (error) {
    sectionFailed('tools', error);
  }

  const kinds = options.runtime ? [options.runtime] : RuntimeKind.options;
  const runtimes: RuntimeReport[] = [];
  for (const kind of kinds) {
    try {
      const detected = await detectRuntime(sys, kind);
      const built = buildRuntimeReport(sys, detected, options.pins?.[kind]);
      problems.push(...built.problems);
      if (options.selfTest && detected.installed && detected.launch) {
        const st = await runSelfTest(sys, kind, detected.launch);
        built.report.selfTest = st.result;
        problems.push(...st.problems);
      }
      runtimes.push(built.report);
    } catch (error) {
      sectionFailed(`runtime ${kind}`, error);
    }
  }

  const sandbox = probeSandboxProfiles(sys.platform, tools, runtimes);
  problems.push(...sandbox.problems);

  return ProbeReport.parse({
    schemaVersion: PROBE_SCHEMA_VERSION,
    probedAt,
    probe: {
      workerVersion: WORKER_VERSION,
      durationMs: Math.max(0, Math.round(sys.monotonicMs() - started)),
      selfTest: options.selfTest,
      runtimeFilter: options.runtime,
    },
    host: hostPart.host,
    tools,
    runtimes,
    sandboxProfiles: sandbox.profiles,
    problems,
  });
}
