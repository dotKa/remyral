import { fireEvent, screen, within } from '@testing-library/react';

/**
 * p15-chat-cards-scroll: a turn's cards sit collapsed in a strip under its answer. Opens the strip card titled `name`
 * (its toggle "Kartı aç: <title>", or "Open the card: <title>" in English) and returns the full card (`article`).
 */
export async function openStripCard(
  name: string | RegExp,
  opts: { readonly scope?: HTMLElement; readonly en?: boolean } = {},
): Promise<HTMLElement> {
  const scope = opts.scope ?? (await screen.findByRole('log'));
  const prefix = opts.en === true ? 'Open the card: ' : 'Kartı aç: ';
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern =
    typeof name === 'string'
      ? new RegExp(`^${esc(prefix)}${esc(name)}$`)
      : new RegExp(`^${esc(prefix)}(?:${name.source.replace(/^\^/, '')})`, name.flags);
  const toggle = await within(scope).findByRole('button', { name: pattern });
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
  const strip = toggle.closest<HTMLElement>('[data-testid="card-strip"]') ?? scope;
  const panel = await within(strip).findByTestId('strip-panel');
  return within(panel).findByRole('article', { name });
}
