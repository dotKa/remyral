import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { ProcRow } from '../src/jobs/memory.js';
import {
  checkPreviewPort,
  loopbackListening,
  osListenerProbe,
  parseLsofPids,
  parseNetstatListeners,
  parseProcNetTcp,
  portPolicy,
  processTree,
} from '../src/previews/ports.js';
import type { RunFn } from '../src/remote-ops/process.js';

/** p8-preview-tunnels (ADR-0032): port policy, listener parsers, process-tree ownership. */

const row = (pid: number, ppid: number): ProcRow => ({ pid, ppid, rssBytes: 0 });
// worker 100 → runtime 200 → dev server 300; another job 400; egress proxy 500 (child of the worker)
const TABLE = [
  row(1, 0),
  row(100, 1),
  row(200, 100),
  row(300, 200),
  row(400, 100),
  row(500, 100),
  row(900, 1),
];

describe('port policy', () => {
  it('refuses privileged, service and worker ports', () => {
    expect(portPolicy(5173, []).ok).toBe(true);
    expect(portPolicy(80, [])).toMatchObject({ ok: false, reason: 'out_of_range' });
    for (const p of [3389, 5432, 6379, 2375, 9229, 20241, 27017]) {
      expect(portPolicy(p, [])).toMatchObject({ ok: false, reason: 'denied' });
    }
    expect(portPolicy(8443, [8443])).toMatchObject({ ok: false, reason: 'worker_port' });
  });
});

describe('parsers', () => {
  it('/proc/net/tcp: LISTEN entries of the port only', () => {
    const text = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1',
      '   1: 0100007F:1435 0100007F:C000 01 00000000:00000000 00:00000000 00000000  1000        0 4343 1',
      '   2: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 77 1',
    ].join('\n');
    expect(parseProcNetTcp(text, 5173)).toEqual(['4242']);
    expect(parseProcNetTcp(text, 22)).toEqual(['77']);
  });

  it('lsof -F p and netstat -ano', () => {
    expect(parseLsofPids('p300\nfu\np300\np301\n')).toEqual([300, 301]);
    const netstat = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       4120',
      '  TCP    [::1]:5173             [::]:0                 LISTENING       4121',
      '  TCP    127.0.0.1:51730        0.0.0.0:0              LISTENING       9',
      '  TCP    127.0.0.1:5173         127.0.0.1:50000        ESTABLISHED     4120',
    ].join('\r\n');
    expect(parseNetstatListeners(netstat, 5173)).toEqual([4120, 4121]);
  });

  it('process trees', () => {
    expect([...processTree(TABLE, [200])].sort()).toEqual([200, 300]);
    expect(processTree(TABLE, [12345]).size).toBe(0);
  });

  it('linux probe maps inodes to candidate pids through /proc/<pid>/fd', async () => {
    const files: Record<string, string> = {
      '/proc/net/tcp':
        'header\n 0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 4242 1\n',
    };
    const probe = osListenerProbe(
      'linux',
      undefined,
      {},
      {
        readFile: (p) =>
          files[p] === undefined ? Promise.reject(new Error('no')) : Promise.resolve(files[p] ?? ''),
        readdir: (p) => Promise.resolve(p === '/proc/300/fd' ? ['0', '7'] : ['0']),
        readlink: (p) => Promise.resolve(p === '/proc/300/fd/7' ? 'socket:[4242]' : '/dev/null'),
      },
    );
    expect(await probe(5173, new Set([200, 300]))).toEqual([300]);
  });

  it('darwin probe runs lsof and treats exit 1 as "none"', async () => {
    const calls: string[][] = [];
    const run: RunFn = (file, args) => {
      calls.push([file, ...args]);
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: '', timedOut: false });
    };
    expect(await osListenerProbe('darwin', run)(5173, new Set())).toEqual([]);
    expect(calls[0]).toEqual(['/usr/sbin/lsof', '-nP', '-a', '-iTCP:5173', '-sTCP:LISTEN', '-Fp']);
  });
});

describe('checkPreviewPort', () => {
  const deps = (listeners: number[] | null) => ({
    listening: () => Promise.resolve(true),
    processTable: () => Promise.resolve(TABLE),
    listeners: () => Promise.resolve(listeners),
    workerPid: 100,
  });

  it('owned: the listener must be in the job’s tree', async () => {
    expect(await checkPreviewPort(deps([300]), 5173, 'owned', new Set([200]))).toEqual({ ok: true });
    expect(await checkPreviewPort(deps([400]), 5173, 'owned', new Set([200]))).toMatchObject({
      ok: false,
      reason: 'not_owned',
    });
    expect(await checkPreviewPort(deps(null), 5173, 'owned', new Set([200]))).toMatchObject({
      reason: 'unverifiable',
    });
    expect(await checkPreviewPort(deps([300]), 5173, 'owned', new Set())).toMatchObject({
      reason: 'unverifiable',
    });
  });

  it('declared: a listener suffices, but never the worker or its other children', async () => {
    expect(await checkPreviewPort(deps([900]), 5173, 'declared', new Set([200]))).toEqual({ ok: true });
    expect(await checkPreviewPort(deps([300]), 5173, 'declared', new Set([200]))).toEqual({ ok: true });
    expect(await checkPreviewPort(deps([500]), 5173, 'declared', new Set([200]))).toMatchObject({
      reason: 'worker_port',
    });
    expect(await checkPreviewPort(deps([100]), 5173, 'declared', new Set([200]))).toMatchObject({
      reason: 'worker_port',
    });
  });

  it('nothing listening / denied ports are refused before any probe', async () => {
    expect(
      await checkPreviewPort({ listening: () => Promise.resolve(false) }, 5173, 'declared', new Set()),
    ).toMatchObject({ reason: 'not_listening' });
    expect(await checkPreviewPort({}, 5432, 'declared', new Set())).toMatchObject({ reason: 'denied' });
  });

  it('loopbackListening sees a real local server', async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    try {
      expect(await loopbackListening(port)).toBe(true);
    } finally {
      await new Promise<void>((r) => {
        srv.close(() => {
          r();
        });
      });
    }
    expect(await loopbackListening(port, 300)).toBe(false);
  });
});
