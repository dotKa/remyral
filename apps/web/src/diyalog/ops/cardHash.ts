import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { CARD_HASH_PREFIX } from './anchors';
import { focusCard } from './keys';

/**
 * p12-diyalog Faz 4: "thread'de aç" from a secondary screen lands on `/needs#kart=<card key>` (`approval:<id>`,
 * `deploy:<id>`, …; p17-needs-page: the decisions page — `/#kart=…` from before is sent on there by the shell). Once
 * that card is on the page (the first page may still be loading) it is brought into view and focused — without
 * animation, like the j / k keys. A card that never shows up (decided long ago, older than the first page) leaves the
 * page as it is; the wait ends after 8 s.
 */
export { CARD_HASH_PREFIX };

export function cardKeyFromHash(hash: string): string | null {
  if (!hash.startsWith(CARD_HASH_PREFIX)) return null;
  try {
    const key = decodeURIComponent(hash.slice(CARD_HASH_PREFIX.length));
    return key === '' ? null : key;
  } catch {
    return null;
  }
}

function find(key: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>('[data-card]')].find((e) => e.dataset.card === key) ?? null
  );
}

export function useCardHash(): void {
  const { hash } = useLocation();
  useEffect(() => {
    const key = cardKeyFromHash(hash);
    if (key === null) return;
    const land = (el: HTMLElement): void => {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      focusCard(el);
    };
    const now = find(key);
    if (now !== null) {
      land(now);
      return;
    }
    const obs = new MutationObserver(() => {
      const el = find(key);
      if (el === null) return;
      obs.disconnect();
      land(el);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    const t = setTimeout(() => {
      obs.disconnect();
    }, 8_000);
    return () => {
      obs.disconnect();
      clearTimeout(t);
    };
  }, [hash]);
}
