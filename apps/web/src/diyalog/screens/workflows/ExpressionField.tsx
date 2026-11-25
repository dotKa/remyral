import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { type EvalResult, evaluateExpression, type Sample } from '../../../api/workflowEngine';
import { cx } from '../../../components/ui';
import { useT } from '../../../i18n/I18nProvider';
import { DyFloatingList } from '../../Popover';
import { matchSuggestions, type Suggestion, tokenBefore } from './nodeCatalog';

/**
 * p14-workflow-engine 14.1 (docs/design/p14-workflow-engine.md §7.3): the in-house expression editor — a textarea with
 * an overlay that highlights `{{ }}` templates and JSONata tokens (no new dependency), autocomplete of `$…` names
 * (upstream outputs, inputs, group items, run, functions) and a live preview: 400 ms after the last keystroke the
 * master evaluates the text in its sandbox against the sample data and the result (or the error code and position)
 * shows under the field. Values are workflow data: rendered as text. The suggestion list floats over the inspector /
 * dialog (`DyFloatingList`, p17-ui-batch), so a scrolling panel never cuts it off.
 */

export const PREVIEW_DEBOUNCE_MS = 400;

type Piece = { readonly text: string; readonly kind: 'plain' | 'tpl' | 'var' | 'str' | 'num' | 'fn' };

/** Highlight pieces of an expression (`expr`) or a template (`template`: only `{{ … }}` is code). */
export function highlight(text: string, mode: 'expr' | 'template'): Piece[] {
  if (mode === 'template') {
    const out: Piece[] = [];
    let last = 0;
    for (const m of text.matchAll(/\{\{[\s\S]*?\}\}/g)) {
      if (m.index > last) out.push({ text: text.slice(last, m.index), kind: 'plain' });
      out.push({ text: m[0], kind: 'tpl' });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ text: text.slice(last), kind: 'plain' });
    return out;
  }
  const out: Piece[] = [];
  const re =
    /(\$[A-Za-z_][\w.]*\s*(?=\())|(\$[A-Za-z_]?[\w.]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b\d+(?:\.\d+)?\b)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), kind: 'plain' });
    const kind = m[1] !== undefined ? 'fn' : m[2] !== undefined ? 'var' : m[3] !== undefined ? 'str' : 'num';
    out.push({ text: m[0], kind });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), kind: 'plain' });
  return out;
}

const PIECE_CLASS: Readonly<Record<Piece['kind'], string>> = {
  plain: '',
  tpl: 'text-dy-violet-ink',
  var: 'text-dy-teal-ink',
  str: 'text-dy-green',
  num: 'text-dy-amber-ink',
  fn: 'text-dy-violet-ink',
};

/** A JSON preview of a value, clipped. */
export function previewText(v: unknown, max = 2_000): string {
  let s: string;
  try {
    const j: unknown = v === undefined ? undefined : JSON.stringify(v, null, 2);
    s = typeof j === 'string' ? j : 'undefined';
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export interface ExpressionFieldProps {
  readonly label: ReactNode;
  readonly value: string;
  readonly mode: 'expr' | 'template';
  readonly onChange: (v: string) => void;
  readonly suggestions: readonly Suggestion[];
  /** Live preview against the sample (null: no preview, e.g. no project yet). */
  readonly preview: { readonly project: string; readonly sample: Sample } | null;
  readonly readOnly?: boolean;
  readonly error?: string | null;
  readonly hint?: ReactNode;
  readonly testId?: string;
  readonly rows?: number;
}

export function ExpressionField(props: ExpressionFieldProps): ReactNode {
  const t = useT().workflows.expr;
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState(false);
  const [result, setResult] = useState<EvalResult | null>(null);
  const [busy, setBusy] = useState(false);
  const { value, mode } = props;
  const preview = props.preview;
  const sampleKey = useMemo(() => JSON.stringify(preview?.sample ?? null), [preview?.sample]);

  // Live preview: debounced, the latest request wins (earlier ones are aborted).
  useEffect(() => {
    if (preview === null || value.trim() === '' || (mode === 'template' && !value.includes('{{'))) {
      setResult(null);
      return;
    }
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      setBusy(true);
      evaluateExpression(preview.project, value, mode, preview.sample, { signal: ctrl.signal }).then(
        (r) => {
          setResult(r);
          setBusy(false);
        },
        () => {
          if (!ctrl.signal.aborted) {
            setResult({ ok: false, error: { code: 'preview_unavailable', position: null } });
            setBusy(false);
          }
        },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
    // sampleKey stands for the sample object (a new object with the same content does not re-evaluate).
  }, [value, mode, preview?.project, sampleKey]);

  const tok = caret === null ? null : tokenBefore(value, caret);
  const matches = tok === null || closed ? [] : matchSuggestions(props.suggestions, tok.token);
  const open = matches.length > 0 && !props.readOnly;
  const listId = `${id}-list`;

  const pick = (s: Suggestion): void => {
    if (tok === null) return;
    const next = value.slice(0, tok.start) + s.insert + value.slice(caret ?? tok.start);
    props.onChange(next);
    const at = tok.start + s.insert.length;
    setCaret(at);
    setClosed(true);
    requestAnimationFrame(() => {
      area.current?.setSelectionRange(at, at);
    });
  };

  const errorText = (code: string): string => {
    const base = code.split(':')[0] ?? code;
    return (t.errors as Record<string, string>)[base] ?? code;
  };

  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={props.testId ?? 'expression-field'}>
      <label htmlFor={id} className="flex items-center gap-1.5 text-[0.8125rem] font-bold">
        <span>{props.label}</span>
        <span className="rounded bg-dy-violet-soft px-1 font-dy-mono text-[0.6875rem] text-dy-violet-ink">
          {mode === 'expr' ? 'fx' : '{{ }}'}
        </span>
      </label>
      <div ref={box} className="relative">
        <pre
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 m-0 overflow-hidden rounded-[9px] border border-transparent px-3 py-2 font-dy-mono text-[0.8125rem] leading-normal whitespace-pre-wrap [overflow-wrap:anywhere]"
        >
          {highlight(value, mode).map((p, i) => (
            <span key={i} className={PIECE_CLASS[p.kind]}>
              {p.text}
            </span>
          ))}
          {'\n'}
        </pre>
        <textarea
          ref={area}
          id={id}
          value={value}
          readOnly={props.readOnly}
          rows={props.rows ?? (mode === 'expr' ? 2 : 3)}
          spellCheck={false}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open ? `${id}-opt-${String(active)}` : undefined}
          aria-invalid={props.error !== undefined && props.error !== null ? true : undefined}
          onChange={(e) => {
            props.onChange(e.target.value);
            setCaret(e.target.selectionStart);
            setActive(0);
            setClosed(false);
          }}
          onSelect={(e) => {
            setCaret(e.currentTarget.selectionStart);
          }}
          onBlur={() => {
            window.setTimeout(() => {
              setClosed(true);
            }, 150);
          }}
          onKeyDown={(e) => {
            if (!open) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
            } else if (e.key === 'Enter' || e.key === 'Tab') {
              const s = matches[active];
              if (s !== undefined) {
                e.preventDefault();
                pick(s);
              }
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setClosed(true);
            }
          }}
          className="relative min-h-[2.75rem] w-full resize-y rounded-[9px] border border-dy-line-2 bg-transparent px-3 py-2 font-dy-mono text-[0.8125rem] leading-normal text-transparent caret-dy-ink selection:bg-dy-teal-soft selection:text-dy-ink"
        />
        {open ? (
          <DyFloatingList
            open
            anchorRef={box}
            id={listId}
            role="listbox"
            ariaLabel={t.suggestions}
            contentKey={String(matches.length)}
            className="dy-pop grid max-h-56 gap-0.5 rounded-[10px] border border-dy-line bg-dy-card p-1 text-dy-ink shadow-dy-pop"
          >
            {matches.map((s, i) => (
              <li
                key={s.insert}
                id={`${id}-opt-${String(i)}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s);
                }}
                className={cx(
                  'flex cursor-pointer items-center justify-between gap-2 rounded-[7px] px-2 py-1 font-dy-mono text-[0.78125rem]',
                  i === active ? 'bg-dy-sunk' : '',
                )}
              >
                <span className="truncate">{s.insert}</span>
                <span className="shrink-0 text-dy-muted">{s.detail}</span>
              </li>
            ))}
          </DyFloatingList>
        ) : null}
      </div>
      {props.hint === undefined ? null : <p className="m-0 text-[0.78125rem] text-dy-muted">{props.hint}</p>}
      {props.error === undefined || props.error === null ? null : (
        <p role="alert" className="m-0 text-[0.78125rem] font-medium text-dy-red-ink">
          {props.error}
        </p>
      )}
      {result === null && !busy ? null : (
        <div
          data-testid="expression-preview"
          aria-live="polite"
          className={cx(
            'rounded-[9px] border px-2.5 py-1.5 text-[0.78125rem]',
            result?.ok === false
              ? 'border-dy-red-soft bg-dy-red-soft text-dy-red-ink'
              : 'border-dy-line bg-dy-sunk',
          )}
        >
          {busy && result === null ? (
            <span className="text-dy-muted">{t.evaluating}</span>
          ) : result?.ok === true ? (
            <>
              <span className="text-dy-muted">{t.result({ type: result.type })}</span>
              <pre className="m-0 mt-1 max-h-40 overflow-auto font-dy-mono whitespace-pre-wrap [overflow-wrap:anywhere]">
                {previewText(result.value)}
              </pre>
            </>
          ) : result?.ok === false ? (
            <span data-testid="expression-error">
              {result.error.position === null
                ? errorText(result.error.code)
                : t.errorAt({ error: errorText(result.error.code), position: result.error.position })}
              <span className="ml-1 font-dy-mono opacity-70">{result.error.code}</span>
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
