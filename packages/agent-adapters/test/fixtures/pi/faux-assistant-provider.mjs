/* global setTimeout, clearTimeout */
// Scripted model for the *real* Pi binary driven by the ops chat assistant engine (tests only, no credentials,
// no network). Loaded as an operator extension (`settings().extensions`) and selected with
// `--model remyral-faux/scripted`; built on Pi's own `fauxProvider`. Scenario = marker in the latest user message:
//   faux:tools    answers with the tools declared to the model and whether the system prompt is ours
//   faux:relay    calls list_workers {"state":"online"}, then answers with the tool result it received
//   faux:invalid  calls list_workers with an argument its schema refuses, then answers with the result
//   faux:foreign  calls the built-in `bash` (not declared), then answers with the result it received
//   faux:long     "thinks" until the request is aborted
//   (default)     "echo: <last user text>"
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';

function text(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map((c) => c.text ?? '').join('');
  return '';
}

function declaredTools(messages) {
  const tools = new Set();
  for (const m of messages) {
    if (m.role !== 'system') continue;
    for (const t of m.toolsAdded ?? []) tools.add(t.name);
    for (const t of m.toolsRemoved ?? []) tools.delete(typeof t === 'string' ? t : t.name);
  }
  return [...tools].sort();
}

function systemText(messages) {
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => [text(m), ...Object.values(m.sections ?? {}).filter((v) => typeof v === 'string')].join('\n'))
    .join('\n');
}

export default function (pi) {
  const faux = fauxProvider({ provider: 'remyral-faux', models: [{ id: 'scripted' }] });
  pi.registerProvider(faux.provider);
  const step = async (context, options) => {
    const users = context.messages.filter((m) => m.role === 'user');
    const last = text(users.at(-1));
    const results = context.messages
      .slice(context.messages.lastIndexOf(users.at(-1)))
      .filter((m) => m.role === 'toolResult');
    const answer = () => `result=${text(results.at(-1))}|${String(results.at(-1)?.isError === true)}`;
    if (last.includes('faux:tools')) {
      const sys = systemText(context.messages);
      return fauxAssistantMessage(
        `tools=${declaredTools(context.messages).join(',')}|ours=${String(sys.includes('the operations assistant of the Remyral platform'))}`,
      );
    }
    if (last.includes('faux:relay')) {
      if (results.length === 0) {
        return fauxAssistantMessage([fauxToolCall('list_workers', { state: 'online' })], {
          stopReason: 'toolUse',
        });
      }
      return fauxAssistantMessage(answer());
    }
    if (last.includes('faux:invalid')) {
      if (results.length === 0) {
        return fauxAssistantMessage([fauxToolCall('list_workers', { bogus: true })], {
          stopReason: 'toolUse',
        });
      }
      return fauxAssistantMessage(answer());
    }
    if (last.includes('faux:foreign')) {
      if (results.length === 0) {
        return fauxAssistantMessage([fauxToolCall('bash', { command: 'id > pwned.txt' })], {
          stopReason: 'toolUse',
        });
      }
      return fauxAssistantMessage(answer());
    }
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
    return fauxAssistantMessage(`echo: ${last.slice(-40)}`);
  };
  faux.setResponses(Array.from({ length: 200 }, () => step));
}
