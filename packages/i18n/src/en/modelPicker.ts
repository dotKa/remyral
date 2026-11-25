import type { Shape } from '../shape.js';
import type tr from '../tr/modelPicker.js';

/**
 * p15-model-picker: choosing a model from a list instead of typing it — the models the runtime supports (available on
 * this machine / catalog), the default option, model profiles and “Custom model id…” for anything not listed.
 */
export default {
  defaultOption: 'Default (the runtime’s own choice)',
  composerLabel: 'Model or model profile',
  chatModel: 'Model or model profile',
  fallbackModel: 'Model of the fallback engine',
  stepModel: 'Model (for this step)',
  defaultWith: (p: { value: string }) => `Default: ${p.value}`,
  groups: {
    profiles: 'Model profiles',
    here: 'Available on this machine',
    fleet: 'Available on machines',
    catalog: 'Catalog',
  },
  search: 'Search models…',
  open: 'Open the model list',
  noMatch: 'No model matches. Choose “Custom model id…” for a model that is not listed.',
  custom: 'Custom model id…',
  customBadge: 'Custom',
  customLabel: 'Custom model id',
  customHint:
    'A model id that is not in the list. The runtime must accept it; if it does not, the job fails when it starts.',
  customPlaceholder: 'e.g. claude-opus-5-5 or provider/model',
  customApply: 'Use',
  customBack: 'Back to the list',
  customIssues: {
    empty: 'Type a model id.',
    too_long: 'At most 128 characters.',
    invalid: 'Must start with a letter or digit and contain only letters, digits and . _ : / @ + -',
  },
  alias: (p: { to: string }) => `alias → ${p.to}`,
  aliasMoving: 'alias · follows the newest version',
  profile: (p: { model: string }) => `profile → ${p.model}`,
  onMachines: (p: { names: string }) => `on ${p.names}`,
  context: (p: { tokens: string }) => `${p.tokens} context`,
  access: {
    subscription: 'subscription',
    'api-key': 'API key',
  },
  loading: 'Loading models…',
  loadFailed: 'The machines’ model lists could not be loaded; the catalog and a custom model id still work.',
  updateNeeded: (p: { names: string }) =>
    `${p.names}: the model list needs a machine update; the catalog is shown for those machines.`,
  listFailed: (p: { name: string; error: string }) => `${p.name}: the model list failed (${p.error}).`,
  catalogVersion: (p: { version: string }) => `Catalog ${p.version}`,
  machineDefaults: 'Machine defaults',
  machineDefault: (p: { name: string; value: string }) => `${p.name} → ${p.value}`,
  machineDefaultHint:
    'A machine’s own default wins over the global default model. Machines → machine → Configuration → Runtimes and models.',
  softDefaultHint:
    'The global default model is used on machines without a default of their own (needs a machine update).',
} satisfies Shape<typeof tr>;
