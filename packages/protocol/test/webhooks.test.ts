import { describe, expect, it } from 'vitest';
import {
  exampleEnvelope,
  GLOBAL_EVENT_TYPES,
  isSubscribableEventType,
  parseWebhookEnvelope,
  SUBSCRIBABLE_EVENT_TYPES,
  WEBHOOK_CATALOG_VERSION,
  WEBHOOK_DATA_SCHEMAS,
  WEBHOOK_EVENT_DESCRIPTIONS,
  WEBHOOK_EVENT_GROUPS,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_EXAMPLES,
} from '../src/webhooks.js';

describe('webhook event catalog (p16-webhooks-out)', () => {
  it('documents every type: a schema, a description and an example that parses', () => {
    for (const type of WEBHOOK_EVENT_TYPES) {
      expect(WEBHOOK_EVENT_DESCRIPTIONS[type].length).toBeGreaterThan(10);
      const parsed = WEBHOOK_DATA_SCHEMAS[type].safeParse(WEBHOOK_EXAMPLES[type]);
      expect(parsed.success, type).toBe(true);
      const env = parseWebhookEnvelope(exampleEnvelope(type));
      expect(env.ok, type).toBe(true);
    }
  });

  it('groups cover every subscribable type exactly once', () => {
    const grouped = Object.values(WEBHOOK_EVENT_GROUPS).flat();
    expect([...grouped].sort()).toEqual([...SUBSCRIBABLE_EVENT_TYPES].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(isSubscribableEventType('webhook.test')).toBe(false);
    expect(isSubscribableEventType('job.failed')).toBe(true);
    expect(isSubscribableEventType('job.unknown')).toBe(false);
  });

  it('data schemas are strict: an undocumented field (e.g. a prompt) is refused', () => {
    const withPrompt = { ...WEBHOOK_EXAMPLES['job.failed'], prompt: 'do the secret thing' };
    expect(WEBHOOK_DATA_SCHEMAS['job.failed'].safeParse(withPrompt).success).toBe(false);
    const nested = {
      ...WEBHOOK_EXAMPLES['job.failed'],
      job: { ...WEBHOOK_EXAMPLES['job.failed'].job, log: 'x' },
    };
    expect(WEBHOOK_DATA_SCHEMAS['job.failed'].safeParse(nested).success).toBe(false);
  });

  it('caps the opt-in detail text', () => {
    const long = { ...WEBHOOK_EXAMPLES['job.failed'], reason: 'x'.repeat(501) };
    expect(WEBHOOK_DATA_SCHEMAS['job.failed'].safeParse(long).success).toBe(false);
  });

  it('refuses a global event with a project and an unknown catalog version', () => {
    const g = GLOBAL_EVENT_TYPES[0] ?? 'worker.online';
    expect(parseWebhookEnvelope({ ...exampleEnvelope(g), project: 'website' }).ok).toBe(false);
    expect(parseWebhookEnvelope({ ...exampleEnvelope('job.created'), catalogVersion: 2 }).ok).toBe(false);
    expect(WEBHOOK_CATALOG_VERSION).toBe(1);
  });

  it('refuses data of the wrong type', () => {
    const env = { ...exampleEnvelope('deploy.failed'), data: WEBHOOK_EXAMPLES['job.created'] };
    const r = parseWebhookEnvelope(env);
    expect(r.ok).toBe(false);
  });
});
