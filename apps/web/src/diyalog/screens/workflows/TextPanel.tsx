import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { cx } from '../../../components/ui';
import { useT } from '../../../i18n/I18nProvider';
import { DyIcon } from '../../icons';
import type { Doc } from './model';
import { parseText, serialize, type TextFormat } from './text';

/**
 * p13-workflows-ui (docs/design/p13-workflows-ui.md §3.4): the definition as YAML or JSON beside the canvas, synced
 * both ways. Canvas edits rewrite the text while it is not being typed in; typed text that parses into a valid shape
 * (model.asDoc) replaces the document after a short pause (one undo step per pause). Text that does not parse stays
 * in the panel with the reason; the document keeps its last good state. The master validates on Doğrula / Kaydet.
 */

const APPLY_MS = 500;

export function TextPanel(props: {
  readonly doc: Doc;
  readonly readOnly: boolean;
  readonly onApply: (doc: Doc) => void;
  readonly onClose: () => void;
}): ReactNode {
  const [fmt, setFmt] = useState<TextFormat>('yaml');
  const [text, setText] = useState(() => serialize(props.doc, 'yaml'));
  const [error, setError] = useState<string | null>(null);
  const editing = useRef(false);
  const timer = useRef<number | null>(null);
  const id = useId();
  const { doc, onApply } = props;
  const w = useT().workflows;

  // The document changed elsewhere (canvas, inspector, undo): show it, unless the user is typing here.
  useEffect(() => {
    if (editing.current) return;
    setText(serialize(doc, fmt));
    setError(null);
  }, [doc, fmt]);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const apply = (value: string): void => {
    const r = parseText(value, fmt, w);
    if ('error' in r) {
      setError(r.error);
      return;
    }
    setError(null);
    onApply(r.doc);
  };

  return (
    <section aria-labelledby={id} className="flex h-full min-h-0 flex-col" data-testid="workflow-text-panel">
      <div className="flex shrink-0 items-center gap-2 border-b border-dy-line px-3 py-2">
        <h2 id={id} className="m-0 flex-1 text-[0.9375rem] font-bold">
          {w.textPanel.title}
        </h2>
        <div
          role="radiogroup"
          aria-label={w.textPanel.format}
          className="flex rounded-[8px] border border-dy-line bg-dy-sunk p-0.5"
        >
          {(['yaml', 'json'] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={fmt === f}
              onClick={() => {
                if (error !== null) return; // keep the user's unparsed text until it is fixed
                editing.current = false;
                setFmt(f);
              }}
              disabled={error !== null && fmt !== f}
              className={cx(
                'min-h-8 rounded-[6px] px-2.5 font-dy-mono text-[0.75rem] font-bold uppercase disabled:opacity-50',
                fmt === f ? 'bg-dy-card text-dy-ink shadow-[0_1px_2px_rgb(24_32_49/0.1)]' : 'text-dy-muted',
              )}
            >
              {f}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label={w.textPanel.close}
          onClick={props.onClose}
          className="dy-press grid size-8 place-items-center rounded-lg text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk"
        >
          <DyIcon name="xc" className="size-4" />
        </button>
      </div>
      <label htmlFor={`${id}-text`} className="sr-only">
        {w.textPanel.definition({ format: fmt.toUpperCase() })}
      </label>
      <textarea
        id={`${id}-text`}
        data-testid="workflow-text"
        value={text}
        readOnly={props.readOnly}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-invalid={error !== null || undefined}
        aria-describedby={`${id}-status`}
        onFocus={() => {
          editing.current = true;
        }}
        onBlur={() => {
          editing.current = false;
          if (timer.current !== null) {
            window.clearTimeout(timer.current);
            timer.current = null;
            apply(text);
          }
        }}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => {
            timer.current = null;
            apply(v);
          }, APPLY_MS);
        }}
        className="min-h-0 w-full flex-1 resize-none border-0 bg-dy-card p-3 font-dy-mono text-[0.78125rem] leading-[1.55] text-dy-ink outline-none"
      />
      <p
        id={`${id}-status`}
        role="status"
        className={cx(
          'm-0 shrink-0 border-t border-dy-line px-3 py-2 text-[0.78125rem]',
          error === null ? 'text-dy-muted' : 'bg-dy-red-soft text-dy-red-ink',
        )}
        data-testid="workflow-text-status"
      >
        {error ?? (props.readOnly ? w.textPanel.readOnly : w.textPanel.inSync)}
      </p>
    </section>
  );
}
