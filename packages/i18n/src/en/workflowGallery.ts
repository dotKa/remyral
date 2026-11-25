import type { Shape } from '../shape.js';
import type tr from '../tr/workflowGallery.js';

/** p14-workflow-engine 14.5 (ADR-0055): Workflows → "Templates" gallery and the create-from-template wizard. */
export default {
  title: 'Templates',
  open: 'Templates',
  emptyLink: 'Start from a ready-made template',
  purpose:
    'Ready-made, runnable workflows: marketing, content and video production. The wizard asks for addresses and vault credentials and saves the workflow to your project as version 1; nothing runs.',
  back: 'Workflows',
  loading: 'Loading templates',
  what: 'Templates',
  none: 'This server has no templates.',
  engineOff:
    'Templates use the new workflow engine, which is off on this server. Ask an administrator to turn on WORKFLOW_ENGINE_V2.',
  noDefine: 'Creating a workflow from a template needs at least the operator role in a project.',
  nodes: (p: { n: number }) => `${String(p.n)} ${p.n === 1 ? 'node' : 'nodes'}`,
  create: 'Create',
  createAria: (p: { name: string }) => `${p.name}: create from template`,
  runsOnMachine: 'Runs on a machine',
  needsAdmin: 'Needs a project admin + verification code',
  features: {
    http: 'HTTP request',
    email: 'E-mail',
    code: 'Code',
    ai: 'AI',
    approval: 'Approval',
  },
  graphLabel: (p: { name: string }) => `Graph of the ${p.name} template`,
  wizard: {
    title: (p: { name: string }) => `Create from template: ${p.name}`,
    notFound: 'This template was not found.',
    steps: {
      where: 'Project and name',
      values: 'Connections',
      review: 'Check and create',
    },
    stepOf: (p: { n: number; total: number }) => `Step ${String(p.n)} of ${String(p.total)}`,
    project: 'Project',
    noProject: 'There is no project where you can define workflows.',
    name: 'Workflow name',
    nameHint: 'Starts with a lower-case letter; letters, digits, - and _ (at most 64).',
    nameBad:
      'This name cannot be used: it must start with a lower-case letter and contain only letters, digits, - and _.',
    repositoryNote:
      'This is a repository project: AI steps ask for a repository on every run. A workspace project, where files pass between steps, suits these templates better.',
    workspaceNote: 'Workspace project: the steps’ files (out/ → in/) pass on to the next steps.',
    valuesIntro:
      'The template’s placeholders. Credentials are picked from the vault; the server never sees their values — they are used only on a machine and for their bound addresses.',
    required: 'required',
    optional: 'optional',
    requiredMissing: 'This field is required.',
    originPlaceholder: 'https://api.example.com',
    originBad: 'Enter an address starting with https:// (without a path).',
    pathBad: 'Enter a path starting with / (no spaces, // or ..).',
    pathPlaceholder: '/v1/resource',
    textBad: 'At most 200 characters; {{ and }} are not allowed.',
    emailBad: 'Enter a valid e-mail address.',
    numberBad: (p: { min: string; max: string }) => `Enter a number between ${p.min} and ${p.max}.`,
    cronHint: 'Cron, UTC: minute hour day month weekday. Example: 0 6 * * 1 = every Monday 06:00.',
    credentialPick: '— Pick a credential —',
    credentialNone: 'The vault has no active credential of this kind.',
    credentialAdd: 'Add one in Settings → Credentials',
    credentialHosts: (p: { hosts: string }) => `Allowed addresses: ${p.hosts}`,
    credentialNotBound: (p: { host: string }) =>
      `The chosen credential is not bound to ${p.host}; it cannot be used there.`,
    credentialNoneBound: (p: { host: string }) => `No credential in the vault is bound to ${p.host}.`,
    choose: '— Choose —',
    next: 'Next',
    previous: 'Back',
    check: 'Check again',
    checking: 'Checking',
    valid: 'Valid. Create saves the workflow as version 1; nothing runs.',
    invalid: 'Not valid yet:',
    privileged: (p: { list: string }) =>
      `This workflow has nodes that need the ${p.list} permission: creating it asks for a verification code.`,
    actions: {
      network: 'network (HTTP / e-mail)',
      code: 'code',
      deploy: 'deployment',
    },
    stepUp: 'Enter your verification code to save a workflow with network or code nodes.',
    create: 'Create',
    machineNote:
      'HTTP, e-mail and code nodes run on a machine (a function job); while no suitable machine is online the job waits in the queue.',
  },
} satisfies Shape<typeof tr>;
