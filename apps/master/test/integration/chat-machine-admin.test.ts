import { FakeAssistantEngine } from '@remyral/agent-adapters';
import type { MasterToWorker } from '@remyral/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';
import {
  CAPS,
  pairRealWorker,
  removeDirs,
  type RunningWorker,
  runRealWorker,
  tempDataDir,
} from '../helpers/real-worker.js';

/**
 * p19-chat-machine-admin ("Makinede söylediğimi yap") end to end, part 2: the assistant prepares a
 * machine's sandbox itself (draft_machine_prepare → administration card `machine.prepare` → the same signed
 * `sandbox.prepare` remote operation as Makineler → <machine> → Sandbox ve politika → Hazırla). Real master (Postgres), a
 * real assistant worker with a fake engine, a raw worker with `sandbox-ops-v1`. Covers: runs at once on the user's own
 * message (audited as approved by policy, `source: chat`), administrators only, and the always-fresh code — replaced by
 * the switch while it is on (Dengeli with a 10-minute always-fresh cap, a code older than that but within the 4 h
 * window), kept when it is off
 * (the card asks; confirmed with a fresh code). Part 1 (elevated commands of a chat task pass by policy) is in
 * machine-admin.test.ts.
 */
const PW = 'cobalt-ledger-thistle-58';
const MIN = 60_000;
type OpsCommand = Extract<MasterToWorker, { type: 'OPS_COMMAND' }>;

interface Draft {
  id: string;
  kind: string;
  state: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
}

describeIntegration(
  'machine work from the chat (integration, p19-chat-machine-admin)',
  { timeout: 300_000 },
  () => {
    const h = new Harness(Date.now());
    const engine = new FakeAssistantEngine();
    const dirs: string[] = [];
    let assistant: RunningWorker | undefined;
    let raw: RawWorker;
    let rawId = '';
    let url = '';
    let owner: Client;
    let ownerSecret = '';
    let viewer: Client;

    async function stepUp(c: Client, secret: string): Promise<void> {
      h.clock.advance(30_000);
      const r = await c.req('POST', '/auth/step-up', { code: h.code(secret) });
      expect(r.statusCode, r.body).toBe(200);
    }
    /** One tool call in a fresh conversation: the reply text and the conversation's drafts. */
    async function call(
      c: Client,
      tool: string,
      input: Record<string, unknown>,
    ): Promise<{ reply: string; drafts: Draft[] }> {
      const t = (await c.req('POST', '/chat/threads', {})).json<{ id: string }>().id;
      const r = await c.req('POST', `/chat/threads/${t}/messages`, {
        text: `[[tool ${tool} ${JSON.stringify(input)}]]`,
      });
      expect(r.statusCode, r.body).toBe(202);
      const seq = r.json<{ message: { seq: number } }>().message.seq;
      let reply = '';
      let drafts: Draft[] = [];
      await expect
        .poll(
          async () => {
            const d = (await c.req('GET', `/chat/threads/${t}`)).json<{
              turn: unknown;
              messages: { seq: number; role: string; content: string }[];
              drafts: Draft[];
            }>();
            const last = d.messages
              .filter((m) => m.seq > seq && (m.role === 'assistant' || m.role === 'error'))
              .at(-1);
            reply = last?.content ?? '';
            drafts = d.drafts;
            return d.turn === null && last !== undefined;
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      return { reply, drafts };
    }
    const confirmAudit = async (draftId: string) =>
      (
        await h.db.pool.query<{ metadata: Record<string, unknown> }>(
          "SELECT metadata FROM audit_events WHERE action = 'chat.draft.confirm' AND outcome = 'success' AND target = $1",
          [`chat-draft:${draftId}`],
        )
      ).rows[0]?.metadata;

    beforeAll(async () => {
      await h.start({
        securityPolicy: { preset: 'serbest' },
        workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
      });
      url = await h.listen();
      await h.createUser('owner.mca', PW);
      ({ secret: ownerSecret } = await enroll(h, 'owner.mca', PW));
      owner = await fullLogin(h, 'owner.mca', PW, ownerSecret);
      await h.createUser('viewer.mca', PW, 'viewer');
      const v = await enroll(h, 'viewer.mca', PW);
      viewer = await fullLogin(h, 'viewer.mca', PW, v.secret);
      // The machine to prepare: a raw worker that runs sandbox.prepare (sandbox-ops-v1).
      raw = await RawWorker.connect(url, new TestKey());
      const pending = await raw.handshake({ pairingCode: 'MCAD-ABCD' });
      rawId = pending.workerId ?? '';
      await stepUp(owner, ownerSecret);
      expect(
        (await owner.req('POST', `/workers/${rawId}/approve`, { pairingCode: 'MCAD-ABCD' })).statusCode,
      ).toBe(200);
      await raw.next('SESSION_ESTABLISHED');
      raw.sendJson(
        raw.envelope(
          'CAPABILITIES',
          {
            runtimes: [],
            sandboxProfiles: ['container'],
            maxParallelJobs: 1,
            tools: [],
            features: ['worker-config-v1', 'remote-ops-v1', 'sandbox-ops-v1'],
            remoteOps: {
              runtimes: [],
              login: [],
              service: { manager: 'systemd', restartable: true },
              logs: { available: false, bytes: 0 },
            },
          },
          { workerId: rawId },
        ),
      );
    });
    afterAll(async () => {
      raw.close();
      await assistant?.stop().catch(() => undefined);
      await h.stop();
      await removeDirs(dirs);
    });

    it('sets up the assistant machine', async () => {
      const dataDir = await tempDataDir(dirs);
      const workerId = await pairRealWorker(h, url, owner, ownerSecret, dataDir);
      assistant = await runRealWorker(url, dataDir, {
        capabilities: CAPS,
        assistant: { engine, clock: h.clock.now },
      });
      await stepUp(owner, ownerSecret);
      const s = await owner.req('PUT', '/chat/settings', {
        enabled: true,
        workerId,
        runtime: 'claude-code',
        modelProfile: null,
        expectedVersion: 1,
      });
      expect(s.statusCode, s.body).toBe(200);
      await expect
        .poll(async () => (await owner.req('GET', '/chat/status')).json<{ available: boolean }>().available, {
          timeout: 20_000,
        })
        .toBe(true);
    });

    describe('draft_machine_prepare', () => {
      it('administrators only: a viewer is refused and nothing is sent', async () => {
        const r = await call(viewer, 'draft_machine_prepare', { workerId: rawId, privileged: true });
        expect(r.reply).toMatch(/not allowed/);
        expect(r.drafts).toEqual([]);
      });

      it('Serbest (switch on): the user’s message prepares the machine at once, privileged, audited by policy', async () => {
        const r = await call(owner, 'draft_machine_prepare', { workerId: rawId, privileged: true });
        expect(r.reply).toContain('executed');
        const d = r.drafts[0];
        expect(d).toMatchObject({
          kind: 'settings_change',
          state: 'confirmed',
          payload: { target: 'admin', op: 'machine.prepare', event: 'machines.sandbox', privileged: true },
        });
        expect(d?.result).toMatchObject({ op: 'machine.prepare', via: 'chat', machineAdminByPolicy: true });
        const cmd: OpsCommand = await raw.next('OPS_COMMAND');
        expect(cmd.payload.op).toEqual({ kind: 'sandbox.prepare', privileged: true, localLogin: false });
        expect(await confirmAudit(d?.id ?? '')).toMatchObject({
          via: 'chat-direct',
          approvedBy: 'policy',
          policy: 'autonomy.chatMachineAdmin',
        });
        const ops = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
          "SELECT metadata FROM audit_events WHERE action = 'worker.ops.sandbox.prepare' AND outcome = 'success' ORDER BY id",
        );
        expect(ops.rows.at(-1)?.metadata).toMatchObject({ source: 'chat' });
      });

      it('Dengeli: the switch replaces the always-fresh code; off, the card asks for a fresh one', async () => {
        // Dengeli with an always-fresh cap of 10 minutes (null would let always-fresh routes use the 4 h window too).
        await h.setSecurityPolicy({ preset: 'dengeli', stepUp: { alwaysFreshMinutes: 10 } });
        try {
          // A code from 11 minutes ago: inside Dengeli's 4 h window, too old for an always-fresh route.
          await stepUp(owner, ownerSecret);
          h.clock.advance(11 * MIN);
          const on = await call(owner, 'draft_machine_prepare', { workerId: rawId, privileged: true });
          expect(on.drafts[0]?.state).toBe('confirmed');
          expect((await raw.next('OPS_COMMAND')).payload.op).toMatchObject({
            kind: 'sandbox.prepare',
            privileged: true,
          });

          await h.setSecurityPolicy({
            preset: 'dengeli',
            stepUp: { alwaysFreshMinutes: 10 },
            autonomy: { chatMachineAdmin: false },
          });
          const off = await call(owner, 'draft_machine_prepare', { workerId: rawId, privileged: true });
          expect(off.reply).toContain('not executed');
          const card = off.drafts[0];
          expect(card?.state).toBe('proposed');
          const denied = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
            "SELECT metadata FROM audit_events WHERE action = 'chat.direct_action' AND target = $1 ORDER BY id",
            [`chat-draft:${card?.id ?? ''}`],
          );
          expect(denied.rows.at(-1)?.metadata).toMatchObject({ reason: 'needs_code' });
          // The card, confirmed with a fresh code, runs exactly the same prepare.
          await stepUp(owner, ownerSecret);
          const c = await owner.req('POST', `/chat/drafts/${card?.id ?? ''}/confirm`, {});
          expect(c.statusCode, c.body).toBe(200);
          expect((await raw.next('OPS_COMMAND')).payload.op).toMatchObject({ kind: 'sandbox.prepare' });
          expect(await confirmAudit(card?.id ?? '')).not.toHaveProperty('approvedBy');
        } finally {
          await h.setSecurityPolicy({ preset: 'serbest' });
        }
      });
    });
  },
);
