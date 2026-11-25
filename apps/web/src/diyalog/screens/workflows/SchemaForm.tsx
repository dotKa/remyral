import { type ReactNode, useEffect, useState } from 'react';
import type { JsonSchema, Sample } from '../../../api/workflowEngine';
import { useT } from '../../../i18n/I18nProvider';
import { DyCheck, DyChoice, DyInput, DyTextarea } from '../kit';
import { DyButton } from '../parts';
import { ExpressionField } from './ExpressionField';
import type { Suggestion } from './nodeCatalog';

/**
 * p14-workflow-engine 14.1 (docs/design/p14-workflow-engine.md §7.2): a node's config form generated from the
 * catalog's JSON Schema (`z.toJSONSchema` of the catalog's strict zod schema) and its field modes. Static fields are
 * plain inputs (text, number, select, checkbox); expression-capable fields have an `fx` switch between the literal and
 * a whole-value expression (`{ "$expr": … }`), and their text takes `{{ }}` templates; records (set fields, query,
 * headers) and lists of objects (switch cases, aggregate operations) are small list editors; anything else is edited
 * as raw JSON. Every change goes out as the field's new value (undefined: remove the key).
 */

type JS = Record<string, unknown>;

const isObj = (v: unknown): v is JS => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A copy of `o` with `k` set to `v` (undefined: without `k`). */
export function withKey(o: Readonly<JS>, k: string, v: unknown): JS {
  if (v !== undefined) return { ...o, [k]: v };
  return Object.fromEntries(Object.entries(o).filter(([x]) => x !== k));
}

export const isExprValue = (v: unknown): v is { $expr: string } => isObj(v) && typeof v.$expr === 'string';

function isExprOption(s: unknown): boolean {
  return isObj(s) && isObj(s.properties) && '$expr' in s.properties;
}

function isTemplateOption(s: unknown): boolean {
  return isObj(s) && s.type === 'string' && typeof s.pattern === 'string' && s.pattern.includes('\\{\\{');
}

/** An expression-capable schema (`anyOf [literal, template, {$expr}]`) → its literal part. */
export function splitExpr(s: JS): { literal: JS | null; expr: boolean; exprOnly: boolean } {
  if (isExprOption(s)) return { literal: null, expr: true, exprOnly: true };
  const opts = Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : null;
  if (opts === null || !opts.some(isExprOption)) return { literal: s, expr: false, exprOnly: false };
  const lit = opts.filter((o) => !isExprOption(o) && !isTemplateOption(o));
  if (lit.length === 0) return { literal: null, expr: true, exprOnly: true };
  return {
    literal: lit.length === 1 && isObj(lit[0]) ? lit[0] : { anyOf: lit },
    expr: true,
    exprOnly: false,
  };
}

type Kind = 'enum' | 'boolean' | 'number' | 'string' | 'object' | 'record' | 'list' | 'json';

function enumOf(s: JS): string[] | null {
  if (Array.isArray(s.enum) && s.enum.every((x) => typeof x === 'string')) return s.enum;
  if (Array.isArray(s.anyOf) && s.anyOf.every((o) => isObj(o) && typeof o.const === 'string'))
    return s.anyOf.map((o) => (o as { const: string }).const);
  return null;
}

export function kindOf(s: JS | null): Kind {
  if (s === null) return 'json';
  if (enumOf(s) !== null) return 'enum';
  if (s.type === 'boolean') return 'boolean';
  if (s.type === 'number' || s.type === 'integer') return 'number';
  if (s.type === 'string') return 'string';
  if (s.type === 'object' && isObj(s.properties) && Object.keys(s.properties).length > 0) return 'object';
  if (s.type === 'object' && isObj(s.additionalProperties) && s.properties === undefined) return 'record';
  if (s.type === 'array' && isObj(s.items) && s.items.type === 'object' && isObj(s.items.properties))
    return 'list';
  return 'json';
}

export interface FieldContext {
  readonly readOnly: boolean;
  readonly suggestions: readonly Suggestion[];
  readonly preview: { readonly project: string; readonly sample: Sample } | null;
  /** Issue words per config field path (`cases.0.name`). */
  readonly errors: ReadonlyMap<string, string>;
}

function JsonEditor(props: {
  readonly label: ReactNode;
  readonly value: unknown;
  readonly readOnly: boolean;
  readonly onChange: (v: unknown) => void;
  readonly error?: string | null;
}): ReactNode {
  const t = useT().workflows.form;
  const text = props.value === undefined ? '' : JSON.stringify(props.value, null, 2);
  const [draft, setDraft] = useState(text);
  const [bad, setBad] = useState(false);
  useEffect(() => {
    setDraft(text);
    setBad(false);
  }, [text]);
  return (
    <DyTextarea
      label={props.label}
      value={draft}
      readOnly={props.readOnly}
      spellCheck={false}
      className="font-dy-mono text-[0.78125rem]"
      error={bad ? t.badJson : (props.error ?? null)}
      onChange={(e) => {
        setDraft(e.target.value);
      }}
      onBlur={() => {
        if (draft.trim() === '') {
          setBad(false);
          props.onChange(undefined);
          return;
        }
        try {
          props.onChange(JSON.parse(draft) as unknown);
          setBad(false);
        } catch {
          setBad(true);
        }
      }}
    />
  );
}

/** One field of a config (recursive for objects / lists). */
export function SchemaField(props: {
  readonly name: string;
  readonly path: string;
  readonly schema: JS;
  readonly mode: 'static' | 'expr';
  readonly value: unknown;
  readonly required: boolean;
  readonly ctx: FieldContext;
  readonly onChange: (v: unknown) => void;
}): ReactNode {
  const t = useT().workflows.form;
  const { schema, value, ctx, name } = props;
  const split = splitExpr(schema);
  const canExpr = props.mode === 'expr' || split.expr;
  const error = ctx.errors.get(props.path) ?? null;
  const label = (
    <span className="font-dy-mono">
      {name}
      {props.required ? (
        ''
      ) : (
        <span className="ml-1 font-dy-sans font-normal text-dy-muted">{t.optional}</span>
      )}
    </span>
  );
  const fx = isExprValue(value) || (split.exprOnly && canExpr);
  if (canExpr && fx) {
    return (
      <div className="grid gap-1" data-field={props.path}>
        <ExpressionField
          label={label}
          value={isExprValue(value) ? value.$expr : ''}
          mode="expr"
          suggestions={ctx.suggestions}
          preview={ctx.preview}
          readOnly={ctx.readOnly}
          error={error}
          testId={`expr-${props.path}`}
          onChange={(v) => {
            props.onChange(v === '' && !props.required ? undefined : { $expr: v });
          }}
        />
        {split.exprOnly || ctx.readOnly ? null : (
          <button
            type="button"
            className="justify-self-start text-[0.75rem] text-dy-teal-ink underline"
            data-testid={`fx-off-${props.path}`}
            onClick={() => {
              props.onChange(undefined);
            }}
          >
            {t.useLiteral}
          </button>
        )}
      </div>
    );
  }
  const lit = split.literal ?? schema;
  const kind = kindOf(lit);
  const fxButton =
    canExpr && !ctx.readOnly ? (
      <button
        type="button"
        className="justify-self-start text-[0.75rem] text-dy-violet-ink underline"
        data-testid={`fx-on-${props.path}`}
        aria-label={t.useExpressionFor({ field: name })}
        onClick={() => {
          props.onChange({ $expr: value === undefined || isObj(value) ? '' : JSON.stringify(value) });
        }}
      >
        {t.useExpression}
      </button>
    ) : null;
  let field: ReactNode;
  switch (kind) {
    case 'enum': {
      const opts = enumOf(lit) ?? [];
      field = (
        <DyChoice
          label={label}
          value={typeof value === 'string' ? value : ''}
          disabled={ctx.readOnly}
          error={error}
          options={[...(props.required ? [] : [['', t.none] as const]), ...opts.map((o) => [o, o] as const)]}
          onChange={(v) => {
            props.onChange(v === '' ? undefined : v);
          }}
        />
      );
      break;
    }
    case 'boolean':
      field = (
        <DyCheck
          label={label}
          checked={value === true}
          disabled={ctx.readOnly}
          onChange={(v) => {
            props.onChange(v);
          }}
        />
      );
      break;
    case 'number':
      field = (
        <DyInput
          label={label}
          type="number"
          inputMode="numeric"
          value={typeof value === 'number' ? String(value) : ''}
          readOnly={ctx.readOnly}
          error={error}
          onChange={(e) => {
            const v = e.target.value.trim();
            const n = Number(v);
            props.onChange(v === '' || !Number.isFinite(n) ? undefined : n);
          }}
        />
      );
      break;
    case 'string':
      field = canExpr ? (
        <ExpressionField
          label={label}
          value={typeof value === 'string' ? value : ''}
          mode="template"
          suggestions={ctx.suggestions}
          preview={ctx.preview}
          readOnly={ctx.readOnly}
          error={error}
          testId={`tpl-${props.path}`}
          onChange={(v) => {
            props.onChange(v === '' && !props.required ? undefined : v);
          }}
        />
      ) : (
        <DyInput
          label={label}
          value={typeof value === 'string' ? value : ''}
          readOnly={ctx.readOnly}
          error={error}
          spellCheck={false}
          onChange={(e) => {
            props.onChange(e.target.value === '' && !props.required ? undefined : e.target.value);
          }}
        />
      );
      break;
    case 'object': {
      const props2 = (lit.properties ?? {}) as Record<string, JS>;
      const req = new Set(Array.isArray(lit.required) ? (lit.required as string[]) : []);
      const cur = isObj(value) ? value : {};
      field = (
        <fieldset className="m-0 grid gap-2 rounded-[10px] border border-dy-line p-2.5">
          <legend className="px-1 text-[0.8125rem] font-bold">{label}</legend>
          {Object.entries(props2).map(([k, s]) => (
            <SchemaField
              key={k}
              name={k}
              path={`${props.path}.${k}`}
              schema={s}
              mode={splitExpr(s).expr ? 'expr' : 'static'}
              value={cur[k]}
              required={req.has(k)}
              ctx={ctx}
              onChange={(v) => {
                const next = withKey(cur, k, v);
                props.onChange(Object.keys(next).length === 0 && !props.required ? undefined : next);
              }}
            />
          ))}
        </fieldset>
      );
      break;
    }
    case 'record': {
      const valueSchema = lit.additionalProperties as JS;
      const cur = isObj(value) ? value : {};
      field = (
        <RecordEditor
          label={label}
          path={props.path}
          entries={cur}
          valueSchema={valueSchema}
          mode={props.mode}
          ctx={ctx}
          onChange={(next) => {
            props.onChange(Object.keys(next).length === 0 && !props.required ? undefined : next);
          }}
        />
      );
      break;
    }
    case 'list': {
      const item = lit.items as JS;
      const cur: unknown[] = Array.isArray(value) ? (value as unknown[]) : [];
      const props2 = (item.properties ?? {}) as Record<string, JS>;
      const req = new Set(Array.isArray(item.required) ? (item.required as string[]) : []);
      field = (
        <fieldset
          className="m-0 grid gap-2 rounded-[10px] border border-dy-line p-2.5"
          data-testid={`list-${props.path}`}
        >
          <legend className="px-1 text-[0.8125rem] font-bold">{label}</legend>
          {cur.map((row, i) => (
            <div key={i} className="grid gap-2 rounded-[8px] bg-dy-sunk p-2">
              {Object.entries(props2).map(([k, s]) => (
                <SchemaField
                  key={k}
                  name={k}
                  path={`${props.path}.${String(i)}.${k}`}
                  schema={s}
                  mode={splitExpr(s).expr ? 'expr' : 'static'}
                  value={isObj(row) ? row[k] : undefined}
                  required={req.has(k)}
                  ctx={ctx}
                  onChange={(v) => {
                    const r = withKey(isObj(row) ? row : {}, k, v);
                    props.onChange(cur.map((x, j) => (j === i ? r : x)));
                  }}
                />
              ))}
              {ctx.readOnly ? null : (
                <DyButton
                  variant="ghost"
                  icon="trash"
                  onClick={() => {
                    props.onChange(cur.filter((_, j) => j !== i));
                  }}
                >
                  {t.removeRow}
                </DyButton>
              )}
            </div>
          ))}
          {ctx.readOnly ? null : (
            <DyButton
              icon="plus"
              data-testid={`list-add-${props.path}`}
              onClick={() => {
                props.onChange([...cur, {}]);
              }}
            >
              {t.addRow}
            </DyButton>
          )}
        </fieldset>
      );
      break;
    }
    default:
      field = (
        <JsonEditor
          label={label}
          value={value}
          readOnly={ctx.readOnly}
          error={error}
          onChange={props.onChange}
        />
      );
  }
  return (
    <div className="grid gap-1" data-field={props.path}>
      {field}
      {fxButton}
    </div>
  );
}

function RecordEditor(props: {
  readonly label: ReactNode;
  readonly path: string;
  readonly entries: JS;
  readonly valueSchema: JS;
  readonly mode: 'static' | 'expr';
  readonly ctx: FieldContext;
  readonly onChange: (next: JS) => void;
}): ReactNode {
  const t = useT().workflows.form;
  const [key, setKey] = useState('');
  const entries = Object.entries(props.entries);
  return (
    <fieldset
      className="m-0 grid gap-2 rounded-[10px] border border-dy-line p-2.5"
      data-testid={`record-${props.path}`}
    >
      <legend className="px-1 text-[0.8125rem] font-bold">{props.label}</legend>
      {entries.map(([k, v]) => (
        <div key={k} className="grid gap-1 rounded-[8px] bg-dy-sunk p-2">
          <SchemaField
            name={k}
            path={`${props.path}.${k}`}
            schema={props.valueSchema}
            mode={props.mode}
            value={v}
            required
            ctx={props.ctx}
            onChange={(nv) => {
              const next = withKey(props.entries, k, nv);
              props.onChange(next);
            }}
          />
          {props.ctx.readOnly ? null : (
            <DyButton
              variant="ghost"
              icon="trash"
              onClick={() => {
                const next = withKey(props.entries, k, undefined);
                props.onChange(next);
              }}
            >
              {t.removeRow}
            </DyButton>
          )}
        </div>
      ))}
      {props.ctx.readOnly ? null : (
        <div className="flex items-end gap-2">
          <DyInput
            label={t.newKey}
            value={key}
            spellCheck={false}
            wrapClassName="min-w-0 flex-1"
            onChange={(e) => {
              setKey(e.target.value.trim());
            }}
          />
          <DyButton
            icon="plus"
            disabled={key === '' || key in props.entries}
            onClick={() => {
              props.onChange({ ...props.entries, [key]: props.mode === 'expr' ? { $expr: '' } : '' });
              setKey('');
            }}
          >
            {t.addRow}
          </DyButton>
        </div>
      )}
    </fieldset>
  );
}

/** The whole config of a node: one field per schema property, in the schema's order. */
export function SchemaForm(props: {
  readonly schema: JsonSchema;
  readonly fields: Readonly<Record<string, 'static' | 'expr'>>;
  readonly value: Readonly<Record<string, unknown>>;
  readonly ctx: FieldContext;
  readonly onChange: (next: Record<string, unknown>) => void;
}): ReactNode {
  const t = useT().workflows.form;
  const schema = props.schema;
  const properties = isObj(schema.properties) ? (schema.properties as Record<string, JS>) : null;
  if (properties === null) {
    // A union of shapes (e.g. an uptime check): edit the config as JSON.
    return (
      <JsonEditor
        label={t.configJson}
        value={props.value}
        readOnly={props.ctx.readOnly}
        onChange={(v) => {
          props.onChange(isObj(v) ? v : {});
        }}
      />
    );
  }
  const req = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  if (Object.keys(properties).length === 0)
    return <p className="m-0 text-[0.84375rem] text-dy-muted">{t.noConfig}</p>;
  return (
    <div className="grid gap-3" data-testid="node-config-form">
      {Object.entries(properties).map(([k, s]) => (
        <SchemaField
          key={k}
          name={k}
          path={k}
          schema={s}
          mode={props.fields[k] ?? 'static'}
          value={props.value[k]}
          required={req.has(k)}
          ctx={props.ctx}
          onChange={(v) => {
            const next = withKey(props.value, k, v);
            props.onChange(next);
          }}
        />
      ))}
    </div>
  );
}
