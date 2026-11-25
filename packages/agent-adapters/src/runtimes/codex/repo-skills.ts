import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * p6-skills / ADR-0010: codex-cli 0.162.1 loads **repository** skills (`.agents/skills/<name>/SKILL.md`,
 * `.codex/skills/<name>/SKILL.md`, scope `repo`) even for a workspace marked `trust_level = "untrusted"`
 * (verified on the pinned binary with `skills/list`, test/skills.test.ts). There is no scope switch, only
 * `[[skills.config]]` path/name selectors, so the adapter finds every SKILL.md below a `.agents/skills` or
 * `.codex/skills` directory of the workspace before the app-server starts and disables it by exact path.
 *
 * Bounded walk (depth, entries); symlinks are not followed; `.git` and `node_modules` are skipped.
 */
const MAX_DEPTH = 8;
const MAX_ENTRIES = 20_000;
const SKIP = new Set(['.git', 'node_modules']);

export async function findRepositorySkillFiles(workspaceRoot: string): Promise<string[]> {
  const found: string[] = [];
  let seen = 0;
  const collect = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || seen > MAX_ENTRIES) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      seen += 1;
      if (seen > MAX_ENTRIES) return;
      const path = join(dir, e.name);
      if (e.isFile() && e.name === 'SKILL.md') found.push(path);
      else if (e.isDirectory()) await collect(path, depth + 1);
    }
  };
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || seen > MAX_ENTRIES) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      seen += 1;
      if (seen > MAX_ENTRIES) return;
      if (!e.isDirectory() || SKIP.has(e.name)) continue;
      const path = join(dir, e.name);
      if (e.name === '.agents' || e.name === '.codex') await collect(join(path, 'skills'), depth + 1);
      await walk(path, depth + 1);
    }
  };
  await walk(workspaceRoot, 0);
  return [...new Set(found)].sort();
}
