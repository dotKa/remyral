import type { ReactNode } from 'react';
import { type TagColor } from '../../../api/chatOrganize';
import { cx } from '../../../components/ui';

/**
 * p10-chat-organize: tag chips. The colour is a closed palette name mapped to fixed classes here (never free CSS from
 * the server); the chip always carries the tag's name, so colour is never the only signal.
 */

const DOT: Readonly<Record<TagColor, string>> = {
  gray: 'bg-zinc-400',
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  amber: 'bg-amber-500',
  green: 'bg-green-500',
  teal: 'bg-teal-500',
  blue: 'bg-blue-500',
  violet: 'bg-violet-500',
  pink: 'bg-pink-500',
};

export function TagDot(props: { readonly color: TagColor; readonly className?: string }): ReactNode {
  return (
    <span
      aria-hidden="true"
      className={cx('inline-block size-2 shrink-0 rounded-full', DOT[props.color], props.className)}
    />
  );
}
