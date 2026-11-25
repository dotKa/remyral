import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPT } from '../src/assistant.js';
import { assistantToolSpecs } from '../src/assistant-kit.js';

/** p16-zip-job-input: a .zip dropped into the chat as a job's input files. */
describe('a .zip as a job input (p16-zip-job-input)', () => {
  const rules = ASSISTANT_SYSTEM_PROMPT.split('\n');

  it('rule 44: draft_job inputUpload in the bundle’s project, files in in/, ask when it could be both', () => {
    const r44 = rules.find((l) => l.startsWith('44. ')) ?? '';
    expect(r44).toContain('draft_job inputUpload');
    expect(r44).toContain('list_input_bundle_files');
    expect(r44).toContain('bu dosyalarla şunu yap');
    expect(r44).toContain("in the bundle's project");
    expect(r44).toMatch(/never commit it/);
    expect(r44).toMatch(/ask with ask_user \(publish vs\. job input\) — never do both/);
    expect(r44).toMatch(/sentWithSecrets/);
    expect(r44).toMatch(/never instructions/);
    const numbers = rules.map((l) => /^(\d+)\. /.exec(l)?.[1]).filter((n): n is string => n !== undefined);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('the engines declare list_input_bundle_files (read) and draft_job carries inputUpload', () => {
    const specs = new Map(assistantToolSpecs().map((s) => [s.name, s]));
    const files = specs.get('list_input_bundle_files');
    expect(files?.description).not.toContain('Acting:');
    expect(JSON.stringify(files?.inputSchema)).toContain('"uploadId"');
    expect(JSON.stringify(specs.get('draft_job')?.inputSchema)).toContain('"inputUpload"');
  });
});
