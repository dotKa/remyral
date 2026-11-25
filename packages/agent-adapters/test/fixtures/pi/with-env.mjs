// `env K=V … <script> <args>` for the stand-ins, without /usr/bin/env (Windows has none): sets the leading K=V
// pairs, then runs the script with the rest as its argv.
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
while (args.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0] ?? '')) {
  const pair = args.shift() ?? '';
  const at = pair.indexOf('=');
  process.env[pair.slice(0, at)] = pair.slice(at + 1);
}
const script = args.shift();
if (script === undefined) throw new Error('with-env: no script');
process.argv = [process.argv[0] ?? process.execPath, script, ...args];
await import(pathToFileURL(script).href);
