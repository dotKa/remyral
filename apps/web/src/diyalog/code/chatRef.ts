import type { Messages } from '@remyral/i18n';
import { toast } from '../toast/store';
import { addPendingCodeRef, type CodeRef, codeRefId, codeRefLabel, pendingCodeRefs } from './refs';

/** p19-ide W1: "Sohbete ekle" — the lines go with the next chat message (a toast with "Sohbete git"). */
export function addToChat(r: CodeRef, words: Messages['code']['chat']): void {
  const label = codeRefLabel(r);
  const there = pendingCodeRefs().some((p) => p.project === r.project && codeRefId(p) === codeRefId(r));
  if (!there && pendingCodeRefs().length >= 8) {
    toast({ tone: 'warning', title: words.full });
    return;
  }
  const added = addPendingCodeRef(r);
  toast({
    tone: added ? 'success' : 'info',
    title: added ? words.added : words.already,
    description: added ? words.addedDesc({ label }) : undefined,
    actions: [{ label: words.goChat, to: '/chat' }],
    testId: 'code-chat-toast',
  });
}
