// Tiny loopback HTTP server. argv: <port> <mode: enforce|open|never-ready|crash>
// The secret comes from env REMYRAL_TEST_SERVER_SECRET (never argv).
import { createServer } from 'node:http';
import { setInterval } from 'node:timers';

const [, , portArg, mode] = process.argv;
const secret = process.env.REMYRAL_TEST_SERVER_SECRET;
if (mode === 'crash') {
  process.stderr.write('boom\n');
  process.exit(3);
} else if (mode === 'never-ready') {
  setInterval(() => {}, 1000);
} else {
  const server = createServer((req, res) => {
    const authorised = secret !== undefined && req.headers['x-test-key'] === secret;
    if (mode === 'enforce' && !authorised) {
      res.writeHead(401).end('unauthorised');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  server.listen(Number(portArg), '127.0.0.1');
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
