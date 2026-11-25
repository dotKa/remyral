import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { redactingLogStream } from '../../src/logging.js';
import { LogCapture } from '../helpers/logs.js';

const GH = `ghp_${'Z'.repeat(36)}`;
const DB_URL = 'postgres://remyral_app:s3cr3t-db-password@remyral-pg:5432/remyral';

describe('redactingLogStream (p1-monitoring)', () => {
  it('pattern-redacts messages, error texts and odd keys and keeps one valid JSON object per line', async () => {
    const sink = new LogCapture();
    const app = await buildApp({
      logLevel: 'info',
      trustProxyHops: 0,
      bodyLimitBytes: 1024,
      logStream: redactingLogStream(sink),
      routes: [],
    });
    try {
      app.log.info({ upstream: { note: `token in text ${GH}` } }, `connecting to ${DB_URL}`);
      app.log.error({ err: new Error(`fetch failed: Authorization: Bearer ${'q'.repeat(40)}`) }, 'boom');
    } finally {
      await app.close();
    }
    await new Promise((r) => setImmediate(r));
    const text = sink.text;
    expect(text).not.toContain(GH);
    expect(text).not.toContain('s3cr3t-db-password');
    expect(text).not.toContain('q'.repeat(40));
    const entries = sink.entries; // throws if a line is not JSON
    expect(entries.some((e) => String(e.msg).startsWith('connecting to postgres://remyral_app:'))).toBe(true);
    expect(entries.every((e) => typeof e.level === 'number')).toBe(true);
  });

  it('handles lines split across writes and non-JSON input', () => {
    const sink = new LogCapture();
    const s = redactingLogStream(sink);
    s.write('{"level":30,"msg":"half ');
    s.write(`${GH}"}\nnot json ${GH}\n`);
    s.end();
    const lines = sink.entries;
    expect(lines).toHaveLength(2);
    expect(sink.text).not.toContain(GH);
    expect(lines[1]).toMatchObject({ level: 40, unparsedLogLine: true });
  });
});

describe('request log lines never carry a token from the query string', () => {
  it('masks the values of sensitive query parameters in req.url, keeps the rest', async () => {
    const sink = new LogCapture();
    const app = await buildApp({
      logLevel: 'info',
      trustProxyHops: 0,
      bodyLimitBytes: 1024,
      logStream: sink,
      routes: [],
    });
    const ticket = 'tk_' + 'A'.repeat(40);
    const state = 's'.repeat(32);
    try {
      await app.inject({ method: 'GET', url: `/_ide/enter?w=ws-1&t=${ticket}` });
      await app.inject({ method: 'GET', url: `/integrations/github/manifest/form?state=${state}&x=1` });
    } finally {
      await app.close();
    }
    await new Promise((r) => setImmediate(r));
    expect(sink.text).not.toContain(ticket);
    expect(sink.text).not.toContain(state);
    const urls = sink.entries.map((e) => (e.req as { url?: string } | undefined)?.url).filter(Boolean);
    expect(urls).toContain('/_ide/enter?w=ws-1&t=[REDACTED]');
    expect(urls).toContain('/integrations/github/manifest/form?state=[REDACTED]&x=1');
  });
});
