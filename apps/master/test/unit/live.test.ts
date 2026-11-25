import { describe, expect, it } from 'vitest';
import { LiveRedactor } from '../../src/live/redact.js';
import { comment, encodeFrame, parseCursor, retry } from '../../src/live/sse.js';
import { capPatch } from '../../src/gitflow/types.js';

const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;

describe('live master redaction (ADR-0006 second stage)', () => {
  const r = new LiveRedactor();

  it('redacts secret patterns in one chunk', () => {
    expect(r.chunk(`push with ${TOKEN} now`, null).text).toBe('push with [REDACTED:github-token] now');
  });

  it('leaves clean text and the previous chunk alone', () => {
    expect(r.chunk('hello world', 'previous line\n')).toEqual({ text: 'hello world', previous: null });
  });

  it('catches a secret split across two chunks and rewrites the previous chunk', () => {
    const prev = `line one\ntoken=${TOKEN.slice(0, 12)}`;
    const next = `${TOKEN.slice(12)} done\n`;
    const out = r.chunk(next, prev);
    expect(out.previous).toBe('line one\ntoken=[REDACTED:github-token]');
    expect(out.text).toBe(' done\n');
    expect(out.text + (out.previous ?? '')).not.toContain(TOKEN.slice(12));
  });

  it('a secret entirely in the new chunk after a clean previous chunk', () => {
    const out = r.chunk(`x ${TOKEN}`, 'a'.repeat(5000));
    expect(out).toEqual({ text: 'x [REDACTED:github-token]', previous: null });
  });

  it('does not re-mark a marker that is already in the previous chunk', () => {
    const out = r.chunk('more text', 'before [REDACTED:github-token] after');
    expect(out.previous).toBeNull();
  });

  it('redacts every string of an event deeply, sensitive keys included', () => {
    const ev = r.deep({
      kind: 'tool_call',
      inputSummary: `curl -H "Authorization: Bearer ${TOKEN}"`,
      apiKey: 'x',
    });
    expect(JSON.stringify(ev)).not.toContain(TOKEN);
    expect(ev.apiKey).toBe('[REDACTED:key]');
  });
});

describe('SSE framing', () => {
  it('encodes id, event and JSON data on one line; newlines in values cannot inject fields', () => {
    const f = encodeFrame({ id: 7, event: 'log', data: { text: 'a\nevent: evil\ndata: x\r\n\nid: 99' } });
    const lines = f.split('\n');
    expect(lines[0]).toBe('event: log');
    expect(lines[1]).toBe('id: 7');
    expect(lines.filter((l) => l.startsWith('data: '))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith('id: '))).toHaveLength(1);
    expect(f.endsWith('\n\n')).toBe(true);
    expect(JSON.parse(lines[2]?.slice(6) ?? '')).toEqual({ text: 'a\nevent: evil\ndata: x\r\n\nid: 99' });
  });

  it('refuses invalid event names and ids', () => {
    expect(() => encodeFrame({ event: 'a\nb', data: 1 })).toThrow();
    expect(() => encodeFrame({ id: -1, data: 1 })).toThrow();
  });

  it('comments and retry', () => {
    expect(comment('hb\nx')).toBe(': hb x\n\n');
    expect(retry(3000)).toBe('retry: 3000\n\n');
  });

  it('parses Last-Event-ID strictly', () => {
    expect(parseCursor('42')).toBe(42);
    expect(parseCursor(' 0 ')).toBe(0);
    expect(parseCursor(['5', '6'])).toBe(5);
    for (const bad of [undefined, '', '-1', '1e3', '01', 'abc', '9'.repeat(20)]) {
      expect(parseCursor(bad)).toBeNull();
    }
  });
});

describe('patch cap', () => {
  it('cuts on a line boundary and flags truncation', () => {
    expect(capPatch('a\nb\n', 10)).toEqual({ text: 'a\nb\n', truncated: false });
    expect(capPatch('line1\nline2\nline3\n', 14)).toEqual({ text: 'line1\nline2\n', truncated: true });
    expect(capPatch('äääää', 3).text).toBe('ä');
  });
});
