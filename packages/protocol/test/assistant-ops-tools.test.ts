import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_CARD_DEFAULT_TOOLS,
  ASSISTANT_OPS_TOOLS,
  ASSISTANT_OPS_TOOLS_FEATURE,
  ASSISTANT_TOOLS,
  assistantToolDescription,
  assistantToolInput,
  WorkerFeature,
} from '../src/index.js';

/** p18-assistant-gaps (docs/design/p18-assistant-gaps.md): the tools of worker 1.2.1 and their feature. */
describe('assistant ops tools (p18-assistant-gaps)', () => {
  const U = '7d0e2f1a-3b4c-4d5e-8f60-718293a4b5c6';

  it('are in the catalog with the right kinds; the feature is a worker feature', () => {
    expect(WorkerFeature.options).toContain(ASSISTANT_OPS_TOOLS_FEATURE);
    const reads = [
      'describe_workflow_run',
      'list_job_outputs',
      'read_job_output',
      'uptime_history',
      'memory_review',
      'list_output_library',
      'weekly_reports',
    ] as const;
    for (const r of reads) expect(ASSISTANT_TOOLS[r].kind, r).toBe('read');
    for (const t of ASSISTANT_OPS_TOOLS) {
      if ((reads as readonly string[]).includes(t)) continue;
      expect(ASSISTANT_TOOLS[t].kind, t).toBe('draft');
      expect(assistantToolDescription(t)).toContain('Acting:');
    }
    // The answer to a job agent's question is the user's own: a card unless they stated it.
    expect(ASSISTANT_CARD_DEFAULT_TOOLS.has('draft_job_question_answer')).toBe(true);
    expect(ASSISTANT_CARD_DEFAULT_TOOLS.has('draft_backup_action')).toBe(false);
  });

  it('validate their input strictly and cap what a read returns', () => {
    const ok = (t: Parameters<typeof assistantToolInput>[0], v: unknown) =>
      assistantToolInput(t).safeParse(v).success;
    expect(ok('read_job_output', { jobId: U, path: 'reports/a.md', limit: 65536 })).toBe(true);
    expect(ok('read_job_output', { jobId: U, path: 'a.md', limit: 65537 })).toBe(false);
    expect(ok('list_job_outputs', { jobId: U, glob: '**/*.md', limit: 200 })).toBe(true);
    expect(ok('list_job_outputs', { jobId: U, limit: 201 })).toBe(false);
    expect(ok('draft_backup_action', { action: 'restore', backupId: '20261028T0300Z' })).toBe(true);
    expect(ok('draft_backup_action', { action: 'delete' })).toBe(false);
    expect(ok('draft_backup_action', { action: 'restore', backupId: '../etc' })).toBe(false);
    expect(ok('draft_control_plane_update', { version: '1.4.0', acceptBreaking: true })).toBe(true);
    expect(ok('draft_control_plane_update', { version: 'latest' })).toBe(false);
    expect(ok('draft_workflow_approval_decision', { runId: U, nodeRunId: U, decision: 'approve' })).toBe(
      true,
    );
    expect(ok('draft_workflow_approval_decision', { runId: U, nodeRunId: U, decision: 'maybe' })).toBe(false);
    expect(
      ok('draft_job_question_answer', { jobId: U, questionId: U, answers: [{ id: 'q1', text: 'evet' }] }),
    ).toBe(true);
    expect(ok('draft_job_question_answer', { jobId: U, questionId: U, answers: [] })).toBe(false);
    expect(ok('draft_cost_brake', { action: 'lift', scope: 'global', hours: 73, reason: 'x' })).toBe(false);
    expect(ok('draft_monitor_change', { monitorId: U, action: 'pause' })).toBe(true);
    // No tool takes a secret value.
    for (const name of ASSISTANT_OPS_TOOLS)
      for (const k of Object.keys(ASSISTANT_TOOLS[name].input))
        expect(k, `${name}.${k}`).not.toMatch(/token|password|secret|^value$/i);
  });
});
