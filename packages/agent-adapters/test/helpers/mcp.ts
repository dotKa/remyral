import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpToolRule } from '@remyral/protocol';
import {
  SecretValue,
  type McpJobDelivery,
  type McpRemoteServerDelivery,
  type McpStdioServerDelivery,
} from '../../src/index.js';

/** p14-mcp-core test fixtures: one remote server `x-docs` with a secret bearer header and a literal header. */
export const MCP_TOKEN = 'tok-SECRET-0123456789abcdef';

export const MCP_RULES: McpToolRule[] = [
  { tool: 'search', effect: 'allow' },
  { tool: 'create_*', effect: 'ask' },
  { tool: 'delete_all', effect: 'deny' },
];

export function mcpDelivery(
  rules: readonly McpToolRule[] = MCP_RULES,
  over: Partial<McpRemoteServerDelivery> = {},
  configDir: string = join(mkdtempSync(join(tmpdir(), 'remyral-mcp-')), 'mcp'),
): McpJobDelivery {
  return {
    servers: [
      {
        id: 'docs',
        name: 'x-docs',
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: {
          Authorization: { kind: 'secret', env: 'REMYRAL_MCP_DOCS_TOKEN', format: 'Bearer {}' },
          'X-Team': { kind: 'literal', value: 'blue' },
        },
        rules,
        startupTimeoutSec: 30,
        toolTimeoutSec: 120,
        ...over,
      },
    ],
    configDir,
    secretEnv: { REMYRAL_MCP_DOCS_TOKEN: new SecretValue(MCP_TOKEN) },
  };
}

/** p14-mcp-stdio: one local server `x-files` started through the worker's launcher (no secret on argv or in config). */
export function mcpStdioDelivery(
  rules: readonly McpToolRule[] = MCP_RULES,
  over: Partial<McpStdioServerDelivery> = {},
  configDir: string = join(mkdtempSync(join(tmpdir(), 'remyral-mcp-')), 'mcp'),
): McpJobDelivery {
  return {
    servers: [
      {
        id: 'files',
        name: 'x-files',
        transport: 'stdio',
        command: '/opt/remyral/node/bin/node',
        args: [join(configDir, 'remyral-mcp-launch.mjs'), join(configDir, 'x-files.launch.json')],
        forwardEnv: ['HTTPS_PROXY', 'NO_PROXY'],
        rules,
        startupTimeoutSec: 30,
        toolTimeoutSec: 120,
        ...over,
      },
    ],
    configDir,
    secretEnv: {},
  };
}
