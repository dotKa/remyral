import type { ScreenRoutes } from './types';

/**
 * p17-workflow-canvas harness (dev server only): `?engine=2&path=/workflows/wf-canvas` opens an engine-2 workflow with
 * one node of every catalog type — long ids, Turkish labels, a switch with long case names, a forEach body, error
 * links — to check the card zones (no overlaps), the family colours and the edge palette in both themes and at any
 * zoom. Without `engine=2` the session reports no new engine and nothing here answers (the v1 harness is unchanged).
 */

const engine2 = (): boolean => new URLSearchParams(window.location.search).get('engine') === '2';

const CASES = { cases: [{ name: 'acil' }, { name: 'haftalik-bakim-penceresi' }, { name: 'diger' }] };

/**
 * The catalog's types and ports (packages/workflow-nodes NODE_TYPES; the package cannot load in the browser — it
 * pulls node:crypto through @remyral/protocol). Ports: `<` input, `>` output, `~` a group's inner output, `!`
 * required, `*` many. test/workflow-canvas.test.ts checks this table against the package.
 */
export const HARNESS_TYPES: readonly (readonly [string, string, string, 0 | 1, string])[] = [
  ['trigger.manual', 'trigger', 'trigger', 0, '>out'],
  ['trigger.schedule', 'trigger', 'trigger', 0, '>out'],
  ['trigger.webhook', 'trigger', 'trigger', 0, '>out'],
  ['trigger.github', 'trigger', 'trigger', 0, '>out'],
  ['trigger.workflow', 'trigger', 'trigger', 0, '>out'],
  ['trigger.chat', 'trigger', 'trigger', 0, '>out'],
  ['trigger.error', 'trigger', 'trigger', 0, '>out'],
  ['ai.step', 'ai', 'worker-ai', 0, '<in!* <context >out >error'],
  ['control.if', 'control', 'master', 0, '<in! >true >false >error'],
  ['control.switch', 'control', 'master', 0, '<in! >default >error'],
  ['control.merge', 'control', 'master', 0, '<in!* >out >error'],
  ['control.forEach', 'control', 'master', 1, '<in! ~item >results >done >error'],
  ['control.loop', 'control', 'master', 1, '<in! ~item >results >done >error'],
  ['control.delay', 'control', 'master', 0, '<in! >out >error'],
  ['control.waitUntil', 'control', 'master', 0, '<in! >out >timeout >error'],
  ['control.approval', 'control', 'master', 0, '<in! >approved >denied >timeout >error'],
  ['control.waitWebhook', 'control', 'master', 0, '<in! >received >timeout >error'],
  ['control.subWorkflow', 'control', 'master', 0, '<in! >out >error'],
  ['control.stop', 'control', 'master', 0, '<in!'],
  ['control.fail', 'control', 'master', 0, '<in!'],
  ['control.return', 'control', 'master', 0, '<in!'],
  ['control.respond', 'control', 'master', 0, '<in! >out >error'],
  ['data.set', 'data', 'master', 0, '<in! >out >error'],
  ['data.transform', 'data', 'master', 0, '<in! >out >error'],
  ['data.filter', 'data', 'master', 0, '<in! >kept >dropped >error'],
  ['data.aggregate', 'data', 'master', 0, '<in! >out >error'],
  ['data.split', 'data', 'master', 0, '<in! >items >error'],
  ['data.template', 'data', 'master', 0, '<in! >out >error'],
  ['data.parse', 'data', 'master', 0, '<in! >out >error'],
  ['data.validate', 'data', 'master', 0, '<in! >valid >invalid >error'],
  ['data.dateTime', 'data', 'master', 0, '<in! >out >error'],
  ['notify.users', 'integration', 'integration', 0, '<in! >out >error'],
  ['chat.message', 'integration', 'integration', 0, '<in! >out >error'],
  ['jobs.create', 'integration', 'integration', 0, '<in! >out >error'],
  ['deploy.coolify', 'integration', 'integration', 0, '<in! >out >error'],
  ['deploy.pages', 'integration', 'integration', 0, '<in! >out >error'],
  ['dns.change', 'integration', 'integration', 0, '<in! >out >error'],
  ['github.comment', 'integration', 'integration', 0, '<in! >out >error'],
  ['github.pullRequest', 'integration', 'integration', 0, '<in! >out >error'],
  ['uptime.check', 'integration', 'integration', 0, '<in! >out >error'],
  ['http.request', 'integration', 'worker', 0, '<in! >out >error'],
  ['email.send', 'integration', 'worker', 0, '<in! >out >error'],
  ['code.js', 'code', 'worker', 0, '<in! >out >error'],
  ['code.python', 'code', 'worker', 0, '<in! >out >error'],
];

const NODE_TYPES = HARNESS_TYPES.map(([type, category, placement, group, ports]) => ({
  type,
  category,
  placement,
  group: group === 1,
  ports: ports.split(' ').map((p) => ({
    name: p.replace(/^[<>~]/, '').replace(/[!*]+$/, ''),
    direction: p.startsWith('<') ? 'in' : 'out',
    ...(p.startsWith('~') ? { side: 'inner' } : {}),
    ...(p.includes('!') ? { required: true } : {}),
    ...(p.includes('*') ? { many: true } : {}),
  })),
}));

/** The catalog as the master sends it (config schemas reduced to an open object). */
const CATALOG = {
  engineV2: true,
  executable: NODE_TYPES.map((t) => t.type),
  types: NODE_TYPES.map((t) => ({
    ...t,
    phase: '14.4',
    icon: '',
    sideEffect: false,
    requires: 'workflows.define',
    untrustedOutput: false,
    testable: true,
    fields: {},
    config: { type: 'object', properties: {}, additionalProperties: true },
    ...(t.type === 'control.switch' ? { dynamicPorts: 'cases' } : {}),
  })),
  functions: [],
  refusedFunctions: [],
};

/** Every type once (the switch with three cases, a forEach body); ids include long and Turkish ones. */
const LABELS: Readonly<Record<string, string>> = {
  'control.approval': 'Sürüm yöneticisi onayı (üretim)',
  'http.request': 'Sipariş servisine istek',
};
const ids = new Map<string, string>([
  ['ai.step', 'step'],
  ['control.if', 'kontrol'],
  ['control.switch', 'oncelik-yonlendirme'],
  ['control.forEach', 'her-siparis'],
  ['data.transform', 'cok-uzun-bir-donusum-adimi-adi-burada'],
]);
const idOf = (type: string): string => ids.get(type) ?? type.replace('.', '-');

const NODES = [
  ...NODE_TYPES.map((t) => ({
    id: idOf(t.type),
    type: t.type,
    ...(t.type === 'ai.step'
      ? { role: 'executor', prompt: 'Değişikliği uygula.', runtime: 'claude-code' }
      : { config: t.type === 'control.switch' ? CASES : {} }),
    ...(LABELS[t.type] === undefined ? {} : { label: LABELS[t.type] }),
  })),
  { id: 'govde', type: 'data.set', config: {}, parent: 'her-siparis' },
];

const EDGES = [
  { from: 'trigger-manual', to: 'step' },
  { from: 'step', to: 'kontrol' },
  { from: 'step', to: 'control-fail', fromPort: 'error' },
  { from: 'kontrol', to: 'oncelik-yonlendirme', fromPort: 'true' },
  { from: 'kontrol', to: 'data-filter', fromPort: 'false' },
  { from: 'oncelik-yonlendirme', to: 'http-request', fromPort: 'acil' },
  { from: 'oncelik-yonlendirme', to: 'control-approval', fromPort: 'haftalik-bakim-penceresi' },
  { from: 'oncelik-yonlendirme', to: 'her-siparis', fromPort: 'default' },
  { from: 'her-siparis', to: 'govde', fromPort: 'item' },
  { from: 'her-siparis', to: 'control-merge', fromPort: 'results' },
  { from: 'http-request', to: 'control-merge' },
  { from: 'control-approval', to: 'deploy-coolify', fromPort: 'approved' },
  { from: 'data-filter', to: 'cok-uzun-bir-donusum-adimi-adi-burada', fromPort: 'kept' },
  { from: 'control-merge', to: 'notify-users' },
];

const DEFINITION = {
  schemaVersion: 2,
  name: 'canvas-tour',
  description: 'Her düğüm türünden bir tane: kart bölgeleri, aile renkleri ve bağlantı renkleri.',
  inputs: {},
  defaults: { runtime: 'claude-code', sandboxProfile: 'container', limits: { maxDurationSec: 1800 } },
  nodes: NODES,
  edges: EDGES,
};

const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

export const ROUTES: ScreenRoutes = {
  '/auth/session': (_u, method) =>
    engine2() && method === 'GET'
      ? {
          user: { id: 'u1', username: 'alex', role: 'owner' },
          session: {
            createdAt: iso(60_000),
            expiresAt: iso(-3_600_000),
            idleExpiresAt: iso(-1_800_000),
            mfaAt: iso(60_000),
            stepUpValidUntil: null,
            stepUpScope: 'window',
          },
          features: { workflowEngineV2: true },
        }
      : undefined,
  '/workflows/catalog': () => (engine2() ? CATALOG : undefined),
  '/workflows/wf-canvas/definition': () => ({
    id: 'wf-canvas',
    project: 'vitrin-web',
    name: 'canvas-tour',
    version: 1,
    latestVersion: 1,
    latestId: 'wf-canvas',
    archived: false,
    createdBy: 'alex',
    createdAt: iso(3_600_000),
    hash: 'h-wf-canvas',
    promptsHidden: false,
    definition: DEFINITION,
  }),
};
