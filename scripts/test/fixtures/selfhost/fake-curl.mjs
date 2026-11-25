#!/usr/bin/env node
// A fake `curl` for scripts/test/selfhost-ctl.test.mjs: downloads from https://releases.test/<path> are served from
// $FAKE_RELEASES_DIR/<path>; the health-gate probes (https://<domain>[:port]/api/status and /) answer from the fake
// docker state (healthy master → ok); state.unreachableDomains / untrustedDomains (p17-domain-wizard) make a name fail.
// Every invocation is appended to $FAKE_DOCKER_LOG with a `curl` prefix.
import { appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_DOCKER_LOG, `curl ${args.join(' ')}\n`);
const url = args.at(-1);
const o = args.indexOf('-o');

if (url.startsWith('https://releases.test/')) {
  const src = join(process.env.FAKE_RELEASES_DIR, url.slice('https://releases.test/'.length));
  if (!existsSync(src)) {
    process.stderr.write(`curl: (22) The requested URL returned error: 404\n`);
    process.exit(22);
  }
  copyFileSync(src, args[o + 1]);
  process.exit(0);
}

const state = existsSync(process.env.FAKE_DOCKER_STATE)
  ? JSON.parse(readFileSync(process.env.FAKE_DOCKER_STATE, 'utf8'))
  : { containers: {} };
const master = state.containers?.master;
const host = /^https:\/\/([^/:]+)/.exec(url)?.[1] ?? '';
// p17-domain-wizard: a name the proxy does not answer for (DNS elsewhere), or one without a trusted certificate yet.
if ((state.unreachableDomains ?? []).includes(host)) process.exit(7);
const insecure = args.includes('-k') || args.some((a) => /^-[a-zA-Z]*k[a-zA-Z]*$/.test(a));
if (!insecure && (state.untrustedDomains ?? []).includes(host)) {
  process.stderr.write('curl: (60) SSL certificate problem: self-signed certificate\n');
  process.exit(60);
}
const healthy = master?.running && master.health === 'healthy';
if (url.endsWith('/api/status'))
  process.stdout.write(healthy ? '{"status":"ok"}' : '{"status":"unavailable"}');
else process.stdout.write(state.containers?.web?.running ? '<!doctype html><div id="root"></div>' : '');
process.exit(0);
