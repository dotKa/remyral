import { type Messages, messagesFor } from '@remyral/i18n';

/**
 * p12-diyalog Faz 3: the composer's slash commands (docs/design/p12-diyalog.md §11.3). A command is a short way to
 * state an intent; on sending, `/komut metin` becomes the person's own words followed by one plain line that names the
 * intent and the assistant tool that serves it (draft_job, list_approvals, runtime_limits, describe_worker,
 * draft_job_action, draft_from_template …). The assistant reads it like any message — no new tool, no prompt change —
 * and anything that would change something still arrives as a card to confirm. Pure (unit tested).
 */

export interface SlashCommand {
  /** Shown and typed form ("/iş"). */
  readonly name: string;
  /** ASCII alias typed on keyboards without Turkish letters ("/is"). */
  readonly alias: string;
  /** One line in the list. */
  readonly hint: string;
  /** What the person still has to write after the command (empty: nothing). */
  readonly needs: string;
  /** The intent line appended to the person's words. */
  readonly intent: (arg: string) => string;
}

type SlashKey = Exclude<keyof Messages['chatCompose']['slash'], 'missing' | 'template'>;

/**
 * The commands as typed. The names are command syntax and stay the same in every language (the words that
 * describe them come from the `chatCompose.slash` catalog).
 */
const COMMANDS: readonly { readonly key: SlashKey; readonly name: string; readonly alias: string }[] = [
  { key: 'job', name: '/iş', alias: '/is' }, // i18n-ignore: command syntax
  { key: 'publish', name: '/yayınla', alias: '/yayinla' }, // i18n-ignore: command syntax
  { key: 'approvals', name: '/onaylar', alias: '/onaylar' },
  { key: 'limits', name: '/limitler', alias: '/limitler' },
  { key: 'machine', name: '/makine', alias: '/makine' },
  { key: 'cancel', name: '/iptal', alias: '/iptal' },
  { key: 'rerun', name: '/yeniden', alias: '/yeniden' },
];

const TR = messagesFor('tr');

/** The slash commands with their words in `t`'s language. */
export function slashCommands(t: Messages): SlashCommand[] {
  return COMMANDS.map((c) => {
    const w = t.chatCompose.slash[c.key];
    return {
      name: c.name,
      alias: c.alias,
      hint: w.hint,
      needs: 'needs' in w ? w.needs : '',
      // The machine command names its tool through a parameter (the identifier is not copy).
      intent: () => (typeof w.intent === 'string' ? w.intent : w.intent({ tool: 'describe_worker' })),
    };
  });
}

/** The commands in Turkish (the default of the helpers below). */
export const SLASH_COMMANDS: readonly SlashCommand[] = slashCommands(TR);

const FOLD: Readonly<Record<string, string>> = { ı: 'i', ş: 's', ğ: 'g', ç: 'c', ö: 'o', ü: 'u' };

/** Lower case with Turkish letters folded ("/İŞ" → "/is"). */
export function fold(s: string): string {
  return s
    .toLocaleLowerCase('tr')
    .replace(/[ışğçöü]/g, (c) => FOLD[c] ?? c)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** The commands matching what is typed so far ("/" → all, "/ye" → /yeniden, "/yayinla"…). */
export function matchCommands(
  typed: string,
  commands: readonly SlashCommand[] = SLASH_COMMANDS,
): SlashCommand[] {
  const t = fold(typed);
  if (!t.startsWith('/')) return [];
  return commands.filter((c) => fold(c.name).startsWith(t) || c.alias.startsWith(t));
}

/** The command the field starts with (`/iş …`), or null. */
export function leadingCommand(
  text: string,
  commands: readonly SlashCommand[] = SLASH_COMMANDS,
): { command: SlashCommand; arg: string } | null {
  const m = /^(\/\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (m === null) return null;
  const head = fold(m[1] ?? '');
  const command = commands.find((c) => fold(c.name) === head || c.alias === head);
  return command === undefined ? null : { command, arg: (m[2] ?? '').trim() };
}

/** The slash query the caret is in: only a `/word` at the very start of the field. */
export function slashQuery(text: string, caret: number): string | null {
  const before = text.slice(0, caret);
  return /^\/\S{0,20}$/.test(before) ? before : null;
}

export type Expanded =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

/**
 * What is sent for the field's text: a leading command becomes "<command> <words>" + its intent line; a template
 * chosen in the picker adds the template intent. Text without a command is sent as it is.
 */
export function expandSlash(
  text: string,
  template?: { id: string; title: string } | null,
  msgs: Messages = TR,
): Expanded {
  const w = msgs.chatCompose.slash;
  const t = text.trim();
  const lead = leadingCommand(t, msgs === TR ? SLASH_COMMANDS : slashCommands(msgs));
  const lines: string[] = [];
  if (lead === null) {
    lines.push(t);
  } else {
    if (lead.command.needs !== '' && lead.arg === '')
      return { ok: false, message: w.missing({ name: lead.command.name, needs: lead.command.needs }) };
    lines.push(lead.arg === '' ? lead.command.name : `${lead.command.name} ${lead.arg}`);
    lines.push('', lead.command.intent(lead.arg));
  }
  if (template !== undefined && template !== null) {
    lines.push('', w.template({ title: template.title, id: template.id }));
  }
  return { ok: true, text: lines.join('\n').trim() };
}

/**
 * p18-plan-mode: `/plan <metin>` (alias `/planla`) — unlike the commands above it sets a field, not an intent line: plan
 * mode is turned on and the words are sent. `/plan` alone switches plan mode (on ↔ off). Null: not a plan command.
 */
export function planCommand(text: string): { readonly arg: string } | null {
  const m = /^\/(plan|planla)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return m === null ? null : { arg: (m[2] ?? '').trim() };
}

/** The `/plan` entry of the command list (its words in the console's language). */
export function planSlashCommand(hint: string): SlashCommand {
  return { name: '/plan', alias: '/planla', hint, needs: '', intent: () => '' }; // i18n-ignore: command syntax
}
