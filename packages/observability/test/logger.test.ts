import { describe, expect, it } from 'vitest';
import { Redactor, SecretSet, createLogger } from '../src/index.js';
import { CANARY } from './canaries.js';

function setup(level: 'trace' | 'info' | 'silent' = 'trace') {
  const lines: string[] = [];
  const secrets = new SecretSet();
  secrets.add('canary-exact-secret-1', 'CANARY');
  const logger = createLogger({
    level,
    sink: (l) => lines.push(l),
    redactor: new Redactor({ secrets }),
    clock: () => new Date('2026-10-12T00:00:00.000Z'),
    fields: { component: 'test' },
  });
  return { lines, logger, records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe('createLogger', () => {
  it('writes one JSON line per record with ts, level, msg and fields', () => {
    const { logger, records } = setup();
    logger.info('hello', { jobId: 'j1', n: 3 });
    expect(records()).toEqual([
      { ts: '2026-10-12T00:00:00.000Z', level: 'info', msg: 'hello', component: 'test', jobId: 'j1', n: 3 },
    ]);
  });

  it('filters by level', () => {
    const { logger, records } = setup('info');
    logger.debug('hidden');
    logger.warn('shown');
    expect(records().map((r) => r['msg'])).toEqual(['shown']);
    expect(logger.isLevelEnabled('debug')).toBe(false);
    const silent = setup('silent');
    silent.logger.fatal('nothing');
    expect(silent.lines).toHaveLength(0);
  });

  it('child loggers add fields and share the sink', () => {
    const { logger, records } = setup();
    logger.child({ jobId: 'j2' }).child({ attempt: 1 }).warn('w');
    expect(records()[0]).toMatchObject({ component: 'test', jobId: 'j2', attempt: 1, level: 'warn' });
  });

  it('does not let fields overwrite ts/level/msg', () => {
    const { logger, records } = setup();
    logger.info('real', { msg: 'fake', level: 'fatal' });
    expect(records()[0]).toMatchObject({ msg: 'real', level: 'info', _msg: 'fake', _level: 'fatal' });
  });

  it('never emits canary secrets: message, fields, nested values, child fields, errors, stacks', () => {
    const { logger, lines } = setup();
    const child = logger.child({ token: 'canary-exact-secret-1' });
    child.info(`msg with canary-exact-secret-1 and ${CANARY.anthropic}`, {
      env: { ANTHROPIC_API_KEY: CANARY.anthropic, HOME: '/home/w' },
      header: `Authorization: Bearer ${CANARY.bearer}`,
      url: `https://u:${CANARY.urlPassword}@example.com`,
      list: [CANARY.ghp, { pem: CANARY.pem }],
    });
    const err = new Error(`spawn failed: canary-exact-secret-1 ${CANARY.openai}`);
    err.stack = `Error: spawn failed: canary-exact-secret-1\n    at runtime (${CANARY.ghs})`;
    logger.error('crash', { err });
    const all = lines.join('\n');
    for (const value of ['canary-exact-secret-1', ...Object.values(CANARY)]) {
      expect(all).not.toContain(value);
    }
    expect(all).toContain('/home/w');
    expect(all).toContain('"stack"');
  });

  it('a throwing sink does not crash the caller; drops are counted', () => {
    const logger = createLogger({
      sink: () => {
        throw new Error('EPIPE');
      },
    });
    expect(() => {
      logger.info('x');
    }).not.toThrow();
    expect(logger.droppedLines).toBe(1);
  });
});
