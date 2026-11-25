import { type ReactNode, useContext } from 'react';
import { ReadOnlyContext } from '../chat/turnControls';
import { useT } from '../../i18n/I18nProvider';
import type { ChatDraft } from '../../api/chat';
import { JobDraftCard } from '../compose/JobDraftCard';
import { DyDraftCard } from '../drafts/DraftCard';
import { CredentialSaveCard } from '../vault/CredentialSaveCard';
import { createFormatter, messagesFor } from '@remyral/i18n';
import { fullAccessOf, summarizeDraft } from '../drafts/summary';

/** Full access is read from the spec, which does not depend on the language. */
const SPEC_T = messagesFor('tr');
const SPEC_F = createFormatter('tr');

/**
 * p12-diyalog: an ops chat draft as a live card in a Diyalog thread. Faz 3 made an open job draft the editable card
 * (JobDraftCard); p12-diyalog-w4 renders every other kind — and a job asking for full access — natively with all of
 * the classic card's controls (DyDraftCard: states, details, job checklist, diffs, approval mode and class, result
 * links, the one-time webhook secret, quick buttons).
 */

/**
 * p12-diyalog Faz 3: a job draft is an editable card (JobDraftCard) unless it asks for full access (allow-all /
 * unconfined): that one is read and confirmed on the full card, where its mark and explanation are.
 */
export function editableJobDraft(d: ChatDraft): boolean {
  if (d.kind !== 'job') return false;
  return fullAccessOf(summarizeDraft(d, SPEC_T, SPEC_F).spec) === null;
}

export function DraftItemCard(props: {
  readonly d: ChatDraft;
  readonly threadId: string;
  readonly onChanged: () => void;
}): ReactNode {
  const readOnly = useContext(ReadOnlyContext);
  // p16-chat-complete: a shared reader sees a card of a project they cannot read as "erişimin yok", and every other
  // card read-only (its buttons are disabled; the master refuses a reader anyway).
  if (props.d.restricted === true) return <RestrictedCard kind={props.d.kind} />;
  if (readOnly)
    return (
      <fieldset disabled className="m-0 min-w-0 border-0 p-0" data-testid="draft-readonly">
        <ItemCard {...props} />
      </fieldset>
    );
  return <ItemCard {...props} />;
}

function RestrictedCard(props: { readonly kind: string }): ReactNode {
  const t = useT().chatComplete.shared;
  return (
    <div
      className="rounded-[var(--dy-r-card)] border border-dashed border-dy-line-2 px-3.5 py-2.5 text-[0.8125rem] text-dy-muted"
      data-testid="draft-restricted"
    >
      <span className="font-dy-mono">{props.kind}</span> · {t.restricted}
    </div>
  );
}

function ItemCard(props: {
  readonly d: ChatDraft;
  readonly threadId: string;
  readonly onChanged: () => void;
}): ReactNode {
  if (editableJobDraft(props.d)) return <JobDraftCard {...props} />;
  // p15-chat-vault: the browser completes a "save to vault" card (it seals the value here).
  if (props.d.kind === 'credential_save') return <CredentialSaveCard {...props} />;
  return <DyDraftCard {...props} />;
}
