import { DEFAULT_RULES, Redactor } from '@remyral/observability';
import { safeMarkdown, safeMarkdownLine } from './markdown-safe.js';
import type { DraftView, MessageView } from './store.js';

/**
 * p16-chat-complete (docs/design/p16-chat-complete.md §3): one export document of a conversation for the caller's
 * view (the owner's, or a reader's filtered view), rendered as Markdown here and as a print page by the console.
 * Only the current branch (superseded rows are counted, not shown); per message its files (name, kind, size) and
 * mentions; tool rows as one line; cards with their final state and the links the caller can open — never card
 * payloads, never file bytes. Every text passes the redactor again.
 */

export type ExportLang = 'tr' | 'en';

export interface ExportLink {
  readonly label: string;
  readonly href: string;
}

export type ExportItem =
  | {
      readonly kind: 'message';
      readonly role: 'user' | 'assistant';
      readonly author: string;
      readonly at: string;
      readonly text: string;
      readonly attachments: readonly {
        readonly name: string;
        readonly kind: string;
        readonly sizeBytes: number | null;
      }[];
      readonly mentions: readonly string[];
      /** A regenerated / retried answer: the engine and model it came from. */
      readonly regenerated: { readonly runtime: string | null; readonly model: string | null } | null;
      readonly edited: boolean;
    }
  | { readonly kind: 'tools'; readonly at: string; readonly names: readonly string[] }
  | { readonly kind: 'notice'; readonly at: string; readonly text: string; readonly error: boolean }
  | {
      readonly kind: 'card';
      readonly at: string;
      readonly cardKind: string;
      readonly title: string;
      readonly state: string;
      readonly decidedAt: string | null;
      readonly links: readonly ExportLink[];
      readonly restricted: boolean;
    };

export interface ExportDoc {
  readonly version: 1;
  readonly thread: {
    readonly id: string;
    readonly title: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly owner: string;
  };
  readonly exportedAt: string;
  readonly exportedBy: string;
  readonly access: 'owner' | 'reader';
  /** Rows replaced by an edit / regenerate / retry (not exported). */
  readonly omittedVersions: number;
  readonly items: readonly ExportItem[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Links of a decided card the caller can open (console paths). */
export function cardLinks(d: DraftView): ExportLink[] {
  const r = d.result ?? {};
  const out: ExportLink[] = [];
  const add = (label: string, href: string): void => {
    if (!out.some((l) => l.href === href)) out.push({ label, href });
  };
  const id = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);
  const job = id(r.jobId);
  if (job !== null) add(`job ${job.slice(0, 8)}`, `/jobs/${job}`);
  for (const j of Array.isArray(r.jobIds) ? r.jobIds : []) {
    const x = id(j);
    if (x !== null) add(`job ${x.slice(0, 8)}`, `/jobs/${x}`);
  }
  const action = id(r.actionId);
  if (action !== null) add(`deploy ${action.slice(0, 8)}`, `/deploys/${action}`);
  const automation = id(r.automationId);
  if (automation !== null) add(`automation ${automation.slice(0, 8)}`, `/automations/${automation}`);
  for (const key of ['link', 'url', 'liveUrl']) {
    const v = r[key];
    if (typeof v === 'string' && (/^\/[A-Za-z0-9/_?=&.-]*$/.test(v) || /^https:\/\/[^\s<>"]+$/.test(v)))
      add(key, v.slice(0, 500));
  }
  return out.slice(0, 10);
}

function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? v.filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object')
    : [];
}

/** Builds the export document from the caller's view of the thread (all rows; superseded ones are only counted). */
export function buildExport(input: {
  readonly thread: { id: string; title: string; createdAt: string; updatedAt: string };
  readonly owner: string;
  readonly exportedBy: string;
  readonly access: 'owner' | 'reader';
  readonly messages: readonly MessageView[];
  readonly drafts: readonly (DraftView & { restricted?: boolean })[];
  readonly now: Date;
}): ExportDoc {
  const redactor = new Redactor({ rules: DEFAULT_RULES });
  const red = (s: string): string => redactor.redact(s);
  const current = input.messages.filter((m) => m.supersededAt === undefined);
  const drafts = new Map(input.drafts.map((d) => [d.id, d] as const));
  const placed = new Set<string>();
  const card = (d: DraftView & { restricted?: boolean }): ExportItem => ({
    kind: 'card',
    at: d.decidedAt ?? d.createdAt,
    cardKind: d.kind,
    title: d.restricted === true ? '' : red(d.title),
    state: d.state,
    decidedAt: d.decidedAt,
    links: d.restricted === true ? [] : cardLinks(d),
    restricted: d.restricted === true,
  });
  const items: ExportItem[] = [];
  let tools: { at: string; names: string[]; cards: string[] } | null = null;
  const flush = (): void => {
    if (tools === null) return;
    items.push({ kind: 'tools', at: tools.at, names: [...new Set(tools.names)] });
    for (const id of tools.cards) {
      const d = drafts.get(id);
      if (d !== undefined && !placed.has(id)) {
        placed.add(id);
        items.push(card(d));
      }
    }
    tools = null;
  };
  for (const m of current) {
    if (m.role === 'tool') {
      tools ??= { at: m.createdAt, names: [], cards: [] };
      const name = typeof m.meta?.name === 'string' ? m.meta.name : 'tool';
      tools.names.push(name);
      if (typeof m.meta?.draftId === 'string') tools.cards.push(m.meta.draftId);
      continue;
    }
    flush();
    if (m.role === 'error') {
      items.push({
        kind: 'notice',
        at: m.createdAt,
        text: red(m.content),
        error: m.meta?.notice === undefined,
      });
      continue;
    }
    const meta = m.meta ?? {};
    const regen: unknown = meta.regenerated;
    items.push({
      kind: 'message',
      role: m.role,
      author: m.role === 'user' ? input.owner : 'assistant',
      at: m.createdAt,
      text: red(m.content),
      attachments: [
        ...list(meta.attachments).map((a) => ({
          name: red(typeof a.name === 'string' ? a.name : 'file'),
          kind: typeof a.kind === 'string' ? a.kind : 'file',
          sizeBytes: typeof a.sizeBytes === 'number' ? a.sizeBytes : null,
        })),
        ...list(meta.siteUploads).map((u) => ({
          name: red(typeof u.label === 'string' ? u.label : 'site.zip'),
          kind: 'site',
          sizeBytes: typeof u.totalBytes === 'number' ? u.totalBytes : null,
        })),
      ],
      mentions: list(meta.mentions)
        .filter((c) => c.restricted !== true && typeof c.label === 'string' && c.label !== '')
        .map((c) => red(`@${String(c.label)}`)),
      regenerated:
        typeof regen !== 'object' || regen === null
          ? null
          : {
              runtime:
                typeof (regen as { runtime?: unknown }).runtime === 'string'
                  ? (regen as { runtime: string }).runtime
                  : null,
              model:
                typeof (regen as { model?: unknown }).model === 'string'
                  ? (regen as { model: string }).model
                  : null,
            },
      edited: typeof meta.editOf === 'string',
    });
  }
  flush();
  for (const d of input.drafts) if (!placed.has(d.id)) items.push(card(d));
  return {
    version: 1,
    thread: { ...input.thread, title: red(input.thread.title), owner: input.owner },
    exportedAt: input.now.toISOString(),
    exportedBy: input.exportedBy,
    access: input.access,
    omittedVersions: input.messages.length - current.length,
    items,
  };
}

interface Words {
  readonly owner: string;
  readonly exported: string;
  readonly by: string;
  readonly assistant: string;
  readonly tools: string;
  readonly files: string;
  readonly mentions: string;
  readonly card: string;
  readonly restricted: string;
  readonly state: string;
  readonly edited: string;
  readonly regenerated: string;
  readonly omitted: string;
  readonly notice: string;
  readonly error: string;
  readonly madeWith: string;
}

const WORDS: Readonly<Record<ExportLang, Words>> = {
  tr: {
    owner: 'Sahibi',
    exported: 'Dışa aktarıldı',
    by: 'aktaran',
    assistant: 'Asistan',
    tools: 'Kullanılan araçlar',
    files: 'Ekler',
    mentions: 'Etiketler',
    card: 'Kart',
    restricted: 'erişimin yok',
    state: 'durum',
    edited: 'düzenlendi',
    regenerated: 'yeniden üretildi',
    omitted: 'önceki sürüm dışa aktarılmadı',
    notice: 'Not',
    error: 'Hata',
    madeWith: 'Remyral ile dışa aktarıldı · remyral.com',
  },
  en: {
    owner: 'Owner',
    exported: 'Exported',
    by: 'by',
    assistant: 'Assistant',
    tools: 'Tools used',
    files: 'Files',
    mentions: 'Mentions',
    card: 'Card',
    restricted: 'no access',
    state: 'state',
    edited: 'edited',
    regenerated: 'regenerated',
    omitted: 'earlier versions not exported',
    notice: 'Note',
    error: 'Error',
    madeWith: 'Exported with Remyral · remyral.com',
  },
};

function size(n: number | null): string {
  if (n === null) return '';
  if (n < 1024) return ` (${String(n)} B)`;
  if (n < 1024 * 1024) return ` (${(n / 1024).toFixed(1)} KB)`;
  return ` (${(n / 1024 / 1024).toFixed(1)} MB)`;
}

/** The Markdown file of an export document. */
export function exportMarkdown(doc: ExportDoc, lang: ExportLang = 'en'): string {
  const w = WORDS[lang];
  const lines: string[] = [];
  const time = (iso: string): string => iso.replace('T', ' ').slice(0, 16);
  lines.push(`# ${safeMarkdownLine(doc.thread.title)}`, '');
  lines.push(
    `${w.owner}: ${safeMarkdownLine(doc.thread.owner)} · ${w.exported}: ${time(doc.exportedAt)} UTC (${w.by} ${safeMarkdownLine(doc.exportedBy)})`,
  );
  if (doc.omittedVersions > 0) lines.push('', `_${String(doc.omittedVersions)} ${w.omitted}._`);
  lines.push('', '---', '');
  for (const it of doc.items) {
    switch (it.kind) {
      case 'message': {
        const who = it.role === 'user' ? safeMarkdownLine(it.author) : w.assistant;
        const tags = [
          it.edited ? w.edited : null,
          it.regenerated === null
            ? null
            : `${w.regenerated}${it.regenerated.runtime === null ? '' : ` · ${it.regenerated.runtime}`}${it.regenerated.model === null ? '' : ` · ${it.regenerated.model}`}`,
        ].filter((x): x is string => x !== null);
        lines.push(`**${who}** · ${time(it.at)}${tags.length === 0 ? '' : ` · _${tags.join(', ')}_`}`, '');
        // Raw message text: no HTML and no script links in a viewer that renders them (code is kept as is).
        if (it.text.trim() !== '') lines.push(safeMarkdown(it.text), '');
        if (it.attachments.length > 0)
          lines.push(
            `> ${w.files}: ${it.attachments.map((a) => `${safeMarkdownLine(a.name)} [${safeMarkdownLine(a.kind)}]${size(a.sizeBytes)}`).join(', ')}`,
            '',
          );
        if (it.mentions.length > 0)
          lines.push(`> ${w.mentions}: ${safeMarkdownLine(it.mentions.join(', '))}`, '');
        break;
      }
      case 'tools':
        lines.push(`_${w.tools}: ${safeMarkdownLine(it.names.join(', '))}_`, '');
        break;
      case 'notice':
        lines.push(`> ${it.error ? w.error : w.notice}: ${safeMarkdownLine(it.text)}`, '');
        break;
      case 'card':
        if (it.restricted) {
          lines.push(`- ${w.card} (${it.cardKind}): _${w.restricted}_`, '');
        } else {
          // Parentheses in a (validated) URL would end the link early and start another one.
          const links = it.links
            .map(
              (l) => `[${safeMarkdownLine(l.label)}](${l.href.replace(/\(/g, '%28').replace(/\)/g, '%29')})`,
            )
            .join(' · ');
          lines.push(
            `- ${w.card} (${it.cardKind}): **${safeMarkdownLine(it.title)}** — ${w.state}: ${it.state}${it.decidedAt === null ? '' : ` (${time(it.decidedAt)})`}${links === '' ? '' : ` — ${links}`}`,
            '',
          );
        }
        break;
    }
  }
  // p17-remyral-brand: the product the document comes from (the vendor's site, not this installation's address).
  lines.push('', '---', '', `_${w.madeWith}_`);
  return `${lines.join('\n').trimEnd()}\n`;
}

/** A file name for the export: the title's letters and digits (ASCII), else "conversation". */
export function exportFileName(title: string, ext: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase();
  return `${base === '' ? 'conversation' : base}.${ext}`;
}
