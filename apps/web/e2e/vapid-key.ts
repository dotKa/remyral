import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * p8-pwa: a throw-away VAPID key for the e2e master (so the Devices page shows the push controls). Written
 * once into the OS temp directory (Playwright empties test-results/ at start); never used outside e2e.
 */
export function e2eVapidKeyFile(): string {
  const dir = join(tmpdir(), 'remyral-e2e');
  const file = join(dir, 'vapid.pem');
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const pem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString();
    writeFileSync(file, pem, { mode: 0o600 });
  }
  return file;
}
