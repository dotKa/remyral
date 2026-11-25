import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FunctionContext } from '../src/functions/types.js';
import { SecretString } from '../src/secrets/ref.js';

/** The only address tests treat as "public": their own loopback servers (production never overrides the check). */
export const TEST_SERVER = '127.0.0.1';
export const onlyTestServer = (a: string): boolean => a === TEST_SERVER;

/** A resolver: names in `map` resolve to the listed addresses, everything else fails; counts lookups. */
export function fakeDns(map: Record<string, string[] | (() => string[])>) {
  const calls: string[] = [];
  return {
    calls,
    lookup: (host: string) => {
      calls.push(host);
      const v = map[host];
      if (v === undefined) return Promise.reject(new Error('ENOTFOUND'));
      const list = typeof v === 'function' ? v() : v;
      return Promise.resolve(list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
    },
  };
}

export function ctxWith(
  credentials: Record<string, string> = {},
  signal: AbortSignal = new AbortController().signal,
): FunctionContext & { secrets: string[] } {
  const secrets: string[] = [];
  return {
    secrets,
    signal,
    credential: (id) => Promise.resolve(id in credentials ? new SecretString(credentials[id] ?? '') : null),
    addSecret: (v) => {
      secrets.push(v);
    },
    log: { info: () => undefined, warn: () => undefined },
  };
}

let cached: { key: string; cert: string } | null | undefined;

/**
 * A self-signed certificate for `*.example.test` + 127.0.0.1 (openssl CLI; null when it is not installed — the TLS
 * tests are skipped then).
 */
export function testCert(): { key: string; cert: string } | null {
  if (cached !== undefined) return cached;
  const dir = mkdtempSync(join(tmpdir(), 'rw-cert-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        join(dir, 'k.pem'),
        '-out',
        join(dir, 'c.pem'),
        '-days',
        '2',
        '-subj',
        '/CN=mail.example.test',
        '-addext',
        'subjectAltName=DNS:mail.example.test,DNS:api.example.test,IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    cached = {
      key: readFileSync(join(dir, 'k.pem'), 'utf8'),
      cert: readFileSync(join(dir, 'c.pem'), 'utf8'),
    };
  } catch {
    cached = null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return cached;
}
