import { createHash } from 'node:crypto';

/**
 * p10-semantic-memory (docs/design/p10-semantic-memory.md §4): the cheap, deterministic extraction pass. Pure: reads
 * a finished job's (master-side redacted) result summary and proposes at most {@link MAX_LEARNINGS} short learnings
 * for the project's memory. The summary is untrusted agent output: a learning is only ever a *proposal* a human
 * accepts, edits or dismisses in the Memory suggestions inbox — nothing here writes context.
 *
 * Rules, in priority order (first ones win when the cap is reached):
 *
 * | rule | finds |
 * | --- | --- |
 * | `marker` | lines `MEMORY: …` / `LEARNING: …` / `HAFIZA: …` / `ÖĞRENİM: …` (what a "Summarise with an agent" job writes) |
 * | `section` | bullets under a `## Learnings` / `## Notes for next time` / `## Öğrenimler` / `## Notlar` heading |
 * | `package-manager` | exactly one JavaScript or Python package manager used in commands or named by its lockfile |
 * | `command` | up to three verification commands in backticks (test / lint / typecheck / build / check) |
 * | `color` | a sentence naming a brand / primary / accent colour with a hex value |
 * | `deploy-note` | a sentence about deploying that states a requirement (requires / needs / must / gerekir …) |
 * | `decision` | chat only (p10-chat-memory-suggestions): an explicit decision or convention — `DECISION:` / `KARAR:` /
 * |            | `CONVENTION:` / `KURAL:` lines, "bundan sonra … kullan", "from now on …", "always / never use …" |
 */

export interface Learning {
  readonly rule: string;
  readonly title: string;
  readonly content: string;
}

export const MAX_LEARNINGS = 5;
export const MAX_TITLE = 80;
export const MAX_CONTENT = 500;

const MARKER =
  /^\s*(?:[-*•]\s*)?(?:\*\*)?(?:memory|learning|learned|lesson|hafıza|hafiza|öğrenim|ögrenim|ogrenim|öğrenilen|ÖĞRENİM|ÖĞRENİLEN)(?:\*\*)?\s*[:：]\s*(.+)$/iu;
const SECTION_HEADING =
  /^\s*#{1,4}\s*(?:learnings?|lessons? learned|notes? for (?:next time|future (?:jobs|runs))|öğrenimler|öğrenilenler|notlar|hafıza notları)\s*:?\s*$/iu;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/u;
const HEADING = /^\s*#{1,6}\s/u;

const JS_MANAGERS = [
  {
    name: 'pnpm',
    cmd: /\bpnpm\s+(?:install|i|add|run|test|build|lint|exec|dlx|-r|--filter|--recursive)\b/u,
    lock: /\bpnpm-lock\.yaml\b/u,
  },
  {
    name: 'Yarn',
    cmd: /\byarn\s+(?:install|add|run|test|build|lint|workspace|dlx)\b/u,
    lock: /\byarn\.lock\b/u,
  },
  { name: 'npm', cmd: /\bnpm\s+(?:install|i|ci|run|test|exec)\b/u, lock: /\bpackage-lock\.json\b/u },
  { name: 'Bun', cmd: /\bbun\s+(?:install|add|run|test|x)\b/u, lock: /\bbun\.lockb?\b/u },
] as const;
const PY_MANAGERS = [
  { name: 'uv', cmd: /\buv\s+(?:sync|add|run|pip|lock)\b/u, lock: /\buv\.lock\b/u },
  { name: 'Poetry', cmd: /\bpoetry\s+(?:install|add|run|lock)\b/u, lock: /\bpoetry\.lock\b/u },
  { name: 'Pipenv', cmd: /\bpipenv\s+(?:install|run|lock)\b/u, lock: /\bPipfile\.lock\b/u },
] as const;

const VERIFY_COMMAND =
  /^(?:pnpm|npm|yarn|bun|npx|make|cargo|go|pytest|uv|poetry|tox|gradle|\.\/gradlew|mvn|dotnet|deno|just)\b[^`]*\b(?:test|tests|lint|typecheck|type-check|check|build|verify|vet|fmt)\b/u;
const HEX = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/u;
const COLOR_WORDS = /\b(?:brand|primary|accent|secondary|theme|colou?r|marka|ana renk|vurgu|renk|rengi)\b/iu;
const DEPLOY_WORDS = /\b(?:deploy\w*|release|publish\w*|dağıtım\w*|yayın\w*|canlıya)\b/iu;
const REQUIRE_WORDS =
  /\b(?:requires?|required|needs?|must|only works|has to|gerek\w*|lazım|şart|zorunlu|olmalı|olmadan)\b/iu;

// p10-chat-memory-suggestions: explicit decisions and conventions (chat messages only — in a job summary "always" and
// "never" are mostly narration). A strong opener ("from now on", "bundan sonra") is enough; a weak one ("always",
// "artık", "asla") needs a convention verb in the same sentence. Questions are never decisions.
const DECISION_MARKER =
  /^\s*(?:[-*•]\s*)?(?:\*\*)?(?:decision|decided|convention|rule|karar|kural|teamül)(?:\*\*)?\s*[:：]\s*(.+)$/iu;
const DECISION_STRONG =
  /(?:^|[\s,(])(?:bundan (?:sonra|böyle|boyle)|bu andan itibaren|from now on|going forward|henceforth|from here on)(?=[\s,.:;]|$)/iu;
const DECISION_WEAK =
  /(?:^|[\s,(])(?:artık|artik|her zaman|daima|asla|hiçbir zaman|hicbir zaman|bir daha|always|never|from today)(?=[\s,.:;]|$)/iu;
const DECISION_VERB =
  /(?:kullan\w*|tercih\w*|olsun|olmalı\w*|olmali\w*|yapılsın|yapma\w*|yazma\w*|silme\w*|ekle\w*|koy\w*|yazılsın|çalıştır\w*|calistir\w*|deploy\w*|\buse\b|\buses\b|\bprefer\w*|\bmust\b|\bshould\b|\bdo not\b|\bdon't\b|\brun\b|\bput\b|\bkeep\b|\bavoid\b|\bpin\b)/iu;
const QUESTION = /\?\s*$|(?:^|\s)(?:mı|mi|mu|mü|mısın|misin|musun|müsün)(?:\s|[.!,]|$)/iu;

/** True when a sentence of a chat message states a decision or convention (see {@link DECISION_STRONG}). */
export function isDecision(sentence: string): boolean {
  if (QUESTION.test(sentence)) return false;
  if (DECISION_STRONG.test(sentence)) return true;
  return DECISION_WEAK.test(sentence) && DECISION_VERB.test(sentence);
}

/** Collapses whitespace and trims; strips Markdown emphasis and a trailing colon. */
function tidy(s: string): string {
  return s
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[:;,]\s*$/u, '');
}

/** Cuts at a word boundary, without splitting a surrogate pair, and marks the cut. */
export function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  const space = out.lastIndexOf(' ');
  if (space > max * 0.6) out = out.slice(0, space);
  return `${out}…`;
}

/** A short title from a learning: the part before " — " / " - " / ": ", else its first words. */
export function titleOf(text: string): string {
  const sep = /\s[—–-]\s|:\s/u.exec(text);
  const head = sep !== null && sep.index >= 8 && sep.index <= MAX_TITLE ? text.slice(0, sep.index) : text;
  const first = head.split(/(?<=[.!?])\s/u)[0] ?? head;
  return cut(tidy(first).replace(/[.!?]$/u, ''), MAX_TITLE);
}

function sentences(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[\p{Lu}`#*])/u))
    .map((s) => tidy(s.replace(BULLET, '$1')))
    .filter((s) => s.length >= 12 && s.length <= 600);
}

/** Normalised text of a learning (dedupe key): case-folded, NFKC, punctuation and spacing collapsed. */
export function normalizeLearning(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase('tr')
    .replace(/[`*_"'“”‘’()[\]{}<>]/gu, '')
    .replace(/[^\p{L}\p{N}#./:@+-]+/gu, ' ')
    .replace(/[.:]+(\s|$)/gu, '$1')
    .trim();
}

/** sha256 fingerprint of the normalised content (unique per project: a learning is proposed once). */
export function fingerprint(content: string): string {
  return `sha256:${createHash('sha256').update(normalizeLearning(content), 'utf8').digest('hex')}`;
}

function learning(rule: string, content: string, title?: string): Learning | null {
  const c = cut(tidy(content), MAX_CONTENT);
  if (c.length < 8) return null;
  return { rule, title: title === undefined ? titleOf(c) : cut(tidy(title), MAX_TITLE), content: c };
}

function managerOf(
  text: string,
  managers: readonly { name: string; cmd: RegExp; lock: RegExp }[],
): { name: string; seen: string } | null {
  const found = managers
    .map((m) => {
      const cmd = m.cmd.exec(text);
      const lock = m.lock.exec(text);
      return cmd !== null || lock !== null ? { name: m.name, seen: (cmd ?? lock)?.[0] ?? '' } : null;
    })
    .filter((x): x is { name: string; seen: string } => x !== null);
  // Two managers in one summary (a migration, a comparison): ambiguous, propose nothing.
  return found.length === 1 ? (found[0] ?? null) : null;
}

/** Options of {@link extractLearnings}. */
export interface ExtractOptions {
  /** Which rules run: all job rules (default), or only explicit marker lines (an assistant answer in chat). */
  readonly rules?: 'all' | 'markers';
  /** Also read explicit decisions / conventions (the `decision` rule; chat user messages only). */
  readonly decisions?: boolean;
}

/** The deterministic pass. `summary` is the job's redacted result summary (untrusted). */
export function extractLearnings(summary: string, options: ExtractOptions = {}): Learning[] {
  const text = summary.slice(0, 64 * 1024);
  const out: Learning[] = [];
  const seen = new Set<string>();
  const add = (l: Learning | null): void => {
    if (l === null || out.length >= MAX_LEARNINGS) return;
    const key = normalizeLearning(l.content);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(l);
  };
  const lines = text.split(/\r?\n/u);

  // 1. Explicit markers.
  for (const line of lines) {
    const m = MARKER.exec(line);
    if (m?.[1] !== undefined) add(learning('marker', m[1]));
    const d = options.decisions === true ? DECISION_MARKER.exec(line) : null;
    if (d?.[1] !== undefined) add(learning('decision', d[1]));
  }
  if (options.rules === 'markers') return out;
  // 2. Bullets under a learnings heading.
  let inSection = false;
  for (const line of lines) {
    if (SECTION_HEADING.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (HEADING.test(line)) {
      inSection = false;
      continue;
    }
    const b = BULLET.exec(line);
    if (b?.[1] !== undefined && !MARKER.test(line)) add(learning('section', b[1]));
  }
  // 3. Package manager.
  for (const [managers, kind] of [
    [JS_MANAGERS, 'JavaScript'],
    [PY_MANAGERS, 'Python'],
  ] as const) {
    const m = managerOf(text, managers);
    if (m !== null) {
      add(
        learning(
          'package-manager',
          `This repository uses ${m.name} as its ${kind} package manager; use ${m.name} for installs and scripts.`,
          `Uses ${m.name}`,
        ),
      );
    }
  }
  // 4. Verification commands.
  const commands = [...text.matchAll(/`([^`\n]{3,100})`/gu)]
    .map((m) => (m[1] ?? '').trim())
    .filter((c) => VERIFY_COMMAND.test(c));
  const distinct = [...new Set(commands)].slice(0, 3);
  if (distinct.length > 0) {
    add(
      learning(
        'command',
        `Verify changes with ${distinct.map((c) => `\`${c}\``).join(', ')}.`,
        'Verification commands',
      ),
    );
  }
  // 5. Colours, 6. deploy requirements (sentence level).
  for (const s of sentences(text)) {
    if (MARKER.test(s) || DECISION_MARKER.test(s)) continue;
    if (HEX.test(s) && COLOR_WORDS.test(s)) add(learning('color', s));
    else if (DEPLOY_WORDS.test(s) && REQUIRE_WORDS.test(s)) add(learning('deploy-note', s));
    else if (options.decisions === true && isDecision(s)) add(learning('decision', s));
  }
  return out;
}

/**
 * p10-chat-memory-suggestions: learnings of one project-linked chat message (already redacted by the caller). A
 * person's message runs every rule plus explicit decisions; an assistant answer only its explicit `MEMORY:` lines
 * (an answer narrates, quotes repositories and guesses — its other sentences are not the team's decisions).
 */
export function extractChatLearnings(text: string, author: 'user' | 'assistant'): Learning[] {
  return author === 'user'
    ? extractLearnings(text, { decisions: true })
    : extractLearnings(text, { rules: 'markers' });
}

/**
 * Lines a "Summarise with an agent" job is asked to write (and the `marker` rule reads). Kept here so the prompt and
 * the parser cannot drift apart.
 */
export const AGENT_SUMMARY_FORMAT = 'MEMORY: <short title> — <one or two sentences>';
