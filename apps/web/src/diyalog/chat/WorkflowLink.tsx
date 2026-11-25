import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { ChatWorkflowLink } from '../../api/chat';
import { useT } from '../../i18n/I18nProvider';
import { DyIcon } from '../icons';

/**
 * p15-workflow-ai: a conversation of the workflow editor's AI panel, opened in Sohbet — which workflow it belongs to
 * and the way back to the editor (the AI panel open). Nothing for an ordinary conversation.
 */
export function WorkflowLinkBar(props: {
  readonly link: ChatWorkflowLink | null | undefined;
  readonly threadId: string;
}): ReactNode {
  const t = useT().workflowAi.chat;
  const l = props.link;
  if (l === null || l === undefined) return null;
  const thread = encodeURIComponent(props.threadId);
  const to =
    l.definitionId === null
      ? `/workflows/new?project=${encodeURIComponent(l.project)}&ai=design&aiThread=${thread}`
      : `/workflows/${encodeURIComponent(l.definitionId)}?ai=edit&aiThread=${thread}`;
  return (
    <div
      data-testid="dy-sohbet-workflow"
      className="flex flex-wrap items-center gap-2 border-b border-dy-line bg-dy-card px-4 py-2 text-[0.8125rem]"
    >
      <DyIcon name="branch" className="size-4 text-dy-muted" />
      <span className="min-w-0 flex-1">{l.name === null ? t.linkedNew : t.linked({ name: l.name })}</span>
      {l.definitionId === null && l.name !== null ? null : (
        <Link to={to} className="font-medium text-dy-teal-ink">
          {t.open}
        </Link>
      )}
    </div>
  );
}
