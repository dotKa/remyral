import { HttpError } from '../http/errors.js';
import type { ClientIpHeaderConfig } from '../http/client-ip.js';
import type { SettingValue } from './registry.js';
import type { PanelSettingsService, SectionValidator } from './service.js';

/**
 * p17-panel-settings: small adapters that let existing consumers read a panel setting at use time without changing
 * their types — a live set / list that always reflects the effective value, and the per-section rules.
 */

const bad = (key: string, message: string): never => {
  throw new HttpError(400, 'invalid_panel_setting', message, {}, {}, { key });
};

/** A `ReadonlySet` whose content is the current value of a list setting. */
export class LiveSet implements ReadonlySet<string> {
  #key = '';
  #set = new Set<string>();

  constructor(private readonly read: () => readonly string[]) {}

  #current(): Set<string> {
    const v = this.read();
    const k = v.join('\n');
    if (k !== this.#key) {
      this.#key = k;
      this.#set = new Set(v);
    }
    return this.#set;
  }

  get size(): number {
    return this.#current().size;
  }
  has(value: string): boolean {
    return this.#current().has(value);
  }
  forEach(cb: (value: string, value2: string, set: ReadonlySet<string>) => void, thisArg?: unknown): void {
    for (const v of this.#current()) cb.call(thisArg, v, v, this);
  }
  entries(): SetIterator<[string, string]> {
    return this.#current().entries();
  }
  keys(): SetIterator<string> {
    return this.#current().keys();
  }
  values(): SetIterator<string> {
    return this.#current().values();
  }
  [Symbol.iterator](): SetIterator<string> {
    return this.#current()[Symbol.iterator]();
  }
}

/** A read-only array that always reads the current value of a list setting (spread, map, includes, length …). */
export function liveList(read: () => readonly string[]): readonly string[] {
  return new Proxy([] as string[], {
    get: (_t, p) => {
      const cur = read();
      const v = Reflect.get(cur, p, cur) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(cur) : v;
    },
    has: (_t, p) => Reflect.has(read(), p),
    ownKeys: () => Reflect.ownKeys(read()),
    getOwnPropertyDescriptor: (_t, p) => {
      const d = Reflect.getOwnPropertyDescriptor(read(), p);
      return d === undefined ? undefined : { ...d, configurable: true };
    },
  });
}

export const listOf = (s: PanelSettingsService, key: string): readonly string[] =>
  s.value<readonly string[]>(key) ?? [];

/** The CDN client-IP header configuration in effect (null: none). */
export function networkClientIp(s: PanelSettingsService): ClientIpHeaderConfig | null {
  const header = s.get<string>('net.clientIpHeader', '');
  const sources = listOf(s, 'net.clientIpSources');
  if (header === '' || sources.length === 0) return null;
  return { header, trustedSources: [...sources] };
}

/** TRUSTED_CLIENT_IP_* rules of config.ts, on the values a save would leave. */
export const networkRules: SectionValidator = (get) => {
  const hops = Number(get('net.trustProxyHops') ?? 0);
  const header = String(get('net.clientIpHeader') ?? '');
  const sources = (get('net.clientIpSources') as readonly string[] | null) ?? [];
  if (header !== '' && sources.length === 0)
    bad('net.clientIpSources', 'A client-IP header needs the address ranges it is trusted from.');
  if (header !== '' && hops < 1)
    bad('net.trustProxyHops', 'A client-IP header is set by a proxy: trust at least one proxy hop.');
  if (header === '' && sources.length > 0)
    bad('net.clientIpSources', 'Trusted source ranges only matter with a client-IP header.');
};

/** Remember-me idle ≤ absolute, as config.ts requires. */
export const sessionRules: SectionValidator = (get) => {
  const idle = Number(get('auth.rememberIdleDays') ?? 0);
  const abs = Number(get('auth.rememberAbsoluteDays') ?? 0);
  if (idle > 0 && abs > 0 && idle > abs)
    bad('auth.rememberIdleDays', 'The idle limit cannot be longer than the absolute limit.');
};

/** Engine 2 for version-1 workflows needs engine 2. */
export const workflowRules: SectionValidator = (get) => {
  if (get('workflow.engineV2ForV1') === true && get('workflow.engineV2') !== true)
    bad('workflow.engineV2ForV1', 'Version-1 workflows can move to engine 2 only while engine 2 is on.');
};

/** A webhook allowlist needs the signing secret (and the reverse is harmless). */
export const notificationRules: SectionValidator = (get, has) => {
  const allow = (get('notify.webhook.allowlist') as readonly string[] | null) ?? [];
  if (allow.length > 0 && !has('notify.webhook.secret'))
    bad('notify.webhook.secret', 'Webhooks need a signing secret: generate one.');
};

/** The HTTP search provider needs its URL, model and key together. */
export const searchRules: SectionValidator = (get, has) => {
  if (get('search.provider') !== 'http') return;
  if ((get('search.http.url') ?? '') === '') bad('search.http.url', 'The HTTP provider needs its URL.');
  if ((get('search.http.model') ?? '') === '') bad('search.http.model', 'The HTTP provider needs a model.');
  if (!has('search.http.key')) bad('search.http.key', 'The HTTP provider needs its API key.');
};

export type { SettingValue };
