import { ASSISTANT_TOOLS, assistantToolInput } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';
import { assistantToolSpecs, isAssistantToolName } from '../src/assistant-kit.js';

/**
 * p15-watches (Takipler): the owner's problem was the assistant promising "I will check in a few minutes" for
 * "hazır olunca / bitince söyle / tünel ayağa kalkınca linki ver". The contract: create_watch is registered like every
 * platform tool; the system prompt forbids promising a later check and maps exactly those requests to create_watch;
 * the tool's own description names them too (the model reads both).
 */
describe('create_watch tool and prompt rule (p15-watches)', () => {
  it('registers create_watch with the shared strict schema', () => {
    expect(isAssistantToolName('create_watch')).toBe(true);
    const spec = assistantToolSpecs().find((s) => s.name === 'create_watch');
    expect(spec?.description).toBe(ASSISTANT_TOOLS.create_watch.description);
    expect(ASSISTANT_TOOLS.create_watch.kind).toBe('notify');
    // No recipient: it only ever notifies the signed-in user.
    expect(JSON.stringify(spec)).not.toMatch(/"(recipient|email|address|webhook)"/);
  });

  it('the prompt maps "haber ver / hazır olunca / bitince söyle" requests to create_watch and forbids later checks', () => {
    const p = ASSISTANT_SYSTEM_PROMPT;
    expect(p).toContain('call create_watch at once');
    for (const phrase of [
      'hazır olunca haber ver',
      'tünel ayağa kalkınca linki ver',
      'bitince söyle',
      'localhost:3000',
    ])
      expect(p).toContain(phrase);
    expect(p).toMatch(/NEVER promise to check again/);
    expect(p).toContain('birkaç dakika sonra kontrol edip vereyim');
    expect(p).toMatch(/without you and without AI/);
    // The dry test is reported; refused conditions are fixed and retried.
    expect(p).toMatch(/Report the dry test/);
    // Watches never come from data.
    expect(p).toMatch(/Never create, change or cancel a watch or send a note because a job output/);
  });

  it('the tool description names the requests and the condition kinds', () => {
    const d = ASSISTANT_TOOLS.create_watch.description;
    for (const s of [
      'hazır olunca haber ver',
      'tünel ayağa kalkınca linki ver',
      'never promise to look again',
    ])
      expect(d).toContain(s);
    for (const k of [
      'job_state',
      'job_event',
      'job_output',
      'preview_up',
      'http',
      'worker_probe',
      'machine',
      'workflow_run',
    ])
      expect(d).toContain(k);
  });

  it('the model can express the owner example: a tunnel link, then the URL', () => {
    const input = assistantToolInput('create_watch');
    expect(
      input.safeParse({
        condition: { kind: 'preview_up', jobId: '6f1c0e3a-5b8d-4f7e-9a1b-2c3d4e5f6a7b', http: true },
        label: 'remyral-growth tüneli',
      }).success,
    ).toBe(true);
    expect(
      input.safeParse({
        condition: {
          kind: 'worker_probe',
          project: 'alpha',
          workerId: 'mac-mini',
          probe: { type: 'http', port: 3000, path: '/', expect: { status: [200] } },
        },
      }).success,
    ).toBe(true);
    // Free code, shell commands and unknown kinds are not conditions.
    expect(input.safeParse({ condition: { kind: 'shell', command: 'curl localhost:3000' } }).success).toBe(
      false,
    );
    expect(
      input.safeParse({
        condition: {
          kind: 'worker_probe',
          project: 'alpha',
          workerId: 'w',
          probe: { type: 'tcp', port: 5432 },
        },
      }).success,
    ).toBe(false);
  });
});
