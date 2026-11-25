import type { Messages } from '@remyral/i18n';
import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ApiError, ApiIssue } from '../../api/client';
import { cx, toApiError, useRetryCountdown } from '../../components/ui';
import { useT } from '../../i18n/I18nProvider';
import { StepUpCancelledError, useOptionalStepUp } from '../../stepup/StepUpProvider';
import { DyButton } from '../screens/parts';
import { type GuardEntry, useUnsavedGuard } from './guard';
import { toast } from '../toast/store';

/**
 * p15-form-pattern (docs/design/p15-form-pattern.md): one form per tab.
 *
 * - `useDyForm` — a form's value against the value it was loaded with: `dirty`, `set`, `save` (client validation →
 *   the request through step-up when the master asks for it → field errors from the master's `issues`), `discard`.
 *   It joins a bar through `<DyForm form>` (its own bar) or `useFormSection(form)` (a card inside a tab's scope).
 * - `useFormSection` — the same contract for a card that keeps its own state (an older panel moved into a tab's
 *   form): it reports `dirty`, how to save and how to discard; its own save button goes away.
 * - `DyFormScope` — the tab's form: every section inside it shares ONE sticky save bar ("Kaydedilmemiş değişiklik var
 *   · Kaydet · Vazgeç", only while something is dirty, disabled while saving), the "Kaydedildi" toast, ⌘/Ctrl+S,
 *   and one registration with the unsaved-changes guard. Saving runs the dirty sections in order and stops at the
 *   first that fails (its errors are shown where it is; focus moves to the first invalid field).
 */

// ------------------------------------------------------------------------------------------------ sections

export interface FormSection {
  readonly dirty: boolean;
  readonly busy: boolean;
  /** True when saved; false when refused, invalid or a step-up was cancelled (no error for a cancel). */
  readonly save: () => Promise<boolean>;
  readonly discard: () => void;
  /** The bar's save label while this is the only dirty section ("Devral ve kaydet"); default "Kaydet". */
  readonly saveLabel?: string | undefined;
}

interface ScopeApi {
  readonly put: (id: string, s: FormSection) => void;
  readonly remove: (id: string) => void;
  readonly saveAll: () => Promise<boolean>;
}

const ScopeContext = createContext<ScopeApi | null>(null);

/** The enclosing tab form (null outside one): `saveAll` for a section's own Enter-to-submit. */
export function useFormScope(): ScopeApi | null {
  return use(ScopeContext);
}

/**
 * Joins the enclosing `DyFormScope` (its bar saves / discards this section). Outside a scope the section registers
 * with the unsaved-changes guard directly; the caller then keeps a save button of its own.
 */
export function useFormSection(section: FormSection): void {
  const scope = use(ScopeContext);
  const id = useId();
  const latest = useRef(section);
  latest.current = section;
  const stable = useMemo<FormSection>(
    () => ({
      get dirty() {
        return latest.current.dirty;
      },
      get busy() {
        return latest.current.busy;
      },
      get saveLabel() {
        return latest.current.saveLabel;
      },
      save: () => latest.current.save(),
      discard: () => {
        latest.current.discard();
      },
    }),
    [],
  );
  const { dirty, busy } = section;
  useEffect(() => {
    if (scope === null) return;
    scope.put(id, stable);
  }, [scope, id, stable, dirty, busy]);
  useEffect(() => {
    if (scope === null) return;
    return () => {
      scope.remove(id);
    };
  }, [scope, id]);
  const guardEntry: GuardEntry =
    scope === null ? section : { dirty: false, save: section.save, discard: section.discard };
  useUnsavedGuard(guardEntry);
}

/**
 * A card that keeps its own state, as a section of the tab form around it: it registers (`useFormSection`) and says
 * whether a tab form is there (`inScope` — then its own save button goes away, the tab's bar saves it) and how its
 * own `<form>` submits (Enter: the whole tab form inside a scope, the card alone outside one).
 */
export function useCardForm(section: FormSection): {
  readonly inScope: boolean;
  readonly submit: () => void;
} {
  const scope = use(ScopeContext);
  useFormSection(section);
  return {
    inScope: scope !== null,
    submit: () => {
      if (scope !== null) {
        if (section.dirty) void scope.saveAll();
      } else void section.save();
    },
  };
}

/**
 * The common "save through step-up" of a section built on `useSubmit`: false (and no error) when the person cancels
 * the code dialog, so the bar keeps the edits instead of announcing a save that did not happen.
 */
export function useSectionSave(): (
  submit: { readonly run: (fn: () => Promise<void>) => Promise<boolean> },
  fn: () => Promise<void>,
  why?: string,
) => Promise<boolean> {
  const stepUp = useOptionalStepUp();
  return useCallback(
    async (submit, fn, why) => {
      let cancelled = false;
      const ok = await submit.run(async () => {
        try {
          if (stepUp === null) await fn();
          else await stepUp.run(fn, why);
        } catch (err) {
          if (err instanceof StepUpCancelledError) {
            cancelled = true;
            return;
          }
          throw err;
        }
      });
      return ok && !cancelled;
    },
    [stepUp],
  );
}

// ------------------------------------------------------------------------------------------------ issue texts

type IssueText = Messages['forms']['issues'];

/** A master validation code in the user's language. */
export function issueText(t: IssueText, code: string): string {
  const c = code.toLowerCase();
  if (c === 'required' || c === 'missing' || c === 'invalid_type') return t.required;
  if (c === 'too_small' || c === 'too_short' || c === 'min') return t.tooSmall;
  if (c === 'too_big' || c === 'too_long' || c === 'max' || c === 'too_many') return t.tooBig;
  if (c === 'not_found' || c === 'unknown') return t.notFound;
  if (c === 'duplicate' || c === 'conflict' || c === 'taken' || c === 'exists') return t.duplicate;
  if (c === 'not_allowed' || c === 'forbidden') return t.notAllowed;
  if (c === 'invalid' || c.startsWith('invalid_')) return t.invalid;
  return t.other({ code });
}

export type FieldErrors = Readonly<Record<string, string>>;

/** The issues a form can show next to its fields (`fieldOf` maps an issue path to a field key; null = not a field). */
export function fieldErrorsOf(
  t: IssueText,
  issues: readonly ApiIssue[],
  fieldOf: (path: string) => string | null,
): { readonly fields: FieldErrors; readonly rest: readonly ApiIssue[] } {
  const fields: Record<string, string> = {};
  const rest: ApiIssue[] = [];
  for (const i of issues) {
    const key = fieldOf(i.path);
    if (key === null) rest.push(i);
    else fields[key] ??= issueText(t, i.code);
  }
  return { fields, rest };
}

/** Default issue path → field key: the first segment (`limits.turns` → `limits`, `email` → `email`). */
const firstSegment = (path: string): string | null => {
  const head = path.split(/[.[]/)[0] ?? '';
  return head === '' ? null : head;
};

// ------------------------------------------------------------------------------------------------ useDyForm

/** Order-independent structural equality for plain form values. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) =>
      Object.hasOwn(b, k) && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

export interface DyFormOptions<T> {
  /** The loaded value (null while loading). A new value replaces the form unless it holds edits. */
  readonly initial: T | null;
  /** Sends the value; may return the saved value (it becomes the new baseline). */
  readonly save: (value: T) => Promise<T | undefined> | Promise<void>;
  /** Client checks before the request: field key → message (null / empty = valid). */
  readonly validate?: ((value: T) => FieldErrors | null) | undefined;
  /** The step-up dialog's reason, shown only if the master asks for a code. */
  readonly stepUpReason?: string | undefined;
  /** Master issue path → field key (default: the first path segment). */
  readonly fieldOf?: ((path: string) => string | null) | undefined;
  /** False for read-only viewers: never dirty, never registered. */
  readonly enabled?: boolean | undefined;
  readonly equals?: ((a: T, b: T) => boolean) | undefined;
}

export interface DyFormApi<T> {
  readonly value: T | null;
  readonly baseline: T | null;
  readonly set: (next: Partial<T> | ((v: T) => T)) => void;
  readonly dirty: boolean;
  readonly busy: boolean;
  /** The refusal that is not about one field (or carries issues no field shows). */
  readonly error: ApiError | null;
  readonly retryLeft: number;
  readonly fieldErrors: FieldErrors;
  readonly fieldError: (key: string) => string | undefined;
  readonly save: () => Promise<boolean>;
  readonly discard: () => void;
}

export function useDyForm<T>(opts: DyFormOptions<T>): DyFormApi<T> {
  const t = useT().forms.issues;
  const stepUp = useOptionalStepUp();
  const [value, setValue] = useState<T | null>(opts.initial);
  const [baseline, setBaseline] = useState<T | null>(opts.initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const retryLeft = useRetryCountdown(error);
  const equals = opts.equals ?? sameValue;
  const enabled = opts.enabled !== false;
  const dirty = enabled && value !== null && baseline !== null && !equals(value, baseline);

  // A newly loaded value (first load, a reload, another tab's save) becomes the baseline; edits are kept.
  const lastInitial = useRef(opts.initial);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (opts.initial === lastInitial.current || sameValue(opts.initial, lastInitial.current)) return;
    lastInitial.current = opts.initial;
    setBaseline(opts.initial);
    if (!dirtyRef.current) setValue(opts.initial);
  }, [opts.initial]);

  const set = useCallback((next: Partial<T> | ((v: T) => T)) => {
    setValue((v) => {
      if (v === null) return v;
      return typeof next === 'function' ? next(v) : { ...v, ...next };
    });
  }, []);

  const latest = useRef({ value, opts, stepUp, t });
  latest.current = { value, opts, stepUp, t };

  const save = useCallback(async (): Promise<boolean> => {
    const { value: v, opts: o, stepUp: su, t: tt } = latest.current;
    if (v === null) return false;
    const problems = o.validate?.(v) ?? null;
    const found =
      problems === null ? {} : Object.fromEntries(Object.entries(problems).filter(([, m]) => m !== ''));
    setFieldErrors(found);
    if (Object.keys(found).length > 0) return false;
    setError(null);
    setBusy(true);
    try {
      const send = async (): Promise<T | undefined> => {
        const r = await o.save(v);
        return r === undefined ? undefined : r;
      };
      const out = su === null ? await send() : await su.run(send, o.stepUpReason);
      const next = out ?? v;
      lastInitial.current = next;
      setBaseline(next);
      setValue(next);
      return true;
    } catch (err) {
      if (err instanceof StepUpCancelledError) return false;
      const e = toApiError(err);
      const { fields, rest } = fieldErrorsOf(tt, e.issues, o.fieldOf ?? firstSegment);
      setFieldErrors(fields);
      setError(Object.keys(fields).length > 0 && rest.length === 0 ? null : e);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const baselineRef = useRef(baseline);
  baselineRef.current = baseline;
  const discard = useCallback(() => {
    setValue(lastInitial.current === null ? null : baselineRef.current);
    setFieldErrors({});
    setError(null);
  }, []);

  return {
    value,
    baseline,
    set,
    dirty,
    busy,
    error,
    retryLeft,
    fieldErrors,
    fieldError: (k) => fieldErrors[k],
    save,
    discard,
  };
}

// ------------------------------------------------------------------------------------------------ the tab form

/**
 * A tab's form: renders its sections, then the sticky save bar and the "Kaydedildi" toast. `label` names the form
 * for assistive tech ("Asistan ayarları"). `readOnly` (viewers) never shows a bar.
 */
export function DyFormScope(props: {
  readonly label?: string | undefined;
  readonly readOnly?: boolean | undefined;
  readonly className?: string | undefined;
  readonly testId?: string | undefined;
  readonly children: ReactNode;
}): ReactNode {
  const sections = useRef(new Map<string, FormSection>());
  const [, setTick] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(0);
  const [failed, setFailed] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const put = useCallback((id: string, s: FormSection) => {
    sections.current.set(id, s);
    setTick((n) => n + 1);
  }, []);
  const remove = useCallback((id: string) => {
    sections.current.delete(id);
    setTick((n) => n + 1);
  }, []);

  const savingRef = useRef(false);
  const saveAll = useCallback(async (): Promise<boolean> => {
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setFailed(false);
    let ok = true;
    try {
      for (const s of [...sections.current.values()]) {
        if (!s.dirty) continue;
        if (!(await s.save())) {
          ok = false;
          break;
        }
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
    if (ok) setSaved((n) => n + 1);
    else {
      setFailed(true);
      // After React has painted the errors: the first invalid field, else the first error band.
      setTimeout(() => {
        const el =
          root.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
          root.current?.querySelector<HTMLElement>('[data-testid="api-error"]');
        el?.focus();
      }, 0);
    }
    return ok;
  }, []);

  const discardAll = useCallback(() => {
    for (const s of sections.current.values()) if (s.dirty) s.discard();
    setFailed(false);
  }, []);

  // A section's report (`setTick`) re-renders this scope, which re-reads the sections here.
  const all = [...sections.current.values()];
  const dirty = props.readOnly !== true && all.some((s) => s.dirty);
  const busy = saving || all.some((s) => s.busy);
  const dirtySections = all.filter((s) => s.dirty);
  const saveLabel = dirtySections.length === 1 ? dirtySections[0]?.saveLabel : undefined;

  useUnsavedGuard({ dirty, save: saveAll, discard: discardAll });

  const api = useMemo<ScopeApi>(() => ({ put, remove, saveAll }), [put, remove, saveAll]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's' && dirty) {
      e.preventDefault();
      void saveAll();
    }
  };

  return (
    <ScopeContext value={api}>
      <div
        ref={root}
        role="group"
        aria-label={props.label}
        data-testid={props.testId}
        data-dirty={dirty ? 'true' : undefined}
        onKeyDown={onKeyDown}
        className={cx('flex min-w-0 flex-col gap-4', props.className)}
      >
        {props.children}
        <DyFormBar
          dirty={dirty}
          busy={busy}
          failed={failed && dirty}
          savedKey={saved}
          saveLabel={saveLabel}
          onSave={() => void saveAll()}
          onDiscard={discardAll}
        />
      </div>
    </ScopeContext>
  );
}

/**
 * A single form with its own fields and bar — the simple case (one `useDyForm`): `<DyForm form={f}>fields</DyForm>`.
 * Enter in a field saves (a native `<form>`), the master's non-field error shows above the bar.
 */
export function DyForm<T>(props: {
  readonly form: DyFormApi<T>;
  readonly label?: string | undefined;
  readonly readOnly?: boolean | undefined;
  readonly className?: string | undefined;
  readonly testId?: string | undefined;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <DyFormScope
      label={props.label}
      readOnly={props.readOnly}
      className={props.className}
      testId={props.testId}
    >
      <FormBody form={props.form}>{props.children}</FormBody>
    </DyFormScope>
  );
}

function FormBody<T>(props: { readonly form: DyFormApi<T>; readonly children: ReactNode }): ReactNode {
  const scope = useFormScope();
  useFormSection(props.form);
  return (
    <form
      noValidate
      className="flex min-w-0 flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (props.form.dirty) void (scope?.saveAll() ?? props.form.save());
      }}
      onKeyDown={(e) => {
        // Enter in a one-line field saves, whatever the number of fields (no hidden submit button needed).
        const el = e.target;
        if (
          e.key !== 'Enter' ||
          e.nativeEvent.isComposing ||
          !(el instanceof HTMLInputElement) ||
          ['checkbox', 'radio', 'button', 'submit', 'file'].includes(el.type)
        )
          return;
        e.preventDefault();
        if (props.form.dirty) void (scope?.saveAll() ?? props.form.save());
      }}
    >
      {props.children}
    </form>
  );
}

/** How long the "Kaydedildi" toast stays (ms). */
export const SAVED_TOAST_MS = 2600;

/** The toast id of a form save (a second save replaces it instead of stacking). */
export const SAVED_TOAST_ID = 'form-saved';

/**
 * The sticky save bar (only while dirty). It sticks to the bottom of the viewport above the phone tab bar; it never
 * covers a field it belongs to (it sits after them in the flow). p17-toasts-shortcuts: "Kaydedildi" is a toast of the
 * shell's toaster (bottom right), no longer a pill under the form.
 */
export function DyFormBar(props: {
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly failed?: boolean | undefined;
  /** Changes on every successful save (shows the toast). */
  readonly savedKey: number;
  /** Replaces "Kaydet" (e.g. "Devral ve kaydet"). */
  readonly saveLabel?: string | undefined;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
}): ReactNode {
  const t = useT().forms.bar;
  const saved = t.saved;
  useEffect(() => {
    if (props.savedKey === 0) return;
    toast.success(saved, { id: SAVED_TOAST_ID, duration: SAVED_TOAST_MS, testId: 'dy-form-saved' });
  }, [props.savedKey, saved]);
  return (
    <div
      className={cx(
        'pointer-events-none sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-[5] flex justify-center md:bottom-3',
      )}
    >
      {props.dirty ? (
        <div
          role="region"
          aria-label={t.region}
          data-testid="dy-form-bar"
          className="dy-notice pointer-events-auto flex w-full max-w-[40rem] flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--dy-r-card)] border border-dy-line bg-dy-card px-3.5 py-2.5 shadow-dy-pop"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2 text-[0.875rem] font-medium">
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-dy-amber" />
            <span className="min-w-0">
              {t.dirty}
              {props.failed === true ? (
                <span
                  className="block text-[0.8125rem] font-normal text-dy-red-ink"
                  data-testid="dy-form-failed"
                >
                  {t.failed}
                </span>
              ) : null}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <DyButton
              variant="ghost"
              disabled={props.busy}
              onClick={props.onDiscard}
              data-testid="dy-form-discard"
            >
              {t.discard}
            </DyButton>
            <DyButton variant="primary" busy={props.busy} onClick={props.onSave} data-testid="dy-form-save">
              {props.busy ? t.saving : (props.saveLabel ?? t.save)}
            </DyButton>
          </span>
        </div>
      ) : null}
    </div>
  );
}
