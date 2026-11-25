import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/** The licence file Vite's `build.license` writes into the output dir (served at /third-party-licenses.md). */
export const LICENSE_FILE = 'third-party-licenses.md';

/**
 * The self-hosted fonts (src/fonts.css) are copied woff2 files, not npm modules, so Vite's `build.license` does not
 * see them. Their SIL Open Font License 1.1 texts (src/assets/fonts/OFL-*.txt) are appended to the same file.
 */
const FONTS: readonly { readonly name: string; readonly file: string }[] = [
  { name: 'Inter (@fontsource-variable/inter 5.3.0)', file: 'OFL-inter.txt' },
  {
    name: 'Plus Jakarta Sans (@fontsource-variable/plus-jakarta-sans 5.3.0)',
    file: 'OFL-plus-jakarta-sans.txt',
  },
  { name: 'JetBrains Mono (@fontsource-variable/jetbrains-mono 5.3.0)', file: 'OFL-jetbrains-mono.txt' },
];

export function fontLicenseSection(
  texts: readonly { readonly name: string; readonly text: string }[],
): string {
  return texts.map(({ name, text }) => `\n## ${name} (OFL-1.1)\n\n${text.trim()}\n`).join('');
}

export function fontLicensePlugin(): Plugin {
  const fontsDir = fileURLToPath(new URL('./src/assets/fonts/', import.meta.url));
  return {
    name: 'remyral-font-licenses',
    apply: 'build',
    async writeBundle(options, bundle) {
      if (options.dir === undefined || !(LICENSE_FILE in bundle)) {
        throw new Error(
          `font licences: ${LICENSE_FILE} missing from the build (vite.config.ts build.license)`,
        );
      }
      const texts = await Promise.all(
        FONTS.map(async ({ name, file }) => ({ name, text: await readFile(join(fontsDir, file), 'utf8') })),
      );
      await appendFile(join(options.dir, LICENSE_FILE), fontLicenseSection(texts));
    },
  };
}
