/* global setTimeout, clearTimeout */
// Scripted model for the *real* Pi binary (tests only, no credentials, no network).
// Loaded by the adapter with `-e <this file>` (PiAdapterOptions.extraExtensions) and
// selected with `--model remyral-faux/scripted`. Uses Pi's own test provider
// (`fauxProvider` from @earendil-works/pi-ai, which Pi supplies to extensions).
// Scenario = marker in the latest user message:
//   faux:long          the model "thinks" until the request is aborted
//   faux:approval      bash `echo approved > approved.txt`, then "finished"
//   faux:sleep:<n>     bash `sleep <n> & sleep <n+1>` (process-tree tests), then "slept"
//   faux:context       answers whether the system prompt contains REMYRAL-CONTEXT-CANARY
//   faux:history       answers with the number of user messages in the transcript
//   faux:tool:<name>:<json>  calls tool <name> with the JSON arguments, then answers
//                      "tool-result: <the tool's text>" (p8-subtasks-pi)
//   (default)          read README.md, then "done: <last user text>"
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';

function text(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map((c) => c.text ?? '').join('');
  return '';
}

function systemText(m) {
  const sections = m.sections ? Object.values(m.sections).filter((v) => typeof v === 'string') : [];
  return [text(m), ...sections].join('\n');
}

export default function (pi) {
  const faux = fauxProvider({ provider: 'remyral-faux', models: [{ id: 'scripted' }] });
  pi.registerProvider(faux.provider);
  const step = async (context, options) => {
    const users = context.messages.filter((m) => m.role === 'user');
    const last = text(users.at(-1));
    const lastUserIndex = context.messages.lastIndexOf(users.at(-1));
    const toolResults = context.messages.slice(lastUserIndex).filter((m) => m.role === 'toolResult').length;
    if (last.includes('faux:long')) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 600_000);
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          resolve();
        });
      });
      return fauxAssistantMessage('', { stopReason: 'aborted', errorMessage: 'aborted' });
    }
    const sleep = /faux:sleep:(\d+)/.exec(last);
    if (sleep) {
      const n = Number(sleep[1]);
      if (toolResults === 0) {
        return fauxAssistantMessage(
          [fauxToolCall('bash', { command: `sleep ${n} & sleep ${n + 1}; echo end` })],
          {
            stopReason: 'toolUse',
          },
        );
      }
      return fauxAssistantMessage('slept');
    }
    if (last.includes('faux:approval')) {
      if (toolResults === 0) {
        return fauxAssistantMessage(
          [fauxText('need to write'), fauxToolCall('bash', { command: 'echo approved > approved.txt' })],
          { stopReason: 'toolUse' },
        );
      }
      return fauxAssistantMessage('finished');
    }
    if (last.includes('faux:context')) {
      const system = context.messages
        .filter((m) => m.role === 'system')
        .map(systemText)
        .join('\n');
      return fauxAssistantMessage(
        `context-canary:${system.includes('REMYRAL-CONTEXT-CANARY') ? 'yes' : 'no'}`,
      );
    }
    const toolCall = /faux:tool:([a-z_]+):(\{.*\})/s.exec(last);
    if (toolCall) {
      if (toolResults === 0) {
        return fauxAssistantMessage([fauxToolCall(toolCall[1], JSON.parse(toolCall[2]))], {
          stopReason: 'toolUse',
        });
      }
      const result = context.messages
        .slice(lastUserIndex)
        .filter((m) => m.role === 'toolResult')
        .at(-1);
      return fauxAssistantMessage(`tool-result: ${text(result)}`);
    }
    if (last.includes('faux:history')) {
      return fauxAssistantMessage(`history:${String(users.length)}`);
    }
    if (toolResults === 0) {
      return fauxAssistantMessage([fauxText('ack'), fauxToolCall('read', { path: 'README.md' })], {
        stopReason: 'toolUse',
      });
    }
    return fauxAssistantMessage(`done: ${last.slice(0, 40)}`);
  };
  faux.setResponses(Array.from({ length: 200 }, () => step));
}
