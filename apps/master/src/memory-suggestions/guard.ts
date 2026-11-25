/**
 * p17-auto-learning (docs/design/p17-auto-learning.md §3): cheap, deterministic heuristics over a suggestion's text that
 * decide whether a person must look at it before it may become memory. Pure; Turkish and English.
 *
 * - {@link instructionFlags}: text that tries to steer agents rather than describe the project — "ignore previous
 *   instructions", "always / never …" + skipping tests or approvals, URLs to send data to, `curl … | sh`, credentials,
 *   "you must", hidden characters, long base64 blobs, script tags. Conservative by design: a false positive only means
 *   a person reviews it (the old behaviour); a false negative is limited by the policy (facts and lessons only, below
 *   human instructions, expiry, review date, undo, digest). Defence in depth, never a guarantee.
 * - {@link transientFlags}: notes that only hold on one machine or for a short while (worker hostnames, IP addresses,
 *   temp and home paths, "right now" / "şu an" words). Accepted with a short expiry instead of forever.
 * - {@link language}: Turkish or English (for picking the text to keep when merging twins).
 */

export type InstructionFlag =
  | 'override'
  | 'authority'
  | 'skip_safety'
  | 'exfil_url'
  | 'shell_pipe'
  | 'credentials'
  | 'hidden_text'
  | 'encoded_blob'
  | 'markup';

export type TransientFlag = 'machine' | 'time_bound';

/** Both lower-casings: Turkish (`I` → `ı`, `İ` → `i`) and the default one (so English `IGNORE` stays `ignore`). */
function variants(text: string): string[] {
  const nfc = text.normalize('NFKC');
  return [nfc.toLowerCase(), nfc.toLocaleLowerCase('tr-TR')];
}

function anyMatch(texts: readonly string[], patterns: readonly RegExp[]): boolean {
  return texts.some((t) => patterns.some((p) => p.test(t)));
}

// "ignore / disregard / forget (all) previous instructions", "önceki talimatları yok say / unut / görmezden gel".
const OVERRIDE: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|your|the|system|existing)\b[^.\n]{0,30}\b(?:instructions?|rules?|prompts?|guidelines?|polic(?:y|ies)|context)\b/u,
  /\b(?:new|updated|real|actual|hidden)\s+(?:system\s+)?instructions?\b/u,
  /\bsystem\s+prompt\b/u,
  /\b(?:developer|god|jailbreak|dan)\s+mode\b/u,
  /\bjailbreak/u,
  /(?:önceki|yukarıdaki|eski|mevcut|tüm|bütün)\s+(?:\S+\s+){0,2}(?:talimat|kural|yönerge|komut)\p{L}*\s+(?:\S+\s+){0,2}(?:yok\s*say|unut|görmezden\s*gel|dikkate\s*alma|geçersiz|çiğne|uyma)/u,
  /(?:talimat|kural|yönerge)\p{L}*\s+(?:yok\s*say|unut|görmezden\s*gel)/u,
  /(?<![\p{L}\p{N}])sistem\s+(?:istemi|komutu|promptu)(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}])yeni\s+talimat/u,
];

// Imperatives aimed at an agent: "you must", "from now on", "as an AI", "zorundasın", "bundan sonra … yap".
const AUTHORITY: readonly RegExp[] = [
  /\byou\s+(?:must|have\s+to|are\s+required\s+to|need\s+to|shall|should\s+always)\b/u,
  /\bfrom\s+now\s+on\b/u,
  /\bas\s+an\s+(?:ai|assistant|agent|llm)\b/u,
  /\b(?:the\s+)?(?:owner|admin|administrator|user)\s+(?:has\s+)?(?:approved|authori[sz]ed|allows?|said|wants)\b/u,
  /zorundas[ıi]n(?:[ıi]z)?(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}])\p{L}+(?:mal[ıi]|mel[ie])s[ıi]n(?:[ıi]z)?(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}])bundan\s+(?:sonra|böyle)(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}])(?:sahib[iı]|yönetici|admin)\s+(?:onaylad[ıi]|izin\s+verdi|istedi|söyledi)/u,
];

// What safety checks are called.
const SAFETY_EN =
  '(?:tests?|test\\s+suite|ci|checks?|lint(?:ing)?|verification|verify|approvals?|reviews?|code\\s+review|sandbox|permissions?|2fa|mfa|step-?up|security|hooks?|signing|signatures?)';
const SAFETY_TR = '(?:test|onay|inceleme|doğrulama|kontrol|güvenlik|izin|imza|ci|lint|sandbox)\\p{L}*';

// Skipping or disabling a safety check: "always skip the tests", "disable approvals", "never run the tests",
// "--no-verify", "testleri atla", "onayı kapat", "asla test çalıştırma". "never skip the tests" / "testleri asla
// atlama" (the safe direction) are not flagged.
const SKIP_SAFETY: readonly RegExp[] = [
  new RegExp(
    `(?<!\\b(?:never|not|don't|do\\s+not|dont|no\\s+need\\s+to\\s+not)\\s+)\\b(?:skip(?:ping)?|disable|disabling|bypass(?:ing)?|turn(?:ing)?\\s+off|switch(?:ing)?\\s+off|ignore|ignoring|omit|avoid\\s+running|remove)\\b(?:\\s+\\S+){0,3}?\\s+${SAFETY_EN}\\b`,
    'u',
  ),
  new RegExp(
    `\\b(?:never|don't|do\\s+not|no\\s+need\\s+to)\\s+(?:run|require|wait\\s+for|ask\\s+for|request|perform|do)\\b(?:\\s+\\S+){0,2}?\\s+${SAFETY_EN}\\b`,
    'u',
  ),
  /\b(?:auto-?approve|approve\s+(?:everything|all|automatically|without)|merge\s+without\s+(?:review|approval|tests?)|deploy\s+without\s+(?:review|approval|tests?)|push\s+(?:directly\s+)?to\s+(?:main|master)\s+without)\b/u,
  /--no-verify\b|--dangerously-skip-permissions\b|--yolo\b|--force\b|\bpush\s+-f\b|\bgit\s+reset\s+--hard\b|\brm\s+-rf\s+[/~]/u,
  new RegExp(
    `${SAFETY_TR}\\s+(?:\\S+\\s+){0,2}(?:atla(?!m)|kapat(?!m)|devre\\s*dışı\\s*bırak(?!m)|geç(?!me)|es\\s*geç(?!me)|yok\\s*say|görmezden\\s*gel)`,
    'u',
  ),
  new RegExp(
    `(?:asla|hiçbir\\s+zaman|hiç)\\s+(?:\\S+\\s+){0,2}${SAFETY_TR}\\s+(?:\\S+\\s+){0,1}(?:çalıştırma|yapma|isteme|bekleme|koşturma)`,
    'u',
  ),
  /\bonay(?:sız|\s+beklemeden|\s+almadan)\b|\bincelemeden\s+(?:birleştir|merge|yayınla|deploy)|\btest(?:siz|ler(?:i)?\s+çalıştırmadan)\s+(?:birleştir|merge|yayınla|deploy|gönder)/u,
];

// Sending data out: a URL near a send / upload verb, a well-known request catcher, or an IP-literal URL.
const SEND_VERBS =
  /(?<![\p{L}\p{N}])(?:send|post|upload|forward|report|exfiltrate|submit|transmit|beacon|webhook|callback|leak|share|gönder|yolla|yükle|ilet|aktar|paylaş|bildir)\p{L}*/u;
const URL_RE = /\b(?:https?|ftp|wss?):\/\/[^\s)>"']+/giu;
const EXFIL_HOSTS =
  /(?:webhook\.site|requestbin|pipedream\.net|ngrok(?:-free)?\.(?:io|app|dev)|burpcollaborator|interact\.sh|oast\.(?:fun|live|me|pro|site|online)|pastebin\.com|hastebin|transfer\.sh|discord(?:app)?\.com\/api\/webhooks|hooks\.slack\.com|canarytokens)/u;
const IP_URL = /\b(?:https?|ftp):\/\/(?:\d{1,3}\.){3}\d{1,3}\b/u;

// `curl … | sh`, `wget -O- | bash`, `bash <(curl …)`, `curl -d @file`, `nc -e`, `eval $(…)`, `base64 -d | sh`.
const SHELL_PIPE: readonly RegExp[] = [
  /\b(?:curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k|fi)?sh\b/u,
  /\b(?:curl|wget|iwr|irm)\b[^\n|]*\|\s*(?:python\d?|node|perl|ruby|iex|invoke-expression|powershell|pwsh)\b/u,
  /(?:ba|z)?sh\s+<\(\s*(?:curl|wget)/u,
  /\bcurl\b[^\n]*\s(?:-d|--data(?:-binary|-raw|-urlencode)?|-F|--form|-T|--upload-file)\s/u,
  /\b(?:nc|ncat|netcat)\b[^\n]*\s-(?:e|c)\s/u,
  /\beval\s+["']?\$\(/u,
  /\bbase64\s+(?:-d|--decode)\b[^\n]*\|/u,
  /\|\s*(?:ba)?sh\s*$/mu,
];

// Credentials: well-known secret paths always; a credential word with a reveal / send verb.
const CRED_PATHS =
  /(?:~\/\.ssh|\bid_(?:rsa|ed25519|ecdsa)\b|\.aws\/credentials|\/etc\/shadow|\/etc\/passwd|\.git-credentials|\.netrc\b|\bAWS_SECRET_ACCESS_KEY\b)/iu;
const CRED_WORD =
  /(?<![\p{L}\p{N}])(?:passwords?|passwd|passphrases?|api[\s_-]?keys?|access[\s_-]?keys?|secret[\s_-]?keys?|private[\s_-]?keys?|tokens?|credentials?|cookies?|session\s+ids?|ssh\s+keys?|\.env|şifre|parola|anahtar|kimlik\s+bilgi|gizli\s+(?:anahtar|bilgi)|jeton)(?:\p{L}*)(?![\p{N}])/u;
const REVEAL_VERB =
  /(?<![\p{L}\p{N}])(?:print|echo|cat|show|reveal|dump|log|display|expose|send|share|post|upload|paste|copy|commit|include|email|gönder|paylaş|yazdır|göster|yapıştır|kopyala|ekle|ilet|yolla|dök)\p{L}*/u;

// Zero-width and bidirectional control characters (hidden or reordered text).
const HIDDEN = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD]/u;

// Long base64-looking runs with mixed case and digits (a 40-hex commit sha is lower-case hex only, not flagged).
const BLOB = /[A-Za-z0-9+/]{40,}={0,2}/gu;

const MARKUP =
  /<\s*(?:script|iframe|object|embed|img[^>]+onerror|svg[^>]+onload)\b|javascript:|data:text\/html|<!--/iu;

function hasEncodedBlob(text: string): boolean {
  for (const m of text.matchAll(BLOB)) {
    const s = m[0];
    if (/[A-Z]/u.test(s) && /[a-z]/u.test(s) && /\d/u.test(s)) return true;
  }
  return false;
}

function hasExfilUrl(original: string, lower: readonly string[]): boolean {
  const urls = original.match(URL_RE) ?? [];
  if (urls.length === 0) return false;
  if (urls.some((u) => EXFIL_HOSTS.test(u.toLowerCase()) || IP_URL.test(u))) return true;
  // A URL carrying a template / placeholder of data to send (`?d=$(…)`, `{{secret}}`, `${TOKEN}`).
  if (urls.some((u) => /\$\{|\$\(|\{\{|%24%7B/u.test(u))) return true;
  // A send verb in the same sentence as the URL.
  return lower.some((t) =>
    sentences(t).some(
      (s) => /\b(?:https?|ftp|wss?):\/\//u.test(s) && SEND_VERBS.test(s.replace(URL_RE, ' ')),
    ),
  );
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?;])\s+|\n/u);
}

/** Reasons a text looks like it tries to steer agents; empty for ordinary project knowledge. */
export function instructionFlags(text: string): InstructionFlag[] {
  const lower = variants(text);
  const out = new Set<InstructionFlag>();
  if (anyMatch(lower, OVERRIDE)) out.add('override');
  if (anyMatch(lower, AUTHORITY)) out.add('authority');
  if (anyMatch(lower, SKIP_SAFETY)) out.add('skip_safety');
  if (hasExfilUrl(text, lower)) out.add('exfil_url');
  if (anyMatch(lower, SHELL_PIPE)) out.add('shell_pipe');
  if (
    CRED_PATHS.test(text) ||
    lower.some((t) => sentences(t).some((sn) => CRED_WORD.test(sn) && REVEAL_VERB.test(sn)))
  ) {
    out.add('credentials');
  }
  if (HIDDEN.test(text)) out.add('hidden_text');
  if (hasEncodedBlob(text)) out.add('encoded_blob');
  if (MARKUP.test(text)) out.add('markup');
  return [...out];
}

// One machine: EC2-style hostnames, IPv4 / private ranges, temp and per-user paths, worker ids, PIDs, local ports.
const MACHINE: readonly RegExp[] = [
  /\bip-\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}\b/u,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/u,
  /(?:^|[\s"'`(])(?:\/tmp\/|\/var\/folders\/|\/private\/var\/|\/var\/tmp\/|\/run\/user\/|\/proc\/\d+)/u,
  /(?:^|[\s"'`(])(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+\//u,
  /\b[A-Za-z]:\\Users\\[^\\\s]+\\/u,
  /\b(?:pid|process)\s*#?\s*\d{2,}\b/iu,
  /\b(?:localhost|127\.0\.0\.1):\d{2,5}\b/u,
  /\bworker-[0-9a-f]{6,}\b/iu,
  /\b(?:this|the\s+current)\s+(?:machine|host|worker|box|runner|node)\b/iu,
  /(?<![\p{L}\p{N}])bu\s+(?:makine|sunucu|worker|bilgisayar)/iu,
];

// Time-bound wording: true now, not in general.
const TIME_BOUND: readonly RegExp[] = [
  /\b(?:currently|right\s+now|at\s+the\s+moment|for\s+now|temporar(?:y|ily)|today|tonight|this\s+(?:run|job|session|week|morning|afternoon)|until\s+(?:tomorrow|monday|tuesday|wednesday|thursday|friday|the\s+fix)|as\s+of\s+(?:today|now)|is\s+down|was\s+down|still\s+running|in\s+progress)\b/u,
  /(?<![\p{L}\p{N}])(?:şu\s+an(?:da|lık)?|şimdilik|geçici|bugün|bu\s+gece|bu\s+(?:işte|iş\s+için|çalıştırmada|oturumda|hafta|sabah)|yarına\s+kadar|düzelene\s+kadar|hala\s+çalışıyor|çökük|çöktü)/u,
];

/** Why a text looks machine-specific or short-lived (accepted with a short expiry, never forever). */
export function transientFlags(text: string): TransientFlag[] {
  const lower = variants(text);
  const out: TransientFlag[] = [];
  if (MACHINE.some((p) => p.test(text))) out.push('machine');
  if (anyMatch(lower, TIME_BOUND)) out.push('time_bound');
  return out;
}

const TR_CHARS = /[çğışöüÇĞİŞÖÜ]/gu;
const TR_WORDS =
  /(?<![\p{L}\p{N}])(?:ve|bir|bu|için|ile|olarak|önce|sonra|değil|kullan\p{L}*|çalıştır\p{L}*|kontrol|et|edin|yap\p{L}*|olmalı|gerek\p{L}*|var|yok|ama|da|de|ki|çünkü|şu|her|zaman|asla|proje\p{L}*|dosya\p{L}*|sunucu\p{L}*|iş\p{L}*)(?![\p{L}\p{N}])/gu;
const EN_WORDS =
  /\b(?:the|and|is|are|use|uses|run|runs|check|first|before|after|with|for|not|must|should|always|never|this|that|project|file|server|jobs?|when|then|from|into|of|to|on|in)\b/giu;

/** `tr` or `en` by Turkish letters and common words (ties: Turkish, the platform's default language). */
export function language(text: string): 'tr' | 'en' {
  const tr = (text.match(TR_CHARS)?.length ?? 0) * 2 + (text.match(TR_WORDS)?.length ?? 0) * 2;
  const en = text.match(EN_WORDS)?.length ?? 0;
  return tr >= en ? 'tr' : 'en';
}
