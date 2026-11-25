import type { AdminOp } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_TOOL_NAMES,
  ADMIN_TOOL_PREFIX,
  adminOpFromTool,
  type AdminToolHost,
} from '../src/admin-tools.js';
import { adminMcpServer, type ClaudeSdkPort } from '../src/runtimes/claude-code/adapter.js';

describe('machine-admin tools (ADR-0021)', () => {
  it('map tool arguments to strict protocol operations', () => {
    expect(adminOpFromTool('admin_exec', { shell: 'powershell', command: 'Get-Service' })).toEqual({
      ok: true,
      op: { kind: 'exec', shell: 'powershell', command: 'Get-Service', timeoutSec: 300 },
    });
    const w = adminOpFromTool('admin_write_file', { path: '/etc/motd', content: 'hi\n', mode: 'overwrite' });
    expect(w.ok && w.op.kind === 'write_file' ? Buffer.from(w.op.content, 'base64').toString() : null).toBe(
      'hi\n',
    );
    expect(adminOpFromTool('admin_read_file', { path: 'relative.txt' }).ok).toBe(false);
    expect(adminOpFromTool('admin_exec', { shell: 'sh', command: 'x', timeoutSec: 99_999 }).ok).toBe(false);
    expect(ADMIN_TOOL_PREFIX).toBe('mcp__remyral-admin__');
  });

  it('the in-process MCP server routes every call to the worker host and reports refusals as errors', async () => {
    const calls: AdminOp[] = [];
    const notes: string[] = [];
    const host: AdminToolHost = {
      run: (op) => {
        calls.push(op);
        return Promise.resolve({ ok: true, text: 'state: succeeded' });
      },
      note: (text) => {
        notes.push(text);
        return Promise.resolve({ ok: true, text: 'recorded' });
      },
    };
    type Tool = {
      name: string;
      handler: (args: unknown) => Promise<{ isError: boolean; content: { text: string }[] }>;
    };
    let server: { name: string; tools: Tool[] } | null = null;
    const sdk = {
      query: () => {
        throw new Error('unused');
      },
      createSdkMcpServer: (o: { name: string; tools: Tool[] }) => {
        server = o;
        return { type: 'sdk', name: o.name };
      },
      tool: (name: string, _d: string, _s: unknown, handler: Tool['handler']) => ({ name, handler }),
    } as unknown as ClaudeSdkPort;
    const cfg = adminMcpServer(sdk, host, new AbortController().signal);
    expect(cfg).toMatchObject({ name: 'remyral-admin' });
    const s = server as { name: string; tools: Tool[] } | null;
    if (s === null) throw new Error('no server');
    expect(s.tools.map((t) => t.name)).toEqual(ADMIN_TOOL_NAMES);
    const exec = s.tools.find((t) => t.name === 'admin_exec');
    const ok = await exec?.handler({ shell: 'sh', command: 'id -u' });
    expect(ok).toMatchObject({ isError: false });
    expect(calls).toEqual([{ kind: 'exec', shell: 'sh', command: 'id -u', timeoutSec: 300 }]);
    const bad = await s.tools.find((t) => t.name === 'admin_read_file')?.handler({ path: 'x' });
    expect(bad?.isError).toBe(true);
    expect(calls).toHaveLength(1);
    await s.tools.find((t) => t.name === 'machine_note')?.handler({ text: 'installed ffmpeg' });
    expect(notes).toEqual(['installed ffmpeg']);
  });

  it('p17-worker-1-1-1: the purpose travels next to the operation, never inside it (it is not signed)', () => {
    expect(
      adminOpFromTool('admin_exec', {
        shell: 'sh',
        command: 'id -u',
        purpose: '  Check that the root helper\nworks  ',
      }),
    ).toEqual({
      ok: true,
      op: { kind: 'exec', shell: 'sh', command: 'id -u', timeoutSec: 300 },
      purpose: 'Check that the root helper works',
    });
    // Without one, the command's own comment: trailing on the first line, or a leading comment line.
    expect(
      adminOpFromTool('admin_exec', { shell: 'sh', command: 'id -u # check: root helper works (read-only)' }),
    ).toMatchObject({ purpose: 'check: root helper works (read-only)' });
    expect(
      adminOpFromTool('admin_exec', {
        shell: 'bash',
        command: '#!/bin/bash\n# install ffmpeg\napt-get install -y ffmpeg',
      }),
    ).toMatchObject({ purpose: 'install ffmpeg' });
    expect(
      adminOpFromTool('admin_exec', { shell: 'cmd', command: 'REM list services\nsc query' }),
    ).toMatchObject({
      purpose: 'list services',
    });
    // A `#` inside quotes or a word is no comment.
    const quoted = adminOpFromTool('admin_exec', { shell: 'sh', command: 'echo "a # b" x#y' });
    expect(quoted.ok && 'purpose' in quoted).toBe(false);
    const long = adminOpFromTool('admin_read_file', { path: '/etc/shadow', purpose: 'x'.repeat(500) });
    expect(long.ok ? long.purpose?.length : 0).toBe(300);
    const none = adminOpFromTool('admin_write_file', { path: '/etc/motd', content: '', mode: 'create' });
    expect(none.ok && 'purpose' in none).toBe(false);
  });

  it('p17-worker-1-1-1: the MCP server hands the purpose to the host', async () => {
    const metas: unknown[] = [];
    const host: AdminToolHost = {
      run: (_op, _signal, meta) => {
        metas.push(meta);
        return Promise.resolve({ ok: true, text: 'ok' });
      },
      note: () => Promise.resolve({ ok: true, text: '' }),
    };
    type Tool = { name: string; handler: (args: unknown) => Promise<unknown> };
    let tools: Tool[] = [];
    const sdk = {
      query: () => {
        throw new Error('unused');
      },
      createSdkMcpServer: (o: { name: string; tools: Tool[] }) => {
        tools = o.tools;
        return { type: 'sdk', name: o.name };
      },
      tool: (name: string, _d: string, _s: unknown, handler: Tool['handler']) => ({ name, handler }),
    } as unknown as ClaudeSdkPort;
    adminMcpServer(sdk, host, new AbortController().signal);
    const exec = tools.find((t) => t.name === 'admin_exec');
    await exec?.handler({ shell: 'sh', command: 'id -u', purpose: 'Kök yardımcıyı denetle' });
    await exec?.handler({ shell: 'sh', command: 'id -u' });
    expect(metas).toEqual([{ purpose: 'Kök yardımcıyı denetle' }, {}]);
  });

  it('refuses to build the server with an SDK that cannot register in-process tools', () => {
    const host: AdminToolHost = {
      run: () => Promise.resolve({ ok: true, text: '' }),
      note: () => Promise.resolve({ ok: true, text: '' }),
    };
    expect(() => adminMcpServer({ query: () => null as never }, host, new AbortController().signal)).toThrow(
      /in-process tools/,
    );
  });
});
