import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  apiRequest,
  NETWORK_ERROR_MESSAGE,
  parseRetryAfter,
  readCookie,
  UNEXPECTED_RESPONSE_MESSAGE,
} from '../src/api/client';
import { fakeFetch } from './helpers';

const ok = (): { status: number; body: unknown } => ({ status: 200, body: { status: 'ok' } });
const parseAny = (v: unknown): unknown => v;

describe('readCookie', () => {
  it('finds a cookie by exact name among others and decodes it', () => {
    const jar = '__Host-ras-csrf-old=x; __Host-ras-csrf=abc%2Bdef; other=1';
    expect(readCookie('__Host-ras-csrf', jar)).toBe('abc+def');
    expect(readCookie('missing', jar)).toBeNull();
    expect(readCookie('__Host-ras-csrf', '')).toBeNull();
  });
});

describe('parseRetryAfter', () => {
  it('accepts delta-seconds and HTTP dates', () => {
    expect(parseRetryAfter('42')).toBe(42);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
    const now = Date.parse('2026-10-12T10:00:00Z');
    expect(parseRetryAfter('Mon, 12 Oct 2026 10:01:00 GMT', now)).toBe(60);
  });
});

describe('apiRequest', () => {
  it('prefixes /api, sends JSON and attaches the CSRF cookie as X-CSRF-Token on POST', async () => {
    const f = fakeFetch({ 'POST /api/auth/step-up': ok });
    await apiRequest('POST', '/auth/step-up', parseAny, {
      body: { code: '123456' },
      fetchImpl: f.fetch,
      cookieString: '__Host-ras-csrf=tok123',
    });
    const [req] = f.requests;
    expect(req?.url).toBe('/api/auth/step-up');
    expect(req?.headers['x-csrf-token']).toBe('tok123');
    expect(req?.headers['content-type']).toBe('application/json');
    expect(req?.body).toEqual({ code: '123456' });
  });

  it('sends no Content-Type for body-less POSTs (Fastify rejects empty JSON bodies)', async () => {
    const f = fakeFetch({ 'POST /api/auth/logout': ok });
    await apiRequest('POST', '/auth/logout', parseAny, {
      fetchImpl: f.fetch,
      cookieString: '__Host-ras-csrf=t',
    });
    expect(f.requests[0]?.headers['content-type']).toBeUndefined();
    expect(f.requests[0]?.headers['x-csrf-token']).toBe('t');
  });

  it('never sends the CSRF header on GET', async () => {
    const f = fakeFetch({ 'GET /api/auth/session': ok });
    await apiRequest('GET', '/auth/session', parseAny, {
      fetchImpl: f.fetch,
      cookieString: '__Host-ras-csrf=t',
    });
    expect(f.requests[0]?.headers['x-csrf-token']).toBeUndefined();
  });

  it('uses same-origin credentials, no cache and refuses redirects', async () => {
    const spy = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    await apiRequest('GET', '/auth/session', parseAny, { fetchImpl: spy as unknown as typeof fetch });
    expect(spy).toHaveBeenCalledWith(
      '/api/auth/session',
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' }),
    );
  });

  it('keeps the master error code and message verbatim, plus Retry-After', async () => {
    const f = fakeFetch({
      'POST /api/auth/login': () => ({
        status: 429,
        body: { error: 'rate_limited', message: 'Too many attempts. Try again later.' },
        headers: { 'retry-after': '90' },
      }),
    });
    const err = await apiRequest('POST', '/auth/login', parseAny, { body: {}, fetchImpl: f.fetch }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 429,
      code: 'rate_limited',
      message: 'Too many attempts. Try again later.',
      retryAfterSeconds: 90,
    });
  });

  it('maps network failures and malformed responses to fixed client messages', async () => {
    const down = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(
      apiRequest('GET', '/auth/session', parseAny, { fetchImpl: down as unknown as typeof fetch }),
    ).rejects.toMatchObject({ status: 0, code: 'network_error', message: NETWORK_ERROR_MESSAGE });

    const html = vi.fn(() => Promise.resolve(new Response('<html>bad gateway</html>', { status: 502 })));
    await expect(
      apiRequest('GET', '/auth/session', parseAny, { fetchImpl: html as unknown as typeof fetch }),
    ).rejects.toMatchObject({ status: 502, message: UNEXPECTED_RESPONSE_MESSAGE });

    const wrongShape = vi.fn(() => Promise.resolve(new Response('{"nope":1}', { status: 200 })));
    await expect(
      apiRequest(
        'GET',
        '/auth/session',
        () => {
          throw new Error('shape');
        },
        { fetchImpl: wrongShape as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: 'unexpected_response' });
  });
});
