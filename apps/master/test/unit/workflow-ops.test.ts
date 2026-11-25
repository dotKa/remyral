import { describe, expect, it } from 'vitest';
import { concurrencyLock, isPruned, prunedInput, prunedOutput } from '../../src/workflows/v2/ops.js';
import { respondAnswer } from '../../src/workflows/v2/respond.js';

/** p14-workflow-engine 14.4 (design §20): pure helpers of the workflow operations. */
describe('respond to webhook: the answer', () => {
  it('JSON by default, text for strings, status and allowlisted headers', () => {
    expect(respondAnswer({ status: 201, body: { a: 1 } })).toEqual({
      status: 201,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: '{"a":1}',
    });
    expect(respondAnswer({ body: 'hi', headers: { 'x-request-id': 'r1' } })).toEqual({
      status: 200,
      headers: { 'x-request-id': 'r1', 'content-type': 'text/plain; charset=utf-8' },
      body: 'hi',
    });
    // A JSON content type serialises a string as JSON.
    expect(respondAnswer({ body: 'hi', headers: { 'content-type': 'application/json' } })).toMatchObject({
      body: '"hi"',
    });
  });

  it('refuses active content, other headers, header injection, large bodies, bad status', () => {
    for (const t of ['text/html', 'image/svg+xml', 'application/xml', 'text/xml'])
      expect(respondAnswer({ body: 'x', headers: { 'content-type': t } })).toMatchObject({
        code: 'respond_content_type',
      });
    expect(respondAnswer({ headers: { 'set-cookie': 'a=b' } })).toMatchObject({
      code: 'respond_header_invalid',
    });
    expect(respondAnswer({ headers: { etag: 'a\r\nset-cookie: x' } })).toMatchObject({
      code: 'respond_header_invalid',
    });
    expect(respondAnswer({ body: 'x'.repeat(64 * 1024 + 1) })).toMatchObject({
      code: 'respond_body_too_large',
    });
    expect(respondAnswer({ status: 102 })).toMatchObject({ code: 'respond_invalid' });
  });
});

describe('retention: pruned values', () => {
  it('keeps an AI step drawable (role, runtime, job), drops prompts and data', () => {
    const ai = {
      role: 'executor',
      spec: { runtime: 'codex', prompt: 'secret data' },
      def: { id: 'a', role: 'executor', prompt: 'planned with data' },
      placement: { runtime: 'codex' },
      snapshot: [{ node: 'x', field: 'summary', value: 'data' }],
    };
    const p = prunedInput(ai);
    expect(p).toMatchObject({ $pruned: true, role: 'executor', spec: { runtime: 'codex' } });
    expect(JSON.stringify(p)).not.toContain('data');
    expect(prunedInput({ kind: 'pure', value: { a: 1 } })).toEqual({ $pruned: true });
    expect(prunedOutput({ summary: 's', branch: 'b', jobId: 'j', commits: [] })).toEqual({
      $pruned: true,
      jobId: 'j',
      branch: 'b',
    });
    expect(prunedOutput({ ports: { out: 1 } })).toEqual({ $pruned: true });
    expect(prunedOutput(null)).toBeNull();
    expect(isPruned({ $pruned: true })).toBe(true);
    expect(isPruned({ ports: {} })).toBe(false);
  });
});

describe('concurrency groups', () => {
  it('locks are distinct per (project, name, key) and carry no NUL bytes', () => {
    const a = concurrencyLock('p', 'w', null);
    expect(a).not.toBe(concurrencyLock('p', 'w', 'k'));
    expect(concurrencyLock('p', 'w:x', null)).not.toBe(concurrencyLock('p:w', 'x', null));
    expect(a.includes('\u0000')).toBe(false);
  });
});
