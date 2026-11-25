import { parseArgs } from 'node:util';
import { AdminError, resetUser, validateNewPassword, validateUsername } from './admin.js';
import { runAdminCli } from './run-cli.js';
import { readHidden } from './tty-prompt.js';

/**
 * `pnpm --filter @remyral/master admin:reset --username alex [--reset-mfa] [--reset-password] [--unlock]`
 *
 * Shell-access account recovery (docs/ops/admin-bootstrap.md). Always revokes all sessions of the user.
 */
function args(): { username: string; resetMfa: boolean; resetPassword: boolean; unlock: boolean } {
  try {
    const { values } = parseArgs({
      options: {
        username: { type: 'string' },
        'reset-mfa': { type: 'boolean', default: false },
        'reset-password': { type: 'boolean', default: false },
        unlock: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (!values.username) throw new AdminError('--username is required');
    return {
      username: values.username,
      resetMfa: values['reset-mfa'],
      resetPassword: values['reset-password'],
      unlock: values.unlock,
    };
  } catch (err) {
    if (err instanceof AdminError) throw err;
    throw new AdminError('usage: admin:reset --username <name> [--reset-mfa] [--reset-password] [--unlock]');
  }
}

await runAdminCli(async (deps) => {
  const a = args();
  const username = validateUsername(a.username);
  let newPassword: string | undefined;
  if (a.resetPassword) {
    newPassword = await readHidden(`New password for ${username} (min 12 chars): `);
    validateNewPassword(newPassword, await readHidden('Repeat password: '), username);
  }
  const { revokedSessions } = await resetUser(deps, {
    username,
    resetMfa: a.resetMfa,
    unlock: a.unlock,
    ...(newPassword === undefined ? {} : { newPassword }),
  });
  process.stdout.write(
    `Reset "${username}": ${a.resetMfa ? 'TOTP and recovery codes cleared (re-enrollment at next login), ' : ''}` +
      `${a.resetPassword ? 'password changed, ' : ''}${a.unlock || a.resetPassword ? 'lockout cleared, ' : ''}` +
      `${String(revokedSessions)} session(s) revoked.\n`,
  );
});
