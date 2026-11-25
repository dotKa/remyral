import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p6-logs-ui: `GET /time` — the master's clock for the console header. Any signed-in role (viewer is the
 * weakest); without a full session it answers 401 and no time; the body is the time only, never cached.
 */
describeIntegration('server time (integration)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = new Harness();
    await h.start();
    await h.createUser('clock-viewer', 'tick-tock-Passw0rd-long', 'viewer');
  });
  afterAll(async () => {
    await h.stop();
  });

  it('answers the master clock to a viewer, no-store', async () => {
    const { secret } = await enroll(h, 'clock-viewer', 'tick-tock-Passw0rd-long');
    const c = await fullLogin(h, 'clock-viewer', 'tick-tock-Passw0rd-long', secret);
    h.clock.advance(1234);
    const res = await c.req('GET', '/time');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ now: h.clock.now().toISOString() });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('needs a full session', async () => {
    const anon = await h.client().req('GET', '/time');
    expect(anon.statusCode).toBe(401);
    expect(anon.body).not.toContain('now');
    // Password step only (MFA pending): still refused.
    const half = h.client();
    await half.req('POST', '/auth/login', { username: 'clock-viewer', password: 'tick-tock-Passw0rd-long' });
    const pending = await half.req('GET', '/time');
    expect(pending.statusCode).toBe(401);
  });
});
