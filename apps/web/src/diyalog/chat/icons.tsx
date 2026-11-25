import type { ReactNode } from 'react';

/**
 * p12-diyalog-parity: the few extra glyphs the conversation list and the details panel need, drawn in the Diyalog
 * icon style (24 px grid, 1.6 stroke, round caps — `DyIcon`). Kept apart from `icons.tsx` so parallel phases do not
 * edit the same table.
 */
const PATHS = {
  pin: ['M9 4h6l-1 6 3 3H7l3-3z', 'M12 13v7'], // i18n-ignore: SVG path data
  star: ['m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z'],
  search: ['M16 16l4 4'], // i18n-ignore: SVG path data
  archive: ['M4 5h16v4H4z', 'M5 9v10h14V9', 'M10 13h4'], // i18n-ignore: SVG path data
  tag: ['M3 12V4h8l9 9-8 8z'],
  panel: ['M15 4.5v15'],
  list: ['M8 7h12M8 12h12M8 17h12', 'M4 7h.01M4 12h.01M4 17h.01'], // i18n-ignore: SVG path data
  close: ['M6 6l12 12M18 6L6 18'], // i18n-ignore: SVG path data
  chevr: ['M9 6l6 6-6 6'],
  link: [
    'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1',
    'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  ],
  image: ['M4 17l5-5 4 4 3-3 4 4'],
  group: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M12 11v5M9.5 13.5h5'],
  readall: ['M3 12.5l4 4L15 8', 'M11 16l1 .5L21 8'],
  copy: ['M16 8V4H4v12h4'], // i18n-ignore: SVG path data
  keyboard: ['M7 10h.01M11 10h.01M15 10h.01M7 14h10'],
  stop: [],
  sparkle: ['M12 4v4M12 16v4M4 12h4M16 12h4'], // i18n-ignore: SVG path data
  // p15-watches: Takipler.
  bell: ['M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0'],
} as const;

export type ChatIconName = keyof typeof PATHS;

const SHAPES: Partial<Record<ChatIconName, ReactNode>> = {
  search: <circle cx="10.5" cy="10.5" r="6" />,
  panel: <rect x="3.5" y="4.5" width="17" height="15" rx="2" />,
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <circle cx="9" cy="9.5" r="1.5" />
    </>
  ),
  tag: <circle cx="7.5" cy="8.5" r="1.2" />,
  copy: <rect x="8" y="8" width="12" height="12" rx="2" />,
  keyboard: <rect x="3" y="6" width="18" height="12" rx="2" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="2" />,
};

export function ChatIcon(props: {
  readonly name: ChatIconName;
  readonly className?: string;
  readonly filled?: boolean;
}): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={props.filled === true ? 'currentColor' : 'none'}
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
