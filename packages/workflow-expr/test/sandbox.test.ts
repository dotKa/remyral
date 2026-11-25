import jsonata from 'jsonata';
import { afterAll, describe, expect, it } from 'vitest';
import { checkSource, expressionsIn, JSONATA_FUNCTIONS, SandboxPool, templateParts } from '../src/index.js';
import { bindingsFor, computeNode, handle } from '../src/sandbox-worker.js';

const NOW = '2026-10-20T10:00:00.000Z';
const ctx = (extra: Record<string, unknown> = {}) => ({ now: NOW, ...extra });

describe('static scan (validation without evaluation)', () => {
  it('refuses $eval, $random, $clone and $shuffle — called or passed as a value — with their position', () => {
    for (const src of [
      '$eval("1+1")',
      '$random()',
      '$clone({})',
      '$shuffle([1,2])',
      '($f := $eval; $f("1"))',
    ]) {
      const e = checkSource(src, 'expr');
      expect(e?.code, src).toBe('expr_function_not_allowed');
      expect(typeof e?.position).toBe('number');
    }
    expect(checkSource('{{ $random() }}', 'template')?.code).toBe('expr_function_not_allowed');
    expect(checkSource('$sum([1,2]) + $count([3])', 'expr')).toBeNull();
  });

  it('refuses long regexes, nested quantifiers and back-references; reports syntax errors with a position', () => {
    expect(checkSource(`$match("a", /${'a'.repeat(201)}/)`, 'expr')?.code).toBe('expr_regex_not_allowed');
    expect(checkSource('$match("a", /(a+)+b/)', 'expr')?.code).toBe('expr_regex_not_allowed');
    expect(checkSource('$match("a", /(a)\\1/)', 'expr')?.code).toBe('expr_regex_not_allowed');
    expect(checkSource('$match("ab", /a[bc]+/)', 'expr')).toBeNull();
    const syntax = checkSource('1 +', 'expr');
    expect(syntax?.code).toBe('expr_syntax');
    expect(syntax?.position).toBeGreaterThan(0);
    expect(checkSource('x'.repeat(5000), 'expr')?.code).toBe('expr_too_long');
  });

  it('finds every expression inside a config value with its path', () => {
    expect(
      expressionsIn({
        a: 'plain',
        b: 'Hi {{ $input.name }}',
        c: [{ $expr: '$x' }],
        d: { $expr: '1', other: 2 },
      }),
    ).toEqual([
      { path: ['b'], source: 'Hi {{ $input.name }}', mode: 'template' },
      { path: ['c', 0], source: '$x', mode: 'expr' },
    ]);
    expect(templateParts('a {{ 1 }} b').map((p) => p.expr)).toEqual(['1', null]);
  });

  it('lists the allowed functions for autocomplete (refused ones absent, custom ones present)', () => {
    const names = JSONATA_FUNCTIONS.map((f) => f.name);
    expect(names).toContain('$sum');
    expect(names).toContain('$uuid5');
    expect(names).toContain('$now');
    expect(names).not.toContain('$eval');
    expect(names).not.toContain('$random');
  });
});

describe('bindings', () => {
  it('shadow the built-ins: $now / $millis are the node run time, refused functions throw even without the scan', async () => {
    const b = bindingsFor(ctx());
    expect(await jsonata('$now()').evaluate({}, b)).toBe(NOW);
    expect(await jsonata('$millis()').evaluate({}, b)).toBe(Date.parse(NOW));
    expect(await jsonata('$now("[Y0001]-[M01]-[D01]")').evaluate({}, b)).toBe('2026-10-20');
    for (const src of ['$eval("1")', '$random()', '$clone({})', '$shuffle([1])']) {
      await expect(jsonata(src).evaluate({}, b), src).rejects.toMatchObject({
        code: 'expr_function_not_allowed',
      });
    }
  });

  it('exposes the context ($input, $node, $inputs, $trigger, $item, $index, $run) and custom functions', async () => {
    const c = ctx({
      input: { n: 2 },
      node: { a: { out: { v: 40 } } },
      inputs: { who: 'ada' },
      trigger: { x: 1 },
      item: 'it',
      index: 3,
      run: { id: 'r1' },
    });
    const r = await handle(
      {
        op: 'eval',
        mode: 'expr',
        source:
          '{"s": $node.a.out.v + $input.n, "w": $inputs.who, "t": $trigger.x, "i": $item & $string($index), "r": $run.id}',
        context: c,
      },
      false,
    );
    expect(r).toEqual({ ok: true, value: { s: 42, w: 'ada', t: 1, i: 'it3', r: 'r1' } });
    const u = await handle(
      {
        op: 'eval',
        mode: 'expr',
        source:
          '[$uuid5("6ba7b811-9dad-11d1-80b4-00c04fd430c8", "remyral"), $hash("a"), $urlEncode("a b"), $base64("hi"), $jsonParse("{\\"k\\":1}").k]',
        context: c,
      },
      false,
    );
    expect(u.ok).toBe(true);
    const [uuid, hash, enc, b64, k] = (u as { value: unknown[] }).value;
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(hash).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
    expect([enc, b64, k]).toEqual(['a%20b', 'aGk=', 1]);
  });

  it('is deterministic: the same input gives the same output 1 000 times', async () => {
    const req = {
      op: 'eval' as const,
      mode: 'expr' as const,
      source:
        '{"t": $now(), "m": $millis(), "u": $uuid5("6ba7b811-9dad-11d1-80b4-00c04fd430c8", $input.k), "s": $sort($input.xs)}',
      context: ctx({ input: { k: 'x', xs: [3, 1, 2] } }),
    };
    const first = JSON.stringify(await handle(req, false));
    for (let i = 0; i < 1000; i++) expect(JSON.stringify(await handle(req, false))).toBe(first);
  });

  it('templates: one {{ }} keeps the value type, mixed text interpolates', async () => {
    expect(
      await handle(
        { op: 'eval', mode: 'template', source: '{{ $input.n > 1 }}', context: ctx({ input: { n: 2 } }) },
        false,
      ),
    ).toEqual({ ok: true, value: true });
    expect(
      await handle(
        {
          op: 'eval',
          mode: 'template',
          source: 'n={{ $input.n }} o={{ $input }}',
          context: ctx({ input: { n: 2 } }),
        },
        false,
      ),
    ).toEqual({ ok: true, value: 'n=2 o={"n":2}' });
  });

  it('errors carry a code and a position, never data', async () => {
    const r = await handle(
      {
        op: 'eval',
        mode: 'expr',
        source: '$input.secret + 1',
        context: ctx({ input: { secret: 'TOP-SECRET-VALUE' } }),
      },
      false,
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('TOP-SECRET');
    expect((r as { code: string }).code).toMatch(/^expr_error:T\d+$/);
  });
});

describe('master-pure node computations', () => {
  const run = (
    type: string,
    config: Record<string, unknown>,
    fields: Record<string, 'static' | 'expr'>,
    input: unknown,
  ) => computeNode(type, config, fields, ctx({ input }));

  it('if / switch', async () => {
    expect(
      (await run('control.if', { condition: '{{ $input.n > 1 }}' }, { condition: 'expr' }, { n: 2 })).ports,
    ).toEqual({ true: { n: 2 } });
    await expect(
      run('control.if', { condition: { $expr: '"yes"' } }, { condition: 'expr' }, {}),
    ).rejects.toMatchObject({ code: 'type_error' });
    const sw = {
      value: { $expr: '$input.kind' },
      mode: 'first',
      cases: [
        { name: 'bug', equals: 'bug' },
        { name: 'big', match: { $expr: '$input.size > 10' } },
      ],
    };
    const f = { value: 'expr', mode: 'static', cases: 'static' } as const;
    expect((await run('control.switch', sw, f, { kind: 'bug', size: 20 })).ports).toEqual({
      bug: { kind: 'bug', size: 20 },
    });
    expect(
      Object.keys(
        (await run('control.switch', { ...sw, mode: 'all' }, f, { kind: 'bug', size: 20 })).ports ?? {},
      ),
    ).toEqual(['bug', 'big']);
    expect(Object.keys((await run('control.switch', sw, f, { kind: 'x', size: 1 })).ports ?? {})).toEqual([
      'default',
    ]);
  });

  it('set / transform / filter / aggregate / split / template', async () => {
    expect(
      (
        await run(
          'data.set',
          { fields: { a: { $expr: '$input.x * 2' }, b: 'lit' }, keepInput: true },
          { fields: 'expr', keepInput: 'static' },
          { x: 2 },
        )
      ).ports,
    ).toEqual({ out: { x: 2, a: 4, b: 'lit' } });
    expect(
      (
        await run(
          'data.transform',
          { expression: { $expr: '$input.xs[$ > 1]' } },
          { expression: 'expr' },
          { xs: [1, 2, 3] },
        )
      ).ports,
    ).toEqual({ out: [2, 3] });
    expect(
      (
        await run(
          'data.filter',
          { items: { $expr: '$input' }, keep: { $expr: 'price > 10' } },
          { items: 'expr', keep: 'expr' },
          [{ price: 5 }, { price: 15 }],
        )
      ).ports,
    ).toEqual({ kept: [{ price: 15 }], dropped: [{ price: 5 }] });
    const agg = await run(
      'data.aggregate',
      {
        items: { $expr: '$input' },
        groupBy: { $expr: 'team' },
        operations: [
          { name: 'n', op: 'count' },
          { name: 'total', op: 'sum', field: { $expr: 'hours' } },
        ],
      },
      { items: 'expr', groupBy: 'expr', operations: 'expr' },
      [
        { team: 'a', hours: 2 },
        { team: 'b', hours: 1 },
        { team: 'a', hours: 3 },
      ],
    );
    expect(agg.ports).toEqual({
      out: [
        { key: 'a', n: 2, total: 5 },
        { key: 'b', n: 1, total: 1 },
      ],
    });
    expect(
      (
        await run(
          'data.split',
          { mode: 'string', value: { $expr: '$input' }, separator: ';' },
          { mode: 'static', value: 'expr', separator: 'static' },
          'a;b',
        )
      ).ports,
    ).toEqual({ items: ['a', 'b'] });
    expect(
      (await run('data.template', { template: 'Hi {{ $input.who }}' }, { template: 'expr' }, { who: 'Ada' }))
        .ports,
    ).toEqual({ out: 'Hi Ada' });
  });

  it('parse (json / csv / yaml / form) and validate', async () => {
    const f = { format: 'static', value: 'expr', csv: 'static' } as const;
    expect(
      (await run('data.parse', { format: 'json', value: { $expr: '$input' } }, f, '{"a":1}')).ports,
    ).toEqual({ out: { a: 1 } });
    expect(
      (await run('data.parse', { format: 'csv', value: { $expr: '$input' } }, f, 'a,b\n1,"x,""y"""\n')).ports,
    ).toEqual({ out: [{ a: '1', b: 'x,"y"' }] });
    expect(
      (await run('data.parse', { format: 'yaml', value: { $expr: '$input' } }, f, 'a: [1, 2]\n')).ports,
    ).toEqual({ out: { a: [1, 2] } });
    expect(
      (await run('data.parse', { format: 'form', value: { $expr: '$input' } }, f, 'a=1&a=2&b=x')).ports,
    ).toEqual({ out: { a: ['1', '2'], b: 'x' } });
    const bomb =
      'a: &a [x,x,x,x,x,x,x,x,x]\n' + Array.from({ length: 120 }, (_, i) => `k${String(i)}: *a`).join('\n');
    await expect(
      run('data.parse', { format: 'yaml', value: { $expr: '$input' } }, f, bomb),
    ).rejects.toMatchObject({ code: 'parse_error' });
    const schema = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] };
    const vf = { schema: 'static', value: 'expr' } as const;
    expect((await run('data.validate', { schema, value: { $expr: '$input' } }, vf, { n: 1 })).ports).toEqual({
      valid: { n: 1 },
    });
    expect(
      (await run('data.validate', { schema, value: { $expr: '$input' } }, vf, { n: 'x' })).ports,
    ).toEqual({
      invalid: { value: { n: 'x' }, issues: [{ path: 'n', code: 'type:integer' }] },
    });
  });
});

describe('the thread pool (isolation, deadline, limits)', () => {
  const pool = new SandboxPool({ threads: 2, testHooks: true });
  afterAll(async () => {
    await pool.close();
  });

  it('evaluates in a thread', async () => {
    expect(
      await pool.run({
        op: 'eval',
        mode: 'expr',
        source: '$sum($input)',
        context: ctx({ input: [1, 2, 3] }),
      }),
    ).toEqual({ ok: true, value: 6 });
  });

  it('terminates a catastrophic regex within the deadline without blocking the main event loop, then recovers', async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 10);
    const started = Date.now();
    const r = await pool.run({
      op: 'eval',
      mode: 'expr',
      // Overlapping alternation: exponential backtracking that the static heuristic does not catch.
      source: '$match($input, /(a|a)*b/)',
      context: ctx({ input: 'a'.repeat(40) + '!' }),
    });
    const took = Date.now() - started;
    clearInterval(timer);
    expect(r).toEqual({ ok: false, code: 'expr_timeout', position: null });
    // Two attempts (1 s deadline each) with a 0.5 s pause in between: still bounded, the loop kept ticking.
    expect(took).toBeLessThan(3500);
    expect(ticks).toBeGreaterThan(5);
    expect(pool.terminations).toBeGreaterThanOrEqual(1);
    expect(await pool.run({ op: 'eval', mode: 'expr', source: '1 + 1', context: ctx() })).toEqual({
      ok: true,
      value: 2,
    });
  });

  it('tries a timed-out request once more before answering expr_timeout', async () => {
    const before = pool.terminations;
    expect(await pool.run({ op: 'spin', ms: 5_000 })).toMatchObject({ ok: false, code: 'expr_timeout' });
    // Deterministic work times out again: two attempts, two terminated threads, then the answer.
    expect(pool.terminations - before).toBe(2);
  });

  it('stops a busy loop at the deadline and a memory blow-up by the resource limits', async () => {
    expect(await pool.run({ op: 'spin', ms: 5_000 })).toMatchObject({ ok: false, code: 'expr_timeout' });
    const mem = await pool.run({ op: 'allocate', mb: 512 });
    expect(mem.ok).toBe(false);
    expect(['expr_resource_limit', 'expr_timeout']).toContain((mem as { code: string }).code);
    const seq = await pool.run({
      op: 'eval',
      mode: 'expr',
      source: '$count([1..5000000].($ * 2))',
      context: ctx(),
    });
    expect(seq).toMatchObject({ ok: false });
    expect(['expr_resource_limit', 'expr_timeout']).toContain((seq as { code: string }).code);
  });

  it('caps input and output sizes', async () => {
    expect(
      await pool.run({
        op: 'eval',
        mode: 'expr',
        source: '$input',
        context: ctx({ input: 'x'.repeat(2 * 1024 * 1024) }),
      }),
    ).toMatchObject({ ok: false, code: 'expr_input_too_large' });
    expect(
      await pool.run({ op: 'eval', mode: 'expr', source: '$pad("", 300000, "x")', context: ctx() }),
    ).toMatchObject({ ok: false, code: 'expr_output_too_large' });
  });

  it('runs the static refusals in the thread too', async () => {
    expect(await pool.run({ op: 'eval', mode: 'expr', source: '$eval("1")', context: ctx() })).toMatchObject({
      ok: false,
      code: 'expr_function_not_allowed',
    });
  });
});
