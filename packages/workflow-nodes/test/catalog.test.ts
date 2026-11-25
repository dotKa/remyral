import { CATALOGS } from '@remyral/i18n/all';
import { describe, expect, it } from 'vitest';
import {
  isForbiddenHost,
  NODE_TYPE_NAMES,
  NODE_TYPES,
  nodeType,
  SMTP_PRESETS,
  smtpServer,
  typesDeliveredBy,
  validateV2,
  type EmailSendConfig,
} from '../src/index.js';

const DEFAULTS = {
  runtime: 'codex',
  sandboxProfile: 'host-restricted',
  sourceTrust: 'trusted',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 600 },
};

/** A minimal valid config of every non-AI type. */
const VALID: Record<string, Record<string, unknown>> = {
  'trigger.manual': {},
  'trigger.schedule': { cron: '0 9 * * 1-5' },
  'trigger.webhook': {},
  'trigger.github': { repository: 'example-org/app', events: ['pull_request'] },
  'trigger.workflow': { workflow: { name: 'build' }, outcomes: ['succeeded'] },
  'trigger.chat': {},
  'trigger.error': {},
  'control.if': { condition: '{{ $input.ok }}' },
  'control.switch': { value: { $expr: '$input.kind' }, cases: [{ name: 'bug', equals: 'bug' }] },
  'control.merge': {},
  'control.forEach': { items: { $expr: '$input.items' } },
  'control.loop': { while: { $expr: '$loop.i < 3' }, maxIterations: 3 },
  'control.delay': { duration: 'PT5M' },
  'control.waitUntil': { at: '2026-10-21T09:00:00Z' },
  'control.approval': { title: 'Ship?' },
  'control.waitWebhook': { timeoutSec: 3600, mode: 'token' },
  'control.subWorkflow': { workflow: { name: 'notify-oncall' } },
  'control.stop': {},
  'control.fail': { reason: 'nope' },
  'control.return': {},
  'control.respond': {},
  'data.set': { fields: { a: 1 } },
  'data.transform': { expression: { $expr: '$input' } },
  'data.filter': { items: { $expr: '$input' }, keep: { $expr: 'true' } },
  'data.aggregate': { items: { $expr: '$input' }, operations: [{ name: 'n', op: 'count' }] },
  'data.split': { mode: 'array', value: { $expr: '$input' } },
  'data.template': { template: 'Hello {{ $input.name }}' },
  'data.parse': { format: 'json', value: { $expr: '$input.body' } },
  'data.validate': { schema: { type: 'object' }, value: { $expr: '$input' } },
  'data.dateTime': { operation: 'now' },
  'notify.users': { recipients: { creator: true }, title: 'Done' },
  'chat.message': { text: 'Done' },
  'jobs.create': {
    spec: {
      runtime: 'codex',
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 60 },
    },
    prompt: 'Do it',
  },
  'deploy.coolify': { env: 'preview' },
  'deploy.pages': { fromNode: 'a' },
  'dns.change': { operation: 'upsert', record: { type: 'CNAME', name: 'www', content: 'x.example.com' } },
  'github.comment': { number: { $expr: '$trigger.pull_request.number' }, body: 'hi' },
  'github.pullRequest': { fromNode: 'a', title: 'PR' },
  'uptime.check': { kind: 'http', url: 'https://example.com/health' },
  'http.request': { origin: 'https://api.example.com', path: '/v1/search?q={{ $input.q }}' },
  'email.send': {
    smtp: { provider: 'gmail', username: 'me@example.com', credential: 'gmail-app-password' },
    from: { address: 'me@example.com' },
    to: '{{ $input.email }}',
    subject: 'Hello',
    text: 'Body',
  },
  'code.js': { source: 'return input;' },
  'code.python': { source: 'print(1)' },
};

/** One document: an AI step `a`, then the node under test (`x`), connected by default ports where possible. */
function doc(type: string, config: unknown, extra: Record<string, unknown> = {}): unknown {
  const t = nodeType(type);
  const isTrigger = t?.category === 'trigger';
  const ports = t?.ports(config) ?? [];
  const hasIn = ports.some((p) => p.name === 'in' && p.direction === 'in');
  return {
    schemaVersion: 2,
    name: 'cat',
    defaults: DEFAULTS,
    nodes: [
      { id: 'a', type: 'ai.step', role: 'executor', prompt: 'do' },
      {
        id: 'x',
        type,
        config,
        ...(type === 'control.return' ? { parent: 'g' } : {}),
        ...extra,
      },
      ...(type === 'control.return'
        ? [{ id: 'g', type: 'control.forEach', config: VALID['control.forEach'] }]
        : []),
      // 14.4: a respond node answers the request a waiting webhook trigger holds.
      ...(type === 'control.respond'
        ? [{ id: 'h', type: 'trigger.webhook', config: { responseMode: 'wait' } }]
        : []),
    ],
    edges: isTrigger
      ? [{ from: 'x', to: 'a' }]
      : type === 'control.return'
        ? [
            { from: 'a', to: 'g' },
            { from: 'g', fromPort: 'item', to: 'x' },
          ]
        : hasIn
          ? [{ from: 'a', to: 'x' }]
          : [],
  };
}

describe('node catalog', () => {
  it('has every type of the design (and only once)', () => {
    expect(new Set(NODE_TYPE_NAMES).size).toBe(NODE_TYPE_NAMES.length);
    for (const t of Object.keys(VALID)) expect(NODE_TYPE_NAMES).toContain(t);
    expect(NODE_TYPE_NAMES).toContain('ai.step');
    expect(NODE_TYPE_NAMES.length).toBe(Object.keys(VALID).length + 1);
  });

  it('placement: network and code only on workers; integrations on the master’s provider paths; logic pure', () => {
    for (const t of NODE_TYPES) {
      if (t.type === 'http.request' || t.type === 'email.send' || t.category === 'code')
        expect(t.placement, t.type).toBe('worker');
      if (t.category === 'control' || t.category === 'data') expect(t.placement, t.type).toBe('master');
      if (t.category === 'trigger') expect(t.placement).toBe('trigger');
      if (t.placement === 'worker') expect(t.workerFeature, t.type).toBeDefined();
    }
    expect(nodeType('code.js')?.workerFeature).toBe('function-code-v1');
    expect(nodeType('code.python')?.requires).toBe('workflows.define.code');
    expect(nodeType('http.request')?.requires).toBe('workflows.define.network');
    expect(nodeType('email.send')?.requires).toBe('workflows.define.network');
    expect(nodeType('deploy.coolify')?.requires).toBe('workflows.define.deploy');
    expect(nodeType('http.request')?.egress).toEqual({ default: 'public', allowlist: 'optional' });
    expect([...typesDeliveredBy('14.0')]).toEqual(['ai.step']);
  });

  it('every type has TR + EN labels in the i18n catalog, an icon and a strict config schema', () => {
    // Keyed by category, then name (`control.if` → nodeTypes.control.if): the catalog tooling reads dotted paths.
    type Texts = Record<string, Record<string, { label: string; description: string }>>;
    const flat = (c: Texts) =>
      Object.fromEntries(
        Object.entries(c).flatMap(([cat, xs]) =>
          Object.entries(xs).map(([name, v]) => [`${cat}.${name}`, v]),
        ),
      );
    const tr = flat(CATALOGS.tr.workflows.nodeTypes);
    const en = flat(CATALOGS.en.workflows.nodeTypes);
    expect(Object.keys(tr).sort()).toEqual([...NODE_TYPE_NAMES].sort());
    for (const t of NODE_TYPES) {
      expect(tr[t.type]?.label.length ?? 0, t.type).toBeGreaterThan(0);
      expect(en[t.type]?.description.length ?? 0, t.type).toBeGreaterThan(0);
      expect(t.icon.length).toBeGreaterThan(0);
      if (t.type === 'ai.step') continue;
      const r = t.config.safeParse({ ...VALID[t.type], definitelyUnknown: 1 });
      expect(r.success, t.type).toBe(false);
    }
  });

  it.each(Object.keys(VALID))('%s: a minimal config validates in a document', (type) => {
    const r = validateV2(doc(type, VALID[type]));
    expect(r.ok, JSON.stringify(r.ok ? null : r.issues)).toBe(true);
  });

  it('only the available types run: others are refused with node_type_unavailable', () => {
    const r = validateV2(doc('control.delay', VALID['control.delay']), {
      available: typesDeliveredBy('14.0'),
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.issues).toContainEqual({ path: 'nodes.1.type', code: 'node_type_unavailable' });
  });

  it('static fields refuse expressions (host, credential, recipients set, approver role, code)', () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['http.request', { origin: '{{ $input.host }}' }, 'origin'],
      [
        'http.request',
        { origin: 'https://api.example.com', auth: { credential: { $expr: '$input.c' } } },
        'auth',
      ],
      [
        'email.send',
        { ...VALID['email.send'], smtp: { host: '{{ $input.h }}', username: 'u', credential: 'c' } },
        'smtp',
      ],
      ['notify.users', { recipients: { users: ['{{ $input.u }}'] }, title: 't' }, 'recipients'],
      ['control.approval', { approverRole: { $expr: '"viewer"' }, title: 't' }, 'approverRole'],
      ['code.js', { source: '{{ $input.code }}' }, 'source'],
      ['deploy.coolify', { env: { $expr: '"production"' } }, 'env'],
    ];
    for (const [type, config, field] of cases) {
      const r = validateV2(doc(type, config));
      expect(r.ok, type).toBe(false);
      expect(r.ok ? [] : r.issues, `${type}.${field}`).toContainEqual({
        path: `nodes.1.config.${field}`,
        code: 'static_field',
      });
    }
    // AI-step settings are static too (only the prompt is a template).
    const ai = validateV2({
      schemaVersion: 2,
      name: 'x',
      defaults: DEFAULTS,
      nodes: [{ id: 'a', type: 'ai.step', role: 'executor', prompt: 'p', model: '{{ $input.m }}' }],
      edges: [],
    });
    expect(ai.ok ? [] : ai.issues).toContainEqual({ path: 'nodes.0.model', code: 'static_field' });
  });

  it('K1: HTTP egress is open to public hosts; LAN / private / loopback / link-local / metadata always refused', () => {
    for (const origin of [
      'https://api.example.com',
      'http://news.ycombinator.com',
      'https://8.8.8.8',
      'https://api.example.com:8443',
    ]) {
      expect(validateV2(doc('http.request', { origin })).ok, origin).toBe(true);
    }
    for (const origin of [
      'http://169.254.169.254',
      'http://10.0.0.5',
      'http://192.168.1.1',
      'http://172.16.3.4',
      'http://100.64.0.1',
      'http://127.0.0.1:8080',
      'http://localhost',
      'http://nas.local',
      'http://metadata.google.internal',
      'http://[::1]',
      'http://[fd00::1]',
      'http://[fe80::1]',
      'http://[::ffff:10.0.0.1]',
      'http://[fd00:ec2::254]',
      'http://0.0.0.0',
      'file:///etc/passwd',
      'https://user:pw@api.example.com',
      'https://api.example.com/path',
    ]) {
      expect(validateV2(doc('http.request', { origin })).ok, origin).toBe(false);
    }
    expect(isForbiddenHost('router.lan')).toBe(true);
    expect(isForbiddenHost('example.com')).toBe(false);
  });

  it('K1: credentials only by vault reference; credential headers cannot be set', () => {
    for (const h of ['Authorization', 'cookie', 'X-Api-Key', 'Host', 'Proxy-Authorization']) {
      const r = validateV2(doc('http.request', { origin: 'https://api.example.com', headers: { [h]: 'x' } }));
      expect(r.ok, h).toBe(false);
    }
    const ok = validateV2(
      doc('http.request', {
        origin: 'https://api.example.com',
        method: 'POST',
        headers: { 'X-Trace': '{{ $run.id }}' },
        body: { type: 'json', value: { $expr: '$input' } },
        auth: { credential: 'search-api', placement: 'bearer' },
      }),
    );
    expect(ok.ok).toBe(true);
    expect(
      validateV2(
        doc('http.request', { origin: 'https://api.example.com', body: { type: 'text', value: 'x' } }),
      ).ok,
    ).toBe(false); // GET with a body
  });

  it('K4: e-mail — presets or a custom server with TLS; recipients and content may be expressions', () => {
    const preset = nodeType('email.send')?.config.parse(VALID['email.send']) as EmailSendConfig;
    expect(smtpServer(preset)).toEqual(SMTP_PRESETS.gmail);
    const custom = {
      ...VALID['email.send'],
      smtp: {
        provider: 'custom',
        host: 'smtp.example.com',
        port: 587,
        tls: 'starttls',
        username: 'u',
        credential: 'smtp',
      },
      to: { $expr: '$input.recipients' },
      cc: ['ops@example.com'],
      subject: 'Report {{ $now }}',
      html: '<p>{{ $input.body }}</p>',
    };
    expect(validateV2(doc('email.send', custom)).ok).toBe(true);
    // A custom server needs host, port and TLS mode; plaintext SMTP and odd ports are refused; the host is public.
    for (const smtp of [
      { provider: 'custom', username: 'u', credential: 'c' },
      {
        provider: 'custom',
        host: 'smtp.example.com',
        port: 587,
        tls: 'none',
        username: 'u',
        credential: 'c',
      },
      {
        provider: 'custom',
        host: 'smtp.example.com',
        port: 8025,
        tls: 'tls',
        username: 'u',
        credential: 'c',
      },
      { provider: 'custom', host: '192.168.1.10', port: 465, tls: 'tls', username: 'u', credential: 'c' },
      { provider: 'custom', host: 'mail.local', port: 465, tls: 'tls', username: 'u', credential: 'c' },
    ]) {
      expect(validateV2(doc('email.send', { ...VALID['email.send'], smtp })).ok, JSON.stringify(smtp)).toBe(
        false,
      );
    }
    // No password in the definition: only a credential id; unknown keys (e.g. a password field) are refused.
    expect(
      validateV2(
        doc('email.send', {
          ...VALID['email.send'],
          smtp: { provider: 'gmail', username: 'u', credential: 'c', password: 'p' },
        }),
      ).ok,
    ).toBe(false);
    // The sender is static.
    const from = validateV2(
      doc('email.send', { ...VALID['email.send'], from: { address: '{{ $input.from }}' } }),
    );
    expect(from.ok ? [] : from.issues).toContainEqual({ path: 'nodes.1.config.from', code: 'static_field' });
    // Too many literal recipients.
    const many = Array.from({ length: 51 }, (_, i) => `u${String(i)}@example.com`);
    expect(validateV2(doc('email.send', { ...VALID['email.send'], to: many })).ok).toBe(false);
  });

  it('K3: code nodes need a container-capable worker (feature) and refuse oversized limits', () => {
    expect(validateV2(doc('code.js', { source: 'x', timeoutSec: 61 })).ok).toBe(false);
    expect(validateV2(doc('code.python', { source: 'x', memoryMb: 512 })).ok).toBe(false);
  });

  it('secrets in configs or prompts are refused when a detector is given', () => {
    const looksSecret = (s: string) => /sk-[A-Za-z0-9]{20,}/.test(s);
    const r = validateV2(doc('data.template', { template: 'key sk-abcdefghijklmnopqrstuvwxyz' }), {
      looksSecret,
    });
    expect(r.ok ? [] : r.issues).toContainEqual({ path: 'nodes.1', code: 'secret_in_definition' });
  });

  it('switch ports come from its cases', () => {
    const t = nodeType('control.switch');
    const ports = t?.ports({ cases: [{ name: 'a' }, { name: 'b' }] }).map((p) => p.name);
    expect(ports).toEqual(['in', 'a', 'b', 'default', 'error']);
  });
});
