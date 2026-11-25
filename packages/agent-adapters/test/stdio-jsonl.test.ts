import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  JsonlTransport,
  jsonRpcCodec,
  LineSplitter,
  spawnOwnedProcess,
  TransportError,
  type Inbound,
  type JsonlCodec,
} from '../src/index.js';

const ECHO = fileURLToPath(new URL('./fixtures/jsonl-echo.mjs', import.meta.url));

const RpcMessage = z.looseObject({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
});
type RpcMessage = z.infer<typeof RpcMessage>;

/** Fake child: we write into `toUs` (its stdout) and read what the transport wrote from `fromUs` (its stdin). */
function fakeChild() {
  const toUs = new PassThrough();
  const fromUs = new PassThrough();
  const written: unknown[] = [];
  let buf = '';
  fromUs.on('data', (c: Buffer) => {
    buf += c.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      written.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
  });
  return { toUs, fromUs, written };
}

function rpc(
  child: ReturnType<typeof fakeChild>,
  extra: Partial<ConstructorParameters<typeof JsonlTransport>[0]> = {},
) {
  return new JsonlTransport<RpcMessage, { method: string; params?: unknown }>({
    input: child.toUs,
    output: child.fromUs,
    codec: jsonRpcCodec(RpcMessage, { includeVersionMember: false }),
    defaultTimeoutMs: 1000,
    ...extra,
  } as ConstructorParameters<typeof JsonlTransport<RpcMessage, { method: string; params?: unknown }>>[0]);
}

const tick = () => new Promise((r) => setImmediate(r));

describe('LineSplitter', () => {
  it('splits on LF only, across chunk boundaries, strips trailing CR and ignores U+2028', () => {
    const lines: string[] = [];
    const s = new LineSplitter(1024);
    const push = (t: string) => {
      s.push(
        Buffer.from(t),
        (l) => lines.push(l),
        () => {
          throw new Error('oversize');
        },
      );
    };
    push('{"a":1}\n{"b":');
    push('"x y"}\r\n\n{"c"');
    push(':3}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":"x y"}', '{"c":3}']);
  });

  it('splits multibyte UTF-8 safely across chunks', () => {
    const lines: string[] = [];
    const s = new LineSplitter(1024);
    const bytes = Buffer.from('"héllo ✓"\n');
    s.push(
      bytes.subarray(0, 3),
      (l) => lines.push(l),
      () => undefined,
    );
    s.push(
      bytes.subarray(3),
      (l) => lines.push(l),
      () => undefined,
    );
    expect(lines).toEqual(['"héllo ✓"']);
  });

  it('reports oversize lines and resynchronises at the next LF', () => {
    const lines: string[] = [];
    const over: number[] = [];
    const s = new LineSplitter(8);
    s.push(
      Buffer.from('0123456789'),
      (l) => lines.push(l),
      (n) => over.push(n),
    );
    s.push(
      Buffer.from('abcdef\n{"ok":1}\n'),
      (l) => lines.push(l),
      (n) => over.push(n),
    );
    expect(over.length).toBe(1);
    expect(lines).toEqual(['{"ok":1}']);
  });
});

describe('JsonlTransport', () => {
  it('correlates responses by id, out of order', async () => {
    const child = fakeChild();
    const t = rpc(child);
    const p1 = t.request({ method: 'a' });
    const p2 = t.request({ method: 'b' });
    await tick();
    expect(child.written).toEqual([
      { id: 1, method: 'a' },
      { id: 2, method: 'b' },
    ]);
    child.toUs.write('{"id":2,"result":"B"}\n{"id":1,"result":"A"}\n');
    await expect(p1).resolves.toBe('A');
    await expect(p2).resolves.toBe('B');
  });

  it('rejects a remote error response with TransportError(remote_error)', async () => {
    const child = fakeChild();
    const t = rpc(child);
    const p = t.request({ method: 'x' });
    child.toUs.write('{"id":1,"error":{"code":-32601,"message":"no"}}\n');
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).code).toBe('remote_error');
  });

  it('times out unanswered requests and ignores late responses', async () => {
    const child = fakeChild();
    const errors: TransportError[] = [];
    const t = rpc(child, { onProtocolError: (e) => errors.push(e) });
    const err = await t.request({ method: 'slow' }, 50).catch((e: unknown) => e);
    expect((err as TransportError).code).toBe('timeout');
    child.toUs.write('{"id":1,"result":"late"}\n');
    await tick();
    expect(errors.map((e) => e.code)).toEqual(['remote_error']);
    expect(t.closed).toBe(false);
  });

  it('delivers notifications and runtime requests in order; respond() answers requests', async () => {
    const child = fakeChild();
    const t = rpc(child);
    child.toUs.write('{"method":"turn/started","params":{}}\n{"id":"srv-1","method":"approval/request"}\n');
    child.toUs.end();
    const seen: Inbound<RpcMessage>[] = [];
    for await (const m of t.inbound()) seen.push(m);
    expect(seen.map((m) => m.kind)).toEqual(['notification', 'request']);
    expect(seen[1]).toMatchObject({ kind: 'request', id: 'srv-1' });
  });

  it('fails closed on invalid JSON / schema violations by default', async () => {
    const child = fakeChild();
    const t = rpc(child);
    const pending = t.request({ method: 'x' });
    child.toUs.write('not json\n');
    const err = await pending.catch((e: unknown) => e);
    expect((err as TransportError).code).toBe('invalid_json');
    expect(t.closed).toBe(true);
    expect(await t.done).toBeInstanceOf(TransportError);
    await expect(async () => {
      for await (const _ of t.inbound()) {
        // drain
      }
    }).rejects.toThrow(/not valid JSON/);
  });

  it('skips bad lines in skip mode and validates with the Zod schema hook', async () => {
    const child = fakeChild();
    const errors: string[] = [];
    const strict: JsonlCodec<{ type: 'event'; n: number }, never> = {
      schema: z.object({ type: z.literal('event'), n: z.number() }),
      classify: () => ({ kind: 'notification' }),
      encodeRequest: () => ({}),
    };
    const t = new JsonlTransport({
      input: child.toUs,
      output: child.fromUs,
      codec: strict,
      onBadLine: 'skip',
      onProtocolError: (e) => errors.push(e.code),
    });
    child.toUs.write('{"type":"event","n":1}\n{"type":"event","n":"x"}\n[1,2\n{"type":"event","n":2}\n');
    child.toUs.end();
    const ns: number[] = [];
    for await (const m of t.inbound()) ns.push(m.message.n);
    expect(ns).toEqual([1, 2]);
    expect(errors).toEqual(['schema_violation', 'invalid_json']);
  });

  it('enforces the max line size', async () => {
    const child = fakeChild();
    const t = rpc(child, { maxLineBytes: 32 });
    child.toUs.write(`{"method":"x","params":"${'a'.repeat(100)}"}\n`);
    expect((await t.done)?.code).toBe('line_too_long');
  });

  it('closes with queue_overflow when notifications are not consumed', async () => {
    const child = fakeChild();
    const t = rpc(child, { maxQueued: 2 });
    child.toUs.write('{"method":"a"}\n{"method":"b"}\n{"method":"c"}\n');
    expect((await t.done)?.code).toBe('queue_overflow');
  });

  it('close() rejects pending requests and ends the output stream', async () => {
    const child = fakeChild();
    const t = rpc(child);
    const p = t.request({ method: 'never' });
    await t.close();
    expect(((await p.catch((e: unknown) => e)) as TransportError).code).toBe('closed');
    expect(child.fromUs.writableEnded).toBe(true);
    await expect(t.request({ method: 'after' })).rejects.toBeInstanceOf(TransportError);
  });

  it('works end-to-end with a real child process and shuts down cleanly on EOF', async () => {
    const proc = await spawnOwnedProcess({ command: process.execPath, args: [ECHO], cwd: process.cwd() });
    const t = new JsonlTransport<RpcMessage, { method: string; params?: unknown }>({
      input: proc.stdout,
      output: proc.stdin,
      codec: jsonRpcCodec(RpcMessage, { includeVersionMember: true }),
      defaultTimeoutMs: 5000,
    });
    await expect(t.request({ method: 'echo', params: { hello: 'wörld' } })).resolves.toEqual({
      hello: 'wörld',
    });
    await expect(t.request({ method: 'fail' })).rejects.toMatchObject({ code: 'remote_error' });
    await t.send({ method: 'notify', params: 7 });
    for await (const m of t.inbound()) {
      expect(m).toMatchObject({ kind: 'notification', message: { method: 'note', params: 7 } });
      break;
    }
    await t.close();
    const exit = await proc.exited;
    expect(exit.code).toBe(0);
    await proc.terminate({ graceMs: 100 });
  });
});
