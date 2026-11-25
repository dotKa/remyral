import type { ReactNode } from 'react';
import logoOnDark from '../assets/brand/logo-on-dark.png';
import logoOnLight from '../assets/brand/logo-on-light.png';
import symbol from '../assets/brand/symbol.png';
import { cx } from '../components/ui';

/**
 * p17-remyral-brand (docs/design/p17-remyral-rebrand.md, "Brand assets"): the Remyral marks of the console, from the
 * approved colour PNGs (scripts/brand-assets.mjs).
 *
 * - {@link BrandLogo} — the lock-up (colour symbol + wordmark): navy wordmark on light, white wordmark on dark. Both
 *   images are in the page; the theme rule in diyalog.css (`.dy-logo-on-light` / `.dy-logo-on-dark`) shows one, so it
 *   follows `prefers-color-scheme` and a `data-theme` override alike. The hidden one is `display: none` (not read).
 * - {@link BrandSymbol} — the colour symbol on its Deep Navy tile, like the app icon (the rail's home link, the
 *   assistant's avatar).
 */
const RATIO = 612 / 144;

export function BrandLogo(props: {
  /** Rendered height in px (the brand's minimum on screen is 120 px wide ≈ 28 px high). */
  readonly height?: number;
  /** Accessible name; empty when the product name is also written next to it. */
  readonly alt: string;
  readonly className?: string | undefined;
}): ReactNode {
  const h = Math.max(props.height ?? 28, 28);
  const w = Math.round(h * RATIO);
  return (
    <span className={cx('inline-flex shrink-0', props.className)} data-testid="dy-brand-logo">
      <img
        src={logoOnLight}
        width={w}
        height={h}
        alt={props.alt}
        decoding="async"
        data-brand=""
        className="dy-logo-on-light block"
      />
      <img
        src={logoOnDark}
        width={w}
        height={h}
        alt={props.alt}
        decoding="async"
        data-brand=""
        className="dy-logo-on-dark block"
      />
    </span>
  );
}

export function BrandSymbol(props: {
  /** Tile size class (`size-9`, `size-8`); the symbol fills ~64 % of it. */
  readonly className?: string | undefined;
}): ReactNode {
  return (
    <span
      aria-hidden="true"
      className={cx('grid place-items-center rounded-[10px] bg-dy-brand-tile', props.className)}
    >
      <img src={symbol} alt="" decoding="async" data-brand="" className="block h-[64%] w-auto" />
    </span>
  );
}
