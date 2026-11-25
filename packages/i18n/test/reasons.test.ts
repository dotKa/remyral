// p14-web-perf-2: both catalogs, synchronously (registers English).
import '../src/all.js';
// p14-i18n-reasons (i18n Phase 4): the `reasons` namespace and its resolver.
import { describe, expect, it } from 'vitest';
import { isReasonCode, messagesFor, reasonCodes, reasonSentence, reasonVariants } from '../src/index.js';

const tr = messagesFor('tr');
const en = messagesFor('en');
const vars = { runtime: 'Codex', machine: 'mac-1' };
const anon = { runtime: null, machine: null };

describe('reasonSentence', () => {
  it('says a plain code in both languages, with and without names', () => {
    expect(reasonSentence(tr, 'runtime_not_installed', vars)).toBe('Codex mac-1 makinesinde kurulu değil.');
    expect(reasonSentence(tr, 'runtime_not_installed', anon)).toBe('Runtime bu makinede kurulu değil.');
    expect(reasonSentence(en, 'runtime_not_installed', vars)).toBe('Codex is not installed on mac-1.');
    expect(reasonSentence(en, 'runtime_not_installed', anon)).toBe(
      'The runtime is not installed on this machine.',
    );
  });

  it('picks the variant of params.cause; default without one or for an unknown cause', () => {
    expect(reasonSentence(en, 'login_refresh_contention', vars, 'run_again')).toContain('run the job again');
    expect(reasonSentence(en, 'login_refresh_contention', vars)).toContain('Log in again');
    expect(reasonSentence(en, 'login_refresh_contention', vars, 'nope')).toContain('Log in again');
    // A cause on a code without variants changes nothing.
    expect(reasonSentence(en, 'offline', vars, 'run_again')).toBe('mac-1 is offline.');
  });

  it('unknown code ⇒ null (the caller shows the raw text); prototype keys are not codes', () => {
    expect(reasonSentence(tr, 'frobnicated', vars)).toBeNull();
    expect(reasonSentence(tr, 'toString', vars)).toBeNull();
    expect(isReasonCode(tr, 'constructor')).toBe(false);
    expect(isReasonCode(tr, 'offline')).toBe(true);
  });

  it('both languages know the same codes and variants', () => {
    expect(reasonCodes(en)).toEqual(reasonCodes(tr));
    for (const code of reasonCodes(tr))
      expect(reasonVariants(en, code), code).toEqual(reasonVariants(tr, code));
    expect(reasonVariants(tr, 'not_authenticated').sort()).toEqual(['job_auth_secret_ref', 'no_job_auth']);
  });

  it('Turkish copy keeps the "X makinesinde" pattern and the glossary (no "worker")', () => {
    for (const code of reasonCodes(tr)) {
      const variants = ['default', ...reasonVariants(tr, code)];
      for (const v of variants) {
        const s = reasonSentence(tr, code, vars, v === 'default' ? null : v) ?? '';
        expect(s, `${code}.${v}`).not.toMatch(/\bworker\b/);
        expect(s, `${code}.${v}`).not.toMatch(/mac-1’/);
      }
    }
  });
});
