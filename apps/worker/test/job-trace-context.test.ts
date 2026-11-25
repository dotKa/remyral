import { createTelemetry } from '@remyral/observability/telemetry';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { afterEach, describe, expect, it } from 'vitest';
import { JobTelemetry } from '../src/jobs/telemetry.js';

const exporter = new InMemorySpanExporter();
const t = createTelemetry({ serviceName: 'remyral-worker-test', spanExporter: exporter });
afterEach(() => {
  exporter.reset();
});

const job = { jobId: 'job-1', attemptId: 'att-1', epoch: 3, spec: { runtime: 'claude-code' } };
const TP = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('p16-observability: worker job spans continue the master trace', () => {
  it('job.run is a child of the ASSIGN_JOB traceparent and its phases follow', async () => {
    const tel = new JobTelemetry(t);
    const phase = tel.phases(job);
    await tel.run(job, () => phase('spawn', () => Promise.resolve()), TP);
    const spans = exporter.getFinishedSpans();
    const run = spans.find((s) => s.name === 'job.run');
    const spawn = spans.find((s) => s.name === 'job.spawn');
    expect(run?.spanContext().traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(run?.parentSpanContext?.spanId).toBe('00f067aa0ba902b7');
    expect(spawn?.parentSpanContext?.spanId).toBe(run?.spanContext().spanId);
  });

  it('without (or with a malformed) traceparent the run starts its own trace', async () => {
    const tel = new JobTelemetry(t);
    await tel.run(job, () => Promise.resolve(), 'not-a-traceparent');
    const run = exporter.getFinishedSpans().find((s) => s.name === 'job.run');
    expect(run?.parentSpanContext).toBeUndefined();
    expect(run?.spanContext().traceId).not.toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });
});
