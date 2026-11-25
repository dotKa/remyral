// Windows PowerShell 5.1 reads a BOM-less UTF-8 script as the ANSI code page: a typographic dash or quote
// becomes mojibake whose bytes include a quote character, and the script no longer parses. Every shipped
// PowerShell script (and the installer shell scripts) must therefore stay plain ASCII.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO } from '../security/lib.mjs';

const files = execFileSync(
  'git',
  ['ls-files', '*.ps1', '*.psm1', 'infra/worker/*/install.sh', 'infra/worker/*/uninstall.sh'],
  {
    cwd: REPO,
    encoding: 'utf8',
  },
)
  .split('\n')
  .filter(Boolean);

describe('installer scripts are ASCII-only', () => {
  it('finds the scripts', () => {
    expect(files.some((f) => f.endsWith('install.ps1'))).toBe(true);
  });
  for (const f of files) {
    it(f, () => {
      const text = readFileSync(join(REPO, f), 'utf8');
      const bad = [...text.matchAll(/[^\t\n\r\x20-\x7e]/gu)].map((m) => {
        const line = text.slice(0, m.index).split('\n').length;
        return `line ${line}: U+${m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
      });
      expect(bad).toEqual([]);
    });
  }
});

// PowerShell's -match/-like/-replace/-split are case-insensitive and follow the current culture: on a
// Turkish Windows (tr-TR) an uppercase I does not match [A-Za-z] ("NODE_VERSION" failed to parse from
// node\pin.env). Shipped scripts use only the case-sensitive variants (-cmatch, -clike, ...).
describe('PowerShell scripts avoid culture-dependent case-insensitive operators', () => {
  for (const f of files.filter((x) => x.endsWith('.ps1') && !x.includes('/test/'))) {
    it(f, () => {
      const lines = readFileSync(join(REPO, f), 'utf8').split('\n');
      const bad = lines.flatMap((l, i) =>
        /\s-(i?match|i?notmatch|i?replace|i?split|i?like|i?notlike)\s/i.test(l) &&
        !/\s-c(not)?(match|replace|split|like)\s/.test(l)
          ? [`line ${i + 1}: ${l.trim()}`]
          : [],
      );
      expect(bad).toEqual([]);
    });
  }
});
