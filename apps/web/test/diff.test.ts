import { describe, expect, it } from 'vitest';
import { diffLines, splitLines } from '../src/lib/diff';

describe('splitLines', () => {
  it('has no lines for empty text and ignores one trailing newline', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\r\nb')).toEqual(['a', 'b']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
  });
});

describe('diffLines', () => {
  it('returns only same ops for identical text', () => {
    expect(diffLines('a\nb', 'a\nb')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'same', text: 'b' },
    ]);
  });

  it('marks added and removed lines around common ones', () => {
    expect(diffLines('one\ntwo\nthree\n', 'one\n2\nthree\nfour\n')).toEqual([
      { type: 'same', text: 'one' },
      { type: 'del', text: 'two' },
      { type: 'add', text: '2' },
      { type: 'same', text: 'three' },
      { type: 'add', text: 'four' },
    ]);
  });

  it('handles empty sides', () => {
    expect(diffLines('', 'x\ny')).toEqual([
      { type: 'add', text: 'x' },
      { type: 'add', text: 'y' },
    ]);
    expect(diffLines('x', '')).toEqual([{ type: 'del', text: 'x' }]);
    expect(diffLines('', '')).toEqual([]);
  });

  it('keeps the longest common subsequence', () => {
    const ops = diffLines('a\nb\nc\nd\ne', 'b\nc\nx\ne\nf');
    expect(ops.filter((o) => o.type === 'same').map((o) => o.text)).toEqual(['b', 'c', 'e']);
    expect(ops.filter((o) => o.type === 'del').map((o) => o.text)).toEqual(['a', 'd']);
    expect(ops.filter((o) => o.type === 'add').map((o) => o.text)).toEqual(['x', 'f']);
    // Replaying the ops reproduces both sides.
    expect(ops.filter((o) => o.type !== 'add').map((o) => o.text)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(ops.filter((o) => o.type !== 'del').map((o) => o.text)).toEqual(['b', 'c', 'x', 'e', 'f']);
  });

  it('keeps markup-looking lines as plain text', () => {
    expect(diffLines('', '<img src=x onerror=alert(1)>')).toEqual([
      { type: 'add', text: '<img src=x onerror=alert(1)>' },
    ]);
  });
});
