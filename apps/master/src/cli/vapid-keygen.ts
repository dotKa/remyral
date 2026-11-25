import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { vapidKeysFromPem } from '../notifications/push/webpush.js';

/**
 * `node dist/cli/vapid-keygen.js <path>` (p8-pwa, docs/design/p8-pwa.md §5): generates the master's VAPID
 * key pair once — an EC P-256 private key as PKCS#8 PEM, written with mode 0600 and never overwritten — and
 * prints only the public key (the browsers' `applicationServerKey`, not a secret). Point
 * PUSH_VAPID_PRIVATE_KEY_FILE at the file. Rotating the key invalidates every push subscription (browsers
 * bind a subscription to the key), so do it only when the key may be compromised.
 */
function main(): void {
  const path = process.argv[2];
  if (path === undefined || process.argv.length !== 3) {
    process.stderr.write('usage: vapid-keygen <private-key-file>\n');
    process.exit(2);
  }
  const pem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .privateKey.export({ format: 'pem', type: 'pkcs8' })
    .toString();
  try {
    writeFileSync(path, pem, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'error';
    process.stderr.write(
      code === 'EEXIST'
        ? `vapid-keygen: ${path} exists; refusing to overwrite (rotation invalidates every subscription)\n`
        : `vapid-keygen: cannot write ${path} (${code})\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ file: path, publicKey: vapidKeysFromPem(pem).publicKey })}\n`);
}

main();
