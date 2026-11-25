import { type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes, useId } from 'react';
import { PRIORITY_CLASSES, type PriorityClass } from '../../../api/queue';
import type { ParamType, TemplateParameter, TemplateStats } from '../../../api/templates';
import type { PaginationProps } from '../../../lib/pager';
import { cx } from '../../../components/ui';
import type { Values } from '../../../screens/templates/shared';
import { CLASS_HINT_TR, CLASS_TR } from '../../compose/labels';
import { DyIcon } from '../../icons';
import { DyButton, Pill } from '../parts';

/**
 * p12-diyalog-w1: the pieces the Diyalog Templates screens share — fields in the card vocabulary, the typed
 * parameter form, the version diff, the scope pill, the usage sentence and a pager. The business rules stay in the
 * classic helpers (`screens/templates/shared.tsx`, `TemplateEditor.tsx`); only what the person reads is new.
 */

export const FIELD =
  'min-h-10 w-full min-w-0 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.9375rem] font-normal text-dy-ink placeholder:text-dy-faint disabled:opacity-60 sm:min-h-9 sm:text-[0.875rem]';
export const AREA_FIELD =
  'w-full min-w-0 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 py-2 font-dy-mono text-[0.84375rem] leading-relaxed font-normal text-dy-ink placeholder:text-dy-faint';
const LABEL = 'flex min-w-0 flex-col gap-1 text-[0.8125rem] font-bold';
const HINT = 'text-[0.78125rem] font-normal text-dy-muted';

export const PARAM_TYPE_TR: Readonly<Record<ParamType, string>> = {
  string: 'Kısa metin',
  text: 'Uzun metin',
  int: 'Tam sayı',
  number: 'Sayı',
  url: 'Bağlantı (URL)',
  bool: 'Evet / hayır',
  enum: 'Seçenek',
  file: 'Dosya',
};

/** A labelled input with an optional hint and error. */
export function Field(
  props: InputHTMLAttributes<HTMLInputElement> & {
    readonly label: ReactNode;
    readonly hint?: ReactNode;
    readonly error?: string | undefined;
    readonly mono?: boolean | undefined;
    readonly wrapClass?: string | undefined;
  },
): ReactNode {
  const { label, hint, error, mono, wrapClass, className, ...rest } = props;
  const hintId = useId();
  return (
    <label className={cx(LABEL, wrapClass)}>
      {label}
      <input
        {...rest}
        aria-describedby={hint === undefined && error === undefined ? undefined : hintId}
        aria-invalid={error === undefined ? undefined : true}
        className={cx(FIELD, mono === true && 'font-dy-mono', className)}
      />
      {hint === undefined && error === undefined ? null : (
        <span id={hintId} className={error === undefined ? HINT : 'text-[0.78125rem] text-dy-red-ink'}>
          {error ?? hint}
        </span>
      )}
    </label>
  );
}

export function AreaField(
  props: TextareaHTMLAttributes<HTMLTextAreaElement> & {
    readonly label: ReactNode;
    readonly hint?: ReactNode;
    readonly wrapClass?: string | undefined;
  },
): ReactNode {
  const { label, hint, wrapClass, className, ...rest } = props;
  const hintId = useId();
  return (
    <label className={cx(LABEL, wrapClass)}>
      {label}
      <textarea
        {...rest}
        aria-describedby={hint === undefined ? undefined : hintId}
        className={cx(AREA_FIELD, className)}
      />
      {hint === undefined ? null : (
        <span id={hintId} className={HINT}>
          {hint}
        </span>
      )}
    </label>
  );
}

export function SelectField(props: {
  readonly label: ReactNode;
  readonly value: string;
  readonly options: readonly (readonly [string, string])[];
  readonly onChange: (v: string) => void;
  readonly hint?: ReactNode;
  readonly disabled?: boolean | undefined;
  readonly testId?: string | undefined;
  readonly wrapClass?: string | undefined;
}): ReactNode {
  return (
    <label className={cx(LABEL, props.wrapClass)}>
      {props.label}
      <select
        value={props.value}
        disabled={props.disabled}
        data-testid={props.testId}
        onChange={(e) => {
          props.onChange(e.target.value);
        }}
        className={FIELD}
      >
        {props.options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      {props.hint === undefined ? null : <span className={HINT}>{props.hint}</span>}
    </label>
  );
}

export function CheckField(props: {
  readonly label: ReactNode;
  readonly checked: boolean;
  readonly onChange: (v: boolean) => void;
  readonly id?: string | undefined;
  readonly className?: string | undefined;
}): ReactNode {
  return (
    <label
      htmlFor={props.id}
      className={cx('flex min-h-10 items-center gap-2.5 text-[0.875rem] sm:min-h-9', props.className)}
    >
      <input
        id={props.id}
        type="checkbox"
        checked={props.checked}
        onChange={(e) => {
          props.onChange(e.target.checked);
        }}
        className="size-4 accent-[var(--dy-teal)]"
      />
      {props.label}
    </label>
  );
}

/** The three queue classes as a segmented radio group (Acil · Normal · Arka plan). */
export function ClassPicker(props: {
  readonly value: PriorityClass;
  readonly onChange: (v: PriorityClass) => void;
  readonly label: string;
  readonly testId?: string | undefined;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1.5" data-testid={props.testId}>
      <span className="text-[0.8125rem] font-bold">{props.label}</span>
      <div
        role="radiogroup"
        aria-label={props.label}
        className="inline-flex w-fit flex-wrap gap-0.5 rounded-[10px] border border-dy-line bg-dy-sunk p-[3px]"
      >
        {PRIORITY_CLASSES.map((c) => {
          const on = props.value === c;
          return (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={on}
              data-class={c}
              onClick={() => {
                props.onChange(c);
              }}
              className={cx(
                'inline-flex min-h-9 items-center rounded-[7px] px-3 text-[0.84375rem] font-medium transition-colors duration-150',
                on
                  ? 'bg-dy-card text-dy-ink shadow-dy-seg'
                  : 'text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink',
                on && c === 'urgent' && 'text-dy-red-ink',
              )}
            >
              {CLASS_TR[c]}
            </button>
          );
        })}
      </div>
      <p className={cx('m-0', HINT)}>{CLASS_HINT_TR[props.value]}</p>
    </div>
  );
}

/** "Genel" (every project) or the project's name. */
export function ScopePill(props: { readonly project: string | null }): ReactNode {
  return props.project === null ? (
    <Pill tone="teal" icon="globe">
      Genel
    </Pill>
  ) : (
    <Pill tone="neutral" icon="folder">
      {props.project}
    </Pill>
  );
}

export function secText(sec: number): string {
  if (sec < 90) return `${String(Math.round(sec))} sn`;
  if (sec < 5400) return `${String(Math.round(sec / 60))} dk`;
  return `${(sec / 3600).toFixed(1).replace('.', ',')} sa`;
}

/** The usage sentence (classic `statsLine` in Turkish). */
export function statsText(s: TemplateStats): string {
  if (s.runs === 0)
    return s.automations > 0 ? `${String(s.automations)} otomasyon, henüz çalışmadı` : 'Henüz çalışmadı';
  const parts = [`${String(s.runs)} çalışma`];
  if (s.successRate !== null) parts.push(`%${String(Math.round(s.successRate * 100))} başarılı`);
  if (s.avgCostUsd !== null) parts.push(`ort. $${s.avgCostUsd.toFixed(2)}`);
  if (s.avgDurationSec !== null) parts.push(`ort. ${secText(s.avgDurationSec)}`);
  if (s.automations > 0) parts.push(`${String(s.automations)} otomasyon`);
  return parts.join(' · ');
}

/**
 * One input per parameter, typed (the classic `ParamForm` rules: number fields with their range, URL fields, enum
 * selects, a checkbox, text areas with their length limit; `*` marks a required field without a default).
 */
export function ParamFields(props: {
  readonly params: readonly TemplateParameter[];
  readonly values: Values;
  readonly onChange: (v: Values) => void;
  readonly idPrefix?: string | undefined;
}): ReactNode {
  if (props.params.length === 0) {
    return <p className="m-0 text-[0.875rem] text-dy-muted">Bu şablonun parametresi yok.</p>;
  }
  const set = (name: string, v: string | boolean): void => {
    props.onChange({ ...props.values, [name]: v });
  };
  const prefix = props.idPrefix ?? 'param';
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="param-form">
      {props.params.map((p) => {
        const id = `${prefix}-${p.name}`;
        const required = !(p.required === false || p.default !== undefined);
        const name = p.label ?? p.name;
        const v = props.values[p.name];
        const hint = [
          p.description,
          p.type === 'file' ? 'in/ altındaki dosya adı (dosyayı formda ekle)' : null,
        ]
          .filter((x): x is string => typeof x === 'string' && x !== '')
          .join(' · ');
        const label = (
          <span>
            {name}
            {required ? <span aria-hidden="true"> *</span> : null}
            <span className="ml-1.5 text-[0.75rem] font-normal text-dy-muted">{PARAM_TYPE_TR[p.type]}</span>
          </span>
        );
        if (p.type === 'bool')
          return (
            <div key={p.name} className="flex flex-col">
              <CheckField
                id={id}
                label={<span className="font-bold">{name}</span>}
                checked={v === true}
                onChange={(c) => {
                  set(p.name, c);
                }}
              />
              {hint === '' ? null : <span className={HINT}>{hint}</span>}
            </div>
          );
        if (p.type === 'enum')
          return (
            <SelectField
              key={p.name}
              label={label}
              value={typeof v === 'string' ? v : ''}
              options={[['', 'Seç…'], ...(p.options ?? []).map((o) => [o, o] as const)]}
              onChange={(x) => {
                set(p.name, x);
              }}
              hint={hint === '' ? undefined : hint}
            />
          );
        if (p.type === 'text')
          return (
            <AreaField
              key={p.name}
              id={id}
              wrapClass="sm:col-span-2"
              label={label}
              rows={4}
              value={typeof v === 'string' ? v : ''}
              maxLength={p.maxLength ?? 8000}
              onChange={(e) => {
                set(p.name, e.target.value);
              }}
              hint={hint === '' ? undefined : hint}
            />
          );
        return (
          <Field
            key={p.name}
            id={id}
            label={label}
            type={p.type === 'int' || p.type === 'number' ? 'number' : p.type === 'url' ? 'url' : 'text'}
            inputMode={p.type === 'int' ? 'numeric' : undefined}
            mono={p.type === 'url' || p.type === 'file'}
            {...(p.min === undefined ? {} : { min: p.min })}
            {...(p.max === undefined ? {} : { max: p.max })}
            value={typeof v === 'string' ? v : ''}
            onChange={(e) => {
              set(p.name, e.target.value);
            }}
            hint={hint === '' ? undefined : hint}
          />
        );
      })}
    </div>
  );
}

/** A unified diff: added lines green with "+", removed red with "−", hunk headers muted; words for screen readers. */
export function DiffBlock(props: { readonly diff: string }): ReactNode {
  if (props.diff === '')
    return (
      <p className="m-0 text-[0.875rem] text-dy-muted" data-testid="dy-diff-empty">
        Bu iki sürüm arasında fark yok.
      </p>
    );
  const lines = props.diff.split('\n');
  const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
  return (
    <figure className="m-0" data-testid="dy-diff">
      <figcaption className="mb-1.5 flex gap-3 text-[0.8125rem] text-dy-muted">
        <span className="text-dy-green">{`+${String(added)} satır eklendi`}</span>
        <span className="text-dy-red-ink">{`−${String(removed)} satır çıkarıldı`}</span>
      </figcaption>
      <pre className="m-0 max-h-[28rem] overflow-auto rounded-[10px] border border-dy-line bg-dy-sunk py-2 font-dy-mono text-[0.78125rem] leading-relaxed">
        {lines.map((l, i) => {
          const add = l.startsWith('+') && !l.startsWith('+++');
          const del = l.startsWith('-') && !l.startsWith('---');
          const hunk = l.startsWith('@@');
          return (
            <span
              key={i}
              data-kind={add ? 'add' : del ? 'del' : hunk ? 'hunk' : 'ctx'}
              className={cx(
                'block px-3 whitespace-pre-wrap [overflow-wrap:anywhere]',
                add && 'bg-dy-green-soft text-dy-green',
                del && 'bg-dy-red-soft text-dy-red-ink',
                (hunk || l.startsWith('+++') || l.startsWith('---')) && 'text-dy-muted',
              )}
            >
              {add ? (
                <span className="sr-only">eklendi: </span>
              ) : del ? (
                <span className="sr-only">çıkarıldı: </span>
              ) : null}
              {l === '' ? ' ' : l}
            </span>
          );
        })}
      </pre>
    </figure>
  );
}

/** Client pages: "1–25 / 60", first / previous / next / last, page size (the classic pager's state and URL). */
export function Pager(props: PaginationProps): ReactNode {
  const { page, pageSize, count, total } = props;
  if (page === 1 && !props.hasNext && (total ?? count) <= 25 && pageSize === 25) return null;
  const from = count === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = (page - 1) * pageSize + count;
  return (
    <nav
      aria-label={props.label}
      className={cx(
        'flex flex-wrap items-center gap-2 px-4 py-3 text-[0.8125rem] text-dy-muted',
        props.className,
      )}
    >
      <span className="font-dy-mono tabular-nums" aria-live="polite">
        {total === undefined || total === null
          ? `${String(from)}–${String(to)}`
          : `${String(from)}–${String(to)} / ${String(total)}`}
      </span>
      <span className="ml-auto flex flex-wrap items-center gap-1">
        {props.onFirst !== undefined && page > 2 ? (
          <DyButton variant="ghost" onClick={props.onFirst} aria-label="İlk sayfa">
            İlk
          </DyButton>
        ) : null}
        <DyButton variant="ghost" disabled={page <= 1} onClick={props.onPrev} aria-label="Önceki sayfa">
          <DyIcon name="back" className="size-4" />
          Önceki
        </DyButton>
        <DyButton variant="ghost" disabled={!props.hasNext} onClick={props.onNext} aria-label="Sonraki sayfa">
          Sonraki
          <DyIcon name="chev" className="size-4" />
        </DyButton>
        {props.onLast !== undefined && props.hasNext ? (
          <DyButton variant="ghost" onClick={props.onLast} aria-label="Son sayfa">
            Son
          </DyButton>
        ) : null}
        <label className="ml-1 flex items-center gap-1.5">
          Sayfa başına
          <select
            value={pageSize}
            onChange={(e) => {
              props.onPageSize(Number(e.target.value));
            }}
            className="min-h-9 rounded-[8px] border border-dy-line-2 bg-dy-card px-2 text-dy-ink"
          >
            {[25, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </span>
    </nav>
  );
}
