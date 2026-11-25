import type { Shape } from '../shape.js';
import type tr from '../tr/chatVault.js';

/**
 * p15-chat-vault: secrets pasted into Chat and the vault — the composer's warning and "Save to vault" panel, credential
 * badges in messages and the assistant's "save to vault" / HTTP request cards.
 */
export default {
  warning: {
    title: 'You pasted a secret',
    one: (p: { what: string }) =>
      `This looks like ${p.what}. Secrets are never sent to the chat: a badge takes its place, the value stays in this tab only.`,
    many: (p: { n: number }) =>
      `You pasted ${String(p.n)} things that look like secrets. None is sent to the chat: badges take their place.`,
    offer: 'Save it to the vault if you like; then use it with “send a request to this endpoint with @NAME”.',
    save: 'Save to vault',
    remove: 'Remove',
    subscription:
      'This is a Claude subscription token: it is never stored (use local login); it was only removed from the message.',
    adminOnly: 'Only administrators can save to the vault. The value will not be sent to the chat.',
  },
  providers: {
    openai: 'an OpenAI API key',
    anthropic: 'an Anthropic API key',
    openrouter: 'an OpenRouter API key',
    github: 'a GitHub token',
    gitlab: 'a GitLab token',
    google: 'a Google API key',
    slack: 'a Slack token',
    stripe: 'a Stripe key',
    huggingface: 'a Hugging Face token',
    npm: 'an npm token',
    aws: 'an AWS access key',
    jwt: 'a token (JWT)',
    'private-key': 'a private key',
    generic: 'an API key',
  },
  save: {
    title: 'Save to vault',
    intro:
      'The value is sealed in this browser to the vault keys of the machines you pick; the master and the assistant never see it.',
    name: 'Name (variable name)',
    nameHint: 'Shown in the chat as @NAME, with a vault badge.',
    nameRule: 'Letters, digits and _ (starts with a letter, at most 64).',
    nameTaken: 'A credential with this name exists.',
    kind: 'Kind',
    kinds: {
      'http-auth': 'HTTP authentication (requests and workflow HTTP steps)',
      'api-token': 'API key (an agent runtime environment variable)',
      generic: 'Generic secret',
    },
    hosts: 'Allowed hosts',
    hostsHint: 'The value is only sent to these hosts (one per line or comma separated).',
    hostsRequired: 'An HTTP credential needs at least one host.',
    hostsBad: (p: { host: string }) => `Invalid host: ${p.host}`,
    machines: 'Machines',
    machinesHint: 'The value is sealed to these machines only; requests run on one of them.',
    pickMachine: 'Pick at least one machine.',
    noMachines: 'No machine with a vault key can hold this kind.',
    value: 'Value',
    valueHint:
      'The value pasted in this tab is gone (the page was reloaded). Paste it again; it is sealed here only.',
    submit: 'Seal and save',
    cancel: 'Cancel',
    stepUp: 'Verification code to save to the vault',
    saved: (p: { name: string }) => `${p.name} is saved in the vault.`,
    unsupported: 'This browser has no X25519; the value cannot be sealed.',
  },
  chip: {
    credential: 'Vault credential',
    pasted: 'Unsaved secret',
    removed: 'Removed secret',
    unknown: 'not in the vault or not visible',
    machines: (p: { n: number }) => `on ${String(p.n)} machine${p.n === 1 ? '' : 's'}`,
    open: 'Open the credential',
  },
  card: {
    saveKind: 'Save to vault',
    httpKind: 'HTTP request',
    saveNote: 'Your browser completes this card: the value is sealed here and never reaches the master.',
    savedAs: (p: { name: string }) => `Saved: ${p.name}`,
    request: 'Request',
    credential: 'Credential',
    placement: 'Placement',
    httpNote:
      'Runs as a function job on a machine; the value is attached only for its bound host and hidden in the response.',
  },
} satisfies Shape<typeof tr>;
