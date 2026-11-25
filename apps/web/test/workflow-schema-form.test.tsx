// p14-workflow-engine 14.1: the node config form generated from the catalog's JSON Schema — static fields as plain
// inputs / selects, expression fields with the fx switch, lists of objects (switch cases) and records (set fields).
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { parseCatalog } from '../src/api/workflowEngine';
import { highlight } from '../src/diyalog/screens/workflows/ExpressionField';
import { kindOf, SchemaForm, splitExpr } from '../src/diyalog/screens/workflows/SchemaForm';
import { CATALOG } from './workflow-catalog-fixture';

const catalog = parseCatalog(CATALOG);
const info = (type: string) => {
  const t = catalog.types.find((x) => x.type === type);
  if (t === undefined) throw new Error(type);
  return t;
};

function Harness(props: { type: string; initial: Record<string, unknown>; out: { v: unknown } }) {
  const [value, setValue] = useState(props.initial);
  const t = info(props.type);
  return (
    <SchemaForm
      schema={t.config}
      fields={t.fields}
      value={value}
      ctx={{
        readOnly: false,
        suggestions: [],
        preview: null,
        errors: new Map([['value', 'ifade sözdizimi hatalı']]),
      }}
      onChange={(next) => {
        props.out.v = next;
        setValue(next);
      }}
    />
  );
}

describe('node config form (p14-workflow-engine 14.1)', () => {
  it('reads expression unions and field kinds from the JSON Schema', () => {
    const cond = (info('control.if').config.properties as Record<string, Record<string, unknown>>).condition;
    if (cond === undefined) throw new Error('fixture');
    expect(splitExpr(cond)).toMatchObject({ expr: true, exprOnly: false });
    const items = (info('control.forEach').config.properties as Record<string, Record<string, unknown>>)
      .items;
    if (items === undefined) throw new Error('fixture');
    expect(splitExpr(items)).toMatchObject({ expr: true, exprOnly: true });
    expect(kindOf({ type: 'string', enum: ['a', 'b'] })).toBe('enum');
    expect(kindOf({ type: 'object', additionalProperties: {} })).toBe('record');
    expect(kindOf({ type: 'array', items: { type: 'object', properties: { a: {} } } })).toBe('list');
    expect(kindOf(null)).toBe('json');
    expect(highlight('a {{ $x }} b', 'template').map((p) => p.kind)).toEqual(['plain', 'tpl', 'plain']);
    expect(highlight('$sum($input.n) > 2', 'expr').map((p) => p.kind)).toEqual([
      'fn',
      'plain',
      'var',
      'plain',
      'num',
    ]);
  });

  it('switch: an expression value with its issue, a static mode select and a list of cases', () => {
    const out: { v: unknown } = { v: null };
    render(
      <Harness
        type="control.switch"
        initial={{ value: { $expr: '$input.kind' }, cases: [{ name: 'a', equals: 'a' }] }}
        out={out}
      />,
    );
    const value = screen.getByTestId('expr-value');
    expect(within(value).getByRole('alert').textContent).toBe('ifade sözdizimi hatalı');
    fireEvent.change(within(value).getByRole('combobox'), { target: { value: '$input.type' } });
    expect(out.v).toMatchObject({ value: { $expr: '$input.type' } });
    // Back to a fixed value, then fx again.
    fireEvent.click(screen.getByTestId('fx-off-value'));
    expect(out.v).not.toHaveProperty('value');
    fireEvent.click(screen.getByTestId('fx-on-value'));
    expect(out.v).toMatchObject({ value: { $expr: '' } });
    // Static select.
    fireEvent.change(screen.getByLabelText(/mode/), { target: { value: 'all' } });
    expect(out.v).toMatchObject({ mode: 'all' });
    // Cases: add a row, name it.
    const list = screen.getByTestId('list-cases');
    fireEvent.click(within(list).getByTestId('list-add-cases'));
    const names = within(list).getAllByLabelText(/^name/);
    expect(names).toHaveLength(2);
    fireEvent.change(names[1] as HTMLElement, { target: { value: 'big' } });
    expect(out.v).toMatchObject({ cases: [{ name: 'a', equals: 'a' }, { name: 'big' }] });
  });

  it('set: a record of expression fields; add and remove a field', () => {
    const out: { v: unknown } = { v: null };
    render(<Harness type="data.set" initial={{ fields: { x: { $expr: '1' } } }} out={out} />);
    const rec = screen.getByTestId('record-fields');
    fireEvent.change(within(rec).getByLabelText('Yeni alan adı'), { target: { value: 'y' } });
    fireEvent.click(within(rec).getByRole('button', { name: 'Ekle' }));
    expect(out.v).toEqual({ fields: { x: { $expr: '1' }, y: { $expr: '' } } });
    fireEvent.click(within(rec).getAllByRole('button', { name: 'Kaldır' })[0] as HTMLElement);
    expect(out.v).toEqual({ fields: { y: { $expr: '' } } });
    // keepInput: a static checkbox.
    fireEvent.click(screen.getByRole('checkbox'));
    expect(out.v).toMatchObject({ keepInput: true });
  });
});
