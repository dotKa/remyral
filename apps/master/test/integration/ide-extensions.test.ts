import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { IdeProfile, IdeSpec, type LeaseKey, type MasterToWorker, verifyIdeStart } from '@remyral/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { type Fetch, OpenVsxClient } from '../../src/ide/openvsx.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

/**
 * p19-ide W3 against a real master (Postgres, local blob store) with a fake Open VSX registry and a raw worker that
 * advertises `ide-extensions-v1`: allowing an extension downloads + verifies + caches it (admin, `extensions.ide`
 * step-up; operators refused), deny wins, project required / recommended lists (only allowlisted ids), the user's own
 * list, the signed IDE_START profile (required + user list + dependencies) with its download token, the worker
 * downloads (only that start's blobs; 401 otherwise), settings sync over IDE_EVENT `settings` (stored; a secret-like
 * value refused + audited), the install report in IDE_STATUS, settings reset and removal from the allowlist.
 */
const PW = 'quartz-meadow-lantern-8';
const PROJECT = 'shop';
const IDE_ORIGIN = 'https://ide.example.test';
const REG = 'https://open-vsx.org';
const h = new Harness();
let owner: Client;
let ownerSecret = '';
let operator: Client;
let operatorSecret = '';
let worker: RawWorker;
let workerId = '';
let leaseKeys: LeaseKey[] = [];

type Start = Extract<MasterToWorker, { type: 'IDE_START' }>;
type Notice = Extract<MasterToWorker, { type: 'IDE_NOTICE' }>;

function zip(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc32(e.data) >>> 0, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE((3 << 8) | 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc32(e.data) >>> 0, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, e.data);
    centrals.push(ch, name);
    offset += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** A fake open-vsx.org: acme.tool (needs acme.base), acme.base, acme.lint, acme.bad — signed with a test key. */
function registry(): { fetch: Fetch; vsix: Record<string, Buffer> } {
  const map: Record<string, Buffer> = {};
  const vsix: Record<string, Buffer> = {};
  map[`${REG}/api/-/public-key/k-test`] = Buffer.from(
    publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  );
  for (const [name, deps] of [
    ['tool', ['acme.base']],
    ['base', []],
    ['lint', []],
    ['bad', []],
  ] as const) {
    const id = `acme.${name}`;
    const bytes = zip([
      {
        name: 'extension/package.json',
        data: Buffer.from(JSON.stringify({ publisher: 'acme', name, version: '1.0.0' })),
      },
    ]);
    vsix[id] = bytes;
    const files = `${REG}/files/${id}`;
    map[`${REG}/api/acme/${name}/latest`] = Buffer.from(
      JSON.stringify({
        namespace: 'acme',
        name,
        version: '1.0.0',
        targetPlatform: 'universal',
        displayName: `Acme ${name}`,
        description: 'test',
        verified: true,
        dependencies: deps,
        engines: { vscode: '^1.90.0' },
        downloadSizes: { universal: bytes.length },
        files: {
          download: `${files}.vsix`,
          signature: `${files}.sigzip`,
          sha256: `${files}.sha256`,
          publicKey: `${REG}/api/-/public-key/k-test`,
        },
      }),
    );
    map[`${files}.vsix`] = bytes;
    map[`${files}.sha256`] = Buffer.from(hex(bytes));
    map[`${files}.sigzip`] = zip([
      { name: '.signature.sig', data: sign(null, bytes, privateKey) },
      {
        name: '.signature.manifest',
        data: Buffer.from(
          JSON.stringify({
            package: {
              size: bytes.length,
              digests: { sha256: createHash('sha256').update(bytes).digest('base64') },
            },
          }),
        ),
      },
    ]);
  }
  map[`${REG}/api/-/search?query=acme&size=20`] = Buffer.from(
    JSON.stringify({
      extensions: ['tool', 'base', 'lint', 'bad'].map((n) => ({
        namespace: 'acme',
        name: n,
        version: '1.0.0',
        verified: true,
      })),
    }),
  );
  return {
    vsix,
    fetch: (url) => {
      const body = map[url];
      return Promise.resolve({
        ok: body !== undefined,
        status: body === undefined ? 404 : 200,
        url,
        headers: { get: () => null },
        arrayBuffer: () => {
          const b = body ?? Buffer.alloc(0);
          return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer);
        },
      });
    },
  };
}
const reg = registry();

async function stepUp(c: Client, secret: string): Promise<void> {
  h.clock.advance(30_000);
  expect((await c.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function audits(action: string): Promise<{ target: string; metadata: Record<string, unknown> }[]> {
  const { rows } = await h.db.pool.query<{ target: string; metadata: Record<string, unknown> }>(
    'SELECT target, metadata FROM audit_events WHERE action = $1 ORDER BY id',
    [action],
  );
  return rows;
}

describeIntegration(
  'IDE extensions and settings sync (integration, p19-ide W3)',
  { timeout: 180_000 },
  () => {
    beforeAll(async () => {
      await h.start({
        ide: { origin: IDE_ORIGIN, openVsx: new OpenVsxClient({ fetch: reg.fetch }) },
        workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
      });
      const url = await h.listen();
      await h.createUser('owner1', PW, 'owner');
      ownerSecret = (await enroll(h, 'owner1', PW)).secret;
      owner = await fullLogin(h, 'owner1', PW, ownerSecret);
      await h.db.pool.query(
        "INSERT INTO projects (id, name, kind, created_at) VALUES ($1, $1, 'workspace', now())",
        [PROJECT],
      );
      const operatorId = await h.createUser('oper1', PW, 'operator');
      await h.grant(operatorId, [PROJECT], 'operator');
      operatorSecret = (await enroll(h, 'oper1', PW)).secret;
      operator = await fullLogin(h, 'oper1', PW, operatorSecret);

      worker = await RawWorker.connect(url, new TestKey());
      const pending = await worker.handshake({ pairingCode: 'IDEX-ABCD' });
      workerId = pending.workerId ?? '';
      await stepUp(owner, ownerSecret);
      expect(
        (await owner.req('POST', `/workers/${workerId}/approve`, { pairingCode: 'IDEX-ABCD' })).statusCode,
      ).toBe(200);
      const est = await worker.next('SESSION_ESTABLISHED');
      leaseKeys = [...(est.payload.leaseKeys ?? [])];
      await h.db.pool.query(`UPDATE workers SET facts = jsonb_set(facts, '{os}', '"linux"') WHERE id = $1`, [
        workerId,
      ]);
      worker.sendJson(
        worker.envelope(
          'CAPABILITIES',
          {
            runtimes: [],
            sandboxProfiles: ['host-restricted'],
            maxParallelJobs: 1,
            tools: [],
            features: ['ide-v1', 'ide-extensions-v1'],
            ide: { available: true, serverVersion: '1.109.5', max: 2, workspaces: [] },
          },
          { workerId },
        ),
      );
      await waitFor(async () => {
        const r = await h.db.pool.query<{ ok: boolean }>(
          `SELECT features ? 'ide-extensions-v1' AS ok FROM workers WHERE id = $1`,
          [workerId],
        );
        return r.rows[0]?.ok === true;
      });
    });

    afterAll(async () => {
      worker.close();
      await h.stop();
    });

    it('admins search Open VSX through the master and allow extensions (verified, cached); operators cannot', async () => {
      expect((await operator.req('GET', '/ide/extensions')).statusCode).toBe(403);
      expect((await operator.req('POST', '/ide/extensions', { id: 'acme.tool' })).statusCode).toBe(403);
      const search = await owner.req('GET', '/ide/extensions/search?q=acme');
      expect(search.statusCode).toBe(200);
      expect(search.json<{ results: { id: string }[] }>().results.map((r) => r.id)).toContain('acme.tool');
      await stepUp(owner, ownerSecret);
      for (const id of ['acme.tool', 'acme.base', 'acme.lint']) {
        const res = await owner.req('POST', '/ide/extensions', { id });
        expect(res.statusCode, id).toBe(201);
      }
      const list = (await owner.req('GET', '/ide/extensions')).json<{
        extensions: {
          id: string;
          version: string;
          dependencies: string[];
          targets: { target: string; sha256: string; keyPinned: boolean }[];
        }[];
      }>().extensions;
      const tool = list.find((e) => e.id === 'acme.tool');
      expect(tool).toMatchObject({ version: '1.0.0', dependencies: ['acme.base'] });
      expect(tool?.targets).toEqual([
        expect.objectContaining({
          target: 'universal',
          sha256: hex(reg.vsix['acme.tool'] ?? Buffer.alloc(0)),
          keyPinned: false,
        }),
      ]);
      const blob = await h.db.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM blob_objects WHERE kind = 'ide-extension'",
      );
      expect(blob.rows[0]?.n).toBe(3);
      expect((await audits('ide.extension.allow')).length).toBeGreaterThanOrEqual(3);
      // Unknown in the registry → 404; a denied one cannot be allowed.
      expect((await owner.req('POST', '/ide/extensions', { id: 'acme.none' })).statusCode).toBe(404);
      const policy = await owner.req('PUT', '/ide/extension-policy', {
        registryUrl: null,
        verifiedOnly: false,
        deny: ['acme.bad'],
      });
      expect(policy.statusCode).toBe(200);
      const denied = await owner.req('POST', '/ide/extensions', { id: 'acme.bad' });
      expect(denied.statusCode).toBe(409);
      expect(denied.json<{ error: string }>().error).toBe('ide_extension_denied');
    });

    it('projects mark required / recommended from the allowlist only; users pick from what is allowed', async () => {
      await stepUp(owner, ownerSecret);
      const bad = await owner.req('PUT', `/projects/${PROJECT}/ide/extension-policy`, {
        required: ['acme.unknown'],
        recommended: [],
        deny: [],
        enforcedSettings: {},
      });
      expect(bad.statusCode).toBe(409);
      const secret = await owner.req('PUT', `/projects/${PROJECT}/ide/extension-policy`, {
        required: [],
        recommended: [],
        deny: [],
        enforcedSettings: { 'x.key': `ghp_${'a'.repeat(36)}` },
      });
      expect(secret.statusCode).toBe(400);
      const ok = await owner.req('PUT', `/projects/${PROJECT}/ide/extension-policy`, {
        required: ['acme.tool'],
        recommended: ['acme.lint'],
        deny: [],
        enforcedSettings: { 'files.exclude': { '**/dist': true } },
      });
      expect(ok.statusCode).toBe(200);
      expect(
        (await operator.req('PUT', `/projects/${PROJECT}/ide/extension-policy`, ok.json())).statusCode,
      ).toBe(403);
      const mine = (await operator.req('GET', `/projects/${PROJECT}/ide/extensions`)).json<{
        available: { id: string; required: boolean; recommended: boolean }[];
        required: string[];
      }>();
      expect(mine.required).toEqual(['acme.tool']);
      expect(mine.available.find((a) => a.id === 'acme.lint')).toMatchObject({ recommended: true });
      expect((await operator.req('PUT', '/me/ide/extensions', { extensions: ['acme.bad'] })).statusCode).toBe(
        409,
      );
      const put = await operator.req('PUT', '/me/ide/extensions', { extensions: ['acme.lint'] });
      expect(put.statusCode).toBe(200);
      expect(put.json<{ extensions: string[] }>().extensions).toEqual(['acme.lint']);
    });

    let wsId = '';
    let start: Start | null = null;

    it('a start carries the signed profile and a token that downloads exactly its blobs', async () => {
      await stepUp(operator, operatorSecret);
      const res = await operator.req('POST', `/projects/${PROJECT}/ide/workspaces`, {
        name: 'ext',
        worker: workerId,
      });
      expect(res.statusCode).toBe(201);
      wsId = res.json<{ workspace: { id: string } }>().workspace.id;
      for (;;) {
        const m = await worker.next('IDE_START', 10_000);
        if (m.payload.spec.workspaceId === wsId) {
          start = m;
          break;
        }
      }
      const p = start.payload;
      const profile = IdeProfile.parse(p.profile);
      expect(profile.extensions.map((e) => e.id)).toEqual(['acme.tool', 'acme.lint', 'acme.base']);
      expect(profile.allowed).toEqual(['acme.tool', 'acme.lint', 'acme.base']);
      expect(profile.enforcedSettings).toEqual({ 'files.exclude': { '**/dist': true } });
      expect(profile.settingsSync).toBe(true);
      expect(
        verifyIdeStart(
          { workerId, revision: p.revision, issuedAt: p.issuedAt, spec: IdeSpec.parse(p.spec), profile },
          p.signature,
          leaseKeys,
        ),
      ).toBe('ok');
      const token = p.downloadToken ?? '';
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const sha = profile.extensions[0]?.sha256 ?? '';
      const got = await h.client().req('GET', `/v1/worker/ide/extensions/${sha}`, undefined, {
        authorization: `Bearer ${token}`,
      });
      expect(got.statusCode).toBe(200);
      expect(hex(got.rawPayload)).toBe(sha);
      const badSha = hex(reg.vsix['acme.bad'] ?? Buffer.alloc(0));
      expect(
        (
          await h.client().req('GET', `/v1/worker/ide/extensions/${badSha}`, undefined, {
            authorization: `Bearer ${token}`,
          })
        ).statusCode,
      ).toBe(401);
      expect((await h.client().req('GET', `/v1/worker/ide/extensions/${sha}`)).statusCode).toBe(401);
      const settings = await h.client().req('GET', `/v1/worker/ide/settings/${wsId}`, undefined, {
        authorization: `Bearer ${token}`,
      });
      expect(settings.json()).toEqual({ settings: null, keybindings: null });
      expect(
        (
          await h.client().req('GET', `/v1/worker/ide/settings/${randomUUID()}`, undefined, {
            authorization: `Bearer ${token}`,
          })
        ).statusCode,
      ).toBe(401);
    });

    it('the install report lands on the workspace', async () => {
      worker.sendJson(
        worker.envelope(
          'IDE_STATUS',
          {
            workspaceId: wsId,
            revision: 1,
            state: 'running',
            at: new Date().toISOString(),
            extensions: {
              installed: ['acme.tool', 'acme.base'],
              failed: [{ id: 'acme.lint', reason: 'broken' }],
            },
          },
          { workerId },
        ),
      );
      const ws = await waitFor(async () => {
        const r = (await operator.req('GET', `/ide/workspaces/${wsId}`)).json<{
          workspace: { extensions: { installed: string[] | null; failed: { id: string }[] } | null };
        }>();
        return r.workspace.extensions?.installed === null ? null : r.workspace;
      });
      expect(ws.extensions).toMatchObject({
        installed: ['acme.tool', 'acme.base'],
        failed: [{ id: 'acme.lint' }],
      });
    });

    it('settings sync: the bridge saves settings; a secret-like value is refused and audited; reset forgets them', async () => {
      const send = (content: string): string => {
        const eventId = randomUUID();
        worker.sendJson(
          worker.envelope(
            'IDE_EVENT',
            {
              kind: 'settings',
              workspaceId: wsId,
              eventId,
              at: new Date().toISOString(),
              file: 'settings',
              content,
            },
            { workerId },
          ),
        );
        return eventId;
      };
      const next = async (eventId: string): Promise<Notice> => {
        for (;;) {
          const n = await worker.next('IDE_NOTICE', 10_000);
          if (n.payload.eventId === eventId) return n;
        }
      };
      const ok = await next(send('{"editor.fontSize": 16}'));
      expect(ok.payload.status).toBe('ok');
      const refused = await next(send(`{"x.token": "ghp_${'b'.repeat(36)}"}`));
      expect(refused.payload.status).toBe('refused');
      const audit = (await audits('ide.settings.refused')).at(-1);
      expect(audit).toMatchObject({ target: `ide:${wsId}` });
      expect(JSON.stringify(audit?.metadata)).not.toContain('ghp_');
      const token = start?.payload.downloadToken ?? '';
      const synced = await h.client().req('GET', `/v1/worker/ide/settings/${wsId}`, undefined, {
        authorization: `Bearer ${token}`,
      });
      expect(synced.json()).toEqual({ settings: '{"editor.fontSize": 16}', keybindings: null });
      const view = (await operator.req('GET', `/projects/${PROJECT}/ide/extensions`)).json<{
        settings: { settingsBytes: number | null };
      }>();
      expect(view.settings.settingsBytes).toBe(Buffer.byteLength('{"editor.fontSize": 16}'));
      expect((await operator.req('DELETE', '/me/ide/settings')).statusCode).toBe(204);
      const after = await h.client().req('GET', `/v1/worker/ide/settings/${wsId}`, undefined, {
        authorization: `Bearer ${token}`,
      });
      expect(after.json()).toEqual({ settings: null, keybindings: null });
    });

    it('removing an extension drops its cache rows; the next start leaves it out', async () => {
      await stepUp(owner, ownerSecret);
      expect((await owner.req('DELETE', '/ide/extensions/acme.lint')).statusCode).toBe(204);
      const rows = await h.db.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM ide_extension_blobs WHERE extension_id = 'acme.lint'",
      );
      expect(rows.rows[0]?.n).toBe(0);
      const mine = (await operator.req('GET', `/projects/${PROJECT}/ide/extensions`)).json<{
        blocked: { id: string; reason: string }[];
      }>();
      expect(mine.blocked).toEqual([{ id: 'acme.lint', reason: 'not_allowed' }]);
      expect((await audits('ide.extension.remove')).at(-1)).toMatchObject({
        target: 'ide-extension:acme.lint',
      });
    });
  },
);
