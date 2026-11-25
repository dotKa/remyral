// p5-sandbox-ops / p9-windows-host-isolation: the worker embeds the Windows scripts; the generated copies must be
// current.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCRIPTS, generateScript } from '../release/gen-windows-jobrun.mjs';

describe('embedded Windows scripts', () => {
  for (const entry of SCRIPTS) {
    it(`${entry.generated} matches ${entry.source} (node scripts/release/gen-windows-jobrun.mjs)`, () => {
      expect(readFileSync(entry.generated, 'utf8')).toBe(generateScript(entry));
    });
  }
});
