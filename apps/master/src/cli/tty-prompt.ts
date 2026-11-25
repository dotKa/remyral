/**
 * Reads a secret from an interactive terminal with echo off (raw mode, nothing is written back except a
 * newline). Refuses non-TTY input so a password can never be piped in from a file, argv or environment
 * (ADR-0009 §2).
 */
export interface TtyInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}

export class PromptAbortedError extends Error {
  override name = 'PromptAbortedError';
}

export class NotATtyError extends Error {
  override name = 'NotATtyError';
  constructor() {
    super('refusing to read a password from a non-interactive input: run this command in a terminal');
  }
}

const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const BACKSPACE = '\u0008';
const DELETE = '\u007f';
const ESC = '\u001b';

export function readHidden(
  prompt: string,
  input: TtyInput = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== 'function') return Promise.reject(new NotATtyError());
  const setRaw = input.setRawMode.bind(input);
  output.write(prompt);
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const finish = (err: Error | null): void => {
      input.removeListener('data', onData);
      setRaw(false);
      input.pause();
      output.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (text.startsWith(ESC)) return; // arrow keys and other escape sequences are ignored
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          finish(null);
          return;
        }
        if (ch === CTRL_C || (ch === CTRL_D && value === '')) {
          finish(new PromptAbortedError('aborted'));
          return;
        }
        if (ch === BACKSPACE || ch === DELETE) {
          value = Array.from(value).slice(0, -1).join('');
          continue;
        }
        if (ch >= ' ') value += ch;
      }
    };
    setRaw(true);
    input.resume();
    input.on('data', onData);
  });
}
