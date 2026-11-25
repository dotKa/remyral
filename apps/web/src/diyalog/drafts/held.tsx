import { type ReactNode, useState } from 'react';
import type { ChatDraft } from '../../api/chat';
import { useT } from '../../i18n/I18nProvider';
import { DyNotice } from '../forms';
import { DyCheck } from '../screens/forms';

/**
 * oss-sec3: a card the platform held because the assistant's turn read content from outside the person (a job log, a
 * file, a web response …). It says why, and — when the kind of action may be remembered — offers "remember" (unticked;
 * sent with the confirmation only). Forgetting lives in Ayarlar → Sohbet → Hatırlanan onaylar.
 */
export function useHeldCard(
  d: ChatDraft,
  open: boolean,
  busy: boolean,
): { readonly node: ReactNode; readonly remember: boolean } {
  const w = useT().drafts.held;
  const [remember, setRemember] = useState(false);
  if (!open || d.held === undefined) return { node: null, remember: false };
  return {
    remember: d.held.rememberable && remember,
    node: (
      <div className="flex flex-col gap-1" data-testid="draft-held">
        <DyNotice tone="amber" title={w.title}>
          {w.body}
        </DyNotice>
        {d.held.rememberable ? (
          <DyCheck
            label={w.remember}
            hint={w.rememberHint}
            checked={remember}
            disabled={busy}
            onChange={setRemember}
            testId="draft-held-remember"
          />
        ) : (
          <p className="m-0 text-[0.78125rem] text-dy-muted" data-testid="draft-held-always">
            {w.always}
          </p>
        )}
      </div>
    ),
  };
}
