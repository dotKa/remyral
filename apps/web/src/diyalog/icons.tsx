import type { ReactNode } from 'react';

/**
 * p12-diyalog: the mockup's 24-unit stroke icon set (docs/design/redesign/diyalog-mockup.html `<symbol>`s), inline
 * (no sprite, no icon font, no CDN). Decorative: hidden from assistive tech — the text next to an icon carries the
 * meaning.
 */
const PATHS = {
  shield: ['M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z', 'M12 8v4M12 15.5h.01'],
  rocket: ['M5 15c-1.5 1.5-2 4-2 6 2 0 4.5-.5 6-2', 'M9 15l-3-3c1.5-5 6-9 14-9 0 8-4 12.5-9 14z'],
  merge: ['M6 7v10M6 7c0 4 4 5 10 5'], // i18n-ignore: SVG path data
  xc: ['M9 9l6 6M15 9l-6 6'],
  pause: ['M10 9v6M14 9v6'], // i18n-ignore: SVG path data
  check: ['M5 12.5l4.5 4.5L19 7'],
  checkc: ['M8 12.5l3 3 5-6'],
  clock: ['M12 7v5l3 2'], // i18n-ignore: SVG path data
  copy: ['M16 8V4H4v12h4'], // i18n-ignore: SVG path data
  send: ['M4 12l16-8-6 16-2.5-6.5z', 'M11.5 13.5L20 4'],
  chev: ['M6 9l6 6 6-6'],
  back: ['M15 6l-6 6 6 6'],
  globe: ['M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18'],
  term: ['M7 9l3 3-3 3M12 15h5'],
  retry: ['M4 12a8 8 0 0 1 14-5.3L20 9', 'M20 4v5h-5', 'M20 12a8 8 0 0 1-14 5.3L4 15'],
  key: ['M11 12l8-8M16 7l3 3'],
  cpu: ['M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3'], // i18n-ignore: SVG path data
  gauge: ['M4 16a8 8 0 1 1 16 0', 'M12 16l4-5'], // i18n-ignore: SVG path data
  bubble: [
    'M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6a2.5 2.5 0 0 1-2.5 2.5H11l-4 4v-4h0A2 2 0 0 1 5 13z',
    'M9 9.5h6M9 12h3.5',
  ],
  file: ['M6 3h8l4 4v14H6z', 'M14 3v4h4'], // i18n-ignore: SVG path data
  plus: ['M12 5v14M5 12h14'], // i18n-ignore: SVG path data
  inbox: ['M4 13l2.5-8h11l2.5 8v6H4z', 'M4 13h5l1 2h4l1-2h5'],
  jobs: ['M4 7h16M4 12h16M4 17h10'], // i18n-ignore: SVG path data
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  tray: ['M4 14v5h16v-5', 'M12 4v10M8 10l4 4 4-4'],
  gear: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  ],
  grid: ['M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z'],
  // p12-diyalog Faz 2 (job thread): checkpoint, branch, memory, message, edit, delete, more, rating.
  flag: ['M5 21V4h11l-2 4 2 4H5'],
  branch: ['M6 8v8M18 10c0 4-6 3-11 7'],
  brain: [
    'M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3h1V4z',
    'M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3h-1V4z',
  ],
  msg: ['M4 5h16v11H9l-5 4z'],
  pen: ['M4 20h4L19 9l-4-4L4 16z'],
  trash: ['M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13'],
  more: ['M12 12h.01'],
  // p18-plan-mode W3: the drag handle of a plan item (two columns of dots).
  grip: [],
  history: ['M3 12a9 9 0 1 0 3-6.7', 'M3 4v4h4', 'M12 8v4l3 2'], // i18n-ignore: SVG path data
  up: ['M12 19V5', 'M6 11l6-6 6 6'], // i18n-ignore: SVG path data
  down: ['M12 5v14', 'M6 13l6 6 6-6'], // i18n-ignore: SVG path data
  upbar: ['M12 21V9', 'M6 15l6-6 6 6', 'M5 4h14'], // i18n-ignore: SVG path data
  downbar: ['M12 3v12', 'M6 9l6 6 6-6', 'M5 20h14'], // i18n-ignore: SVG path data
  thumbUp: [
    'M7 10v11', // i18n-ignore: SVG path data
    'M7 10l4-7a2.5 2.5 0 0 1 3 3l-1 4h5.5a2 2 0 0 1 2 2.4l-1.4 7A2 2 0 0 1 17.1 21H4V10z',
  ],
  // p12-diyalog panels: home (rail "Ana sayfa"), search (log search).
  home: ['M4 11l8-7 8 7', 'M6 9.5V20h12V9.5', 'M10 20v-5h4v5'],
  search: ['M20 20l-4.6-4.6'],
  thumbDown: [
    'M17 14V3', // i18n-ignore: SVG path data
    'M17 14l-4 7a2.5 2.5 0 0 1-3-3l1-4H5.5a2 2 0 0 1-2-2.4l1.4-7A2 2 0 0 1 6.9 3H20v11z',
  ],
  // p17-workflow-canvas: node families (trigger, data, code) and the arrange modes of the workflow canvas.
  bolt: ['M13 3L5 14h6l-1 7 8-11h-6z'], // i18n-ignore: SVG path data
  db: [
    'M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3z', // i18n-ignore: SVG path data
    'M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6', // i18n-ignore: SVG path data
    'M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3', // i18n-ignore: SVG path data
  ],
  code: ['M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14'], // i18n-ignore: SVG path data
  layoutLr: ['M3 9h5v6H3zM16 9h5v6h-5z', 'M8 12h7M12.5 9.5L15 12l-2.5 2.5'], // i18n-ignore: SVG path data
  layoutTb: ['M9 3h6v5H9zM9 16h6v5H9z', 'M12 8v7M9.5 12.5L12 15l2.5-2.5'], // i18n-ignore: SVG path data
  tree: ['M3 10h5v4H3zM16 3h5v4h-5zM16 17h5v4h-5z', 'M8 12h4M12 5v14M12 5h4M12 19h4'], // i18n-ignore: SVG path data
  alignMid: ['M3 12h18', 'M5 7h5v10H5zM14 9h5v6h-5z'], // i18n-ignore: SVG path data
  // p17-toasts-shortcuts: the toast tones (info, warning) and a notification preview (bell).
  info: ['M12 11v5M12 8h.01'], // i18n-ignore: SVG path data
  warn: [
    'M10.3 4.2L2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z', // i18n-ignore: SVG path data
    'M12 9v4M12 17h.01', // i18n-ignore: SVG path data
  ],
  bell: [
    'M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9', // i18n-ignore: SVG path data
    'M10 20a2 2 0 0 0 4 0', // i18n-ignore: SVG path data
  ],
} as const;

/** Extra shapes (circles, rects) some icons need besides paths. */
const SHAPES: Partial<Record<IconName, ReactNode>> = {
  merge: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="12" r="2" />
    </>
  ),
  rocket: <circle cx="15" cy="9" r="1.6" />,
  search: <circle cx="10.5" cy="10.5" r="6.5" />,
  xc: <circle cx="12" cy="12" r="9" />,
  pause: <circle cx="12" cy="12" r="9" />,
  checkc: <circle cx="12" cy="12" r="9" />,
  info: <circle cx="12" cy="12" r="9" />,
  clock: <circle cx="12" cy="12" r="9" />,
  copy: <rect x="8" y="8" width="12" height="12" rx="2" />,
  globe: <circle cx="12" cy="12" r="9" />,
  term: <rect x="3" y="4" width="18" height="16" rx="2" />,
  key: <circle cx="8" cy="15" r="4" />,
  cpu: <rect x="6" y="6" width="12" height="12" rx="2" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="19" cy="12" r="1.2" />
    </>
  ),
  grip: (
    <>
      <circle cx="9" cy="6" r="1.3" />
      <circle cx="15" cy="6" r="1.3" />
      <circle cx="9" cy="12" r="1.3" />
      <circle cx="15" cy="12" r="1.3" />
      <circle cx="9" cy="18" r="1.3" />
      <circle cx="15" cy="18" r="1.3" />
    </>
  ),
  branch: (
    <>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="8" r="2" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

export function DyIcon(props: { readonly name: IconName; readonly className?: string }): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={props.className ?? 'size-4 shrink-0'}
    >
      {SHAPES[props.name]}
      {PATHS[props.name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
