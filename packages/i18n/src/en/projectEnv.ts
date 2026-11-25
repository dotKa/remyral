import type { Shape } from '../shape.js';
import type tr from '../tr/projectEnv.js';

/** p19-project-env: Projects → Policy → "Environment variables" from vault credentials of kind “Other”. */
export default {
  title: 'Environment variables',
  sub: 'Vault credentials of kind “Other” are given to this project’s jobs under their own variable names.',
  loading: 'Environment variables',
  none: 'This project’s jobs get no environment variables yet.',
  listLabel: 'Variables given',
  machines: (p: { names: string }) => `On machines: ${p.names}`,
  noMachine: 'Not on any machine — jobs wait. Share the credential with a machine in Settings → Credentials.',
  addLabel: 'Add a credential',
  addNone: 'No credential of kind “Other” to add. Add one in Settings → Credentials first.',
  add: 'Add',
  remove: 'Remove',
  rule: 'Jobs run only on machines holding all of these credentials. Jobs from untrusted sources and pull request jobs never get them. Values are never shown; logs mask them.',
  stepUp: 'Enter your verification code to change the environment variables.',
  saved: 'Environment variables saved.',
  manage: 'Manage credentials',
} satisfies Shape<typeof tr>;
