// p14-diyalog-polish (docs/design/p14-diyalog-polish.md): the token contrast floor in both themes, the one finish of
// the native form controls (scoped to Diyalog surfaces), solid-button hover / disabled states, the rail labels that
// wrap instead of being cut, and the row hover wash that never repaints a selected row.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Row, Rows } from '../src/diyalog/screens/parts';

const css = readFileSync(join(__dirname, '../src/diyalog/diyalog.css'), 'utf8');

function tokens(block: string): Record<string, string> {
  return Object.fromEntries(
    [...block.matchAll(/--dy-([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1] ?? '', m[2] ?? '']),
  );
}
const light = tokens(/\[data-ui='diyalog'\] \{([^}]*)\}/.exec(css)?.[1] ?? '');
const darkMedia = tokens(
  /\[data-ui='diyalog'\]:not\(\[data-theme='light'\]\) \{([^}]*)\}/.exec(css)?.[1] ?? '',
);
const darkAttr = tokens(/\[data-ui='diyalog'\]\[data-theme='dark'\] \{([^}]*)\}/.exec(css)?.[1] ?? '');

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}
function contrast(a: string | undefined, b: string | undefined): number {
  const x = luminance(a ?? '#000000');
  const y = luminance(b ?? '#000000');
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe('token contrast (WCAG AA)', () => {
  it('both dark blocks declare the same values', () => {
    expect(Object.keys(darkMedia).length).toBeGreaterThan(20);
    expect(darkAttr).toEqual(darkMedia);
  });

  for (const [name, t] of [
    ['light', light],
    ['dark', darkMedia],
  ] as const) {
    it(`${name}: text tokens reach 4.5:1 on every surface they sit on`, () => {
      for (const fg of ['ink', 'muted', 'faint'])
        for (const bg of ['bg', 'thread', 'card', 'sunk'])
          expect(contrast(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      // Meaning colours used as text on the card, and the on-fill text of solid buttons.
      for (const fg of ['teal', 'amber', 'red', 'green', 'violet'])
        expect(contrast(t[fg], t.card), `${fg} on card`).toBeGreaterThanOrEqual(4.5);
      for (const fill of ['teal', 'amber', 'red'])
        expect(contrast(t['on-fill'], t[fill]), `on-fill on ${fill}`).toBeGreaterThanOrEqual(4.5);
      for (const [fg, bg] of [
        ['teal-ink', 'teal-soft'],
        ['amber-ink', 'amber-soft'],
        ['red-ink', 'red-soft'],
      ] as const)
        expect(contrast(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    });

    it(`${name}: a form field's boundary reaches 3:1 (WCAG 1.4.11)`, () => {
      expect(contrast(t.field, t.card)).toBeGreaterThanOrEqual(3);
    });
  }
});

describe('one finish for controls', () => {
  const unlayered = css.slice(
    css.indexOf('*/', css.indexOf('p14-diyalog-polish (docs/design/p14-diyalog-polish.md)')) + 2,
    css.indexOf('@keyframes dy-breathe'),
  );

  it('every new rule is scoped to Diyalog (the classic console and "Klasik görünüm" never match)', () => {
    const code = unlayered.replace(/\/\*[\s\S]*?\*\//g, '');
    // A selector is the text between the previous `{`, `}` or `;` and the next `{`.
    const selectors = [...code.matchAll(/(?:^|[{};])([^{};]+)\{/g)]
      .map((m) => (m[1] ?? '').trim())
      .filter((s) => !s.startsWith('@'));
    expect(selectors.length).toBeGreaterThan(5);
    for (const s of selectors) expect(s.startsWith("[data-ui='diyalog']"), s).toBe(true);
  });

  it('fields are re-bordered and get a focus halo only on Diyalog surfaces; borderless and invalid ones are left alone', () => {
    expect(unlayered).toMatch(/\.dy-surface\s*:is\([^)]*input:not/);
    expect(unlayered).toContain("[class~='border-0']");
    expect(unlayered).toContain("[aria-invalid='true']");
    expect(unlayered).toMatch(/:focus \{\s*outline: none;\s*border-color: var\(--dy-teal\);\s*box-shadow/);
    expect(unlayered).toMatch(/select:not\(\[multiple\], \[size\]\) \{[^}]*appearance: none/);
    expect(unlayered).toContain('::file-selector-button');
  });

  it('solid buttons answer the pointer (hover-capable devices only) and read as unavailable when disabled', () => {
    expect(unlayered).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\) \{\s*\[data-ui='diyalog'\] \.dy-press\[class~='bg-dy-ink'\]/,
    );
    expect(unlayered).toMatch(
      /:disabled:not\(\s*\[aria-busy='true'\]\s*\) \{[^}]*background-color: var\(--dy-sunk\)/,
    );
  });
});

describe('row hover', () => {
  it('a plain row gets the pointer wash; a row the caller paints (selected) keeps its colour', () => {
    render(
      <Rows label="Liste">
        <Row testId="plain" title="Bir" />
        <Row testId="selected" title="İki" className="bg-dy-teal-soft/60" />
      </Rows>,
    );
    expect(screen.getByTestId('plain').className).toContain('hover:bg-dy-sunk/60');
    expect(screen.getByTestId('selected').className).not.toContain('hover:bg-dy-sunk');
  });
});
