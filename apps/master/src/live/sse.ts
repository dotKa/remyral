/**
 * Server-Sent Events framing (WHATWG HTML §9.2). Data is always JSON: `JSON.stringify` escapes CR and LF,
 * so untrusted text can never end a frame or inject a field; the line split below is a second guard.
 */

export interface SseFrame {
  readonly id?: number;
  readonly event?: string;
  readonly data: unknown;
}

const EVENT_NAME = /^[a-z][a-z_]{0,31}$/;

export function encodeFrame(f: SseFrame): string {
  let out = '';
  if (f.event !== undefined) {
    if (!EVENT_NAME.test(f.event)) throw new Error('invalid SSE event name');
    out += `event: ${f.event}\n`;
  }
  if (f.id !== undefined) {
    if (!Number.isSafeInteger(f.id) || f.id < 0) throw new Error('invalid SSE id');
    out += `id: ${String(f.id)}\n`;
  }
  const json = JSON.stringify(f.data);
  for (const line of json.split(/\r\n|\r|\n/)) out += `data: ${line}\n`;
  return `${out}\n`;
}

export function comment(text: string): string {
  return `: ${text.replace(/[\r\n]/g, ' ')}\n\n`;
}

export function retry(ms: number): string {
  return `retry: ${String(Math.max(0, Math.trunc(ms)))}\n\n`;
}

/** `Last-Event-ID` / `?after=`: a non-negative stream sequence, or null when absent or malformed. */
export function parseCursor(value: string | string[] | undefined): number | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (v === undefined) return null;
  const t = v.trim();
  if (!/^(0|[1-9][0-9]{0,14})$/.test(t)) return null;
  return Number(t);
}
