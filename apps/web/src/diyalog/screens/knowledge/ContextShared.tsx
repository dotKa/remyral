import type { Messages } from '@remyral/i18n';
import type { Provenance, PurgeResult } from '../../../api/context';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';

/**
 * p12-diyalog wave 2 (W3) — Bağlam: small helpers shared by the context panels. The rules are the classic
 * ContextPage ones (step-up for deletes, policy changes, export and the retention run; a cancelled code dialog is
 * not an error; whole-number fields).
 */

export const GLOBAL = 'global';
const DIGITS = /^\d+$/;

/** Runs an action through the step-up dialog; a cancelled dialog is not an error. Resolves false then. */
export function usePrivileged(): {
  submit: ReturnType<typeof useSubmit>;
  run: (fn: () => Promise<void>, why: string) => Promise<boolean>;
} {
  const stepUp = useStepUp();
  const submit = useSubmit();
  const run = async (fn: () => Promise<void>, why: string): Promise<boolean> => {
    let done = false;
    await submit.run(async () => {
      try {
        await stepUp.run(fn, why);
        done = true;
      } catch (err) {
        if (!(err instanceof StepUpCancelledError)) throw err;
      }
    });
    return done;
  };
  return { submit, run };
}

/** '' → null, digits → number, anything else → undefined (invalid). */
export function optionalInt(value: string): number | null | undefined {
  const v = value.trim();
  if (v === '') return null;
  return DIGITS.test(v) ? Number(v) : undefined;
}

export function short(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

/** p14-i18n-screens-c: the words of the context screens (`knowledge.context`). */
export type ContextWords = Messages['knowledge']['context'];

function lookup(words: Readonly<Record<string, string>>, key: string): string {
  return words[key] ?? key;
}

export const kindText = (t: ContextWords, kind: string): string => lookup(t.kind, kind);
export const roleText = (t: ContextWords, role: string): string => lookup(t.role, role);
export const provenanceWord = (t: ContextWords, type: string): string => lookup(t.provenance, type);
export const receiptText = (t: ContextWords, action: string): string => lookup(t.receipt, action);

export function provenanceText(t: ContextWords, p: Provenance): string {
  switch (p.type) {
    case 'user':
      return p.userId === undefined ? t.provenance.user : t.byUser({ id: short(p.userId) });
    case 'import':
      return p.source === undefined ? t.provenance.import : t.byImport({ source: p.source });
    case 'agent':
      return p.jobId === undefined ? t.provenance.agent : t.byAgent({ job: short(p.jobId) });
    case 'platform':
      return t.provenance.platform;
  }
}

export function purgeSummary(t: ContextWords, r: PurgeResult): string {
  const versions = r.pruned.reduce((sum, p) => sum + p.versions.length, 0);
  return t.purged({
    purged: r.purged.length,
    expired: r.expired.length,
    pruned: r.pruned.length,
    versions,
    held: r.held,
  });
}
