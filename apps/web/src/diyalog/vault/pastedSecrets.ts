import {
  detectSecrets,
  pastedSecretToken,
  replaceFindings,
  removedSecretToken,
  type SecretProvider,
} from '@remyral/protocol/chat-secrets';

/**
 * p15-chat-vault (docs/design/p15-chat-vault.md §3): secrets pasted into the Sohbet composer, held **in this tab's
 * memory only** — never in storage, never in a request. The composer replaces each value with a
 * `{{secret:pasted-N:provider}}` token before anything leaves the page; "Kasaya kaydet" (inline, or the assistant's
 * card later in the same tab) takes the value from here, seals it to the machines' vault keys and forgets it. A value is
 * kept for 30 minutes at most.
 */

export interface PastedSecret {
  readonly handle: string;
  readonly value: string;
  readonly provider: SecretProvider;
  readonly subscription: boolean;
  readonly at: number;
}

const TTL_MS = 30 * 60_000;
const store = new Map<string, PastedSecret>();
let next = 1;

function sweep(now: number): void {
  for (const [k, v] of store) if (now - v.at > TTL_MS) store.delete(k);
}

/** Keeps `value` (the same value keeps its handle) and returns its handle `pasted-N`. */
export function rememberSecret(value: string, provider: SecretProvider, subscription = false): string {
  const now = Date.now();
  sweep(now);
  for (const s of store.values()) if (s.value === value) return s.handle;
  const handle = `pasted-${String(next)}`;
  next = next >= 9999 ? 1 : next + 1;
  store.set(handle, { handle, value, provider, subscription, at: now });
  return handle;
}

export function pastedSecret(handle: string): PastedSecret | undefined {
  sweep(Date.now());
  return store.get(handle);
}

export function forgetSecret(handle: string): void {
  store.delete(handle);
}

/** Tests: start with an empty store. */
export function resetPastedSecrets(): void {
  store.clear();
  next = 1;
}

/**
 * `text` with every secret-looking value replaced by its token (subscription tokens by a removed token: they are never
 * kept). `pasted`: the text is one paste (a single random token counts too).
 */
export function protectText(
  text: string,
  opts: { readonly pasted?: boolean } = {},
): { readonly text: string; readonly secrets: readonly PastedSecret[]; readonly removed: number } {
  const found = detectSecrets(text, opts);
  if (found.length === 0) return { text, secrets: [], removed: 0 };
  const secrets: PastedSecret[] = [];
  let removed = 0;
  const out = replaceFindings(text, found, (f) => {
    if (f.subscription) {
      removed += 1;
      return removedSecretToken('subscription');
    }
    const handle = rememberSecret(f.value, f.provider);
    const s = store.get(handle);
    if (s !== undefined && !secrets.includes(s)) secrets.push(s);
    return pastedSecretToken(handle, f.provider);
  });
  return { text: out, secrets, removed };
}
