import { describe, expect, it } from 'vitest';
import { ASSISTANT_TOOLS, assistantToolInput } from '../src/assistant.js';
import {
  AssignedInputBundle,
  EXECUTABLE_EXTENSIONS,
  executableKind,
  executableProblem,
  INPUT_BUNDLE_FEATURE,
  INPUT_BUNDLE_LIMITS,
  InputBundleDataPayload,
  InputBundleRequestPayload,
  inputBundlePathKey,
  inputBundlePathProblem,
  inputBundleProblems,
} from '../src/input-bundles.js';
import { AssignJob } from '../src/master-messages.js';
import { WorkerFeature } from '../src/worker-features.js';
import { masterMessages, workerMessages } from './fixtures.js';

const UUID = '7b0c4f1e-1d2a-4c3b-9a8e-0f1e2d3c4b5a';
const SHA = 'a'.repeat(64);

describe('job input bundles (p16-zip-job-input)', () => {
  it('path rule: relative, safe on every worker OS, hidden files allowed', () => {
    for (const ok of [
      'README.md',
      'src/main.rs',
      '.gitignore',
      '.env.example',
      'docs/Sunum çalışması.pdf',
      'a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p.txt',
      'data/2026-10-23 rapor (son).xlsx',
      'nested/archive.zip',
    ]) {
      expect(inputBundlePathProblem(ok), ok).toBeNull();
    }
    const bad: [string, string][] = [
      ['', 'empty path'],
      ['/etc/passwd', 'not a relative path'],
      ['C:/x.txt', 'not a relative path'],
      ['a\\b.txt', 'not a relative path'],
      ['../x', 'unsafe path segment'],
      ['a/./b', 'unsafe path segment'],
      ['a//b', 'unsafe path segment'],
      ['a/\u0007b', 'name has control characters'],
      ['a/b?.txt', 'name has characters that are not allowed'],
      ['a/b:c', 'name has characters that are not allowed'],
      ['trailing./x', 'name ends with a dot or a space'],
      ['space /x', 'name ends with a dot or a space'],
      ['con.txt', 'reserved device name'],
      ['LPT1', 'reserved device name'],
      ['.git/config', 'git metadata folder'],
      ['src/.git/HEAD', 'git metadata folder'],
      ['x'.repeat(301), 'path too long'],
      [`${'a/'.repeat(16)}x`, 'nested too deep'],
      ['cafe\u0301.txt', 'name is not in Unicode NFC form'],
    ];
    for (const [p, why] of bad) expect(inputBundlePathProblem(p), p).toBe(why);
    expect(inputBundlePathKey('Src/Main.RS')).toBe(inputBundlePathKey('src/main.rs'));
  });

  it('executables: ELF, PE (with its header), Mach-O by magic bytes and by extension — unless allowed', () => {
    const elf = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
    expect(executableKind(elf)).toMatch(/ELF/);
    expect(executableKind(Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe]))).toMatch(/Mach-O/);
    expect(executableKind(Uint8Array.from([0xca, 0xfe, 0xba, 0xbe]))).toMatch(/universal/);
    const pe = new Uint8Array(256);
    pe.set([0x4d, 0x5a]);
    pe[0x3c] = 0x80;
    pe.set([0x50, 0x45, 0, 0], 0x80);
    expect(executableKind(pe)).toMatch(/PE/);
    // "MZ" text without a PE header is not an executable.
    expect(executableKind(new TextEncoder().encode(`MZ notes ${'x'.repeat(100)}`))).toBeNull();
    expect(executableKind(new TextEncoder().encode('#!/bin/sh\necho hi\n'))).toBeNull();
    expect(executableProblem('bin/tool', elf, false)).toMatch(/not allowed/);
    expect(executableProblem('bin/tool', elf, true)).toBeNull();
    expect(executableProblem('setup.EXE', new Uint8Array(4), false)).toMatch(/\.exe file/);
    expect(executableProblem('lib/libx.so', new Uint8Array(4), false)).toMatch(/\.so file/);
    expect(executableProblem('script.sh', new TextEncoder().encode('echo'), false)).toBeNull();
    expect(EXECUTABLE_EXTENSIONS.has('dll')).toBe(true);
  });

  it('bundle problems: no files, more than 2000 files, more than 100 MiB', () => {
    expect(inputBundleProblems([])).toEqual(['no_files']);
    expect(inputBundleProblems([{ path: 'a', size: 1 }])).toEqual([]);
    const many = Array.from({ length: INPUT_BUNDLE_LIMITS.maxFiles + 1 }, (_, i) => ({
      path: `f${String(i)}`,
      size: 1,
    }));
    expect(inputBundleProblems(many)).toEqual(['too_many_files']);
    expect(inputBundleProblems([{ path: 'a', size: INPUT_BUNDLE_LIMITS.maxTotalBytes + 1 }])).toEqual([
      'too_large',
    ]);
  });

  it('wire: ASSIGN_JOB execution.inputBundle, INPUT_BUNDLE_REQUEST / DATA, the feature', () => {
    expect(WorkerFeature.safeParse(INPUT_BUNDLE_FEATURE).success).toBe(true);
    const assigned = { uploadId: UUID, files: 3, totalBytes: 10, bundleSha256: SHA };
    expect(AssignedInputBundle.parse(assigned)).toEqual(assigned);
    expect(AssignedInputBundle.safeParse({ ...assigned, files: 0 }).success).toBe(false);
    expect(AssignedInputBundle.safeParse({ ...assigned, files: 2001 }).success).toBe(false);
    const assign = structuredClone(masterMessages.ASSIGN_JOB) as { payload: { execution?: object } };
    assign.payload.execution = { hostExecutionOptIn: false, inputBundle: assigned };
    expect(AssignJob.safeParse(assign).success).toBe(true);
    expect(workerMessages.INPUT_BUNDLE_REQUEST).toBeDefined();
    expect(masterMessages.INPUT_BUNDLE_DATA).toBeDefined();
    const req = { attemptId: 'att_01', epoch: 3, requestId: UUID };
    expect(InputBundleRequestPayload.safeParse({ ...req, op: { op: 'list', offset: 0 } }).success).toBe(true);
    expect(
      InputBundleRequestPayload.safeParse({ ...req, op: { op: 'read', index: 2000, offset: 0 } }).success,
    ).toBe(false);
    expect(
      InputBundleDataPayload.safeParse({
        ...req,
        status: 'ok',
        entries: [{ index: 0, path: '../x', size: 1, sha256: SHA }],
        total: 1,
      }).success,
    ).toBe(false);
    expect(
      InputBundleDataPayload.safeParse({
        ...req,
        status: 'ok',
        entries: [{ index: 0, path: 'src/a.ts', size: 1, sha256: SHA }],
        total: 1,
      }).success,
    ).toBe(true);
    const tooBig = 'A'.repeat(Math.ceil(INPUT_BUNDLE_LIMITS.chunkBytes / 3) * 4 + 4);
    expect(InputBundleDataPayload.safeParse({ ...req, status: 'ok', data: tooBig }).success).toBe(false);
  });

  it('assistant tools: draft_job.inputUpload and list_input_bundle_files (strict read tool)', () => {
    const draft = assistantToolInput('draft_job');
    expect(
      draft.safeParse({ project: 'p', title: 't', prompt: 'x', runtime: 'codex', inputUpload: UUID }).success,
    ).toBe(true);
    expect(
      draft.safeParse({ project: 'p', title: 't', prompt: 'x', runtime: 'codex', inputUpload: 'nope' })
        .success,
    ).toBe(false);
    expect(ASSISTANT_TOOLS.draft_job.description).toContain('inputUpload');
    expect(ASSISTANT_TOOLS.list_input_bundle_files.kind).toBe('read');
    const files = assistantToolInput('list_input_bundle_files');
    expect(files.safeParse({ uploadId: UUID, offset: 25, limit: 100 }).success).toBe(true);
    expect(files.safeParse({ uploadId: UUID, limit: 501 }).success).toBe(false);
    expect(files.safeParse({ uploadId: UUID, extra: 1 }).success).toBe(false);
  });
});
