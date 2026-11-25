/**
 * p17-domain-wizard (docs/design/p17-domain-wizard.md §2): the console's public origin as consumers read it.
 *
 * The effective origin is the owner's stored setting (Kurulum sihirbazı → Alan adı ve erişim), else the environment
 * (PUBLIC_ORIGIN, else the origin of NOTIFY_PUBLIC_URL). Services that build links take an {@link OriginInput}: a fixed
 * string (tests, the release-import CLI) or a live {@link OriginSource} (the master), read at the moment a link is
 * built — so a saved origin is used immediately, without a restart.
 */
export interface OriginSource {
  /** The effective public origin (`https://host[:port]`, no trailing slash), or null when none is known. */
  current(): string | null;
}

export type OriginInput = string | null | undefined | OriginSource;

/** The origin of an input right now. */
export function originOf(o: OriginInput): string | null {
  if (o === undefined || o === null) return null;
  if (typeof o === 'string') return o;
  return o.current();
}

/** Lower-case host name of an origin; null when absent or not a URL. */
export function hostOfOrigin(origin: string | null): string | null {
  if (origin === null) return null;
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}
