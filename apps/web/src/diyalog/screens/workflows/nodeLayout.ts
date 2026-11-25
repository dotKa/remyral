/**
 * p17-workflow-canvas (docs/design/p17-workflow-canvas.md §1): the geometry of a workflow card — pure, no React, no
 * DOM. The card is laid out in zones so the port labels, the title, the subtitle and the badges never overlap:
 *
 *   ┌───────────── family band ──────────────┐
 *   │ [icon] title ………………………… [gate][issues] │  header (icon chip, title, subtitle, badges)
 *   │        subtitle …………………………          │
 *   ├────────────────────────────────────────┤
 *   ● in                               out ●  │  port rows (one per port; a side's lone unlabelled port
 *   ● context                        error ●  │  sits in the middle of the zone)
 *   └────────────────────────────────────────┘
 *
 * Left → right: inputs on the left edge, outputs on the right, one row each; the card grows in height with the
 * number of ports and in width with its longest label (between CARD_MIN_W and CARD_MAX_W; beyond, the text is cut
 * with an ellipsis and the full text is the tooltip). Top → bottom: inputs along the top edge, outputs along the
 * bottom, one slot each. A group (forEach / loop) keeps its ports beside its header so its body starts below it.
 * Text widths are estimated generously from the font sizes; the card draws every text clipped to its box, so a
 * wider glyph run is cut, never drawn over a neighbour. The handles (and so the edge anchors) sit on the port rows.
 */

export const CARD_MIN_W = 232;
export const CARD_MAX_W = 360;
export const CARD_MIN_H = 76;
/** The family band on top of the card. */
export const BAND = 4;
const PAD_X = 12;
/** The icon chip. */
const CHIP = 24;
const TITLE_H = 20;
const SUB_H = 18;
/** Title + gap + subtitle. */
const HEADER_BLOCK = TITLE_H + 2 + SUB_H;
/** The header zone of a card with port rows (band + padding + title + subtitle + padding). */
export const HEADER_ZONE = BAND + 8 + HEADER_BLOCK + 8;
export const ROW_H = 20;
const ROWS_PAD_TOP = 4;
const ROWS_PAD_BOTTOM = 8;
const LABEL_H = 14;
/** From a side edge to its label (half a handle + a gap). */
const LABEL_INSET = 12;
/** Between an input's and an output's label on the same row. */
const GUTTER = 12;
/** A group's `item` handle sits inside its left edge. */
const INNER_X = 10;
/** Top → bottom: the strip of port labels under the top edge / above the bottom edge. */
const STRIP = 24;

export type LayoutDir = 'LR' | 'TB';
export type PortSide = 'in' | 'out' | 'inner';

export interface LayoutPort {
  readonly name: string;
  readonly label: string;
}

export interface LayoutInput {
  readonly title: string;
  readonly subtitle: string;
  readonly ports?:
    | {
        readonly in: readonly LayoutPort[];
        readonly out: readonly LayoutPort[];
        readonly inner?: readonly LayoutPort[];
      }
    | undefined;
  readonly dir: LayoutDir;
  readonly gate?: boolean;
  /** The issue count badge (0: none). */
  readonly issues?: number;
  readonly group?: boolean;
  /** A role icon before the subtitle (v1 AI steps). */
  readonly subtitleIcon?: boolean;
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface PortPlace {
  readonly name: string;
  readonly side: PortSide;
  /** The handle's centre (the edge anchor), relative to the card's top-left corner. */
  readonly x: number;
  readonly y: number;
  /** The label's box (null: the port shows no label). */
  readonly label: Box | null;
  readonly align: 'start' | 'end' | 'center';
  /** The label is longer than its box (drawn cut, the full name as tooltip). */
  readonly truncated: boolean;
}

export interface CardLayout {
  readonly w: number;
  readonly h: number;
  readonly chip: Box;
  readonly title: Box;
  readonly subtitle: Box;
  /** The badges (gate shield, issue count) right of the title; null without badges. */
  readonly badges: Box | null;
  readonly titleTruncated: boolean;
  readonly subtitleTruncated: boolean;
  readonly ports: readonly PortPlace[];
}

/** A generous estimate of a text's width in px (Inter / JetBrains Mono at `px`). */
export function textWidth(text: string, px: number, mono = false): number {
  let units = 0;
  for (const ch of text) {
    if (mono) units += 0.62;
    else if (/[mwMWĞŞ@%]/.test(ch)) units += 0.86;
    else if (/[A-ZÇÖÜİ0-9]/.test(ch)) units += 0.68;
    else if (/[iljtfrı.,:;'|!·\s]/.test(ch)) units += 0.36;
    else units += 0.58;
  }
  return Math.ceil(units * px) + 2;
}

const LABEL_PX = 10;
const TITLE_PX = 13;
const SUB_PX = 12;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function badgesWidth(input: LayoutInput): number {
  const issues = input.issues ?? 0;
  const parts = [
    ...(input.gate === true ? [16] : []),
    ...(issues > 0 ? [12 + textWidth(String(issues), 11, true)] : []),
  ];
  return parts.length === 0 ? 0 : parts.reduce((a, b) => a + b, 0) + (parts.length - 1) * 4;
}

/** What the header needs (chip, title + badges, subtitle). */
function headerNeed(input: LayoutInput): number {
  const b = badgesWidth(input);
  const title = textWidth(input.title, TITLE_PX, true) + (b > 0 ? b + 4 : 0);
  const sub = textWidth(input.subtitle, SUB_PX) + (input.subtitleIcon === true ? 20 : 0);
  return PAD_X + CHIP + 8 + Math.max(title, sub) + PAD_X;
}

/** A side shows rows when one of its ports has a label (a lone unlabelled `in` / `out` does not). */
const labelled = (ports: readonly LayoutPort[]): boolean => ports.some((p) => p.label !== '');
const widest = (ports: readonly LayoutPort[]): number =>
  Math.max(0, ...ports.filter((p) => p.label !== '').map((p) => textWidth(p.label, LABEL_PX)));

/** Splits `room` between two label columns: each keeps its need when it fits, else at least half. */
function split(room: number, a: number, b: number): [number, number] {
  if (a + b <= room) return [a, b];
  const half = room / 2;
  if (a <= half) return [a, room - a];
  if (b <= half) return [room - b, b];
  return [half, half];
}

interface Header {
  readonly chip: Box;
  readonly title: Box;
  readonly subtitle: Box;
  readonly badges: Box | null;
}

function header(input: LayoutInput, left: number, right: number, top: number): Header {
  const b = badgesWidth(input);
  const textX = left + CHIP + 8;
  const textW = Math.max(0, right - textX);
  const badges = b === 0 ? null : { x: right - b, y: top, w: b, h: TITLE_H };
  return {
    chip: { x: left, y: top + (HEADER_BLOCK - CHIP) / 2, w: CHIP, h: CHIP },
    title: { x: textX, y: top, w: Math.max(0, textW - (b === 0 ? 0 : b + 4)), h: TITLE_H },
    subtitle: { x: textX, y: top + TITLE_H + 2, w: textW, h: SUB_H },
    badges,
  };
}

function finish(
  input: LayoutInput,
  w: number,
  h: number,
  head: Header,
  ports: readonly PortPlace[],
): CardLayout {
  return {
    w,
    h,
    ...head,
    titleTruncated: textWidth(input.title, TITLE_PX, true) > head.title.w,
    subtitleTruncated:
      textWidth(input.subtitle, SUB_PX) + (input.subtitleIcon === true ? 20 : 0) > head.subtitle.w,
    ports,
  };
}

/** Rows of one side (left → right): a lone unlabelled port in the middle of the zone, else one row per port. */
function sideRows(
  ports: readonly LayoutPort[],
  side: PortSide,
  zoneTop: number,
  zoneRows: number,
  x: number,
  labelX: (w: number) => number,
  room: number,
  firstRow = 0,
): PortPlace[] {
  if (ports.length === 1 && !labelled(ports) && side !== 'inner') {
    const only = ports[0];
    return only === undefined
      ? []
      : [
          {
            name: only.name,
            side,
            x,
            y: zoneTop + ROWS_PAD_TOP + (zoneRows * ROW_H) / 2,
            label: null,
            align: side === 'out' ? 'end' : 'start',
            truncated: false,
          },
        ];
  }
  return ports.map((p, i) => {
    const cy = zoneTop + ROWS_PAD_TOP + (firstRow + i) * ROW_H + ROW_H / 2;
    const need = p.label === '' ? 0 : textWidth(p.label, LABEL_PX);
    const lw = Math.min(need, room);
    return {
      name: p.name,
      side,
      x,
      y: cy,
      label: p.label === '' ? null : { x: labelX(lw), y: cy - LABEL_H / 2, w: lw, h: LABEL_H },
      align: side === 'out' ? 'end' : 'start',
      truncated: need > room,
    };
  });
}

/**
 * The card's size and every box in it. `size`: a size the caller fixes (a group around its body); the card is never
 * smaller than its content needs (min / max width apply to plain cards).
 */
export function cardLayout(
  input: LayoutInput,
  size?: { readonly w: number; readonly h: number },
): CardLayout {
  const ins = input.ports?.in ?? [{ name: 'in', label: '' }];
  const outs = input.ports?.out ?? [{ name: 'out', label: '' }];
  const inner = input.ports?.inner ?? [];
  if (input.group === true) return groupLayout(input, ins, outs, inner, size);
  return input.dir === 'TB' ? tbLayout(input, ins, outs, size) : lrLayout(input, ins, outs, size);
}

function lrLayout(
  input: LayoutInput,
  ins: readonly LayoutPort[],
  outs: readonly LayoutPort[],
  size?: { readonly w: number; readonly h: number },
): CardLayout {
  const inL = labelled(ins);
  const outL = labelled(outs);
  const inW = widest(ins);
  const outW = widest(outs);
  const portsNeed = LABEL_INSET * 2 + inW + outW + (inL && outL ? GUTTER : 0);
  const w = Math.max(size?.w ?? 0, clamp(Math.max(headerNeed(input), portsNeed), CARD_MIN_W, CARD_MAX_W));
  const rows = Math.max(inL ? ins.length : 0, outL ? outs.length : 0);
  if (rows === 0) {
    // Compact: no port labels — the header in the middle, the handles at the card's middle height.
    const h = Math.max(size?.h ?? 0, CARD_MIN_H);
    const top = BAND + (h - BAND - HEADER_BLOCK) / 2;
    const head = header(input, PAD_X, w - PAD_X, top);
    const mid = (h + BAND) / 2;
    const place = (ps: readonly LayoutPort[], side: PortSide, x: number): PortPlace[] =>
      ps.map((p, i) => ({
        name: p.name,
        side,
        x,
        y: ps.length === 1 ? mid : BAND + ((h - BAND) * (i + 1)) / (ps.length + 1),
        label: null,
        align: side === 'out' ? 'end' : 'start',
        truncated: false,
      }));
    return finish(input, w, h, head, [...place(ins, 'in', 0), ...place(outs, 'out', w)]);
  }
  const h = Math.max(size?.h ?? 0, HEADER_ZONE + ROWS_PAD_TOP + rows * ROW_H + ROWS_PAD_BOTTOM);
  const head = header(input, PAD_X, w - PAD_X, BAND + 8);
  const room = w - LABEL_INSET * 2 - (inL && outL ? GUTTER : 0);
  const [inRoom, outRoom] = inL && outL ? split(room, inW, outW) : [room, room];
  return finish(input, w, h, head, [
    ...sideRows(ins, 'in', HEADER_ZONE, rows, 0, () => LABEL_INSET, inRoom),
    ...sideRows(outs, 'out', HEADER_ZONE, rows, w, (lw) => w - LABEL_INSET - lw, outRoom),
  ]);
}

function tbLayout(
  input: LayoutInput,
  ins: readonly LayoutPort[],
  outs: readonly LayoutPort[],
  size?: { readonly w: number; readonly h: number },
): CardLayout {
  const inL = labelled(ins);
  const outL = labelled(outs);
  const slotNeed = (ps: readonly LayoutPort[]): number => ps.length * (widest(ps) + 10);
  const w = Math.max(
    size?.w ?? 0,
    clamp(Math.max(headerNeed(input), slotNeed(ins), slotNeed(outs)), CARD_MIN_W, CARD_MAX_W),
  );
  const top = inL ? STRIP : BAND + 8;
  const bottom = outL ? STRIP : 8;
  const h = Math.max(size?.h ?? 0, CARD_MIN_H, top + HEADER_BLOCK + bottom);
  const headTop = top + (h - top - bottom - HEADER_BLOCK) / 2;
  const head = header(input, PAD_X, w - PAD_X, headTop);
  const slots = (ps: readonly LayoutPort[], side: PortSide, y: number, labelY: number): PortPlace[] => {
    const slot = w / ps.length;
    return ps.map((p, i) => {
      const cx = slot * (i + 0.5);
      const need = p.label === '' ? 0 : textWidth(p.label, LABEL_PX);
      const room = Math.max(0, slot - 10);
      const lw = Math.min(need, room);
      return {
        name: p.name,
        side,
        x: cx,
        y,
        label: p.label === '' ? null : { x: cx - lw / 2, y: labelY, w: lw, h: LABEL_H },
        align: 'center',
        truncated: need > room,
      };
    });
  };
  return finish(input, w, h, head, [
    ...slots(ins, 'in', 0, BAND + 6),
    ...slots(outs, 'out', h, h - 6 - LABEL_H),
  ]);
}

/** A group: its ports in columns beside the header (inputs, then the inner `item`, left; outputs right). */
function groupLayout(
  input: LayoutInput,
  ins: readonly LayoutPort[],
  outs: readonly LayoutPort[],
  inner: readonly LayoutPort[],
  size?: { readonly w: number; readonly h: number },
): CardLayout {
  const leftW = Math.max(widest(ins), inner.length === 0 ? 0 : widest(inner) + (INNER_X + 8 - LABEL_INSET));
  const rightW = widest(outs);
  const leftCol = leftW === 0 ? PAD_X : LABEL_INSET + leftW + 8;
  const rightCol = rightW === 0 ? PAD_X : LABEL_INSET + rightW + 8;
  const w = Math.max(size?.w ?? 0, leftCol + headerNeed(input) - 2 * PAD_X + rightCol, CARD_MIN_W);
  const leftRows = ins.length + inner.length;
  const rows = Math.max(leftRows, outs.length);
  const headH = Math.max(BAND + 8 + HEADER_BLOCK + 8, BAND + ROWS_PAD_TOP + rows * ROW_H + ROWS_PAD_BOTTOM);
  const h = Math.max(size?.h ?? 0, headH);
  const head = header(input, leftCol, w - rightCol, BAND + 8);
  const column = (
    ps: readonly LayoutPort[],
    side: PortSide,
    x: number,
    labelX: (lw: number) => number,
    room: number,
    first: number,
  ): PortPlace[] =>
    ps.map((p, i) => {
      const cy = BAND + ROWS_PAD_TOP + (first + i) * ROW_H + ROW_H / 2;
      const need = p.label === '' ? 0 : textWidth(p.label, LABEL_PX);
      const lw = Math.min(need, room);
      return {
        name: p.name,
        side,
        x,
        y: cy,
        label: p.label === '' ? null : { x: labelX(lw), y: cy - LABEL_H / 2, w: lw, h: LABEL_H },
        align: side === 'out' ? 'end' : 'start',
        truncated: need > room,
      };
    });
  return finish(input, w, h, head, [
    ...column(ins, 'in', 0, () => LABEL_INSET, leftCol - LABEL_INSET - 8, 0),
    ...column(inner, 'inner', INNER_X, () => INNER_X + 8, Math.max(0, leftCol - INNER_X - 16), ins.length),
    ...column(outs, 'out', w, (lw) => w - LABEL_INSET - lw, rightCol - LABEL_INSET - 8, 0),
  ]);
}

/** The drawn size of a card (what the layout and React Flow get). */
export function cardSize(
  input: LayoutInput,
  size?: { readonly w: number; readonly h: number },
): {
  readonly w: number;
  readonly h: number;
} {
  const l = cardLayout(input, size);
  return { w: l.w, h: l.h };
}

/** The header height of a group (its body starts below it: see GROUP_PAD in layout.ts). */
export function groupHeaderHeight(input: LayoutInput): number {
  const l = cardLayout({ ...input, group: true });
  const lowest = Math.max(
    l.subtitle.y + l.subtitle.h,
    ...l.ports.map((p) => (p.label === null ? p.y + 6 : p.label.y + p.label.h)),
  );
  return lowest;
}

const overlaps = (a: Box, b: Box): boolean =>
  a.w > 0 &&
  a.h > 0 &&
  b.w > 0 &&
  b.h > 0 &&
  a.x < b.x + b.w &&
  b.x < a.x + a.w &&
  a.y < b.y + b.h &&
  b.y < a.y + a.h;

/**
 * Every pair of boxes that overlap in a layout (title, subtitle, badges, chip, port labels) plus the boxes outside
 * the card — empty for a good layout (the tests check every catalog node with it).
 */
export function layoutProblems(l: CardLayout): string[] {
  const boxes: [string, Box][] = [
    ['chip', l.chip],
    ['title', l.title],
    ['subtitle', l.subtitle],
    ...(l.badges === null ? [] : ([['badges', l.badges]] as [string, Box][])),
    ...l.ports.flatMap((p): [string, Box][] =>
      p.label === null ? [] : [[`port:${p.side}:${p.name}`, p.label]],
    ),
  ];
  const out: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const [an, a] = boxes[i] ?? ['', l.chip];
    if (a.x < 0 || a.y < 0 || a.x + a.w > l.w + 0.5 || a.y + a.h > l.h + 0.5) out.push(`${an} outside`);
    for (let j = i + 1; j < boxes.length; j++) {
      const [bn, b] = boxes[j] ?? ['', l.chip];
      if (overlaps(a, b)) out.push(`${an} × ${bn}`);
    }
  }
  // Handles (12 px) of one side must not overlap each other either.
  const handles = l.ports.map((p) => ({
    name: p.name,
    side: p.side,
    box: { x: p.x - 6, y: p.y - 6, w: 12, h: 12 },
  }));
  for (let i = 0; i < handles.length; i++)
    for (let j = i + 1; j < handles.length; j++) {
      const a = handles[i];
      const b = handles[j];
      if (a !== undefined && b !== undefined && overlaps(a.box, b.box))
        out.push(`handle ${a.name} × ${b.name}`);
    }
  return out;
}
