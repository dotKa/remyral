import { messagesFor } from '@remyral/i18n';
import { registerCard } from '../registry';
import { ApprovalCard, DeployCard, FailedJobCard, LimitCard, MergeCard } from './cards';
import { WorkflowApprovalCard } from '../chat/WorkflowCards';

/**
 * p12-diyalog Faz 1: attaches the live card renderers to the registry's ops thread types (imported once by the
 * home). An item whose payload is not the type the renderer expects renders nothing here and falls back to its
 * event line in the thread. The kind words are the registry's static (Turkish) defaults; screens say them in the
 * user's language through `t.home.kinds` (DiyalogHome's event lines) or the card's own `kind` prop.
 */
const KIND = messagesFor('tr').home.kinds;
registerCard('approval:request', {
  kind: { label: KIND.approval, icon: 'shield', tone: 'amber' },
  render: (p) => (p.item.type === 'approval:request' ? <ApprovalCard {...p} item={p.item} /> : null),
});
registerCard('deploy:action', {
  kind: { label: KIND.deploy, icon: 'rocket', tone: 'amber' },
  render: (p) => (p.item.type === 'deploy:action' ? <DeployCard {...p} item={p.item} /> : null),
});
registerCard('merge:integration', {
  kind: { label: KIND.merge, icon: 'merge', tone: 'teal' },
  render: (p) => (p.item.type === 'merge:integration' ? <MergeCard {...p} item={p.item} /> : null),
});
registerCard('job:failed', {
  kind: { label: KIND.failed, icon: 'xc', tone: 'red' },
  render: (p) => (p.item.type === 'job:failed' ? <FailedJobCard {...p} item={p.item} /> : null),
});
// p17-chat-flow: a workflow's approval step (decided on the card with the run page's route).
registerCard('workflow:approval', {
  kind: { label: messagesFor('tr').chatFlow.approval.kind, icon: 'shield', tone: 'amber' },
  render: (p) =>
    p.item.type === 'workflow:approval' ? (
      <div data-card={p.item.id}>
        <WorkflowApprovalCard
          runId={p.item.approval.runId}
          nodeRunId={p.item.approval.nodeRunId}
          initial={p.item.approval}
          onDecided={(next) => {
            if (p.item.type === 'workflow:approval') p.onChanged({ ...p.item, approval: next });
          }}
        />
      </div>
    ) : null,
});
registerCard('limit:paused', {
  kind: { label: KIND.limit, icon: 'pause', tone: 'violet' },
  render: (p) => (p.item.type === 'limit:paused' ? <LimitCard {...p} item={p.item} /> : null),
});
