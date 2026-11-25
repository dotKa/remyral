import { describe, expect, it } from 'vitest';
import { ServiceEvents, serviceTransitions } from '../../src/services/events.js';

/** p15-services: the typed event hook other features subscribe to. */

const row = (state: string, health = 'unknown', url: string | null = null, desired = 'running') => ({
  state,
  health,
  url,
  desired,
});

describe('service events', () => {
  it('derives url_up / healthy / down / removed from one stored change', () => {
    expect(
      serviceTransitions(row('pending'), row('running', 'healthy', 'https://a.trycloudflare.com')),
    ).toEqual(['service.url_up', 'service.healthy']);
    // No repeat while nothing changes; a new quick URL is announced again.
    const up = row('running', 'healthy', 'https://a.trycloudflare.com');
    expect(serviceTransitions(up, up)).toEqual([]);
    expect(serviceTransitions(up, row('running', 'healthy', 'https://b.trycloudflare.com'))).toEqual([
      'service.url_up',
    ]);
    expect(serviceTransitions(up, row('unhealthy', 'unhealthy', up.url))).toEqual(['service.down']);
    expect(serviceTransitions(row('running', 'none'), row('failed', 'none'))).toEqual(['service.down']);
    expect(serviceTransitions(row('stopped'), row('stopped', 'unknown', null, 'removed'))).toEqual([
      'service.removed',
    ]);
    // Without a probe, running counts as healthy.
    expect(serviceTransitions(row('starting'), row('running', 'none'))).toEqual(['service.healthy']);
  });

  it('filters subscribers and isolates a throwing listener', () => {
    const errors: unknown[] = [];
    const hub = new ServiceEvents((err) => errors.push(err));
    const got: string[] = [];
    const off = hub.subscribe({ kinds: ['service.url_up'], project: 'shop' }, (e) => got.push(e.serviceId));
    hub.subscribe({}, () => {
      throw new Error('boom');
    });
    const base = {
      project: 'shop',
      workerId: 'w',
      name: 'web',
      url: 'https://x',
      state: 'running',
      at: new Date(),
    };
    hub.emit({ ...base, kind: 'service.url_up', serviceId: 'a' });
    hub.emit({ ...base, kind: 'service.down', serviceId: 'b' });
    hub.emit({ ...base, project: 'other', kind: 'service.url_up', serviceId: 'c' });
    expect(got).toEqual(['a']);
    expect(errors).toHaveLength(3);
    off();
    hub.emit({ ...base, kind: 'service.url_up', serviceId: 'd' });
    expect(got).toEqual(['a']);
  });
});
