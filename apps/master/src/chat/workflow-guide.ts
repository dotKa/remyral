/**
 * p16-workflow-quality (docs/design/p16-workflow-quality.md §6): the assistant's compact guide to building workflows
 * that work the first time — what starts a run, minimal VALID documents for common patterns, the common validation
 * errors with their fixes. Platform facts, the same for every user. Every pattern document is validated by the master
 * in the integration suite (test/integration/workflow-quality.test.ts), so the guide cannot drift from the engine.
 */

export type GuideTopic = 'all' | 'triggers' | 'patterns' | 'errors' | 'repository';

export const TRIGGER_SEMANTICS: Readonly<
  Record<string, { readonly startsRuns: string; readonly activation: boolean }>
> = {
  'trigger.manual': {
    startsRuns: 'A start by hand: the run form, a draft_workflow_run card, the API, a sub-workflow call.',
    activation: false,
  },
  'trigger.chat': {
    startsRuns: 'A draft_workflow_run card confirmed in the chat (its inputs are untrusted data).',
    activation: false,
  },
  'trigger.schedule': {
    startsRuns:
      'Every cron time (5 fields) or once at "at", on the wall clock of "timezone" (IANA, default UTC; daylight saving handled) — only while the workflow is ACTIVE (one scheduler for all masters, a missed time follows catchUp).',
    activation: true,
  },
  'trigger.webhook': {
    startsRuns:
      'A signed POST to the webhook URL shown once on activation — only while the workflow is ACTIVE (project admin + fresh code to activate).',
    activation: true,
  },
  'trigger.github': {
    startsRuns:
      'A GitHub event of the repository (push, pull_request, issues, issue_comment) — only while the workflow is ACTIVE (project admin + fresh code).',
    activation: true,
  },
  'trigger.workflow': {
    startsRuns: 'Another workflow run ending with one of "outcomes" — only while the workflow is ACTIVE.',
    activation: true,
  },
  'trigger.error': {
    startsRuns:
      'A failed run of a workflow whose settings.onFailure names this workflow ($trigger = the failure).',
    activation: false,
  },
};

const DEFAULTS_NOTE =
  'Leave "defaults" out: the master fills runtime, sandboxProfile, approvalPolicy and limits from the project.';

/** Minimal valid documents (schemaVersion 2). `<...>` are the only things to replace. */
export const WORKFLOW_PATTERNS: readonly {
  readonly id: string;
  readonly when: string;
  readonly definition: Record<string, unknown>;
  readonly notes: readonly string[];
}[] = [
  {
    id: 'scheduled-http-message',
    when: 'Send a fixed message every hour (WhatsApp / Telegram / any HTTP API) — no AI needed.',
    definition: {
      schemaVersion: 2,
      name: 'hourly-reminder',
      nodes: [
        {
          id: 'every_hour',
          type: 'trigger.schedule',
          config: { cron: '0 * * * *', timezone: 'Europe/Istanbul' },
        },
        { id: 'run_by_hand', type: 'trigger.manual' },
        { id: 'either', type: 'control.merge', config: { join: 'any' } },
        {
          id: 'send',
          type: 'http.request',
          config: {
            method: 'POST',
            origin: 'https://api.example.com',
            path: '/v1/messages',
            body: { type: 'json', value: { to: '<recipient>', text: 'Su içmeyi unutma.' } },
          },
        },
      ],
      edges: [
        { from: 'every_hour', to: 'either' },
        { from: 'run_by_hand', to: 'either' },
        { from: 'either', to: 'send' },
      ],
    },
    notes: [
      'Most nodes take ONE input edge: join two triggers (schedule + manual) with a control.merge {join: "any"}.',
      'For an authenticated API add config.auth {credential: "<vault credential id>", placement: "bearer"} — a vault http-auth credential bound to that host; never a token in the document.',
      'Or call a saved messaging workflow with control.subWorkflow {workflow: {name: "<workflow>"}, inputs: {...}}.',
      'The schedule starts runs once the card is confirmed (activate defaults to true).',
    ],
  },
  {
    id: 'ai-text-to-http',
    when: 'An AI step writes a text, an HTTP request sends it.',
    definition: {
      schemaVersion: 2,
      name: 'daily-tip',
      nodes: [
        {
          id: 'every_morning',
          type: 'trigger.schedule',
          config: { cron: '0 9 * * *', timezone: 'Europe/Istanbul' },
        },
        {
          id: 'write',
          type: 'ai.step',
          role: 'executor',
          prompt: 'Write one short, friendly reminder line in Turkish. Answer with the line only.',
        },
        {
          id: 'send',
          type: 'http.request',
          config: {
            method: 'POST',
            origin: 'https://api.example.com',
            path: '/v1/messages',
            body: { type: 'json', value: { text: { $expr: '$node.write.out.summary' } } },
          },
        },
      ],
      edges: [
        { from: 'every_morning', to: 'write' },
        { from: 'write', to: 'send' },
      ],
    },
    notes: [
      'The AI step needs NO repository: without one it runs in a scratch folder. Only add needsRepository: true when the step must read or change code.',
      'For structured output give the ai.step an outputSchema and read $node.write.out.data.',
    ],
  },
  {
    id: 'approval-gate',
    when: 'A human approves before something happens.',
    definition: {
      schemaVersion: 2,
      name: 'approve-then-notify',
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        {
          id: 'ask',
          type: 'control.approval',
          config: { approverRole: 'admin', title: 'Send the announcement?' },
        },
        { id: 'tell', type: 'notify.users', config: { recipients: { creator: true }, title: 'Approved' } },
        { id: 'stopped', type: 'control.stop', config: {} },
      ],
      edges: [
        { from: 'start', to: 'ask' },
        { from: 'ask', fromPort: 'approved', to: 'tell' },
        { from: 'ask', fromPort: 'denied', to: 'stopped' },
      ],
    },
    notes: [
      'control.approval has ports approved / denied / timeout; an AI step can also carry approval {approverRole}.',
    ],
  },
  {
    id: 'for-each',
    when: 'Do the same thing for every item of a list.',
    definition: {
      schemaVersion: 2,
      name: 'notify-each',
      inputs: { names: { required: true, type: 'json' } },
      nodes: [
        { id: 'start', type: 'trigger.manual' },
        {
          id: 'each',
          type: 'control.forEach',
          config: { items: { $expr: '$inputs.names' }, concurrency: 2 },
        },
        {
          id: 'hello',
          type: 'chat.message',
          parent: 'each',
          config: { text: 'Merhaba {{ $item }}' },
        },
        { id: 'done', type: 'notify.users', config: { recipients: { creator: true }, title: 'All sent' } },
      ],
      edges: [
        { from: 'start', to: 'each' },
        { from: 'each', fromPort: 'item', to: 'hello' },
        { from: 'each', fromPort: 'done', to: 'done' },
      ],
    },
    notes: [
      'Body nodes carry "parent": "<group id>" and are fed from the group\'s item port; results / done leave the group.',
    ],
  },
];

export const COMMON_ERRORS: readonly { readonly code: string; readonly fix: string }[] = [
  {
    code: 'defaults required / defaults.sandboxProfile',
    fix: `${DEFAULTS_NOTE} Never guess a sandbox profile.`,
  },
  {
    code: 'unknown_timezone',
    fix: 'Use an IANA zone name (Europe/Istanbul, America/New_York, UTC) in trigger.schedule config.timezone.',
  },
  { code: 'cron_or_at', fix: 'trigger.schedule takes exactly one of cron (5 fields) or at (ISO time).' },
  {
    code: 'invalid_cron / too often',
    fix: 'Five fields: minute hour day-of-month month day-of-week; at most every 5 minutes ("0 * * * *" = every hour on the hour).',
  },
  { code: 'unknown_type / nodes.N.type', fix: 'Call workflow_node_catalog and use a listed type.' },
  {
    code: 'static_field',
    fix: 'That field takes a literal only (origin, credential, recipients, approver role, sub-workflow): no {{ }} or $expr.',
  },
  {
    code: 'forbidden_host',
    fix: 'HTTP requests go to public https addresses only (no localhost, private or metadata addresses).',
  },
  {
    code: 'secret_in_definition',
    fix: 'Remove the token / password: save it as a vault credential (propose_credential_save) and use its id in auth.credential.',
  },
  {
    code: 'not_upstream / unknown_node in an expression',
    fix: 'An expression may read $node.<id> only of an upstream node; use ids without "-".',
  },
  {
    code: 'crosses_scope',
    fix: "Inside a forEach / loop group connect body nodes only from the group's item port.",
  },
  {
    code: 'single_input',
    fix: 'That node takes one input edge: put a control.merge (join "any" for alternative triggers, "all" to wait for every branch) in front of it.',
  },
  {
    code: 'repository_required (when running)',
    fix: "Only integrators, Coolify deploy steps and needsRepository steps need code; remove needsRepository from steps that do not, or register the project's repository.",
  },
  {
    code: 'manual_trigger_missing (when running by hand)',
    fix: 'A workflow whose only triggers are schedule / webhook / github / workflow cannot be started by hand: add a trigger.manual.',
  },
];

export const GUIDE_RULES: readonly string[] = [
  'Build the workflow in ONE valid draft: validate_workflow the document, fix every issue, then call draft_workflow once. An invalid draft never becomes a card.',
  DEFAULTS_NOTE,
  'Schedules / webhooks / GitHub / workflow triggers start runs only while the workflow is active; confirming the draft_workflow card activates them (activate defaults to true). Add a trigger.manual when the user also wants to run it by hand.',
  'A fixed text needs no AI step: send it with http.request (or a sub-workflow). Use an ai.step only when the text must be written each time.',
  'AI steps do not need a repository; never replace an AI step with a fixed list because of a repository error — use needsRepository only for steps that work on code.',
];

const REPOSITORY_NOTE =
  "A run takes its repository from the run input, else the workflow defaults.repository, else the project's registered repository. With none, AI steps run in a scratch folder without code; integrators, Coolify deploy steps and steps with needsRepository: true are refused with repository_required.";

/** The guide answer for `topic` (compact; the documents are complete and valid). */
export function workflowGuide(topic: GuideTopic = 'all'): Record<string, unknown> {
  const all = topic === 'all';
  return {
    rules: GUIDE_RULES,
    ...(all || topic === 'triggers'
      ? {
          triggers: Object.entries(TRIGGER_SEMANTICS).map(([type, t]) => ({
            type,
            startsRuns: t.startsRuns,
            needsActivation: t.activation,
          })),
        }
      : {}),
    ...(all || topic === 'patterns' ? { patterns: WORKFLOW_PATTERNS } : {}),
    ...(all || topic === 'errors' ? { commonErrors: COMMON_ERRORS } : {}),
    ...(all || topic === 'repository' ? { repository: REPOSITORY_NOTE } : {}),
  };
}

/** A short hint for an issue code of the master's validation (the guide's fix), or null. */
export function issueHint(path: string, code: string): string | null {
  if (path === 'defaults' || path.startsWith('defaults.')) return COMMON_ERRORS[0]?.fix ?? null;
  for (const e of COMMON_ERRORS) {
    const first = e.code.split(/[ /]/)[0] ?? '';
    if (first !== '' && code.startsWith(first)) return e.fix;
  }
  if (code.startsWith('invalid_cron')) return COMMON_ERRORS[3]?.fix ?? null;
  if (path.endsWith('.type')) return COMMON_ERRORS[4]?.fix ?? null;
  return null;
}
