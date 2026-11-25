import { FakeAssistantEngine, fakeToolData } from '@remyral/agent-adapters';
import { createNodeFileOps, ManualSignals, pairWorker } from '@remyral/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebhookNotifier } from '../../src/notifications/index.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { FACTS } from '../helpers/raw-worker.js';
import {
  CAPS,
  pairRealWorker,
  removeDirs,
  type RunningWorker,
  runRealWorker,
  tempDataDir,
} from '../helpers/real-worker.js';

/**
 * p16-assistant-admin (docs/design/p16-assistant-admin.md) end to end: real master (Postgres), a real assistant worker
 * whose fake engine calls the administration tools. Per tool: the caller's permissions (viewer / admin / owner), runs at
 * once vs. a card by the security policy, a card that asks for the authenticator code, destructive changes and invites
 * always as cards (unless the policy allows destructive administration), the console's audit entries with
 * `source: chat`, and no secret in any tool result.
 */
const PW = 'harbor-quill-saffron-39';
const MIN = 60_000;

interface Message {
  seq: number;
  role: string;
  content: string;
  meta: Record<string, unknown> | null;
}
interface Draft {
  id: string;
  kind: string;
  state: string;
  title: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
}

describeIntegration(
  'administration through the chat (integration, p16-assistant-admin)',
  { timeout: 300_000 },
  () => {
    const h = new Harness(Date.now());
    const engine = new FakeAssistantEngine();
    const dirs: string[] = [];
    let worker: RunningWorker | undefined;
    let url = '';
    let owner: Client;
    let ownerSecret = '';
    let ownerId = '';
    let admin: Client;
    let adminSecret = '';
    let viewer: Client;
    let viewerId = '';
    let viewerSecret = '';
    let targetId = '';

    async function stepUp(c: Client, secret: string): Promise<void> {
      h.clock.advance(30_000);
      const r = await c.req('POST', '/auth/step-up', { code: h.code(secret) });
      expect(r.statusCode, r.body).toBe(200);
    }
    async function thread(c: Client): Promise<string> {
      const r = await c.req('POST', '/chat/threads', {});
      expect(r.statusCode, r.body).toBe(201);
      return r.json<{ id: string }>().id;
    }
    async function detail(
      c: Client,
      id: string,
    ): Promise<{ messages: Message[]; drafts: Draft[]; turn: unknown }> {
      const r = await c.req('GET', `/chat/threads/${id}`);
      expect(r.statusCode, r.body).toBe(200);
      return r.json();
    }
    /** One tool call in a fresh conversation; the reply text, the parsed tool data and the conversation's drafts. */
    async function call(
      c: Client,
      tool: string,
      input: Record<string, unknown>,
    ): Promise<{ reply: string; data: Record<string, unknown>; refused: boolean; drafts: Draft[] }> {
      const t = await thread(c);
      const r = await c.req('POST', `/chat/threads/${t}/messages`, {
        text: `[[tool ${tool} ${JSON.stringify(input)}]]`,
      });
      expect(r.statusCode, r.body).toBe(202);
      const seq = r.json<{ message: Message }>().message.seq;
      let last: Message | undefined;
      await expect
        .poll(
          async () => {
            const d = await detail(c, t);
            last = d.messages
              .filter((m) => m.seq > seq && (m.role === 'assistant' || m.role === 'error'))
              .at(-1);
            return d.turn === null && last !== undefined;
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      const reply = (last as Message).content;
      const m = /^Tool \S+ (answered|refused): /.exec(reply);
      const data = (fakeToolData(reply.replace(/^Tool \S+ (answered|refused): /, '')) ?? {}) as Record<
        string,
        unknown
      >;
      return { reply, data, refused: m?.[1] === 'refused', drafts: (await detail(c, t)).drafts };
    }
    const audits = async (action: string) =>
      (
        await h.db.pool.query<{
          actor_id: string;
          outcome: string;
          target: string;
          metadata: Record<string, unknown>;
        }>('SELECT actor_id, outcome, target, metadata FROM audit_events WHERE action = $1 ORDER BY id', [
          action,
        ])
      ).rows;
    const direct = async (draftId: string) =>
      (
        await h.db.pool.query<{ outcome: string; metadata: Record<string, unknown> }>(
          `SELECT outcome, metadata FROM audit_events WHERE action = 'chat.direct_action' AND target = $1 ORDER BY id`,
          [`chat-draft:${draftId}`],
        )
      ).rows;

    beforeAll(async () => {
      await h.start({
        securityPolicy: { preset: 'serbest' },
        workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
        notifications: {
          publicUrl: 'https://remyral.example.com',
          notifiers: [
            new WebhookNotifier(
              { allowlist: ['https://hooks.example.com/services/'], secret: Buffer.alloc(32, 7) },
              h.clock.now,
            ),
          ],
        },
      });
      url = await h.listen();
      ownerId = await h.createUser('owner.adm', PW);
      ({ secret: ownerSecret } = await enroll(h, 'owner.adm', PW));
      owner = await fullLogin(h, 'owner.adm', PW, ownerSecret);
      await h.createUser('admin.adm', PW, 'admin');
      ({ secret: adminSecret } = await enroll(h, 'admin.adm', PW));
      admin = await fullLogin(h, 'admin.adm', PW, adminSecret);
      viewerId = await h.createUser('viewer.adm', PW, 'viewer');
      await h.grant(viewerId, ['alpha'], 'viewer');
      ({ secret: viewerSecret } = await enroll(h, 'viewer.adm', PW));
      viewer = await fullLogin(h, 'viewer.adm', PW, viewerSecret);
      targetId = await h.createUser('target.adm', PW, 'operator');
      await h.grant(targetId, ['beta'], 'operator');
    });
    afterAll(async () => {
      await worker?.stop().catch(() => undefined);
      await h.stop();
      await removeDirs(dirs);
    });

    it('sets up the assistant machine', async () => {
      const dataDir = await tempDataDir(dirs);
      const workerId = await pairRealWorker(h, url, owner, ownerSecret, dataDir);
      worker = await runRealWorker(url, dataDir, {
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
        .poll(
          async () => (await viewer.req('GET', '/chat/status')).json<{ available: boolean }>().available,
          {
            timeout: 20_000,
          },
        )
        .toBe(true);
    });

    describe('reads, with the caller’s permissions and without secrets', () => {
      it('list_users: administrators only; no password material', async () => {
        const v = await call(viewer, 'list_users', {});
        expect(v.refused).toBe(true);
        expect(v.reply).toMatch(/not allowed/);
        const a = await call(admin, 'list_users', { query: 'target' });
        expect(a.refused).toBe(false);
        const users = a.data.users as { username: string; memberships: unknown[] }[];
        expect(users.map((u) => u.username)).toEqual(['target.adm']);
        expect(users[0]?.memberships).toEqual([{ project: 'beta', role: 'operator' }]);
        expect(a.reply).not.toMatch(/password_hash|scrypt|totp_secret/i);
      });

      it('list_project_members: members read their project; an invisible project is not found', async () => {
        const ok = await call(viewer, 'list_project_members', { project: 'alpha' });
        expect((ok.data.members as { username: string }[]).map((m) => m.username)).toEqual(['viewer.adm']);
        const hidden = await call(viewer, 'list_project_members', { project: 'beta' });
        expect(hidden.refused).toBe(true);
        expect(hidden.reply).toMatch(/not found/);
      });

      it('describe_backups: owners and admins; read-only and says where backups are run', async () => {
        expect((await call(viewer, 'describe_backups', {})).refused).toBe(true);
        const a = await call(admin, 'describe_backups', {});
        expect(a.data).toMatchObject({ configured: false });
        expect(String(a.data.actions)).toMatch(/master host/);
      });

      it('notification_preferences: own only; a webhook URL is never shown, only its origin', async () => {
        // A target change needs a step-up on the route.
        await stepUp(viewer, viewerSecret);
        const put = await viewer.req('PUT', '/notifications/preferences', {
          webhookUrl: 'https://hooks.example.com/services/T000/B000/s3cr3t-token-value',
        });
        expect(put.statusCode, put.body).toBe(200);
        const r = await call(viewer, 'notification_preferences', {});
        expect(r.refused).toBe(false);
        expect(r.reply).not.toContain('s3cr3t-token-value');
        expect(r.reply).not.toContain('/services/T000');
      });

      it('list_vault_credentials / open_credential_rotation: administrators; metadata and a link only', async () => {
        expect((await call(viewer, 'list_vault_credentials', {})).refused).toBe(true);
        const a = await call(admin, 'list_vault_credentials', {});
        expect(a.data).toMatchObject({ credentials: [], total: 0 });
        expect(String(a.data.note)).toMatch(/Metadata only/);
        const missing = await call(admin, 'open_credential_rotation', { credential: 'NOPE_KEY' });
        expect(missing.refused).toBe(true);
        expect(missing.reply).toMatch(/not found/);
        expect((await call(viewer, 'open_credential_rotation', { credential: 'X' })).refused).toBe(true);
      });

      it('list_integrations, quota_status, list_schedules, list_previews, git_central_status, worker_release_status', async () => {
        expect((await call(viewer, 'list_integrations', {})).refused).toBe(true);
        const i = await call(admin, 'list_integrations', {});
        expect(i.data).toMatchObject({ coolify: [], cloudflare: null, github: { connected: false } });
        expect(i.reply).not.toMatch(/"token"\s*:/);
        expect((await call(viewer, 'quota_status', {})).refused).toBe(false);
        expect((await call(viewer, 'list_schedules', { project: 'alpha' })).data).toMatchObject({ total: 0 });
        expect((await call(viewer, 'list_schedules', { project: 'beta' })).refused).toBe(true);
        expect((await call(viewer, 'list_previews', { project: 'alpha' })).data).toMatchObject({
          project: 'alpha',
        });
        const g = await call(viewer, 'git_central_status', {});
        expect(g.data).toMatchObject({ pullRequests: [], pendingMergeDecisions: [] });
        expect(g.data.githubApp).toBeUndefined();
        expect((await call(viewer, 'worker_release_status', {})).refused).toBe(false);
        const rel = await call(admin, 'worker_release_status', {});
        expect((rel.data.machines as { name: string }[]).length).toBeGreaterThanOrEqual(1);
      });
    });

    describe('user accounts (owners; safe core event users.roles)', () => {
      it('an admin is refused; the owner changes a role at once with a fresh code, audited with source chat', async () => {
        const a = await call(admin, 'manage_user', {
          action: 'set_role',
          user: 'target.adm',
          role: 'viewer',
        });
        expect(a.refused).toBe(true);
        await stepUp(owner, ownerSecret);
        const o = await call(owner, 'manage_user', {
          action: 'set_role',
          user: 'target.adm',
          role: 'viewer',
        });
        expect(o.reply).toContain('executed');
        expect(o.reply).not.toContain('NOT executed');
        expect(o.drafts[0]).toMatchObject({ kind: 'settings_change', state: 'confirmed' });
        const row = (await audits('user.role.change')).at(-1);
        expect(row).toMatchObject({ actor_id: ownerId, outcome: 'success', target: `user:${targetId}` });
        expect(row?.metadata).toMatchObject({ source: 'chat', previousRole: 'operator', role: 'viewer' });
        expect((await direct(o.drafts[0]?.id ?? ''))[0]?.metadata).toMatchObject({ event: 'users.roles' });
      });

      it('without a fresh code the change waits on a card that asks for it', async () => {
        await h.setSecurityPolicy({ preset: 'serbest', stepUp: { windowMinutes: 5 } });
        h.clock.advance(6 * MIN);
        const o = await call(owner, 'manage_user', {
          action: 'set_role',
          user: 'target.adm',
          role: 'operator',
        });
        expect(o.reply).toContain('needsCode');
        expect(o.drafts[0]).toMatchObject({ state: 'proposed' });
        expect((await direct(o.drafts[0]?.id ?? ''))[0]).toMatchObject({
          outcome: 'denied',
          metadata: expect.objectContaining({ reason: 'needs_code' }) as unknown,
        });
        // The card asks for the code; with it the change runs (always-fresh: a code from just now).
        await stepUp(owner, ownerSecret);
        const c = await owner.req('POST', `/chat/drafts/${o.drafts[0]?.id ?? ''}/confirm`, {});
        expect(c.statusCode, c.body).toBe(200);
        expect((await audits('user.role.change')).at(-1)?.metadata).toMatchObject({
          source: 'chat',
          role: 'operator',
        });
        await h.setSecurityPolicy({ preset: 'serbest' });
      });

      it('disabling a user is destructive: a card even on an explicit command, until the policy allows it', async () => {
        await stepUp(owner, ownerSecret);
        const o = await call(owner, 'manage_user', { action: 'disable', user: 'target.adm', execute: true });
        expect(o.reply).toContain('not executed');
        expect(o.drafts[0]?.payload).toMatchObject({ cardOnly: 'destructive', op: 'user.disable' });
        expect(o.drafts[0]?.state).toBe('proposed');
        expect((await direct(o.drafts[0]?.id ?? ''))[0]?.metadata).toMatchObject({ reason: 'destructive' });
        expect(await audits('user.disable')).toHaveLength(0);
        // Confirming the card disables the account, audited like the console with source chat.
        const c = await owner.req('POST', `/chat/drafts/${o.drafts[0]?.id ?? ''}/confirm`, {});
        expect(c.statusCode, c.body).toBe(200);
        expect((await audits('user.disable')).at(-1)?.metadata).toMatchObject({ source: 'chat' });
        // The policy allows destructive administration from the chat: enable + disable run at once.
        await h.setSecurityPolicy({ preset: 'serbest', autonomy: { chatDestructive: true } });
        await stepUp(owner, ownerSecret);
        expect((await call(owner, 'manage_user', { action: 'enable', user: 'target.adm' })).reply).toContain(
          'executed',
        );
        const again = await call(owner, 'manage_user', { action: 'disable', user: 'target.adm' });
        expect(again.drafts[0]?.state).toBe('confirmed');
        await h.setSecurityPolicy({ preset: 'serbest' });
        await stepUp(owner, ownerSecret);
        await call(owner, 'manage_user', { action: 'enable', user: 'target.adm' });
      });

      it('an invite is always a card; the temporary password reaches only the card’s answer', async () => {
        await h.setSecurityPolicy({ preset: 'serbest', autonomy: { chatDestructive: true } });
        await stepUp(owner, ownerSecret);
        const o = await call(owner, 'manage_user', {
          action: 'invite',
          username: 'newbie.adm',
          role: 'viewer',
          execute: true,
        });
        expect(o.reply).toContain('not executed');
        expect(o.drafts[0]?.payload).toMatchObject({ cardOnly: 'reveal', op: 'user.invite' });
        expect((await direct(o.drafts[0]?.id ?? ''))[0]?.metadata).toMatchObject({ reason: 'card_only' });
        const c = await owner.req('POST', `/chat/drafts/${o.drafts[0]?.id ?? ''}/confirm`, {});
        expect(c.statusCode, c.body).toBe(200);
        const password = c.json<{ result: { temporaryPassword: string } }>().result.temporaryPassword;
        expect(password).toMatch(/^[A-Za-z0-9_-]{24}$/);
        // Stored result, audit and the transcript never carry it.
        const stored = await h.db.pool.query<{ payload: unknown; result: unknown }>(
          'SELECT payload, result FROM chat_drafts WHERE id = $1',
          [o.drafts[0]?.id ?? ''],
        );
        expect(JSON.stringify(stored.rows)).not.toContain(password);
        expect(stored.rows[0]?.result).toMatchObject({ temporaryPassword: 'shown once on the card' });
        const all = await h.db.pool.query<{ metadata: unknown }>('SELECT metadata FROM audit_events');
        expect(JSON.stringify(all.rows)).not.toContain(password);
        const msgs = await h.db.pool.query<{ content: string }>('SELECT content FROM chat_messages');
        expect(JSON.stringify(msgs.rows)).not.toContain(password);
        expect((await audits('user.create')).at(-1)?.metadata).toMatchObject({
          source: 'chat',
          username: 'newbie.adm',
        });
        await h.setSecurityPolicy({ preset: 'serbest' });
      });
    });

    describe('project members (project administrators)', () => {
      it('a viewer is refused; an admin adds and removes a member at once, audited with source chat', async () => {
        expect(
          (
            await call(viewer, 'manage_project_member', {
              action: 'add',
              project: 'alpha',
              user: 'target.adm',
              role: 'viewer',
            })
          ).refused,
        ).toBe(true);
        await stepUp(admin, adminSecret);
        const add = await call(admin, 'manage_project_member', {
          action: 'add',
          project: 'alpha',
          user: 'target.adm',
          role: 'viewer',
        });
        expect(add.reply).toContain('executed');
        expect((await audits('project.member.set')).at(-1)?.metadata).toMatchObject({
          source: 'chat',
          role: 'viewer',
          userId: targetId,
        });
        const rm = await call(admin, 'manage_project_member', {
          action: 'remove',
          project: 'alpha',
          user: 'target.adm',
        });
        expect(rm.reply).toContain('executed');
        expect((await audits('project.member.remove')).at(-1)?.metadata).toMatchObject({ source: 'chat' });
      });
    });

    describe('machines and releases (administrators)', () => {
      let pendingId = '';
      let code = '';
      let paired: Promise<string> | undefined;

      it('approves a pending pairing with the machine’s code; a wrong code is refused by the fleet service', async () => {
        const dataDir = await tempDataDir(dirs);
        const out: string[] = [];
        paired = pairWorker({
          ops: createNodeFileOps(),
          host: {
            platform: process.platform,
            env: () => undefined,
            homedir: () => dataDir,
            isPrivileged: false,
          },
          signals: new ManualSignals(),
          facts: () => Promise.resolve({ ...FACTS, hostname: 'chat-pairing' }),
          out: (t) => out.push(t),
          masterUrl: url,
          dataDir,
          logSink: () => undefined,
        });
        await expect.poll(() => out.join('').includes('Waiting for approval')).toBe(true);
        code = /Pairing code: ([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(out.join(''))?.[1] ?? '';
        const fp = /Fingerprint: +(SHA256:[0-9A-F-]+)/.exec(out.join(''))?.[1] ?? '';
        const list = await admin.req('GET', '/workers');
        pendingId =
          list
            .json<{ workers: { id: string; fingerprint: string }[] }>()
            .workers.find((w) => w.fingerprint === fp)?.id ?? '';
        expect(pendingId).not.toBe('');
        expect(
          (
            await call(viewer, 'manage_machine', {
              action: 'approve',
              workerId: pendingId,
              pairingCode: code,
            })
          ).refused,
        ).toBe(true);
        await stepUp(admin, adminSecret);
        const ok = await call(admin, 'manage_machine', {
          action: 'approve',
          workerId: pendingId,
          pairingCode: code,
        });
        expect(ok.reply).toContain('executed');
        // The tool result never repeats the pairing code.
        expect(ok.reply).not.toContain(code);
        expect(await paired).toBe('approved');
        expect((await audits('worker.approve')).at(-1)?.metadata).toMatchObject({ source: 'chat' });
      });

      it('rolls the release out, pauses it and rolls one machine back; the status shows it', async () => {
        for (const v of ['9.9.8', '9.9.9'])
          await h.db.pool.query(
            `INSERT INTO worker_releases (version, channel, manifest, signature, key_id, sha256, size_bytes,
                                        protocol_versions, min_node, artifact, built_at, uploaded_at)
           VALUES ($1, 'stable', '\\x7b7d', '{}', '0123456789abcdef', repeat('a', 64), 1, '["1.0"]', '22.0.0',
                   '\\x00', now(), now())`,
            [v],
          );
        await stepUp(admin, adminSecret);
        const set = await call(admin, 'manage_release', {
          action: 'set_rollout',
          version: '9.9.9',
          percent: 25,
        });
        expect(set.reply).toContain('executed');
        expect((await audits('release.promote')).at(-1)?.metadata).toMatchObject({ source: 'chat' });
        const pause = await call(admin, 'manage_release', { action: 'pause' });
        expect(pause.reply).toContain('executed');
        const status = await call(admin, 'worker_release_status', {});
        expect(status.data.channels).toEqual([
          expect.objectContaining({ channel: 'stable', version: '9.9.9', rolloutPercent: 0, paused: true }),
        ]);
        const back = await call(admin, 'manage_release', {
          action: 'rollback_machine',
          workerId: pendingId,
          version: '9.9.8',
        });
        expect(back.reply).toContain('executed');
        expect((await audits('worker.update.target')).at(-1)?.metadata).toMatchObject({ source: 'chat' });
        const missing = await call(admin, 'manage_release', { action: 'set_rollout', version: '1.2.3' });
        expect(missing.refused).toBe(true);
      });

      it('revoking a machine is destructive: a card; confirming it revokes, audited with source chat', async () => {
        await stepUp(admin, adminSecret);
        const o = await call(admin, 'manage_machine', {
          action: 'revoke',
          workerId: pendingId,
          reason: 'lost laptop',
        });
        expect(o.reply).toContain('not executed');
        expect(o.drafts[0]?.payload).toMatchObject({ cardOnly: 'destructive', op: 'machine.revoke' });
        const c = await admin.req('POST', `/chat/drafts/${o.drafts[0]?.id ?? ''}/confirm`, {});
        expect(c.statusCode, c.body).toBe(200);
        expect((await audits('worker.revoke')).at(-1)?.metadata).toMatchObject({ source: 'chat' });
      });
    });

    describe('own notifications and integrations', () => {
      it('a viewer switches their own e-mail off for a kind at once; changing the address asks for a code when the policy says so', async () => {
        const k = await call(viewer, 'update_notification_preferences', {
          kinds: [{ kind: 'job.failed', email: false }],
        });
        expect(k.reply).toContain('executed');
        expect((await audits('notification.preferences.update')).at(-1)?.metadata).toMatchObject({
          source: 'chat',
        });
        await h.setSecurityPolicy({
          preset: 'serbest',
          stepUp: { windowMinutes: 5 },
          events: { 'notifications.channels': true },
        });
        h.clock.advance(6 * MIN);
        const e = await call(viewer, 'update_notification_preferences', { email: 'viewer@example.com' });
        expect(e.reply).toContain('needsCode');
        expect(e.drafts[0]?.payload).toMatchObject({ event: 'notifications.channels', changesTargets: true });
        await h.setSecurityPolicy({ preset: 'serbest' });
      });

      it('check_integration: administrators; a connection that is not configured is reported, not hidden', async () => {
        expect((await call(viewer, 'check_integration', { provider: 'cloudflare' })).refused).toBe(true);
        await stepUp(admin, adminSecret);
        const r = await call(admin, 'check_integration', { provider: 'cloudflare' });
        expect(r.reply).toMatch(/not executed — the master refused \(not_configured\)/);
      });
    });

    describe('the policy keeps cards', () => {
      it('Sıkı: every administration change waits on a card', async () => {
        await h.setSecurityPolicy({ preset: 'siki' });
        await stepUp(admin, adminSecret);
        const r = await call(admin, 'manage_release', {
          action: 'set_rollout',
          version: '9.9.9',
          percent: 50,
        });
        expect(r.reply).toMatch(/not executed/i);
        expect(r.reply).not.toContain('"executed": true');
        expect(r.drafts[0]?.state).toBe('proposed');
        await h.setSecurityPolicy({ preset: 'serbest' });
      });
    });
  },
);
