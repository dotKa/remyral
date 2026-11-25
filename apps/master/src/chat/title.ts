import { Redactor } from '@remyral/observability';
import { fenceData, normalizeJobTitle } from '@remyral/protocol';
import { RETITLE_AFTER, RETITLE_UNTIL, type TitleSource } from './store.js';

/**
 * p17-chat-github Part 1 (docs/design/p17-chat-github.md §1): conversation titles from meaning.
 *
 * The control plane runs no model of its own (p10-semantic-memory: "no model runs on the control plane"); the model
 * that already reads the conversation — the chat assistant on its machine — names it. The master asks for a title
 * in the turn's context (a small platform block, no extra text sent anywhere) and takes it through the
 * `set_chat_title` tool. The first words of the first message stay the instant placeholder and the fallback (an
 * older worker, a model that does not answer, an error).
 *
 * Pure rules here: whether a first message is worth naming from, the request block and the title normalisation.
 */

/** Greeting, courtesy and filler words that carry no topic (lower-cased, Turkish and English). */
const FILLER = new Set([
  'merhaba',
  'merhabalar',
  'selam',
  'selamlar',
  'slm',
  'mrb',
  'sa',
  'as',
  'selamün',
  'aleyküm',
  'aleykum',
  'günaydın',
  'gunaydin',
  'iyi',
  'akşamlar',
  'aksamlar',
  'geceler',
  'günler',
  'gunler',
  'nasılsın',
  'nasilsin',
  'naber',
  'napıyorsun',
  'hey',
  'hi',
  'hello',
  'hallo',
  'yo',
  'good',
  'morning',
  'evening',
  'afternoon',
  'how',
  'are',
  'you',
  'there',
  'test',
  'testing',
  'deneme',
  'ok',
  'okay',
  'tamam',
  'peki',
  'evet',
  'hayır',
  'hayir',
  'yes',
  'no',
  'thanks',
  'thank',
  'teşekkürler',
  'tesekkurler',
  'sağol',
  'sagol',
  'lütfen',
  'lutfen',
  'please',
  'bir',
  'şey',
  'sey',
  'soru',
  'sorum',
  'var',
  'question',
  'help',
  'yardım',
  'yardim',
]);

/**
 * Whether the first message says enough to name the conversation: at least two words that are not greetings,
 * courtesy or filler ("merhaba", "selam nasılsın", "test", a lone word or only a file are not).
 */
export function titleWorthy(text: string): boolean {
  const words = text
    .toLocaleLowerCase('tr')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => /\p{L}/u.test(w) && Array.from(w).length >= 2 && !FILLER.has(w));
  return words.length >= 2;
}

/** What the assistant is asked in this turn (null: nothing). */
export type TitleAsk = 'first_message' | 'conversation' | null;

/**
 * A placeholder title is named from the first message (in the first turn — and later ones while it stays a
 * placeholder); a provisional one from the conversation so far once 3 messages were exchanged, up to the 5th.
 * `exchanged` counts the current user and assistant messages including the one being answered.
 */
export function titleAsk(source: TitleSource, exchanged: number): TitleAsk {
  // Asked until the 5th message at most: a model that never answers costs nothing after that (first words stay).
  if (source === 'placeholder') return exchanged <= RETITLE_UNTIL ? 'first_message' : null;
  if (source === 'provisional' && exchanged >= RETITLE_AFTER && exchanged <= RETITLE_UNTIL)
    return 'conversation';
  return null;
}

/** The platform block of the turn's context that asks for a title (data fence; rule 49 of the system prompt). */
export function titleBlock(ask: Exclude<TitleAsk, null>, current: string): string {
  return fenceData('conversation title', {
    request: ask === 'first_message' ? 'name_from_first_message' : 'name_from_conversation',
    currentTitle: current,
    tool: 'set_chat_title',
    maxChars: 60,
    language: 'the language of the conversation',
  });
}

const redactor = new Redactor();

/**
 * The title as stored: one line, no surrounding quotes, ≤ 60 characters at a word boundary. Null when nothing is
 * left or the text carries something that looks like a secret (the title is shown in lists and notices).
 */
export function normalizeChatTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const unquoted = raw
    .trim()
    .replace(/^["'“”‘’«»`*_#\s]+|["'“”‘’«»`*_\s.]+$/gu, '')
    .trim();
  const t = normalizeJobTitle(unquoted);
  if (t === null) return null;
  if (redactor.redact(t) !== t) return null;
  return t;
}

/**
 * p18-plan-mode: the person's own message asks to rename the conversation ("bu sohbetin adını
 * Deploy notları yap", "yeniden adlandır", "başlığını değiştir", "rename this chat", "call it …"). A guard for
 * `set_chat_title {requested: true}`: the model says the user asked; the master checks the message does.
 */
export function renameRequested(text: string): boolean {
  const t = text.toLocaleLowerCase('tr');
  if (/(yeniden\s+)?adland[ıi]r|isimlendir|rename|retitle/u.test(t)) return true;
  const subject = /\b(ad[ıi]n?[ıi]?|ismin?[ıi]?|isim|başl[ıi](k|ğ[ıi]n?[ıi]?)|title|name)\b/u;
  const verb = /(değiştir|degistir|koy|ver|yap|güncelle|guncelle|olsun|change|set|make|call)/u;
  return (
    subject.test(t) && verb.test(t) && /(sohbet|konuşma|konusma|chat|conversation|thread|bunun|bu\b)/u.test(t)
  );
}
