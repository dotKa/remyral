#!/usr/bin/env node
// Local-test TLS material for a master behind a TLS-terminating proxy (docs/ops/local-fleet-test.md).
//
//   node scripts/e2e/dev-ca.mjs <dir>
//
// Writes into <dir> (created 0700; existing files are kept, never overwritten):
//   ca.pem      self-signed dev CA (CA:TRUE, pathlen 0, 30 days) — the ONLY file a worker needs
//               (NODE_EXTRA_CA_CERTS=ca.pem); TLS verification stays on everywhere
//   ca.key      CA private key (0600) — stays on this machine
//   server.pem  server certificate signed by the CA, SAN host.docker.internal, localhost, 127.0.0.1
//   server.key  server private key (0600)
// Uses the `openssl` CLI (OpenSSL 3 or LibreSSL). Never prints key material.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SANS = ['DNS:host.docker.internal', 'DNS:localhost', 'IP:127.0.0.1'];

function openssl(args, cwd) {
  execFileSync('openssl', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
}

/**
 * Creates the CA and a server certificate in `dir` unless both already exist.
 * @returns {{ caCert: string, serverCert: string, serverKey: string, created: boolean }}
 */
export function ensureDevCa(dir, { sans = DEFAULT_SANS, days = 30 } = {}) {
  const abs = resolve(dir);
  const paths = {
    caCert: join(abs, 'ca.pem'),
    caKey: join(abs, 'ca.key'),
    serverCert: join(abs, 'server.pem'),
    serverKey: join(abs, 'server.key'),
  };
  const result = { caCert: paths.caCert, serverCert: paths.serverCert, serverKey: paths.serverKey };
  if (Object.values(paths).every((p) => existsSync(p))) return { ...result, created: false };
  if (Object.values(paths).some((p) => existsSync(p))) {
    throw new Error(`${abs} holds a partial CA; delete it or choose another directory`);
  }
  mkdirSync(abs, { recursive: true, mode: 0o700 });
  chmodSync(abs, 0o700);

  const caCnf = join(abs, 'ca.cnf');
  const srvExt = join(abs, 'server.ext');
  const csr = join(abs, 'server.csr');
  writeFileSync(
    caCnf,
    [
      '[req]',
      'distinguished_name = dn',
      'prompt = no',
      'x509_extensions = v3_ca',
      '[dn]',
      'CN = Remyral local fleet test CA (dev only)',
      '[v3_ca]',
      'basicConstraints = critical,CA:TRUE,pathlen:0',
      'keyUsage = critical,keyCertSign,cRLSign',
      'subjectKeyIdentifier = hash',
      '',
    ].join('\n'),
  );
  writeFileSync(
    srvExt,
    [
      'basicConstraints = critical,CA:FALSE',
      'keyUsage = critical,digitalSignature',
      'extendedKeyUsage = serverAuth',
      `subjectAltName = ${sans.join(',')}`,
      'subjectKeyIdentifier = hash',
      'authorityKeyIdentifier = keyid,issuer',
      '',
    ].join('\n'),
  );
  try {
    openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', paths.caKey], abs);
    chmodSync(paths.caKey, 0o600);
    openssl(
      [
        'req',
        '-x509',
        '-new',
        '-key',
        paths.caKey,
        '-sha256',
        '-days',
        String(days),
        '-config',
        caCnf,
        '-out',
        paths.caCert,
      ],
      abs,
    );
    openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', paths.serverKey], abs);
    chmodSync(paths.serverKey, 0o600);
    openssl(['req', '-new', '-key', paths.serverKey, '-subj', '/CN=host.docker.internal', '-out', csr], abs);
    openssl(
      [
        'x509',
        '-req',
        '-in',
        csr,
        '-CA',
        paths.caCert,
        '-CAkey',
        paths.caKey,
        '-set_serial',
        `0x${Date.now().toString(16)}`,
        '-days',
        String(days),
        '-sha256',
        '-extfile',
        srvExt,
        '-out',
        paths.serverCert,
      ],
      abs,
    );
    chmodSync(paths.caCert, 0o644);
    chmodSync(paths.serverCert, 0o644);
  } finally {
    rmSync(caCnf, { force: true });
    rmSync(srvExt, { force: true });
    rmSync(csr, { force: true });
  }
  return { ...result, created: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node scripts/e2e/dev-ca.mjs <dir>');
    process.exit(2);
  }
  const r = ensureDevCa(dir);
  console.log(`${r.created ? 'created' : 'kept existing'} dev CA in ${resolve(dir)}`);
  console.log(`  CA certificate (give this to workers): ${r.caCert}`);
  console.log(`  server certificate (SAN ${DEFAULT_SANS.join(', ')}): ${r.serverCert}`);
}
