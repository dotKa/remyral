import type { ApprovalSummary } from '../../api/jobs';
import type { IconName } from '../icons';
import type { JobThreadItem, ToolCall } from './mapping';
import { TR_FORMAT } from '../common/time';
import { type Formatter, type Messages, messagesFor } from '@remyral/i18n';
import { type MessageDelivery, pairDeliveries } from './delivery';

/**
 * p12-diyalog panels (docs/design/p12-diyalog.md §10): the job's "Akış günlüğü" — the Faz 2 mapping (`buildJobThread`)
 * flattened into one chronological activity log: every row is time · kind icon · one line. The agent's narration is a
 * plain line (the full Markdown one click away), each tool call its own foldable row, state changes and notices system
 * rows, approvals a system row pointing at the decision panel. Pure; filtered and searched without rendering.
 */

export type LogGroup = 'agent' | 'tools' | 'system';
export type LogFilter = 'all' | LogGroup | 'errors';

/** The filter chips, in order (their words: `t.job.log.filters`). */
export const FILTERS: readonly LogFilter[] = ['all', 'agent', 'tools', 'system', 'errors'];

const TR = messagesFor('tr');

export type LogRow =
  | {
      readonly kind: 'text';
      readonly key: string;
      readonly at: string;
      readonly group: LogGroup;
      readonly icon: IconName;
      /** Who / what: the runtime for narration, "sen" for a person's message. */
      readonly who: 'agent' | 'me' | 'system';
      readonly text: string;
      /** The full text (Markdown for narration, plain for prompts) when it is longer than the line. */
      readonly body: string | null;
      readonly markdown: boolean;
      readonly error: boolean;
      readonly pending?: boolean | undefined;
      /** p15-message-delivery: a message a person sent to the agent, with how far it got. */
      readonly delivery?: MessageDelivery | undefined;
    }
  | {
      readonly kind: 'tool';
      readonly key: string;
      readonly at: string;
      readonly group: 'tools';
      readonly call: ToolCall;
      readonly error: boolean;
    }
  | {
      readonly kind: 'approval';
      readonly key: string;
      readonly at: string;
      readonly group: 'system';
      readonly requestId: string | null;
      readonly text: string;
      /** pending / approved / denied / expired / … (null: not registered yet). */
      readonly status: string | null;
      readonly error: boolean;
    };

/** The first line of a text, without Markdown decoration, at most `max` characters. */
export function lineOf(text: string, max = 220): string {
  const first =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? '';
  const plain = first
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

function more(text: string, line: string): boolean {
  return text.trim() !== line && text.trim().length > 0;
}

export function logRows(
  items: readonly JobThreadItem[],
  approvals: readonly ApprovalSummary[],
  messages: readonly MessageDelivery[] = [],
  t: Messages = TR,
): LogRow[] {
  const w = t.job.log;
  const status = new Map(approvals.map((a) => [a.id, a.status] as const));
  const out: LogRow[] = [];
  // p15-message-delivery: the agent's echo of each message carries its state; the rest wait at the end.
  const { byKey, unmatched } = pairDeliveries(
    items.flatMap((i) => (i.kind === 'said' ? [{ key: i.key, text: i.text }] : [])),
    messages,
  );
  for (const it of items) {
    switch (it.kind) {
      case 'prompt': {
        const line = lineOf(it.text);
        out.push({
          kind: 'text',
          key: it.key,
          at: it.at,
          group: 'agent',
          icon: 'pen',
          who: 'me',
          text: w.prompt({ line }),
          body: more(it.text, line) ? it.text : null,
          markdown: false,
          error: false,
        });
        break;
      }
      case 'context':
        out.push({
          kind: 'text',
          key: it.key,
          at: it.at,
          group: 'agent',
          icon: 'file',
          who: 'system',
          text: w.context({ n: it.text.length }),
          body: it.text,
          markdown: false,
          error: false,
        });
        break;
      case 'said': {
        const line = lineOf(it.text);
        out.push({
          kind: 'text',
          key: it.key,
          at: it.at,
          group: 'agent',
          icon: 'send',
          who: 'me',
          text: w.said({ line }),
          body: more(it.text, line) ? it.text : null,
          markdown: false,
          error: byKey.get(it.key)?.status === 'failed',
          delivery: byKey.get(it.key),
        });
        break;
      }
      case 'agent': {
        if (it.text !== null) {
          const line = lineOf(it.text);
          out.push({
            kind: 'text',
            key: it.key,
            at: it.at,
            group: 'agent',
            icon: 'msg',
            who: 'agent',
            text: line,
            body: more(it.text, line) ? it.text : null,
            markdown: true,
            error: false,
          });
        }
        for (const call of it.tools)
          out.push({
            kind: 'tool',
            key: call.key,
            at: call.at,
            group: 'tools',
            call,
            error: call.result !== null && !call.result.ok,
          });
        break;
      }
      case 'line':
        out.push({
          kind: 'text',
          key: it.key,
          at: it.at,
          group: 'system',
          icon: it.icon,
          who: 'system',
          text: it.text,
          body: null,
          markdown: false,
          error: it.tone === 'warn',
        });
        break;
      case 'approval': {
        const st = it.requestId === null ? null : (status.get(it.requestId) ?? 'pending');
        out.push({
          kind: 'approval',
          key: it.key,
          at: it.at,
          group: 'system',
          requestId: it.requestId,
          text: w.approval({
            action: it.action,
            description: it.description === '' ? '' : lineOf(it.description, 160),
          }),
          status: st,
          error: st === 'denied' || st === 'rejected',
        });
        break;
      }
    }
  }
  for (const m of unmatched)
    out.push({
      kind: 'text',
      key: `message:${m.id}`,
      at: m.createdAt,
      group: 'agent',
      icon: 'send',
      who: 'me',
      text: w.said({ line: lineOf(m.text) }),
      body: more(m.text, lineOf(m.text)) ? m.text : null,
      markdown: false,
      error: m.status === 'failed',
      pending: m.status !== 'failed',
      delivery: m,
    });
  return out;
}

function haystack(r: LogRow): string {
  if (r.kind === 'tool') return `${r.call.name} ${r.call.input} ${r.call.result?.output ?? ''}`;
  if (r.kind === 'approval') return r.text;
  return `${r.text} ${r.body ?? ''}`;
}

export function matches(r: LogRow, filter: LogFilter, query: string): boolean {
  if (filter === 'errors' ? !r.error : filter !== 'all' && r.group !== filter) return false;
  const q = query.trim().toLocaleLowerCase('tr-TR');
  return q === '' || haystack(r).toLocaleLowerCase('tr-TR').includes(q);
}

export function counts(rows: readonly LogRow[]): Readonly<Record<LogFilter, number>> {
  return {
    all: rows.length,
    agent: rows.filter((r) => r.group === 'agent').length,
    tools: rows.filter((r) => r.group === 'tools').length,
    system: rows.filter((r) => r.group === 'system').length,
    errors: rows.filter((r) => r.error).length,
  };
}

/** "14:02:31" — log rows carry seconds. */
export function logTime(iso: string, f: Formatter = TR_FORMAT): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return f.dateWith(t, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
