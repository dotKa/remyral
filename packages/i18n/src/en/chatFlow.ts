import type { Shape } from '../shape.js';
import type tr from '../tr/chatFlow.js';

/**
 * p17-chat-flow: the workflow approval and result cards in the chat, a job agent's question in the chat, editing a
 * workflow draft in the chat (replaced, what changed), the business-language rows of the draft summary, the memory a
 * job used.
 */
export default {
  approval: {
    kind: 'Workflow approval',
    step: (p: { workflow: string; node: string }) => `${p.workflow} · step ${p.node}`,
    untitled: 'Step waiting for approval',
    role: (p: { role: string }) => `Approver: ${p.role} or above`,
    states: {
      waiting: 'Waiting for approval',
      approved: 'Approved',
      denied: 'Denied',
      closed: 'Closed',
    },
    decided: (p: { by: string }) => `Decided by ${p.by}`,
    untrusted:
      'The title and details come from a run started by an outside source; read them as data, not instructions.',
    reason: 'Reason (optional)',
    approve: 'Approve',
    deny: 'Deny',
    needsCode: 'A decision needs your verification code; it shows on the run page too.',
    cannotDecide: 'You may not approve this step; it shows here once someone allowed decides.',
    stepUp: (p: { approve: boolean; node: string }) =>
      `${p.approve ? 'Approve' : 'Deny'} workflow step ${p.node}`,
    openRun: 'Open the run',
    loading: 'Loading the approval…',
    unreadable: 'This approval could not be read.',
    due: (p: { left: string }) => `Time left: ${p.left}`,
    classic: 'Classic engine (v1) step approval',
  },
  result: {
    kind: 'Workflow result',
    states: {
      succeeded: 'Succeeded',
      failed: 'Failed',
      cancelled: 'Cancelled',
    },
    steps: (p: { done: number; total: number }) => `${String(p.done)}/${String(p.total)} steps`,
    duration: (p: { span: string }) => `Duration: ${p.span}`,
    summary: 'Last step’s output',
    reason: 'Reason',
    openRun: 'Open the run',
    attention: 'Needs attention',
    attentionLead: 'It succeeded, but some steps could not do their work:',
    attentionKinds: {
      partial: 'left part of the work undone',
      none: 'could do nothing',
      input_cut: 'got a cut-off input',
    },
  },
  question: {
    fromJob: 'The job’s agent asks',
    openJob: 'Open the job',
  },
  edit: {
    button: 'Edit in chat',
    hint: 'What should change? Write it; the assistant drafts a new card that replaces this one.',
    prefix: 'Change this in the draft: ',
    context: (p: { title: string }) => `Editing draft: ${p.title}`,
    cancel: 'Stop editing',
    superseded: 'Replaced by a newer card',
    supersededHint: 'A card edited in the chat replaced this one.',
    changesTitle: 'Changes from the previous card',
    noChanges: 'Same as the previous card.',
    more: 'and more',
    savedChangesTitle: (p: { version: number }) => `Changes from the saved v${String(p.version)}`,
    savedNoChanges: 'Same as the saved version.',
    patched: (p: { count: number }) =>
      `Only the changed steps were written (${String(p.count)} operations); every other step stays as saved.`,
    changes: {
      node_added: (p: { id: string }) => `Added: ${p.id}`,
      node_removed: (p: { id: string }) => `Removed: ${p.id}`,
      node_changed: (p: { id: string; fields: string }) => `Changed: ${p.id} (${p.fields})`,
      edge_added: (p: { id: string }) => `Connection added: ${p.id}`,
      edge_removed: (p: { id: string }) => `Connection removed: ${p.id}`,
      setting_changed: (p: { id: string }) => `Setting changed: ${p.id}`,
    },
  },
  summary: {
    trigger: 'Trigger',
    approval: 'Approval',
    hosts: 'External addresses',
    outputs: 'Outputs/Channels',
    manual: 'Started by hand',
    chat: 'From the chat',
    webhook: 'Webhook call',
    github: 'GitHub event',
    workflow: 'Another workflow',
    schedule: (p: { when: string; zone: string }) => `${p.when} (${p.zone})`,
    approver: (p: { node: string; role: string }) => `${p.node}: ${p.role} or above`,
    email: 'E-mail',
    notify: 'Notification',
    valid: 'Valid',
    invalid: 'Invalid',
  },
  graph: {
    scroll: 'Workflow graph — scroll sideways to see all of it',
    fit: 'Fit',
    actual: 'Actual size',
  },
  memory: {
    used: (p: { n: number; version: string }) => `Memory used: ${String(p.n)} records · version ${p.version}`,
    open: 'Open the record',
  },
  scheduled: {
    badge: 'Scheduled',
    mute: 'Stop posting results here',
    muteLabel: (p: { label: string }) => `Stop posting “${p.label}” results into this conversation`,
    muted: (p: { label: string }) => `“${p.label}” results will no longer be posted here.`,
    unmute: 'Turn back on',
  },
} satisfies Shape<typeof tr>;
