/**
 * Turkish case suffixes after names the UI does not control (machine, project, repo names): "mac-1’de",
 * "web’in", "pi-5’e" (ADR-0053 §2). Vowel harmony and consonant assimilation follow the *pronounced* end
 * of the word: a trailing number is read out ("10" → "on" → "10’da"). Prefer the "X makinesinde" pattern
 * (suffix on a Turkish noun) when the sentence allows it; use these helpers when it does not.
 */

export type TurkishCase =
  /** -de / -da / -te / -ta ("içinde") */
  | 'locative'
  /** -den / -dan / -ten / -tan ("-den") */
  | 'ablative'
  /** -e / -a / -ye / -ya ("-e doğru") */
  | 'dative'
  /** -i / -ı / -u / -ü / -yi … ("-i") */
  | 'accusative'
  /** -in / -ın / -un / -ün / -nin … ("-in") */
  | 'genitive';

/** Apostrophe used before a suffix on a proper name (the console's copy uses the typographic one). */
export const TR_APOSTROPHE = '’';

const VOWELS = 'aeıioöuü';
const BACK = new Set(['a', 'ı', 'o', 'u']);
const ROUNDED = new Set(['o', 'ö', 'u', 'ü']);
/** "Fıstıkçı şahap": voiceless consonants that harden d → t. */
const VOICELESS = new Set(['f', 's', 't', 'k', 'ç', 'ş', 'h', 'p']);

const UNITS = ['sıfır', 'bir', 'iki', 'üç', 'dört', 'beş', 'altı', 'yedi', 'sekiz', 'dokuz'];
const TENS = ['', 'on', 'yirmi', 'otuz', 'kırk', 'elli', 'altmış', 'yetmiş', 'seksen', 'doksan'];

/** How a non-negative integer's last word is said in Turkish (what the suffix attaches to). */
export function spokenNumberEnd(n: bigint): string {
  if (n === 0n) return UNITS[0] ?? 'sıfır';
  const unit = Number(n % 10n);
  if (unit !== 0) return UNITS[unit] ?? '';
  const ten = Number((n / 10n) % 10n);
  if (ten !== 0) return TENS[ten] ?? '';
  if ((n / 100n) % 10n !== 0n) return 'yüz';
  if ((n / 1000n) % 1000n !== 0n) return 'bin';
  if ((n / 1_000_000n) % 1000n !== 0n) return 'milyon';
  return 'milyar';
}

const LETTER_OR_NUMBER = /^[\p{L}\p{N}]$/u;
const ASCII_DIGIT = /^[0-9]$/;

/** The pronounced tail of a name: trailing punctuation dropped, a trailing number read out. */
function spokenTail(word: string): string {
  // Scanned back from the end (a `/…+$/` regex is quadratic on a long run that is not at the end).
  const chars = Array.from(word);
  let end = chars.length;
  while (end > 0 && !LETTER_OR_NUMBER.test(chars[end - 1] ?? '')) end -= 1;
  let start = end;
  while (start > 0 && ASCII_DIGIT.test(chars[start - 1] ?? '')) start -= 1;
  if (start < end) return spokenNumberEnd(BigInt(chars.slice(start, end).join('')));
  return chars.slice(0, end).join('').toLocaleLowerCase('tr-TR');
}

interface Sound {
  readonly lastVowel: string;
  readonly endsInVowel: boolean;
  readonly voiceless: boolean;
}

function soundOf(word: string): Sound {
  const tail = spokenTail(word);
  let lastVowel = 'e';
  for (const ch of tail) if (VOWELS.includes(ch)) lastVowel = ch;
  const last = tail.at(-1) ?? 'e';
  return { lastVowel, endsInVowel: VOWELS.includes(last), voiceless: VOICELESS.has(last) };
}

/** Two-way harmony: e / a. */
function twoWay(s: Sound): 'e' | 'a' {
  return BACK.has(s.lastVowel) ? 'a' : 'e';
}

/** Four-way harmony: i / ı / u / ü. */
function fourWay(s: Sound): 'i' | 'ı' | 'u' | 'ü' {
  const back = BACK.has(s.lastVowel);
  const round = ROUNDED.has(s.lastVowel);
  if (back) return round ? 'u' : 'ı';
  return round ? 'ü' : 'i';
}

/** The suffix alone ("de", "ya", "nin", …) for `word` in `kase`. */
export function turkishSuffix(word: string, kase: TurkishCase): string {
  const s = soundOf(word);
  const d = s.voiceless ? 't' : 'd';
  switch (kase) {
    case 'locative':
      return `${d}${twoWay(s)}`;
    case 'ablative':
      return `${d}${twoWay(s)}n`;
    case 'dative':
      return `${s.endsInVowel ? 'y' : ''}${twoWay(s)}`;
    case 'accusative':
      return `${s.endsInVowel ? 'y' : ''}${fourWay(s)}`;
    case 'genitive':
      return `${s.endsInVowel ? 'n' : ''}${fourWay(s)}n`;
  }
}

/** `word` + apostrophe + suffix: `withSuffix('mac-1', 'locative')` → "mac-1’de". */
export function withSuffix(word: string, kase: TurkishCase): string {
  return `${word}${TR_APOSTROPHE}${turkishSuffix(word, kase)}`;
}
