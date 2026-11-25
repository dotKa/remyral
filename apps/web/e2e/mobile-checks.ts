import type { Page } from '@playwright/test';

/**
 * p5-mobile layout checks run inside the page (docs/design/p5-mobile.md §3):
 * - no horizontal page scroll (the document is never wider than the viewport; wide content scrolls inside
 *   its own container),
 * - every visible touch target is at least 44 × 44 CSS px (WCAG 2.5.5 / Apple HIG; Material's 48 dp is met
 *   by most controls). A checkbox/radio counts through its enclosing `<label>`. Exempt, as WCAG 2.5.8
 *   allows: links inside running text, disabled controls, and targets inside an element marked
 *   `data-touch-exempt` (with the reason next to it in the code, e.g. the keyboard-only skip link).
 */
export interface MobileIssue {
  readonly kind: 'overflow' | 'target';
  readonly what: string;
  readonly width: number;
  readonly height: number;
}

export const MIN_TARGET = 44;

export async function mobileIssues(page: Page): Promise<MobileIssue[]> {
  return page.evaluate((min) => {
    const out: { kind: 'overflow' | 'target'; what: string; width: number; height: number }[] = [];
    const doc = document.documentElement;
    const vw = doc.clientWidth;
    if (doc.scrollWidth > vw + 1) {
      // Name the widest offenders so a failure points at the culprit.
      const wide: { el: Element; right: number }[] = [];
      for (const el of document.body.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.right > vw + 1 && r.width > 0) {
          let clipped = false;
          for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            const s = getComputedStyle(p);
            if (s.overflowX !== 'visible' && p.getBoundingClientRect().right <= vw + 1) {
              clipped = true;
              break;
            }
          }
          if (!clipped) wide.push({ el, right: r.right });
        }
      }
      const describe = (el: Element) =>
        `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${
          el.getAttribute('data-testid') ? `[data-testid=${String(el.getAttribute('data-testid'))}]` : ''
        } ${el.textContent.trim().slice(0, 40)}`;
      // Deepest offenders first (the parents are wide only because of them).
      const leaves = wide.filter((w) => !wide.some((o) => o.el !== w.el && w.el.contains(o.el)));
      out.push({
        kind: 'overflow',
        what: `document ${String(doc.scrollWidth)}px > ${String(vw)}px: ${leaves
          .slice(0, 3)
          .map((w) => describe(w.el))
          .join(' | ')}`,
        width: doc.scrollWidth,
        height: 0,
      });
    }
    const selector =
      'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=link], [role=checkbox], [role=switch]';
    const seen = new Set<Element>();
    for (const raw of document.querySelectorAll(selector)) {
      // A disabled control is not a target (it cannot be activated).
      if (raw.matches(':disabled')) continue;
      let el: Element = raw;
      if (raw instanceof HTMLInputElement && (raw.type === 'checkbox' || raw.type === 'radio')) {
        el = raw.closest('label') ?? raw;
      }
      if (seen.has(el)) continue;
      seen.add(el);
      if (el.closest('[data-touch-exempt]')) continue;
      if (el.closest('[inert]') || el.closest('[aria-hidden=true]')) continue;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Skip anything not in the scrollable page area (e.g. closed popovers moved off-screen).
      if (r.right < 0 || r.left > vw) continue;
      // Inline links inside running text are exempt (WCAG 2.5.8 "inline" exception).
      if (el.tagName === 'A' && s.display === 'inline') {
        const p = el.parentElement;
        if (
          p &&
          /^(P|LI|SPAN|DD|TD|SMALL)$/.test(p.tagName) &&
          p.textContent.trim() !== el.textContent.trim()
        ) {
          continue;
        }
      }
      if (r.height + 0.5 < min || r.width + 0.5 < min) {
        const label =
          el.getAttribute('aria-label') ??
          (el.textContent.trim().slice(0, 40) || el.getAttribute('name') || '');
        out.push({
          kind: 'target',
          what: `${el.tagName.toLowerCase()}${el.getAttribute('type') ? `[type=${String(el.getAttribute('type'))}]` : ''} "${label}"`,
          width: Math.round(r.width),
          height: Math.round(r.height),
        });
      }
    }
    return out;
  }, MIN_TARGET);
}
