import type { Shape } from '../shape.js';
import type tr from '../tr/workflowAi.js';

/** p15-workflow-ai: the AI panel of the workflow editor (design, edit with a diff, explain, debug). */
export default {
  open: 'AI',
  openAria: 'Open the AI panel',
  title: 'Work with AI',
  close: 'Close the AI panel',
  modes: {
    design: 'Design',
    edit: 'Edit',
    explain: 'Explain',
    debug: 'Debug',
  },
  modesLabel: 'What should the AI do?',
  placeholder: {
    design:
      'What should the workflow do? E.g. “Every morning fetch new leads and tell me about the hot ones.”',
    edit: 'What should change? E.g. “put this step behind an approval”, “add an error branch”.',
    explain: 'What do you want to know? E.g. “What does this workflow do?”',
    debug: 'What do you want to ask? E.g. “Why did it fail?”',
  },
  hint: {
    design:
      'The AI drafts it with the node catalog; it reaches the canvas after the server validated it. Nothing changes until you save.',
    edit: 'The AI gets the current document (with the selected nodes); its proposal is shown as a diff and you accept or reject each change.',
    explain: 'It only answers; the workflow is not touched.',
    debug:
      'The node data of the failed run you pick is sent. That data is untrusted: the AI does not follow instructions in it, it only explains it.',
  },
  explainPrompt: 'What does this workflow do?',
  debugPrompt: 'Why did it fail?',
  selected: (p) =>
    p.n === 1 ? 'The selected node is sent too.' : `The ${String(p.n)} selected nodes are sent too.`,
  send: 'Send',
  stop: 'Stop',
  working: 'The AI is working…',
  empty: 'No AI conversation for this workflow yet. Ask something or let it design one.',
  newConversation: 'New conversation',
  openInChat: 'Open in chat',
  you: 'You',
  assistant: 'Assistant',
  repairMessage: 'Automatic repair: the AI fixes the reported issues once.',
  tool: (p) => `Tool: ${p.name}`,
  unavailable: 'The assistant is not available right now (Settings → Chat).',
  viewerNote: 'In this project only Explain and Debug are available (editing needs the operator role).',
  needProject: 'Pick a project in Settings first.',
  run: {
    label: 'Failed run',
    none: 'This workflow has no failed run.',
    option: (p) => `${p.id} · ${p.time}`,
    ask: 'Why did it fail?',
  },
  proposal: {
    invalid: 'The AI could not produce a valid workflow; the canvas did not change.',
    invalidAfterRepair: 'Still invalid after the automatic repair; the canvas did not change. Issues:',
    repairing: 'The draft was invalid; the AI is fixing the issues automatically…',
    applied:
      'The AI draft is on the canvas — nothing changes until you save. Undo brings back the previous canvas.',
    load: 'Load onto the canvas',
    review: 'Show the changes',
    unreadable: 'The AI’s draft could not be read.',
    latest: 'Latest AI proposal',
  },
  review: {
    title: (p) => (p.n === 1 ? 'AI proposal: 1 change' : `AI proposal: ${String(p.n)} changes`),
    none: 'The proposal is the same as the current document; nothing changes.',
    acceptAll: 'Accept all',
    rejectAll: 'Reject all',
    applySelected: 'Apply selected',
    applied: (p) =>
      p.n === 0 ? 'No change was applied.' : `${String(p.n)} changes applied; Save new version to keep them.`,
    rejected: 'Proposal rejected; the canvas did not change.',
    reviewing: 'The changes are marked on the canvas: green added, red removed, amber changed.',
    kinds: {
      nodeAdded: (p) => `New node ${p.id}`,
      nodeRemoved: (p) => `Node ${p.id} removed`,
      nodeChanged: (p) => `Node ${p.id} changed (${p.fields})`,
      edgeAdded: (p) => `New link ${p.id}`,
      edgeRemoved: (p) => `Link ${p.id} removed`,
      settings: (p) => `Settings: ${p.fields}`,
    },
  },
  diff: {
    added: 'added',
    removed: 'removed',
    changed: 'changed',
  },
  chat: {
    linked: (p) => `This conversation belongs to the workflow ${p.name}.`,
    linkedNew: 'This conversation is about a new workflow that is not saved yet.',
    open: 'Go to the workflow',
  },
} satisfies Shape<typeof tr>;
