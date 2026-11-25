import type { ReactNode } from 'react';
import { lazyScreen } from '../../lib/lazyScreen';

const ChatPrintScreen = lazyScreen(() => import('./ChatPrintScreen'), 'ChatPrintScreen');

/** p16-chat-complete: the print / save-as-PDF page of a conversation. */
export const CHAT_PRINT_SEGMENT = 'yazdir';

export function chatPrintPath(threadId: string): string {
  return `/chat/${encodeURIComponent(threadId)}/${CHAT_PRINT_SEGMENT}`;
}

/** `/chat/:id/yazdir` → the print page; null for any other path. */
export function matchChatPrint(pathname: string): ReactNode | null {
  const m = /^\/chat\/([^/]+)\/yazdir$/.exec(pathname);
  if (m === null) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[1] ?? '');
  } catch {
    return null;
  }
  return <ChatPrintScreen key={id} threadId={id} />;
}
