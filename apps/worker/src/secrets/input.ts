import { InvalidSecretValueError } from './errors.js';
import { MAX_SECRET_VALUE_LENGTH } from './ref.js';

/** Minimal TTY surface (process.stdin when it is a terminal). */
export interface TtyInput {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  removeListener(event: 'data', listener: (chunk: string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface PromptOutput {
  write(text: string): unknown;
}

const ESC = String.fromCharCode(0x1b);

export class SecretInputAbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'SecretInputAbortedError';
  }
}

/**
 * Reads a line from a terminal with echo off (raw mode: nothing is echoed, the
 * terminal mode is restored on every path). Enter ends input, Backspace/DEL edit,
 * Ctrl-C/Ctrl-D (on an empty line) abort. Bracketed-paste markers are ignored.
 */
export function readHiddenLine(input: TtyInput, output: PromptOutput, prompt: string): Promise<string> {
  if (input.isTTY !== true || typeof input.setRawMode !== 'function') {
    return Promise.reject(
      new InvalidSecretValueError('stdin is not a terminal; pipe the value and use --stdin'),
    );
  }
  const setRaw = input.setRawMode.bind(input);
  output.write(prompt);
  setRaw(true);
  input.setEncoding('utf8');
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const finish = (error: Error | null) => {
      input.removeListener('data', onData);
      setRaw(false);
      input.pause();
      output.write('\n');
      if (error === null) resolve(value);
      else reject(error);
    };
    const onData = (chunk: string) => {
      const text = chunk.split(`${ESC}[200~`).join('').split(`${ESC}[201~`).join('');
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          finish(null);
          return;
        }
        if (ch === '\u0003' || (ch === '\u0004' && value === '')) {
          finish(new SecretInputAbortedError());
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = Array.from(value).slice(0, -1).join(''); // code points: what a terminal deletes
          continue;
        }
        if (ch < ' ') continue;
        value += ch;
        if (value.length > MAX_SECRET_VALUE_LENGTH) {
          finish(new InvalidSecretValueError('too long'));
          return;
        }
      }
    };
    input.on('data', onData);
    input.resume();
  });
}

/** Reads all of stdin (bounded) and strips one trailing newline (`echo "$KEY" | …`). */
export async function readAllStdin(stream: AsyncIterable<Buffer | string>): Promise<string> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += b.length;
    if (size > MAX_SECRET_VALUE_LENGTH * 4 + 2) throw new InvalidSecretValueError('too long');
    parts.push(b);
  }
  return Buffer.concat(parts)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}
