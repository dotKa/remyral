import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSISTANT_SYSTEM_PROMPT } from '@remyral/agent-adapters';
import { ASSISTANT_TOOLS } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { sandboxCardLink } from '../../src/chat/tools.js';
import { alertLink } from '../../src/alerts/rules.js';
import { machineLink } from '../../src/workers/console-links.js';

/**
 * p9-ui-names-sweep: the console has no "Fleet" section any more (sidebar "Machines", `/machines/<id>?tab=…`;
 * `/fleet` only redirects). The ops assistant once told a user to use "the Fleet area on the left": nothing the
 * assistant reads (system prompt, tool descriptions, chat tool messages) and no user-facing master / worker /
 * scheduler text may name the old screen again.
 */
const STALE = /Fleet ?(→|>|->)|\/fleet\?/;

const repo = fileURLToPath(new URL('../../../../', import.meta.url));

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Source text without comments (block comments and `//` / `*` comment lines): strings and code only. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

function staleLines(dirs: readonly string[]): string[] {
  const hits: string[] = [];
  for (const d of dirs) {
    for (const f of tsFiles(join(repo, d))) {
      codeOnly(readFileSync(f, 'utf8'))
        .split('\n')
        .forEach((l) => {
          if (STALE.test(l)) hits.push(`${f.slice(repo.length)}: ${l.trim().slice(0, 160)}`);
        });
    }
  }
  return hits;
}

describe('console navigation names (p9-ui-names-sweep)', () => {
  it('the assistant system prompt names no Fleet screen and maps the current navigation', () => {
    expect(ASSISTANT_SYSTEM_PROMPT).not.toMatch(STALE);
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('There is no "Fleet" section');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('Machines → <machine> → Admin');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('Sandbox & policy');
  });

  it('no assistant tool description names the Fleet screen', () => {
    for (const [name, tool] of Object.entries(ASSISTANT_TOOLS)) {
      expect(tool.description, name).not.toMatch(STALE);
    }
  });

  it('chat tool messages and links point at /machines', () => {
    expect(staleLines(['apps/master/src/chat'])).toEqual([]);
    expect(sandboxCardLink('w 1')).toBe('/machines/w%201?tab=sandbox');
    expect(alertLink('worker.offline_with_work', 'w-1')).toBe('/machines/w-1');
    expect(machineLink('w-1', 'admin')).toBe('/machines/w-1?tab=admin');
  });

  it('no user-facing master, worker or scheduler text names the Fleet screen', () => {
    expect(
      staleLines([
        'apps/master/src',
        'apps/worker/src',
        'packages/scheduler/src',
        'packages/agent-adapters/src',
      ]),
    ).toEqual([]);
  });
});
