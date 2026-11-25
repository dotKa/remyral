import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isNonPublicAddress } from './http.js';
import { isLinkLocalAddress } from './web-fetch.js';

/**
 * The egress rule for the master's own `git ls-remote` calls (lost-attempt inspector, repository preflight): the
 * repository URL comes from a project, so before git runs, the host is resolved and every address must be public —
 * the same rule as the guarded HTTP clients (`./http.ts`, `./web-fetch.ts`). An operator-listed internal origin
 * (`ops.internalOrigins`, e.g. a self-managed GitLab on the private network) may be private, never link-local.
 *
 * For https the checked address is pinned for git's HTTP client (`http.curloptResolve`), so a second DNS answer
 * cannot point the connection elsewhere, and redirects are not followed (`http.followRedirects=false`).
 */

export type HostResolver = (host: string) => Promise<readonly string[]>;

export const dnsResolver: HostResolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export type GitEgressVerdict =
  { readonly ok: true; readonly gitConfig: readonly string[] } | { readonly ok: false; readonly why: string };

function isInternal(url: URL, internalOrigins: ReadonlySet<string> | undefined): boolean {
  if (internalOrigins === undefined) return false;
  if (url.protocol === 'https:') return internalOrigins.has(url.origin);
  // ssh: the host of a listed origin (its scheme and port are those of the web/API endpoint).
  const host = url.hostname.toLowerCase();
  for (const o of internalOrigins) {
    try {
      if (new URL(o).hostname.toLowerCase() === host) return true;
    } catch {
      // not an origin: ignored
    }
  }
  return false;
}

/** Checks the host of an `https:` / `ssh:` repository URL; on success, the `-c` arguments that pin it for git. */
export async function checkGitRemote(
  url: URL,
  opts: { readonly internalOrigins?: ReadonlySet<string>; readonly resolve?: HostResolver } = {},
): Promise<GitEgressVerdict> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === '') return { ok: false, why: 'no host' };
  const internal = isInternal(url, opts.internalOrigins);
  let addresses: readonly string[];
  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      addresses = await (opts.resolve ?? dnsResolver)(host);
    } catch {
      return { ok: false, why: 'host does not resolve' };
    }
  }
  if (addresses.length === 0) return { ok: false, why: 'host does not resolve' };
  if (addresses.some((a) => (internal ? isLinkLocalAddress(a) : isNonPublicAddress(a)))) {
    return { ok: false, why: 'host address not allowed' };
  }
  const gitConfig: string[] = [];
  if (url.protocol === 'https:') {
    gitConfig.push('-c', 'http.followRedirects=false');
    if (isIP(host) === 0) {
      const first = addresses[0] ?? '';
      const port = url.port === '' ? '443' : url.port;
      const addr = isIP(first) === 6 ? `[${first}]` : first;
      gitConfig.push('-c', `http.curloptResolve=${host}:${port}:${addr}`);
    }
  }
  return { ok: true, gitConfig };
}
