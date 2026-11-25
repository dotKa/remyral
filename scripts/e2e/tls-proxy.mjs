#!/usr/bin/env node
// Minimal TLS-terminating TCP proxy for local fleet tests (docs/ops/local-fleet-test.md):
// TLS on <listen> → plain TCP to the master on <target>. HTTP and the WebSocket upgrade pass through
// unchanged (byte pipe). Dev only: production terminates TLS in Traefik/Coolify (docs/ops).
//
//   node scripts/e2e/tls-proxy.mjs --cert server.pem --key server.key \
//     [--listen 127.0.0.1:8443] [--target 127.0.0.1:8080]
//
// Binds loopback by default. Docker Desktop forwards host.docker.internal to the host's loopback, so a
// container reaches it as wss://host.docker.internal:8443 without exposing anything on the LAN.
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { createServer } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

function hostPort(value, name) {
  const i = value.lastIndexOf(':');
  const host = value.slice(0, i);
  const port = Number(value.slice(i + 1));
  if (i <= 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be host:port (got ${value})`);
  }
  return { host: host.replace(/^\[(.*)\]$/, '$1'), port };
}

/**
 * Starts the proxy. Resolves once listening.
 * @returns {Promise<{ close(): Promise<void>, connections(): number }>}
 */
export async function startTlsProxy({ cert, key, listen, target, onError = () => {} }) {
  const l = hostPort(listen, 'listen');
  const t = hostPort(target, 'target');
  const sockets = new Set();
  const server = createServer({ cert: readFileSync(cert), key: readFileSync(key), minVersion: 'TLSv1.2' });
  server.on('secureConnection', (client) => {
    const upstream = connect(t.port, t.host);
    sockets.add(client);
    sockets.add(upstream);
    const done = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on('error', done).on('close', done);
    upstream.on('error', done).on('close', done);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.on('tlsClientError', (err) => {
    onError(err);
  });
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(l.port, l.host, () => {
      server.off('error', fail);
      ok();
    });
  });
  return {
    connections: () => sockets.size / 2,
    close: () =>
      new Promise((ok) => {
        for (const s of sockets) s.destroy();
        server.close(() => {
          ok();
        });
      }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      cert: { type: 'string' },
      key: { type: 'string' },
      listen: { type: 'string', default: '127.0.0.1:8443' },
      target: { type: 'string', default: '127.0.0.1:8080' },
    },
  });
  if (!values.cert || !values.key) {
    console.error(
      'usage: node scripts/e2e/tls-proxy.mjs --cert server.pem --key server.key [--listen h:p] [--target h:p]',
    );
    process.exit(2);
  }
  const proxy = await startTlsProxy({
    cert: values.cert,
    key: values.key,
    listen: values.listen,
    target: values.target,
    onError: (err) => {
      console.error(`tls-proxy: client TLS error: ${err.code ?? err.message}`);
    },
  });
  console.log(`tls-proxy: https/wss on ${values.listen} → http/ws ${values.target} (Ctrl-C to stop)`);
  const stop = () => {
    void proxy.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
