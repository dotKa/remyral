import type { JsonlCodec } from '../../stdio-jsonl.js';
import { PI_DIALOG_METHODS, PiInbound, type PiCommand, type PiUiAnswer } from './schema.js';

const DIALOGS: ReadonlySet<string> = new Set(PI_DIALOG_METHODS);

/**
 * Pi RPC framing (docs/rpc.md): commands `{id?, type, ...}`, responses
 * `{type:"response", id?, command, success, data?|error?}` correlated by `id`,
 * session events without id, and the extension-UI subprotocol where Pi asks
 * (`extension_ui_request{id, method}`) and the client answers
 * `extension_ui_response{id, value|confirmed|cancelled}` with no response record.
 */
export const piCodec: JsonlCodec<PiInbound, PiCommand> = {
  schema: PiInbound,
  classify(message) {
    if (message.type === 'response') {
      // A parse-error response has no id: surfaced to the adapter as a notification.
      if (message.id === undefined) return { kind: 'notification' };
      return message.success
        ? { kind: 'response', id: message.id, ok: true, result: message.data }
        : { kind: 'response', id: message.id, ok: false, error: message.error ?? 'unknown error' };
    }
    if (message.type === 'extension_ui_request' && DIALOGS.has(message.method)) {
      return { kind: 'request', id: message.id };
    }
    return { kind: 'notification' };
  },
  encodeRequest: (id, request) => ({ ...request, id }),
  encodeResponse: (id, result) => ({ type: 'extension_ui_response', id, ...(result as PiUiAnswer) }),
};
