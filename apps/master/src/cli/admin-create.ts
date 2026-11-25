import { parseArgs } from 'node:util';
import {
  AdminError,
  assertUserAbsent,
  createUser,
  parseRole,
  validateNewPassword,
  validateUsername,
} from './admin.js';
import { runAdminCli } from './run-cli.js';
import { readHidden } from './tty-prompt.js';

/**
 * `pnpm --filter @remyral/master admin:create --username alex [--role owner]`
 *
 * Creates a local account (ADR-0009 §2). The password is read twice from the terminal with echo off; it is
 * never accepted from argv or the environment. TOTP enrollment happens at the first web login.
 */
function args(): { username: string; role: string } {
  try {
    const { values } = parseArgs({
      options: { username: { type: 'string' }, role: { type: 'string', default: 'owner' } },
      strict: true,
      allowPositionals: false,
    });
    if (!values.username) throw new AdminError('--username is required');
    return { username: values.username, role: values.role };
  } catch (err) {
    if (err instanceof AdminError) throw err;
    throw new AdminError(
      'usage: admin:create --username <name> [--role owner|admin|operator|viewer] (passwords are never accepted as arguments)',
    );
  }
}

await runAdminCli(async (deps) => {
  const a = args();
  const username = validateUsername(a.username);
  const role = parseRole(a.role);
  await assertUserAbsent(deps.pool, username);
  const password = await readHidden(`Password for ${username} (min 12 chars): `);
  const confirmation = await readHidden('Repeat password: ');
  validateNewPassword(password, confirmation, username);
  process.stdout.write('Hashing password (scrypt)...\n');
  await createUser(deps, { username, role, password });
  process.stdout.write(
    `Created user "${username}" (${role}). Log in to enroll an authenticator app; see docs/ops/admin-bootstrap.md.\n`,
  );
});
