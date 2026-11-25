import { parseEgressTarget } from '../network.js';
import { startEgressProxy } from './proxy.js';

/**
 * Entry point of the egress proxy sidecar (bundled into the `remyral-egress-proxy`
 * image by infra/worker/images/build.mjs). Configuration via environment only:
 *   REMYRAL_EGRESS_ALLOW  comma-separated `host[:port]` (port default 443)
 *   REMYRAL_EGRESS_MODE   `allowlist` (default) or `web` (p5-research-workspace: also any public host on 443)
 *   REMYRAL_EGRESS_HINT   p14-repo-egress: text added to the 403 body of a refused target (the policy and where
 *                        to change it); at most 500 characters, never secret
 *   REMYRAL_EGRESS_PORT   listen port (default 3128), listening on all interfaces of
 *                        the sidecar — it is attached only to the job's internal
 *                        network and the egress network, never published.
 * Every decision is one JSON line on stdout (target, allowed, reason; no payload).
 */
async function main(): Promise<void> {
  const allow = (process.env.REMYRAL_EGRESS_ALLOW ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map(parseEgressTarget);
  const port = Number(process.env.REMYRAL_EGRESS_PORT ?? '3128');
  const web = process.env.REMYRAL_EGRESS_MODE === 'web';
  const hint = (process.env.REMYRAL_EGRESS_HINT ?? '').trim().slice(0, 500);
  const proxy = await startEgressProxy({
    allow,
    anyPublicHttps: web,
    ...(hint === '' ? {} : { refusalHint: hint }),
    host: '0.0.0.0',
    port,
    onDecision: (d) => {
      process.stdout.write(`${JSON.stringify({ event: 'egress', ...d })}\n`);
    },
  });
  process.stdout.write(
    `${JSON.stringify({ event: 'ready', port: proxy.port, allow: allow.length, mode: web ? 'web' : 'allowlist' })}\n`,
  );
  const stop = (): void => {
    void proxy.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((error: unknown) => {
  process.stderr.write(`egress proxy failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
