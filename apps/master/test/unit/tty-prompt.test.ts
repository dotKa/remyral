import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { NotATtyError, PromptAbortedError, readHidden, type TtyInput } from '../../src/cli/tty-prompt.js';

class FakeTty extends PassThrough implements TtyInput {
  readonly isTTY = true;
  rawModes: boolean[] = [];
  setRawMode(mode: boolean): this {
    this.rawModes.push(mode);
    return this;
  }
}

function capture(): { out: PassThrough; text: () => string } {
  const out = new PassThrough();
  const chunks: string[] = [];
  out.on('data', (c: Buffer) => chunks.push(c.toString()));
  return { out, text: () => chunks.join('') };
}

describe('readHidden (admin CLI password prompt)', () => {
  it('reads a line with echo off and restores the terminal', async () => {
    const input = new FakeTty();
    const { out, text } = capture();
    const p = readHidden('Password: ', input, out);
    input.write('s3cret-pass');
    input.write('word\r');
    await expect(p).resolves.toBe('s3cret-password');
    await new Promise((r) => setImmediate(r));
    expect(text()).toBe('Password: \n'); // nothing typed is echoed
    expect(input.rawModes).toEqual([true, false]);
  });

  it('handles backspace and ignores escape sequences', async () => {
    const input = new FakeTty();
    const p = readHidden('> ', input, capture().out);
    input.write('abcx\u007f');
    input.write('\u001b[A');
    input.write('d\n');
    await expect(p).resolves.toBe('abcd');
  });

  it('aborts on Ctrl-C', async () => {
    const input = new FakeTty();
    const p = readHidden('> ', input, capture().out);
    input.write('abc\u0003');
    await expect(p).rejects.toBeInstanceOf(PromptAbortedError);
    expect(input.rawModes).toEqual([true, false]);
  });

  it('refuses non-interactive input (no piping passwords in)', async () => {
    const piped = new PassThrough() as unknown as TtyInput;
    await expect(readHidden('> ', piped, capture().out)).rejects.toBeInstanceOf(NotATtyError);
  });
});
