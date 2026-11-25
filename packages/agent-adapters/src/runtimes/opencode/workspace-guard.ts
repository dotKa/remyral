import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Finding (verified on the 1.19.0 binary, docs/design/p3-adapter-pi-opencode.md
 * §6.5): OpenCode's v2 configuration service (`@opencode/v2/Config`) walks up
 * from the session directory collecting `.opencode/` directories and
 * `opencode.json(c)` files **without honouring `OPENCODE_DISABLE_PROJECT_CONFIG`**;
 * its `config-plugin` then imports `.opencode/{plugin,plugins}/*.{ts,js}` into the
 * server process (and a document's `plugins` list can name further modules).
 * A repository that ships such files gets code execution in the server — with
 * the server password and provider keys in its environment — before any
 * approval. The adapter therefore refuses to start on a workspace where any of
 * these names exists in the workspace or one of its ancestors. Entries directly
 * in the worker user's home are the operator's own (OpenCode loads `~/.opencode`
 * unconditionally anyway) and are not refused.
 */
export const OPENCODE_PROJECT_CONFIG_NAMES: readonly string[] = [
  '.opencode',
  'opencode.json',
  'opencode.jsonc',
];

/** Paths of OpenCode project configuration from `workspaceRoot` up to the filesystem root. */
export async function findOpenCodeProjectConfig(
  workspaceRoot: string,
  home: string = homedir(),
): Promise<string[]> {
  const found: string[] = [];
  const homeDir = await realpath(home).catch(() => resolve(home));
  let dir = await realpath(workspaceRoot);
  for (;;) {
    if (dir !== homeDir) {
      for (const name of OPENCODE_PROJECT_CONFIG_NAMES) {
        const candidate = join(dir, name);
        try {
          await lstat(candidate);
          found.push(candidate);
        } catch {
          // absent
        }
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return found;
    dir = parent;
  }
}
