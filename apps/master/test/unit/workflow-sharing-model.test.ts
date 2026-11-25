import { describe, expect, it } from 'vitest';
import type { StoredDefinition } from '@remyral/workflow-nodes';
import {
  AttachmentOverrides,
  credentialSlots,
  effectiveDefinition,
  newRequiredInputs,
  overrideIssues,
  overridesHash,
  slotNames,
  withInputDefaults,
} from '../../src/workflows/sharing-model.js';

/** p18-multi-project: the pure part of shared workflows (overrides, slots, compatibility). */

const DEFAULTS = {
  runtime: 'codex',
  sandboxProfile: 'host-restricted',
  sourceTrust: 'trusted',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 600 },
  repository: { url: 'https://git.example.test/acme/owner.git', baseRef: 'main' },
};

const v2 = (extra: Record<string, unknown> = {}): StoredDefinition =>
  ({
    schemaVersion: 2,
    name: 'shared',
    inputs: { topic: { required: true } },
    defaults: DEFAULTS,
    settings: { concurrency: { max: 4, onLimit: 'queue' }, retentionDays: 30 },
    nodes: [
      { id: 'start', type: 'trigger.manual', config: {} },
      {
        id: 'nightly',
        type: 'trigger.schedule',
        config: { cron: '0 3 * * *', timezone: 'UTC', catchUp: 'skip' },
      },
      { id: 'gh', type: 'trigger.github', config: { repository: 'acme/owner', events: ['push'] } },
      {
        id: 'write',
        type: 'ai.step',
        role: 'executor',
        prompt: 'Write.',
        approval: { approverRole: 'operator' },
      },
      { id: 'ask', type: 'control.approval', config: { title: 'Go?', approverRole: 'admin' } },
      {
        id: 'call',
        type: 'http.request',
        config: { origin: 'https://api.example.test', auth: { credential: 'cred-a', placement: 'bearer' } },
      },
      {
        id: 'call2',
        type: 'http.request',
        config: { origin: 'https://api.example.test:8443', auth: { credential: 'cred-a' } },
      },
      {
        id: 'mail',
        type: 'email.send',
        config: {
          smtp: { host: 'smtp.example.test', port: 587, username: 'u', credential: 'smtp-a' },
          from: { address: 'a@example.test' },
          to: 'b@example.test',
          subject: 'x',
          maxRecipients: 5,
        },
      },
    ],
    edges: [],
    ...extra,
  }) as unknown as StoredDefinition;

describe('effectiveDefinition', () => {
  it('drops the owner repository outside the owner project and keeps the document otherwise', () => {
    const own = v2();
    expect(effectiveDefinition(own, {}, false)).toEqual(own);
    const attached = effectiveDefinition(own, {}, true) as unknown as { defaults: Record<string, unknown> };
    expect(attached.defaults.repository).toBeUndefined();
    expect(attached.defaults.runtime).toBe('codex');
  });

  it('raises approver roles, never lowers them', () => {
    const d = effectiveDefinition(
      v2(),
      { approvers: { write: 'admin', ask: 'operator' } },
      true,
    ) as unknown as {
      nodes: { id: string; approval?: { approverRole: string }; config?: { approverRole?: string } }[];
    };
    expect(d.nodes.find((n) => n.id === 'write')?.approval?.approverRole).toBe('admin');
    expect(d.nodes.find((n) => n.id === 'ask')?.config?.approverRole).toBe('admin');
  });

  it('replaces error workflow and retention, lowers concurrency only, overrides triggers', () => {
    const d = effectiveDefinition(
      v2(),
      {
        onFailure: { workflow: 'on-fail' },
        retentionDays: 3,
        concurrency: { max: 9 },
        triggers: {
          nightly: { cron: '0 5 * * 1', timeZone: 'Europe/Istanbul' },
          gh: { repository: 'acme/target', events: ['pull_request'] },
        },
      },
      true,
    ) as unknown as {
      settings: { onFailure: { workflow: string }; retentionDays: number; concurrency: { max: number } };
      nodes: { id: string; config: Record<string, unknown> }[];
    };
    expect(d.settings.onFailure.workflow).toBe('on-fail');
    expect(d.settings.retentionDays).toBe(3);
    expect(d.settings.concurrency.max).toBe(4);
    expect(d.nodes.find((n) => n.id === 'nightly')?.config).toMatchObject({
      cron: '0 5 * * 1',
      timeZone: 'Europe/Istanbul',
    });
    expect(d.nodes.find((n) => n.id === 'nightly')?.config.timezone).toBeUndefined();
    expect(d.nodes.find((n) => n.id === 'gh')?.config).toMatchObject({
      repository: 'acme/target',
      events: ['pull_request'],
    });
    const lower = effectiveDefinition(v2(), { concurrency: { max: 2 } }, true) as unknown as {
      settings: { concurrency: { max: number } };
    };
    expect(lower.settings.concurrency.max).toBe(2);
  });

  it('works on version-1 documents (approval gates)', () => {
    const v1 = {
      name: 'old',
      inputs: {},
      defaults: DEFAULTS,
      nodes: [{ id: 'a', role: 'executor', prompt: 'x', approval: { approverRole: 'operator' } }],
      edges: [],
    } as unknown as StoredDefinition;
    const d = effectiveDefinition(v1, { approvers: { a: 'owner' } }, true) as unknown as {
      nodes: { approval: { approverRole: string } }[];
      defaults: Record<string, unknown>;
      settings?: unknown;
    };
    expect(d.nodes[0]?.approval.approverRole).toBe('owner');
    expect(d.defaults.repository).toBeUndefined();
    expect(d.settings).toBeUndefined();
  });
});

describe('overrideIssues', () => {
  it('refuses lower approver roles, unknown gates / inputs / triggers and a higher concurrency', () => {
    expect(
      overrideIssues(v2(), {
        approvers: { ask: 'operator', start: 'admin', write: 'owner' },
        inputs: { nope: 'x', topic: 'y' },
        triggers: { start: { cron: '* * * * *' }, nightly: { repository: 'a/b' }, gh: { timeZone: 'UTC' } },
        concurrency: { max: 5 },
      }),
    ).toEqual([
      { path: 'approvers.ask', code: 'lower_than_definition' },
      { path: 'approvers.start', code: 'not_a_gate' },
      { path: 'inputs.nope', code: 'unknown' },
      { path: 'triggers.start', code: 'not_a_trigger' },
      { path: 'triggers.nightly', code: 'not_allowed' },
      { path: 'triggers.gh', code: 'not_allowed' },
      { path: 'concurrency.max', code: 'higher_than_definition' },
    ]);
    expect(overrideIssues(v2(), { approvers: { ask: 'owner' }, concurrency: { max: 1 } })).toEqual([]);
  });

  it('the schema refuses unknown keys and bad values', () => {
    expect(AttachmentOverrides.safeParse({ approvers: { ask: 'viewer' } }).success).toBe(false);
    expect(AttachmentOverrides.safeParse({ owner: true }).success).toBe(false);
    expect(AttachmentOverrides.safeParse({ retentionDays: 0 }).success).toBe(false);
    expect(AttachmentOverrides.safeParse({ triggers: { n: { timeZone: 'Europe/Istanbul' } } }).success).toBe(
      true,
    );
  });
});

describe('credential slots', () => {
  it('lists every credential id with the node, kind and host it is used for', () => {
    expect(credentialSlots(v2())).toEqual([
      { slot: 'cred-a', nodeId: 'call', kind: 'http-auth', host: 'api.example.test', port: 443 },
      { slot: 'cred-a', nodeId: 'call2', kind: 'http-auth', host: 'api.example.test', port: 8443 },
      { slot: 'smtp-a', nodeId: 'mail', kind: 'smtp', host: 'smtp.example.test', port: 587 },
    ]);
    expect(slotNames(v2())).toEqual(['cred-a', 'smtp-a']);
  });
});

describe('compatibility of a new version', () => {
  it('a new required input without a default here holds the version back', () => {
    const prev = v2();
    const next = v2({
      inputs: { topic: { required: true }, audience: { required: true }, tone: { required: false } },
    });
    expect(newRequiredInputs(prev, next, {})).toEqual(['audience']);
    expect(newRequiredInputs(prev, next, { inputs: { audience: 'customers' } })).toEqual([]);
  });

  it('input defaults fill what a run leaves empty (declared inputs only)', () => {
    expect(withInputDefaults(v2(), { topic: '' }, { inputs: { topic: 'weekly', other: 'x' } })).toEqual({
      topic: 'weekly',
    });
    expect(withInputDefaults(v2(), { topic: 'mine' }, { inputs: { topic: 'weekly' } })).toEqual({
      topic: 'mine',
    });
  });

  it('hashes overrides independently of key order', () => {
    expect(overridesHash({ retentionDays: 3, inputs: { a: '1' } })).toBe(
      overridesHash({ inputs: { a: '1' }, retentionDays: 3 }),
    );
  });
});
