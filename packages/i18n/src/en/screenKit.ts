import { plural } from '../plural.js';
import type { Shape } from '../shape.js';
import type tr from '../tr/screenKit.js';

const days = (n: number): string => `${String(n)} ${plural('en', n, { one: 'day', other: 'days' })}`;

export default {
  frame: {
    live: 'Live',
    liveError: 'Connection problem',
  },
  section: {
    emptyTitle: 'Nothing here yet',
    home: 'Home',
    notReady: 'This section’s screen is not ready yet.',
  },
  threadLink: {
    label: 'open in thread',
    aria: (p) => `${p.about}: open in thread`,
  },
  errorLine: {
    readFailed: (p) => `Could not load ${p.what}: ${p.reason}`,
    retry: 'Try again',
  },
  exportResult: {
    saved: (p) => `saved: ${String(p.n)} ${plural('en', p.n, { one: 'record', other: 'records' })}.`,
    verified: 'Checksum verified.',
    mismatch: 'Checksum does not match — delete this file and export again.',
    unchecked: 'The checksum is on the file’s last line.',
    truncated: ' The export reached its size limit; continue for the rest.',
  },
  time: {
    justNow: 'just now',
    minutesAgo: (p) => `${String(p.n)} min ago`,
    hoursAgo: (p) => `${String(p.n)} h ago`,
    daysAgo: (p) => `${days(p.n)} ago`,
    minutesAhead: (p) => `in ${String(p.n)} min`,
    hoursAhead: (p) => `in ${String(p.n)} h`,
    daysAhead: (p) => `in ${days(p.n)}`,
  },
} satisfies Shape<typeof tr>;
