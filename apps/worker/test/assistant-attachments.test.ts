import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { FakeAssistantEngine, SecretValue } from '@remyral/agent-adapters';
import { createLogger, Redactor } from '@remyral/observability';
import {
  type AssistantAttachmentDataPayload,
  type AssistantAttachmentRef,
  type AssistantAttachmentRequestPayload,
  AssistantReport,
  type AssistantTurnPayload,
  AssistantUpdatePayload,
  ATTACHMENT_CHUNK_BYTES,
  type LeaseKey,
  leaseKeyId,
  signAssistantTurn,
} from '@remyral/protocol';
import { MasterToWorker, type WorkerToMaster } from '@remyral/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantAttachmentFetcher } from '../src/assistant/attachments.js';
import { AssistantHost, type AssistantHostOptions } from '../src/assistant/index.js';
import { ChildRegistry } from '../src/daemon/children.js';
import { WorkerDaemon } from '../src/daemon/daemon.js';
import { ManualSignals } from '../src/daemon/signals.js';
import { DeviceKey } from '../src/identity/device-key.js';
import { WorkerStore } from '../src/store/store.js';
import { MemoryTransport } from '../src/transport/memory.js';
import { nodeOps, tempDir } from './helpers.js';

/**
 * p8-chat-attachments-mentions: the assistant host pulls a turn's attachments from the master in slices, verifies them
 * against the signed refs (size, SHA-256, magic bytes) and hands them to the engine with the context block.
 */

const WORKER = 'w-chat';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const raw = publicKey.export({ format: 'jwk' }).x as string;
const lease: LeaseKey = { kid: leaseKeyId(raw), publicKey: raw };

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 1000, 7),
]);
const PDF = Buffer.from('%PDF-1.7\n%…');

function ref(data: Buffer, over: Partial<AssistantAttachmentRef> = {}): AssistantAttachmentRef {
  return {
    id: randomUUID(),
    kind: 'image',
    mediaType: 'image/png',
    name: 'screen.png',
    sizeBytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    ...over,
  };
}

function turn(
  message: string,
  extra: Pick<AssistantTurnPayload, 'attachments' | 'context'>,
): AssistantTurnPayload {
  const now = new Date();
  const base = {
    turnId: randomUUID(),
    sessionKey: randomUUID(),
    runtime: 'claude-code' as const,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 120_000).toISOString(),
    message,
    history: '',
    ...extra,
  };
  return { ...base, signature: signAssistantTurn({ workerId: WORKER, turn: base }, lease.kid, privateKey) };
}

/** A master stand-in: answers ASSISTANT_ATTACHMENT_REQUEST from a store, in ATTACHMENT_CHUNK_BYTES slices. */
function fakeMaster(
  store: Map<string, Buffer>,
  opts: { status?: 'refused' | 'not_found'; silent?: boolean } = {},
) {
  const requests: AssistantAttachmentRequestPayload[] = [];
  const fetcher = new AssistantAttachmentFetcher({ timeoutMs: 200 });
  fetcher.attach((r) => {
    requests.push(r);
    if (opts.silent === true) return Promise.resolve();
    const data = store.get(r.attachmentId);
    const answer: AssistantAttachmentDataPayload =
      opts.status !== undefined || data === undefined
        ? { ...r, status: opts.status ?? 'not_found', data: '', eof: true }
        : {
            ...r,
            status: 'ok',
            data: data.subarray(r.offset, r.offset + ATTACHMENT_CHUNK_BYTES).toString('base64'),
            eof: r.offset + ATTACHMENT_CHUNK_BYTES >= data.length,
          };
    queueMicrotask(() => {
      fetcher.onData(answer);
    });
    return Promise.resolve();
  });
  return { fetcher, requests };
}

const hosts: AssistantHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
});

async function setup(over: Partial<AssistantHostOptions> = {}, engine = new FakeAssistantEngine()) {
  const updates: AssistantUpdatePayload[] = [];
  const host = new AssistantHost({
    logger: createLogger({ sink: () => undefined }),
    redactor: new Redactor(),
    engines: { 'claude-code': engine },
    keySource: () => ({ keys: [lease], pinned: false }),
    disabled: false,
    scratchRoot: await tempDir('assistant-att-'),
    runtimeAllowed: () => ({ ok: true }),
    auth: () =>
      Promise.resolve({
        authMode: 'secret-ref' as const,
        secretEnv: { ANTHROPIC_API_KEY: new SecretValue('sk-ant-api03-' + 'Q'.repeat(48)) },
        release: () => undefined,
      }),
    flushMs: 5,
    ...over,
  });
  host.attach((u) => {
    updates.push(AssistantUpdatePayload.parse(u));
    return Promise.resolve();
  });
  hosts.push(host);
  return { host, engine, updates };
}

async function end(updates: AssistantUpdatePayload[], turnId: string): Promise<AssistantUpdatePayload> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const last = updates.filter((u) => u.turnId === turnId).at(-1);
    if (last !== undefined && ['done', 'failed', 'refused'].includes(last.kind)) return last;
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('assistant host attachments (p8-chat-attachments-mentions)', () => {
  it('pulls the slices, verifies them and gives the engine the bytes and the context', async () => {
    const image = ref(PNG);
    const doc = ref(PDF, { kind: 'pdf', mediaType: 'application/pdf', name: 'spec.pdf' });
    const m = fakeMaster(
      new Map([
        [image.id, PNG],
        [doc.id, PDF],
      ]),
    );
    const { host, engine, updates } = await setup({
      fetchAttachment: (t, r, s) => m.fetcher.fetch(t, r, s),
    });
    const t = turn('what is wrong here?', { attachments: [image, doc], context: '<<<REMYRAL-DATA ctx>>>' });
    await host.onTurn(WORKER, t);
    const last = await end(updates, t.turnId);
    expect(last.kind).toBe('done');
    // Two slices for the image (just over one chunk), one for the PDF; offsets in order.
    expect(m.requests.map((r) => [r.attachmentId, r.offset])).toEqual([
      [image.id, 0],
      [image.id, ATTACHMENT_CHUNK_BYTES],
      [doc.id, 0],
    ]);
    expect(m.requests.every((r) => r.turnId === t.turnId)).toBe(true);
    const input = engine.sessions[0]?.turns[0];
    expect(input?.context).toBe('<<<REMYRAL-DATA ctx>>>');
    expect(input?.attachments?.map((a) => [a.kind, a.mediaType, a.name])).toEqual([
      ['image', 'image/png', 'screen.png'],
      ['pdf', 'application/pdf', 'spec.pdf'],
    ]);
    expect(input?.attachments?.[0]?.data.equals(PNG)).toBe(true);
  });

  it('fails the turn without running it when the bytes do not match the signed ref', async () => {
    const cases: [string, AssistantAttachmentRef, Buffer][] = [
      ['size', ref(PNG, { sizeBytes: PNG.length - 1 }), PNG.subarray(0, PNG.length - 1)],
      ['digest', ref(PNG, { sha256: 'a'.repeat(64) }), PNG],
      ['type', ref(Buffer.from('GIF89a……')), Buffer.from('GIF89a……')],
    ];
    for (const [what, r, bytes] of cases) {
      const m = fakeMaster(new Map([[r.id, what === 'size' ? PNG : bytes]]));
      const { host, engine, updates } = await setup({
        fetchAttachment: (t, x, s) => m.fetcher.fetch(t, x, s),
      });
      const t = turn('look', { attachments: [r] });
      await host.onTurn(WORKER, t);
      const last = await end(updates, t.turnId);
      expect(last, what).toMatchObject({ kind: 'failed', reason: 'attachment_unavailable' });
      expect(
        engine.sessions.flatMap((s) => s.turns),
        what,
      ).toHaveLength(0);
    }
  });

  it('fails closed on a refusal, a missing attachment, a timeout and without a fetcher', async () => {
    const r = ref(PNG);
    const variants: Partial<AssistantHostOptions>[] = [
      { fetchAttachment: (t, x, s) => fakeMaster(new Map(), { status: 'refused' }).fetcher.fetch(t, x, s) },
      { fetchAttachment: (t, x, s) => fakeMaster(new Map()).fetcher.fetch(t, x, s) },
      { fetchAttachment: (t, x, s) => fakeMaster(new Map(), { silent: true }).fetcher.fetch(t, x, s) },
      {},
    ];
    for (const over of variants) {
      const { host, updates } = await setup(over);
      const t = turn('look', { attachments: [r] });
      await host.onTurn(WORKER, t);
      const last = await end(updates, t.turnId);
      expect(last).toMatchObject({ kind: 'failed', reason: 'attachment_unavailable' });
      if (last.kind === 'failed') expect(last.detail).not.toContain(PNG.toString('base64').slice(0, 20));
    }
  });

  it('leaves out what the engine cannot read and says so in the context', async () => {
    const engine = new FakeAssistantEngine();
    engine.input = { images: 'supported', pdf: false };
    const doc = ref(PDF, { kind: 'pdf', mediaType: 'application/pdf', name: 'spec.pdf' });
    const image = ref(PNG);
    const m = fakeMaster(
      new Map([
        [image.id, PNG],
        [doc.id, PDF],
      ]),
    );
    const { host, updates } = await setup({ fetchAttachment: (t, x, s) => m.fetcher.fetch(t, x, s) }, engine);
    const t = turn('both', { attachments: [doc, image] });
    await host.onTurn(WORKER, t);
    expect((await end(updates, t.turnId)).kind).toBe('done');
    const input = engine.sessions[0]?.turns[0];
    expect(input?.attachments?.map((a) => a.name)).toEqual(['screen.png']);
    expect(input?.context).toContain('a PDF (spec.pdf) that this assistant engine cannot read');
    expect(m.requests.every((x) => x.attachmentId === image.id)).toBe(true);
  });

  it('turns without attachments are unchanged (no context, no requests)', async () => {
    const m = fakeMaster(new Map());
    const { host, engine, updates } = await setup({ fetchAttachment: (t, x, s) => m.fetcher.fetch(t, x, s) });
    const t = turn('plain', {});
    await host.onTurn(WORKER, t);
    expect((await end(updates, t.turnId)).kind).toBe('done');
    expect(m.requests).toEqual([]);
    expect(engine.sessions[0]?.turns[0]?.context).toBeNull();
    expect(engine.sessions[0]?.turns[0]?.attachments).toBeUndefined();
  });

  it('reports each engine input in CAPABILITIES.assistant', async () => {
    const legacy = new FakeAssistantEngine('codex');
    (legacy as { input?: unknown }).input = undefined;
    const { host } = await setup({
      engines: { 'claude-code': new FakeAssistantEngine(), codex: legacy },
    });
    const report = AssistantReport.parse(await host.report());
    expect(report.engines).toEqual([
      expect.objectContaining({ runtime: 'claude-code', input: { images: 'supported', pdf: true } }),
      expect.objectContaining({ runtime: 'codex', input: { images: 'unsupported', pdf: false } }),
    ]);
  });
});

describe('attachment fetcher', () => {
  it('ignores answers nobody waits for and answers for another attachment', async () => {
    const fetcher = new AssistantAttachmentFetcher({ timeoutMs: 100 });
    fetcher.onData({
      turnId: randomUUID(),
      requestId: randomUUID(),
      attachmentId: randomUUID(),
      status: 'ok',
      offset: 0,
      data: '',
      eof: true,
    });
    const r = ref(PNG);
    fetcher.attach((req) => {
      queueMicrotask(() => {
        fetcher.onData({ ...req, attachmentId: randomUUID(), status: 'ok', data: '', eof: true });
      });
      return Promise.resolve();
    });
    await expect(fetcher.fetch(randomUUID(), r, new AbortController().signal)).rejects.toMatchObject({
      code: 'refused',
    });
  });

  it('refuses more bytes than the signed size and fails waiting requests on disconnect', async () => {
    const small = ref(Buffer.from([0x89, 0x50]), { sizeBytes: 2 });
    const big = new AssistantAttachmentFetcher();
    big.attach((req) => {
      queueMicrotask(() => {
        big.onData({ ...req, status: 'ok', data: PNG.subarray(0, 100).toString('base64'), eof: true });
      });
      return Promise.resolve();
    });
    await expect(big.fetch(randomUUID(), small, new AbortController().signal)).rejects.toMatchObject({
      code: 'too_large',
    });
    const quiet = new AssistantAttachmentFetcher({ timeoutMs: 5_000 });
    quiet.attach(() => Promise.resolve());
    const pending = quiet.fetch(randomUUID(), small, new AbortController().signal);
    await new Promise((r) => setTimeout(r, 10));
    quiet.onDisconnected();
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
    const abort = new AbortController();
    const cancelled = quiet.fetch(randomUUID(), small, abort.signal);
    abort.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });
  });
});

function fromMaster(type: string, payload: unknown): MasterToWorker {
  return MasterToWorker.parse({
    protocolVersion: '1.0',
    type,
    messageId: randomUUID(),
    seq: 0,
    ts: new Date().toISOString(),
    correlationId: 'c-1',
    workerId: 'w-1',
    payload,
  });
}

describe('daemon routing of attachment slices', () => {
  it('sends ASSISTANT_ATTACHMENT_REQUEST as a control message and routes ASSISTANT_ATTACHMENT_DATA back', async () => {
    const { store } = await WorkerStore.open(nodeOps(), await tempDir());
    const transport = new MemoryTransport();
    const fetcher = new AssistantAttachmentFetcher({ timeoutMs: 2_000 });
    const daemon = new WorkerDaemon({
      maxParallelJobs: 1,
      store,
      key: DeviceKey.generate(),
      logger: createLogger({ sink: () => undefined }),
      transport,
      children: new ChildRegistry(),
      signals: new ManualSignals(),
      assistant: {
        onTurn: () => Promise.resolve(),
        onToolResult: () => undefined,
        onCancel: () => undefined,
        onAttachmentData: (p) => {
          fetcher.onData(p);
        },
        onDisconnected: () => {
          fetcher.onDisconnected();
        },
      },
    });
    fetcher.attach((p) => daemon.sendAssistantAttachmentRequest(p));
    await daemon.start();
    // Without a session the request is refused at once (no queueing).
    await expect(
      fetcher.fetch(
        randomUUID(),
        ref(PDF, { kind: 'pdf', mediaType: 'application/pdf' }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'unavailable' });
    transport.emit({ kind: 'connected', enrolled: false });
    transport.emit({
      kind: 'message',
      message: fromMaster('ENROLL_APPROVED', { workerId: 'w-1', approvedAt: new Date().toISOString() }),
    });
    transport.emit({
      kind: 'message',
      message: fromMaster('SESSION_ESTABLISHED', {
        negotiatedVersion: '1.0',
        sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        resumeFromSeq: 0,
      }),
    });
    const r = ref(PDF, { kind: 'pdf', mediaType: 'application/pdf', name: 'a.pdf' });
    const turnId = randomUUID();
    await vi.waitFor(() => {
      expect(transport.sent.some((m) => m.type === 'HEARTBEAT')).toBe(true);
    });
    const fetched = fetcher.fetch(turnId, r, new AbortController().signal);
    await vi.waitFor(() => {
      expect(transport.sent.some((m) => m.type === 'ASSISTANT_ATTACHMENT_REQUEST')).toBe(true);
    });
    const req = transport.sent.find(
      (m): m is Extract<WorkerToMaster, { type: 'ASSISTANT_ATTACHMENT_REQUEST' }> =>
        m.type === 'ASSISTANT_ATTACHMENT_REQUEST',
    );
    expect(req?.seq).toBe(0);
    expect(req?.payload).toMatchObject({ turnId, attachmentId: r.id, offset: 0 });
    transport.emit({
      kind: 'message',
      message: fromMaster('ASSISTANT_ATTACHMENT_DATA', {
        ...req?.payload,
        status: 'ok',
        data: PDF.toString('base64'),
        eof: true,
      }),
    });
    expect((await fetched).equals(PDF)).toBe(true);
    await daemon.stop('SIGTERM');
  });
});
