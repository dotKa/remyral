import { afterAll, describe, expect, it } from 'vitest';
import { innermost, iterationScope, parseOutputBlock, typedInputs } from '../../src/workflows/v2/engine.js';
import { dateTime, durationSec, formatInstant, PureExecutor } from '../../src/workflows/v2/pure.js';
import { isPayloadRef, redactValue } from '../../src/workflows/v2/values.js';
import type { WorkflowDefinitionV2 } from '@remyral/workflow-nodes';

/** p14-workflow-engine 14.1: the master-pure executor's bounded helpers, value redaction and iteration scopes. */
describe('engine 2 helpers (p14 14.1)', () => {
  const pure = new PureExecutor();
  afterAll(async () => {
    await pure.close();
  });
  const NOW = '2026-10-20T10:00:00.000Z';

  it('durations: seconds or ISO 8601 (days … seconds); anything else is invalid', () => {
    expect(durationSec(90)).toBe(90);
    expect(durationSec('PT1M30S')).toBe(90);
    expect(durationSec('P1DT2H')).toBe(93_600);
    expect(durationSec('120')).toBe(120);
    expect(durationSec('P1Y')).toBeNull();
    expect(durationSec(-1)).toBeNull();
    expect(durationSec('PT')).toBeNull();
  });

  it('dates: parse a wall time in a zone, format, add (calendar months), diff', () => {
    expect(formatInstant(new Date('2026-10-20T10:05:09.007Z'), 'yyyy-MM-dd HH:mm:ss.SSS', 'UTC')).toBe(
      '2026-10-20 10:05:09.007',
    );
    expect(formatInstant(new Date('2026-10-20T10:05:00Z'), 'HH:mm', 'Europe/Istanbul')).toBe('13:05');
    expect(
      dateTime({ operation: 'parse', value: '2026-10-20 13:00', timezone: 'Europe/Istanbul' }, NOW),
    ).toMatchObject({
      ports: { out: '2026-10-20T10:00:00.000Z' },
    });
    expect(
      dateTime({ operation: 'add', value: '2026-01-31T00:00:00Z', amount: 1, unit: 'months' }, NOW),
    ).toMatchObject({
      ports: { out: '2026-02-28T00:00:00.000Z' },
    });
    expect(
      dateTime(
        { operation: 'diff', value: '2026-10-21T10:00:00Z', other: '2026-10-20T10:00:00Z', unit: 'hours' },
        NOW,
      ),
    ).toMatchObject({ ports: { out: 24 } });
    expect(dateTime({ operation: 'now' }, NOW)).toMatchObject({ ports: { out: NOW } });
    expect(dateTime({ operation: 'parse', value: 'tomorrow' }, NOW)).toMatchObject({
      kind: 'error',
      code: 'type_error',
    });
    expect(dateTime({ operation: 'now', timezone: 'Mars/Base' }, NOW)).toMatchObject({
      code: 'invalid_timezone',
    });
  });

  it('executor: a delay becomes a timer at the node run time + duration; waitUntil > 90 days is refused', async () => {
    const ctx = { now: NOW };
    expect(
      await pure.execute({ type: 'control.delay', config: { duration: 'PT1H' }, context: ctx }),
    ).toMatchObject({
      kind: 'timer',
      dueAt: new Date('2026-10-20T11:00:00Z'),
    });
    expect(
      await pure.execute({ type: 'control.waitUntil', config: { at: '2027-06-01T00:00:00Z' }, context: ctx }),
    ).toMatchObject({ kind: 'error', code: 'out_of_range' });
    expect(
      await pure.execute({
        type: 'control.merge',
        config: { combine: 'object' },
        context: ctx,
        merged: { values: [1, 2], from: ['a', 'b'] },
      }),
    ).toMatchObject({ kind: 'value', ports: { out: { a: 1, b: 2 } } });
    expect(await pure.execute({ type: 'http.request', config: {}, context: ctx })).toMatchObject({
      kind: 'error',
      code: 'node_type_unavailable',
    });
  });

  it('values: every string redacted, credential header keys dropped; payload references recognised', () => {
    const v = redactValue({
      a: 'token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF here',
      headers: { Authorization: 'Bearer x', accept: 'json' },
      list: [{ Cookie: 'c' }],
    }) as { a: string; headers: Record<string, string>; list: Record<string, string>[] };
    expect(v.a).not.toContain('sk-ant-api03-abcdefghij');
    expect(v.headers).toEqual({ accept: 'json' });
    expect(v.list).toEqual([{}]);
    expect(isPayloadRef({ $payload: 'a'.repeat(64), size: 3 })).toBe(true);
    expect(isPayloadRef({ $payload: 'x', size: 3, extra: 1 })).toBe(false);
  });

  it('iteration scopes: nested group iterations and their innermost iteration', () => {
    expect(iterationScope('', 'each', 3)).toBe('each[3]');
    expect(iterationScope('each[3]', 'inner', 1)).toBe('each[3]/inner[1]');
    expect(innermost('each[3]/inner[1]')).toEqual({ group: 'inner', index: 1, outer: 'each[3]' });
    expect(innermost('each[12]')).toEqual({ group: 'each', index: 12, outer: '' });
    expect(innermost('')).toBeNull();
  });

  it('AI output blocks: exactly one fenced remyral-output JSON value; typed run inputs', () => {
    expect(parseOutputBlock('done\n```remyral-output\n{"risk":"low"}\n```')).toEqual({
      ok: true,
      value: { risk: 'low' },
    });
    expect(parseOutputBlock('no block')).toEqual({ ok: false });
    expect(parseOutputBlock('```remyral-output\n{bad}\n```')).toEqual({ ok: false });
    expect(parseOutputBlock('```remyral-output\n1\n```\n```remyral-output\n2\n```')).toEqual({ ok: false });
    const def = {
      inputs: {
        n: { required: false, type: 'number' },
        b: { required: false, type: 'boolean' },
        j: { required: false, type: 'json' },
        s: { required: false },
      },
    } as unknown as WorkflowDefinitionV2;
    expect(typedInputs(def, { n: '4', b: 'true', j: '{"a":1}', s: '4' })).toEqual({
      n: 4,
      b: true,
      j: { a: 1 },
      s: '4',
    });
  });
});
