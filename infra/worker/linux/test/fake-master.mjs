// Minimal scripted master for the systemd update e2e (infra/worker/linux/test/update-e2e.sh).
// TEST ONLY: it auto-approves every worker and serves releases from a directory. Bundled with esbuild
// (ws) by the host driver and run inside the test container on 127.0.0.1:8080.
//
//   FM_DIR/releases/<version>/{manifest.json,manifest.sig.json,remyral-worker.mjs}
//   FM_DIR/offer.json            {"version":"1.1.0","rollback":false,"force":false} — offered to the
//                                connected worker whenever it runs another version (once per attempt)
//   FM_DIR/sessions.jsonl        one line per established session: {workerVersion, at}
//   FM_DIR/status.jsonl          every UPDATE_STATUS payload received
//   FM_DIR/pairing.jsonl         p5-worker-onboarding: every pairing request {pairingCode, fingerprint}
// FM_PENDING=1: never approve — the worker stays in "waiting for approval" (onboarding-e2e.sh).
// FM_STATIC=<dir>: GET of any other path serves <dir>/<path> (installer kits, bootstrap, a Node mirror).
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, normalize } from 'node:path';
import { Buffer } from 'node:buffer';
import { setInterval } from 'node:timers';
import { WebSocketServer } from 'ws';

const DIR = process.env.FM_DIR ?? '/tmp/fm';
const TOKEN = 'e2eDownloadTokenAAAAAAAAAAAAAAAAAAAAAAAAAAA'.slice(0, 43);
const WORKER_ID = 'wrk_e2eaaaaaaaaaaaaaaaaaaaaaaa';
let current = null; // { ws, version }
// Offered once per process (like the real master, which never re-offers an attempt that is activating).
const offered = new Set();

const envelope = (type, payload, extra = {}) =>
  JSON.stringify({
    protocolVersion: '1.0',
    type,
    messageId: randomUUID(),
    seq: 0,
    ts: new Date().toISOString(),
    correlationId: 'fake-master',
    ...extra,
    payload,
  });

function fingerprint(publicKey) {
  const hex = createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex').toUpperCase();
  return `SHA256:${hex.match(/.{4}/g).join('-')}`;
}

function maybeOffer() {
  if (current === null || !existsSync(join(DIR, 'offer.json'))) return;
  const offer = JSON.parse(readFileSync(join(DIR, 'offer.json'), 'utf8'));
  const key = `${offer.version}:${offer.nonce ?? ''}`;
  if (offer.version === current.version || offered.has(key)) return;
  offered.add(key);
  const manifest = JSON.parse(readFileSync(join(DIR, 'releases', offer.version, 'manifest.json'), 'utf8'));
  current.ws.send(
    envelope(
      'UPDATE_AVAILABLE',
      {
        attemptId: randomUUID(),
        version: offer.version,
        channel: manifest.channel,
        sha256: manifest.sha256,
        size: manifest.size,
        manifestUrl: `/v1/worker/releases/${offer.version}/manifest`,
        artifactUrl: `/v1/worker/releases/${offer.version}/artifact`,
        downloadToken: TOKEN,
        tokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        rollback: offer.rollback === true,
        force: offer.force === true,
      },
      { workerId: WORKER_ID },
    ),
  );
}
setInterval(maybeOffer, 500);

const STATIC = process.env.FM_STATIC;
const PENDING = process.env.FM_PENDING === '1';

const server = createServer((req, res) => {
  if (STATIC !== undefined && !(req.url ?? '').startsWith('/v1/worker/releases/')) {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^\/+/, '');
    const file = join(STATIC, rel);
    if (rel.includes('..') || !existsSync(file) || !statSync(file).isFile()) return res.writeHead(404).end();
    return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(readFileSync(file));
  }
  const m = /^\/v1\/worker\/releases\/([0-9A-Za-z.-]+)\/(manifest|artifact)$/.exec(req.url ?? '');
  if (m === null) return res.writeHead(404).end();
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end();
  const dir = join(DIR, 'releases', m[1]);
  if (m[2] === 'manifest') {
    const body = JSON.stringify({
      manifest: readFileSync(join(dir, 'manifest.json')).toString('base64'),
      signature: JSON.parse(readFileSync(join(dir, 'manifest.sig.json'), 'utf8')),
    });
    return res.writeHead(200, { 'content-type': 'application/json' }).end(body);
  }
  return res
    .writeHead(200, { 'content-type': 'application/octet-stream' })
    .end(readFileSync(join(dir, 'remyral-worker.mjs')));
});

const wss = new WebSocketServer({ server, path: '/v1/worker' });
wss.on('connection', (ws) => {
  let hello = null;
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    switch (msg.type) {
      case 'HELLO':
        hello = msg.payload;
        ws.send(
          envelope('CHALLENGE', {
            nonce: randomUUID().replaceAll('-', ''),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        );
        return;
      case 'AUTH': {
        const session = () =>
          ws.send(
            envelope(
              'SESSION_ESTABLISHED',
              {
                negotiatedVersion: '1.0',
                sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                resumeFromSeq: 0,
              },
              { workerId: WORKER_ID },
            ),
          );
        if (hello.pairingCode !== undefined) {
          appendFileSync(
            join(DIR, 'pairing.jsonl'),
            `${JSON.stringify({ pairingCode: hello.pairingCode, fingerprint: fingerprint(hello.publicKey) })}\n`,
          );
          ws.send(
            envelope(
              'ENROLL_PENDING',
              {
                fingerprint: fingerprint(hello.publicKey),
                expiresAt: new Date(Date.now() + 600_000).toISOString(),
              },
              { workerId: WORKER_ID },
            ),
          );
          if (PENDING) return; // waiting for approval (the owner has not approved yet)
          ws.send(
            envelope(
              'ENROLL_APPROVED',
              { workerId: WORKER_ID, approvedAt: new Date().toISOString() },
              { workerId: WORKER_ID },
            ),
          );
        }
        session();
        current = { ws, version: hello.workerVersion };
        appendFileSync(
          join(DIR, 'sessions.jsonl'),
          `${JSON.stringify({ workerVersion: hello.workerVersion, at: new Date().toISOString() })}\n`,
        );
        return;
      }
      case 'UPDATE_STATUS':
        appendFileSync(join(DIR, 'status.jsonl'), `${JSON.stringify(msg.payload)}\n`);
        return;
      default:
    }
  });
  ws.on('close', () => {
    if (current?.ws === ws) current = null;
  });
});
server.listen(8080, '127.0.0.1', () => console.log('fake master on 127.0.0.1:8080'));
