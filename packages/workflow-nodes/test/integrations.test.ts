import { describe, expect, it } from 'vitest';
import {
  deltaActions,
  nodeAction,
  privilegedDelta,
  typesDeliveredBy,
  validateV2,
  type V2Node,
} from '../src/index.js';

/**
 * p14-workflow-engine 14.2: the privileged delta of a version (which `workflows.define.*` actions a save needs) and the
 * 14.2 validation rules (webhook waits, trigger nodes, deferred options).
 */

const DEFAULTS = {
  runtime: 'codex',
  sandboxProfile: 'host-restricted',
  sourceTrust: 'trusted',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 600 },
};
const n = (
  id: string,
  type: string,
  config: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => ({ id, type, config, ...extra }) as unknown as V2Node;
const wf = (nodes: unknown[], edges: unknown[] = []) => ({
  schemaVersion: 2,
  name: 'v',
  defaults: DEFAULTS,
  nodes,
  edges,
});
const issuesOf = (doc: unknown) => {
  const r = validateV2(doc);
  return r.ok ? [] : r.issues;
};

describe('privileged delta (§8.5)', () => {
  const deploy = n('ship', 'deploy.coolify', { env: 'preview' });
  const comment = n('say', 'github.comment', { number: 1, body: 'hi' });
  const notify = n('ping', 'notify.users', { recipients: { creator: true }, title: 't' });

  it('maps node types to the define action they need', () => {
    expect(nodeAction(deploy)).toBe('workflows.define.deploy');
    expect(nodeAction(comment)).toBe('workflows.define.network');
    expect(nodeAction(n('dns', 'dns.change', {}))).toBe('workflows.define.deploy');
    expect(nodeAction(n('up', 'uptime.check', {}))).toBe('workflows.define.network');
    expect(nodeAction(n('js', 'code.js', {}))).toBe('workflows.define.code');
    expect(nodeAction(notify)).toBeNull();
    // A webhook wait is privileged only in token-only mode (the URL alone authenticates the caller).
    expect(nodeAction(n('w', 'control.waitWebhook', { timeoutSec: 60 }))).toBeNull();
    expect(nodeAction(n('w', 'control.waitWebhook', { timeoutSec: 60, mode: 'token' }))).toBe(
      'workflows.define.network',
    );
  });

  it('counts added and changed privileged nodes, never removals, labels or key order', () => {
    expect(privilegedDelta(null, { nodes: [deploy, notify] })).toEqual([
      { node: 'ship', type: 'deploy.coolify', action: 'workflows.define.deploy', change: 'added' },
    ]);
    const prev = { nodes: [deploy, comment, notify] };
    // Unchanged (label and key order differ only).
    const same = [
      { ...deploy, label: 'Ship it' } as V2Node,
      n('say', 'github.comment', { body: 'hi', number: 1 }),
      notify,
    ];
    expect(privilegedDelta(prev, { nodes: same })).toEqual([]);
    // Removing a privileged node needs nothing; changing one does.
    expect(privilegedDelta(prev, { nodes: [notify] })).toEqual([]);
    const changed = privilegedDelta(prev, {
      nodes: [n('ship', 'deploy.coolify', { env: 'production' }), comment],
    });
    expect(changed).toEqual([
      { node: 'ship', type: 'deploy.coolify', action: 'workflows.define.deploy', change: 'changed' },
    ]);
    expect(
      deltaActions([
        ...changed,
        { node: 'x', type: 'github.comment', action: 'workflows.define.network', change: 'added' },
      ]),
    ).toEqual(['workflows.define.deploy', 'workflows.define.network']);
  });
});

describe('14.2 validation', () => {
  it('delivers the integrations, the webhook wait and every trigger with 14.2 (respond waits for 14.4)', () => {
    const t = typesDeliveredBy('14.2');
    for (const type of [
      'notify.users',
      'chat.message',
      'jobs.create',
      'deploy.coolify',
      'deploy.pages',
      'dns.change',
      'github.comment',
      'github.pullRequest',
      'uptime.check',
      'control.waitWebhook',
      'trigger.schedule',
      'trigger.webhook',
      'trigger.github',
      'trigger.workflow',
      'trigger.chat',
    ])
      expect(t.has(type), type).toBe(true);
    expect(t.has('control.respond')).toBe(false);
    expect(t.has('http.request')).toBe(false);
  });

  it('a signed webhook wait needs a webhook trigger in the workflow; token mode does not', () => {
    const wait = (mode?: string) =>
      n('w', 'control.waitWebhook', { timeoutSec: 600, ...(mode === undefined ? {} : { mode }) });
    expect(issuesOf(wf([n('start', 'trigger.manual'), wait()], [{ from: 'start', to: 'w' }]))).toContainEqual(
      {
        path: 'nodes.1.config.mode',
        code: 'wait_needs_webhook_trigger',
      },
    );
    expect(issuesOf(wf([n('hook', 'trigger.webhook'), wait()], [{ from: 'hook', to: 'w' }]))).toEqual([]);
    expect(issuesOf(wf([n('start', 'trigger.manual'), wait('token')], [{ from: 'start', to: 'w' }]))).toEqual(
      [],
    );
  });

  it('the wait URL may be sent by any node of the same or an enclosing scope, before the wait (not other data)', () => {
    const nodes = [
      n('start', 'trigger.manual'),
      n('w', 'control.waitWebhook', { timeoutSec: 600, mode: 'token' }),
      n('tell', 'notify.users', {
        recipients: { creator: true },
        title: 'Open {{ $node.w.url }}',
      }),
    ];
    const edges = [
      { from: 'start', to: 'tell' },
      { from: 'tell', to: 'w' },
    ];
    expect(issuesOf(wf(nodes, edges))).toEqual([]);
    // Anything but `.url` of a node that is not upstream stays refused.
    const bad = [
      nodes[0],
      nodes[1],
      n('tell', 'notify.users', { recipients: { creator: true }, title: '{{ $node.w.received }}' }),
    ];
    expect(issuesOf(wf(bad, edges))).toContainEqual({ path: 'nodes.2.config', code: 'not_upstream:w' });
  });

  it('schedules take an IANA zone (p16); a respond node needs a waiting webhook trigger at top level (14.4)', () => {
    expect(
      issuesOf(wf([n('s', 'trigger.schedule', { cron: '0 9 * * 1-5', timezone: 'Europe/Istanbul' })])),
    ).toEqual([]);
    expect(
      issuesOf(wf([n('s', 'trigger.schedule', { cron: '0 * * * *', timeZone: 'Europe/Istanbul' })])),
    ).toEqual([]);
    expect(
      issuesOf(wf([n('s', 'trigger.schedule', { at: '2026-10-24T09:00:00', timeZone: 'Europe/Istanbul' })])),
    ).toEqual([]);
    expect(
      issuesOf(wf([n('s', 'trigger.schedule', { cron: '0 9 * * 1-5', timezone: 'Mars/Olympus' })])),
    ).toContainEqual({ path: 'nodes.0.config.timezone', code: 'unknown_timezone' });
    expect(
      JSON.stringify(
        issuesOf(wf([n('s', 'trigger.schedule', { cron: '0 9 * * *', timezone: 'UTC', timeZone: 'UTC' })])),
      ),
    ).toContain('nodes.0.config');
    expect(issuesOf(wf([n('s', 'trigger.schedule', { cron: '0 9 * * 1-5' })]))).toEqual([]);
    expect(issuesOf(wf([n('h', 'trigger.webhook', { responseMode: 'wait' })]))).toEqual([]);
    const respond = n('r', 'control.respond', { status: 201, body: { $expr: '$input' } });
    expect(issuesOf(wf([n('h', 'trigger.webhook'), respond], [{ from: 'h', to: 'r' }]))).toContainEqual({
      path: 'nodes.1',
      code: 'respond_needs_wait_trigger',
    });
    expect(
      issuesOf(
        wf(
          [n('h', 'trigger.webhook', { responseMode: 'wait', responseTimeoutSec: 10 }), respond],
          [{ from: 'h', to: 'r' }],
        ),
      ),
    ).toEqual([]);
    // Header names come from the allowlist only.
    expect(
      issuesOf(
        wf(
          [
            n('h', 'trigger.webhook', { responseMode: 'wait' }),
            n('r', 'control.respond', { headers: { 'set-cookie': 'a' } }),
          ],
          [{ from: 'h', to: 'r' }],
        ),
      ).length,
    ).toBeGreaterThan(0);
  });

  it('refuses an error workflow that names itself (14.4)', () => {
    const d = {
      ...(wf([n('start', 'trigger.manual')]) as object),
      settings: { onFailure: { workflow: 'v' } },
    };
    expect(issuesOf(d)).toContainEqual({ path: 'settings.onFailure.workflow', code: 'on_failure_self' });
  });

  it('keeps every integration target static (no expressions in recipients, env, record, origin)', () => {
    const codes = (doc: unknown) => issuesOf(doc).map((i) => `${i.path}:${i.code}`);
    expect(
      codes(
        wf([
          n('start', 'trigger.manual'),
          n('ship', 'deploy.coolify', { env: '{{ $input.env }}' }),
          n('ping', 'notify.users', { recipients: { role: '{{ $input.role }}' }, title: 'x' }),
        ]),
      ).some((c) => c.includes('static_field')),
    ).toBe(true);
  });
});
