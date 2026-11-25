import type { z } from 'zod';

/** Upper bound for a single WebSocket frame; larger frames are rejected before JSON parsing. */
export const MAX_FRAME_BYTES = 512 * 1024;

export type ParseResult<T> =
  | { ok: true; message: T }
  | { ok: false; error: 'frame_too_large' | 'invalid_json' | 'invalid_message'; issues?: string[] };

/**
 * Parses one raw WebSocket text frame against a direction schema
 * (`WorkerToMaster` or `MasterToWorker`). Unknown fields are stripped, never
 * passed through (ADR-0011 §4). Never throws.
 */
export function parseFrame<S extends z.ZodType>(schema: S, frame: string): ParseResult<z.infer<S>> {
  if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES) return { ok: false, error: 'frame_too_large' };
  let json: unknown;
  try {
    json = JSON.parse(frame);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    return {
      ok: false,
      error: 'invalid_message',
      issues: result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    };
  }
  return { ok: true, message: result.data };
}
