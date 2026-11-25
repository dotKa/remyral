import { GIT_BRANCH_ALLOWED, GIT_FORBIDDEN, GIT_READ_SUBCOMMANDS, GIT_RULE } from './rules.js';
import { type Arg, type Effects, looksLikePath, notSafe } from './types.js';

/** `HEAD:src/a.ts`, `main~2:README.md` — an object inside the repository, not a file path. */
const OBJECT_SPEC = /^[A-Za-z0-9_.^~@/-]*:[A-Za-z0-9_./-]*$/;

function forbiddenOption(name: string): boolean {
  return GIT_FORBIDDEN.some((f) =>
    f.startsWith('--') ? name.length >= 3 && name.startsWith('--') && f.startsWith(name) : name === f,
  );
}

/**
 * `git <read-only subcommand> …` (shared by every shell). The worker additionally checks that the workspace root
 * holds the repository (`.git`), so git never discovers a parent repository outside the workspace.
 */
export function checkGit(args: readonly Arg[], fx: Effects): void {
  let i = 0;
  // Global options: only --no-pager / -P (no -c, -C, --git-dir, --work-tree, --exec-path, --namespace …).
  while (i < args.length && (args[i]?.text ?? '').startsWith('-')) {
    const a = args[i];
    if (a === undefined || a.dynamic || (a.text !== '--no-pager' && a.text !== '-P'))
      notSafe('git_global_option');
    i++;
  }
  const sub = args[i];
  if (sub === undefined || sub.dynamic) notSafe('git_no_subcommand');
  if (!GIT_READ_SUBCOMMANDS.includes(sub.text)) notSafe('git_subcommand');
  fx.usesGit = true;
  fx.rules.add(GIT_RULE.id);
  const rest = args.slice(i + 1);
  let pathspecs = false;
  let listMode = false;
  const operands: Arg[] = [];
  for (const a of rest) {
    if (a.dynamic) notSafe('dynamic_argument');
    if (!pathspecs && a.text === '--') {
      pathspecs = true;
      continue;
    }
    if (!pathspecs && a.text.startsWith('-') && a.text !== '-') {
      const eq = a.text.indexOf('=');
      const name = eq === -1 ? a.text : a.text.slice(0, eq);
      if (forbiddenOption(name)) notSafe('git_forbidden_option');
      if (!name.startsWith('--') && /^-[^-]/.test(name) && name.slice(1).includes('O')) {
        notSafe('git_forbidden_option'); // -O<orderfile> glued into a cluster
      }
      if (sub.text === 'branch') {
        if (!GIT_BRANCH_ALLOWED.includes(name)) notSafe('git_branch_option');
        if (name === '--list' || name === '-l') listMode = true;
      }
      if (eq !== -1) {
        const value = a.text.slice(eq + 1);
        if (looksLikePath(value) && (/^[A-Za-z]:/.test(value) || !OBJECT_SPEC.test(value))) fx.read(value);
      }
      continue;
    }
    operands.push(a);
    if (pathspecs) fx.read(a.text);
  }
  if (sub.text === 'branch' && operands.length > 0 && !listMode) notSafe('git_branch_write');
  for (const a of pathspecs ? [] : operands) {
    // Revisions and names are data; anything that could be a file is checked as one.
    if (a.text.includes(':') && !/^[A-Za-z]:/.test(a.text)) {
      if (!OBJECT_SPEC.test(a.text) || a.text.split(/[:/]/).includes('..')) notSafe('git_object_spec');
      continue;
    }
    if (looksLikePath(a.text) || a.text === '..') fx.read(a.text);
  }
}
