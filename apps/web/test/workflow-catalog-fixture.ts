// p14-workflow-engine 14.1: a node catalog as `GET /workflows/catalog` sends it (shapes of the master's
// `z.toJSONSchema` output for the types the web tests use).
const expr = (literal: Record<string, unknown>): Record<string, unknown> => ({
  anyOf: [
    literal,
    { type: 'string', maxLength: 16384, pattern: '\\{\\{[\\s\\S]*?\\}\\}' },
    {
      type: 'object',
      properties: { $expr: { type: 'string', minLength: 1, maxLength: 4096 } },
      required: ['$expr'],
      additionalProperties: false,
    },
  ],
});
const exprValue = {
  type: 'object',
  properties: { $expr: { type: 'string', minLength: 1, maxLength: 4096 } },
  required: ['$expr'],
  additionalProperties: false,
};
const IN = { name: 'in', direction: 'in', required: true };
const OUT = { name: 'out', direction: 'out' };
const ERROR = { name: 'error', direction: 'out' };

const base = {
  placement: 'master',
  phase: '14.1',
  icon: 'branch',
  group: false,
  sideEffect: false,
  requires: 'workflows.define',
  untrustedOutput: false,
  testable: true,
};

export const CATALOG = {
  engineV2: true,
  executable: [
    'ai.step',
    'trigger.manual',
    'control.if',
    'control.switch',
    'control.merge',
    'control.forEach',
    'data.set',
  ],
  types: [
    {
      ...base,
      type: 'trigger.manual',
      category: 'trigger',
      placement: 'trigger',
      testable: false,
      fields: {},
      config: { type: 'object', properties: {}, additionalProperties: false },
      ports: [OUT],
    },
    {
      ...base,
      type: 'ai.step',
      category: 'ai',
      placement: 'worker-ai',
      phase: '14.0',
      testable: false,
      sideEffect: true,
      untrustedOutput: true,
      fields: {},
      config: { type: 'object', properties: {}, additionalProperties: false },
      ports: [
        { name: 'in', direction: 'in', required: true, many: true },
        { name: 'context', direction: 'in' },
        {
          name: 'out',
          direction: 'out',
          schema: { type: 'object', properties: { summary: { type: 'text' }, branch: { type: 'string' } } },
        },
        ERROR,
      ],
    },
    {
      ...base,
      type: 'control.if',
      category: 'control',
      fields: { condition: 'expr' },
      config: {
        type: 'object',
        properties: {
          condition: expr({ anyOf: [{ type: 'boolean' }, { type: 'string', maxLength: 16384 }] }),
        },
        required: ['condition'],
        additionalProperties: false,
      },
      ports: [IN, { name: 'true', direction: 'out' }, { name: 'false', direction: 'out' }, ERROR],
    },
    {
      ...base,
      type: 'control.switch',
      category: 'control',
      fields: { value: 'expr', mode: 'static', cases: 'static' },
      config: {
        type: 'object',
        properties: {
          value: expr({ type: 'string' }),
          mode: { type: 'string', enum: ['first', 'all'] },
          cases: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,31}$' },
                equals: {
                  anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }],
                },
                match: exprValue,
              },
              required: ['name'],
              additionalProperties: false,
            },
          },
        },
        required: ['value', 'cases'],
        additionalProperties: false,
      },
      ports: [IN, { name: 'default', direction: 'out' }, ERROR],
      dynamicPorts: 'cases',
    },
    {
      ...base,
      type: 'control.merge',
      category: 'control',
      fields: { join: 'static', combine: 'static' },
      config: {
        type: 'object',
        properties: { combine: { type: 'string', enum: ['array', 'object'] } },
        additionalProperties: false,
      },
      ports: [{ name: 'in', direction: 'in', required: true, many: true }, OUT, ERROR],
    },
    {
      ...base,
      type: 'control.forEach',
      category: 'control',
      group: true,
      fields: { items: 'expr', concurrency: 'static', onItemError: 'static' },
      config: {
        type: 'object',
        properties: {
          items: exprValue,
          concurrency: { type: 'integer', minimum: 1, maximum: 20 },
          onItemError: { type: 'string', enum: ['fail', 'continue', 'collect'] },
        },
        required: ['items'],
        additionalProperties: false,
      },
      ports: [
        IN,
        { name: 'item', direction: 'out', side: 'inner' },
        { name: 'results', direction: 'out', schema: { type: 'array' } },
        { name: 'done', direction: 'out' },
        ERROR,
      ],
    },
    {
      ...base,
      type: 'data.set',
      category: 'data',
      icon: 'data',
      fields: { fields: 'expr', keepInput: 'static' },
      config: {
        type: 'object',
        properties: {
          fields: { type: 'object', propertyNames: { type: 'string' }, additionalProperties: expr({}) },
          keepInput: { type: 'boolean' },
        },
        required: ['fields'],
        additionalProperties: false,
      },
      ports: [IN, OUT, ERROR],
    },
    {
      ...base,
      type: 'http.request',
      category: 'integration',
      placement: 'worker',
      phase: '14.3',
      icon: 'http',
      requires: 'workflows.define.network',
      sideEffect: true,
      testable: false,
      untrustedOutput: true,
      fields: { origin: 'static', path: 'expr' },
      config: {
        type: 'object',
        properties: { origin: { type: 'string' }, path: expr({ type: 'string' }) },
        required: ['origin'],
        additionalProperties: false,
      },
      ports: [IN, OUT, ERROR],
    },
  ],
  functions: [
    { name: '$sum', signature: '<a<n>:n>' },
    { name: '$uuid5', signature: '<ss:s>' },
  ],
  refusedFunctions: ['$eval', '$random', '$clone', '$shuffle'],
  limits: { maxNodes: 200 },
};
