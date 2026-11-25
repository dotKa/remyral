import { type Formatter, type Messages, messagesFor } from '@remyral/i18n';
import {
  accountText,
  orderedWindows,
  percentText,
  runtimeSummary,
  type UsageLevel,
  type UsageOverview,
  windowName,
} from '../../api/runtimeUsage';
import type { PriorityClass } from '../../api/queue';
import { HH_MM, TR_FORMAT } from '../common/time';

/**
 * p12-diyalog Faz 3: the Diyalog words for a job card's choices and the per-runtime limit line (from the usage
 * overview the rail already reads). API values stay as they are; the words live in the `chatCompose` catalog
 * (p14-i18n-screens-a) — `choiceWords(t)` gives them in the user's language.
 */

export interface ChoiceWords {
  readonly cls: Readonly<Record<PriorityClass, string>>;
  readonly classHint: Readonly<Record<PriorityClass, string>>;
  readonly sandbox: Readonly<Record<string, { label: string; text: string }>>;
  readonly approval: Readonly<Record<string, { label: string; text: string }>>;
  readonly verify: Readonly<Record<string, string>>;
}

/** The choice words of `t`'s language (index with API values; unknown values are undefined). */
export function choiceWords(t: Messages): ChoiceWords {
  const c = t.chatCompose;
  return {
    cls: c.priorityClass,
    classHint: c.classHint,
    sandbox: c.sandbox,
    approval: c.approval,
    verify: c.verify,
  };
}

const TR_WORDS = choiceWords(messagesFor('tr'));

/*
 * Turkish views of the same catalog entries, for screens outside Sohbet whose own copy is still Turkish until their
 * Phase 5 move (composer, templates, automations, workflows, drafts); new code uses `choiceWords(t)`.
 */
export const CLASS_TR = TR_WORDS.cls;
export const CLASS_HINT_TR = TR_WORDS.classHint;
export const SANDBOX_TR = TR_WORDS.sandbox;
export const APPROVAL_TR = TR_WORDS.approval;
export const VERIFY_TR = TR_WORDS.verify;

const TR = messagesFor('tr');

export interface LimitLine {
  readonly text: string;
  readonly level: UsageLevel;
  /** Highest used share of the shown windows (0..100), null when unknown. */
  readonly used: number | null;
}

/**
 * "5 saatlik %72, 16:05’te sıfırlanır · haftalık %41" for a runtime, or null when nothing is reported. `t` / `f`
 * pick the language (Turkish by default for callers not moved yet).
 */
export function limitLine(
  usage: UsageOverview | null,
  runtime: string,
  t: Messages = TR,
  f: Formatter = TR_FORMAT,
): LimitLine | null {
  if (usage === null) return null;
  const w = t.chatCompose.limit;
  const windows: Readonly<Record<string, string>> = w.window;
  const hhmm = (iso: string): string => f.dateWith(iso, HH_MM);
  const s = runtimeSummary(usage.entries, runtime);
  const e = s.best;
  if (e === null) return null;
  if (s.level === 'limited') {
    const reset = e.limit?.resetAt ?? e.limit?.resumeAt ?? null;
    return {
      text: reset === null ? w.limited : w.limitedUntil({ time: hhmm(reset) }),
      level: 'limited',
      used: 100,
    };
  }
  const ws = orderedWindows(e.windows).slice(0, 2);
  if (ws.length === 0) return null;
  const parts = ws.map((win, i) => {
    const name = windowName(win);
    const pct = w.percent({ value: percentText(win.usedPercent) });
    const reset = i === 0 && win.resetsAt !== null ? w.resets({ time: hhmm(win.resetsAt) }) : '';
    return `${windows[name] ?? name} ${pct}${reset}`;
  });
  const used = Math.max(...ws.map((win) => win.usedPercent ?? 0));
  // p13-runtime-accounts: with several accounts the line names the emptiest one and how many there are.
  if (s.multiAccount) {
    return {
      text: w.multiAccount({ account: accountText(e), parts: parts.join(' · '), n: s.stores }),
      level: s.level,
      used,
    };
  }
  return { text: parts.join(' · '), level: s.level, used };
}
