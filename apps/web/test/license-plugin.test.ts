// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fontLicensePlugin, LICENSE_FILE } from '../license-plugin';

const dir = mkdtempSync(join(tmpdir(), 'remyral-web-licenses-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

type WriteBundle = (options: { dir?: string }, bundle: Record<string, unknown>) => Promise<void>;
const writeBundle = fontLicensePlugin().writeBundle as unknown as WriteBundle;

describe('third-party licence file', () => {
  it('appends the OFL text of every self-hosted font to the file Vite wrote', async () => {
    writeFileSync(join(dir, LICENSE_FILE), '# Licenses\n\n## react - 19.0.0 (MIT)\n\nMIT License\n');
    await writeBundle({ dir }, { [LICENSE_FILE]: { type: 'asset' } });
    const text = readFileSync(join(dir, LICENSE_FILE), 'utf8');
    expect(text).toMatch(/^# Licenses\n\n## react - 19\.0\.0 \(MIT\)/);
    for (const font of ['Inter', 'Plus Jakarta Sans', 'JetBrains Mono']) {
      expect(text).toMatch(
        new RegExp(`\\n## ${font} \\(@fontsource-variable/[a-z-]+ 5\\.3\\.0\\) \\(OFL-1\\.1\\)\\n`),
      );
    }
    expect(text.match(/SIL OPEN FONT LICENSE Version 1\.1/g)).toHaveLength(3);
  });

  it('fails the build when build.license did not produce the file', async () => {
    await expect(writeBundle({ dir }, {})).rejects.toThrow(/third-party-licenses\.md missing/);
  });
});
